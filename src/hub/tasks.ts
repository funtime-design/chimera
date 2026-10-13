import type { Message, Rollup, Task, TaskChange, TaskEvent, TaskInput, TaskQuery, TaskRow, TaskSummary } from "./schema";
import { MAX_BODY, MAX_TASK_TITLE, TASK_COLUMNS, TASK_LIST_LIMIT } from "./schema";
import { firstOf, post, type Router, type Waiters } from "./messages";
import { parentOf } from "./devices";
import { endClaim, recordClaim } from "./faults";
import { eventsOf } from "./events";
import { checkWarmClaim } from "./warm";
import { household, memberFor, people, personFor, personOf } from "./roster";
import { BridgeError, checkBrief, checkDue, checkLabels, checkPriority, checkUrl, optText, requiredText, stateOf } from "./validate";
import { assertAllowed } from "./permissions";
import { callerPermissions } from "./trust";
import { CLOUD_PARENT_CLAIM, isCloud, isCloudParent, refusal, rolesOf, rollupEpic, rollupOf, SYSTEM_LABELS, taskEvent, transition, writeTask } from "./state";

const CLOSED_STATES = ["done", "dropped"];
// A claim on a task in one of these states is someone else's work in progress.
const WORKING_STATES = ["claimed", "in_progress", "blocked", "review"];
const STATE_ORDER = `CASE state WHEN 'in_progress' THEN 0 WHEN 'claimed' THEN 1 WHEN 'review' THEN 2 WHEN 'blocked' THEN 3
  WHEN 'ready' THEN 4 WHEN 'backlog' THEN 5 WHEN 'done' THEN 6 WHEN 'dropped' THEN 7 ELSE 8 END`;

// The brief opens a new thread from the creator to the assignee, or to the owner when nobody is assigned.
export function taskCreate(sql: SqlStorage, waiters: Waiters, caller: string, members: string[], input: TaskInput): Task {
  const title = requiredText(input.title, MAX_TASK_TITLE, "title");
  const brief = checkBrief(input.brief);
  if (!input.owner?.trim()) throw new BridgeError(`owner is required: a person, one of ${people(members).join(", ")}`);
  const owner = personFor(input.owner, members);
  let assignee = input.assignee ? memberFor(input.assignee, members, "assignee") : null;
  let state = input.state === undefined ? "backlog" : stateOf(input.state);
  const priority = input.priority === undefined ? 3 : checkPriority(input.priority);
  const labels = checkLabels(input.labels ?? []);
  const repo = optText(input.repo, 200, "repo");
  // Created claimed is a claim like any other: for the assignee (else the caller), through the warm check.
  let claimer: string | null = null;
  if (state === "claim" || state === "claimed") {
    state = "claimed";
    claimer = assignee = assignee ?? caller;
    if (isCloudParent(claimer)) throw new BridgeError(`${claimer} cannot hold a claim: ${CLOUD_PARENT_CLAIM}`);
    checkWarmClaim(sql, claimer, { id: -1, key: "the new task", owner, repo, labels, thread_id: 0, state: "ready", claim_session: null } as unknown as Task);
  }
  // Created closed is a record of finished work, not a transition: the owner's call only.
  if (CLOSED_STATES.includes(state) && !rolesOf(caller, { owner, claim_session: null }, members).includes("owner")) {
    throw new BridgeError(`only ${owner} (or one of their non-cloud devices) can create a task that is already ${state}`);
  }
  const branch = optText(input.branch, 200, "branch");
  const prUrl = checkUrl(input.pr_url);
  const due = checkDue(input.due);
  const kind = kindOf(input.kind);
  const parent = input.parent ? parentKey(sql, input.parent, null) : null;
  if (kind === "epic" && parent) throw new BridgeError("an epic cannot have a parent: epics are one level deep");
  if (kind === "epic" && claimer) throw new BridgeError("an epic cannot be claimed: create it, then claim its child tasks");
  const now = new Date().toISOString();
  const closed = CLOSED_STATES.includes(state);
  if (!closed) assertFree(sql, null, repo, branch, prUrl, parent);

  const id = sql
    .exec<{ id: number }>(
      `INSERT INTO tasks (title, brief, owner, assignee, state, priority, repo, branch, pr_url, labels, due, created_by, created_at, updated_at, closed_at, closed_by, version, parent, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`,
      title, brief, owner, assignee, state, priority, repo, branch, prUrl, JSON.stringify(labels), due, caller, now, now,
      closed ? now : null, closed ? caller : null, parent, kind,
    )
    .one().id;
  const key = `T-${id}`;
  const to = assignee ?? owner;
  const footer = `\n\n---\nTask ${key} · owner ${owner}${assignee ? ` · assignee ${assignee}` : ""} · ${state} · P${priority}${repo ? ` · ${repo}` : ""}. Read it with task_get ${key}; comment with task_update note.`;
  const message = post(sql, waiters, null, caller, to, `Task ${key}: ${title}`, brief + footer, members);
  sql.exec("UPDATE tasks SET key = ?, thread_id = ? WHERE id = ?", key, message.thread_id, id);
  if (claimer) stampClaim(sql, id, claimer);
  taskEvent(sql, id, caller, "created", { title, owner, assignee, state, priority, repo, branch, pr_url: prUrl, labels, due, thread_id: message.thread_id, ...(parent ? { parent } : {}), ...(kind === "epic" ? { kind } : {}) });
  if (parent) rollupEpic(sql, parent);
  return taskById(sql, id);
}

function kindOf(v: string | undefined): string {
  const k = (v ?? "task").trim().toLowerCase() || "task";
  if (k !== "task" && k !== "epic") throw new BridgeError(`kind must be task or epic, not ${v}`);
  return k;
}

// The epic a parent value names, as its key: it must exist, be an epic, and not be the task itself.
function parentKey(sql: SqlStorage, value: string, self: Task | null): string {
  const epic = taskByKey(sql, value);
  if (epic.kind !== "epic") throw new BridgeError(`${epic.key} is not an epic: make it one first (task_update kind epic, owner only)`);
  if (self && epic.id === self.id) throw new BridgeError(`${self.key} cannot be its own parent`);
  return epic.key;
}

// scope: mine (owned by my person, or assigned to me, my person or their devices), all, or owner:<person>.
// Closed tasks are left out unless `states` asks for them ("all" = every state).
export function taskList(sql: SqlStorage, caller: string, members: string[], query: TaskQuery = {}): TaskSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = (query.scope ?? "mine").trim().toLowerCase() || "mine";
  if (scope === "mine") {
    const person = personOf(caller, members) ?? caller;
    const family = household(caller, members);
    if (!family.includes(caller)) family.push(caller);
    where.push(`(owner = ? OR assignee IN (${family.map(() => "?").join(", ")}))`);
    params.push(person, ...family);
  } else if (scope !== "all") {
    where.push("owner = ?");
    params.push(personFor(scope.startsWith("owner:") ? scope.slice("owner:".length) : scope, members));
  }
  const states = (query.states ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (states.includes("all")) {
    // every state
  } else if (states.length === 0 || states.includes("open")) {
    const named = states.filter((x) => x !== "open").map(stateOf);
    where.push(`(state NOT IN ('done', 'dropped')${named.length ? ` OR state IN (${named.map(() => "?").join(", ")})` : ""})`);
    params.push(...named);
  } else {
    const named = states.map(stateOf);
    if (named.includes("claim")) throw new BridgeError("state claim is not a state to list; use claimed");
    where.push(`state IN (${named.map(() => "?").join(", ")})`);
    params.push(...named);
  }
  if (query.repo?.trim()) {
    where.push("repo = ? COLLATE NOCASE");
    params.push(query.repo.trim());
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), TASK_LIST_LIMIT);
  const columns = ["id", ...Object.keys(TASK_COLUMNS).filter((c) => c !== "brief")].join(", ");
  return sql
    .exec<TaskRow>(
      `SELECT ${columns} FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY owner, ${STATE_ORDER}, priority, id LIMIT ?`,
      ...params, limit,
    )
    .toArray()
    .map((r) => taskOf(r) as TaskSummary)
    .map((t) => (t.kind === "epic" ? { ...t, rollup: rollupOf(sql, t.key) } : t));
}

// An epic's children, open first (task_get on an epic lists them).
export function childrenOf(sql: SqlStorage, key: string): TaskSummary[] {
  const columns = ["id", ...Object.keys(TASK_COLUMNS).filter((c) => c !== "brief")].join(", ");
  return sql.exec<TaskRow>(`SELECT ${columns} FROM tasks WHERE parent = ? ORDER BY ${STATE_ORDER}, priority, id`, key).toArray().map((r) => taskOf(r) as TaskSummary);
}

// The task's events, oldest first (T-52): the newest TASK_EVENTS_DEFAULT unless `limit` asks for up to TASK_EVENTS_MAX.
// `total` is the full count, so the reader knows when there are more. An epic (T-53) also gets its children and rollup.
export const TASK_EVENTS_DEFAULT = 50;
export const TASK_EVENTS_MAX = 500;
export function taskGet(sql: SqlStorage, key: string, limit?: number): { task: Task; events: TaskEvent[]; total: number; children?: TaskSummary[]; rollup?: Rollup } {
  const task = taskByKey(sql, key);
  const epic = task.kind === "epic" ? { children: childrenOf(sql, task.key), rollup: rollupOf(sql, task.key) } : {};
  const { events, total } = eventsOf(sql, "task", task.id, Math.min(Math.max(limit ?? TASK_EVENTS_DEFAULT, 1), TASK_EVENTS_MAX));
  return { task, events: events.map((e) => ({ id: e.id, task_id: task.id, at: e.at, by: e.actor, kind: e.kind, data: e.data })), total, ...epic };
}

// The cloud router bridge_send uses (Hub.cloudRouter), and whether it decides anything for a given cloud parent.
export type NoteRouter = { applies: (to: string) => boolean; router: Router };

// `route`: a note for a cloud device goes through the bridge_send router (T-56).
export function taskUpdate(sql: SqlStorage, waiters: Waiters, caller: string, members: string[], key: string, input: TaskInput, route?: NoteRouter): TaskChange {
  return changeTask(sql, waiters, caller, members, taskByKey(sql, key), input, null, route);
}

// task_done reports finished work; it never closes the task (the merge does). It posts the summary in the task's thread
// and moves the task to review when it has a PR. With no PR, a holder that reports its claimed or in_progress task lets
// the claim go (back to ready), so its later exit is not reported as an orphan. When the reporter is not the owner's household, that post goes to the
// owner as the notice, so it reaches their phone and claude.ai.
// task_report (T-52) is the canonical name: a report with a verdict. finished is task_done's meaning (the state moves as
// above); progress, blocked and failed are recorded and posted with no state change. Every report is a `report` event
// first, and its thread line skips the reply cap, so a full thread cannot strand it.
export const REPORT_VERDICTS = ["finished", "progress", "blocked", "failed"];
export const MAX_TASK_REPORTS = 50;
export type ReportInput = { summary?: string; verdict?: string; branch?: string; pr_url?: string; expected_version?: number };

export function taskDone(sql: SqlStorage, waiters: Waiters, caller: string, members: string[], key: string, input: ReportInput): TaskChange {
  const task = taskByKey(sql, key);
  const verdict = (input.verdict ?? "finished").trim().toLowerCase() || "finished";
  if (!REPORT_VERDICTS.includes(verdict)) throw new BridgeError(`verdict must be one of ${REPORT_VERDICTS.join(", ")}`);
  if (CLOSED_STATES.includes(task.state)) throw new BridgeError(`${task.key} is already ${task.state} (closed by ${task.closed_by} at ${task.closed_at}). Use task_update with a note to add to it.`);
  if (!input.summary?.trim()) throw new BridgeError("summary is required: what was done, the branch and commit, and anything left");
  // Reports skip the thread's 20-message cap, so they have their own: a session looping on task_report stops here.
  const reports = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE subject_kind = 'task' AND subject_id = ? AND kind = 'report'", String(task.id)).one().n;
  // The owner is never capped (the cap stops a looping session, and the owner is who it would send you to).
  if (reports >= MAX_TASK_REPORTS && !rolesOf(caller, task, members).includes("owner")) {
    throw new BridgeError(`${task.key} already has ${MAX_TASK_REPORTS} reports; start a new task (task_create) for further work, or note it with task_update.`);
  }
  const hasPr = (input.pr_url !== undefined ? checkUrl(input.pr_url) : task.pr_url) !== null;
  const state = verdict !== "finished" ? undefined : hasPr ? (task.state !== "review" ? "review" : undefined)
    : task.claim_session === caller && (task.state === "claimed" || task.state === "in_progress") ? "ready" : undefined;
  return changeTask(sql, waiters, caller, members, task,
    { ...(state ? { state } : {}), note: input.summary, branch: input.branch, pr_url: input.pr_url, expected_version: input.expected_version }, verdict);
}

// `report` is the verdict of a task_report / task_done call, or null for a plain update.
export function changeTask(sql: SqlStorage, waiters: Waiters, caller: string, members: string[], task: Task, input: TaskInput, report: string | null = null, route?: NoteRouter): TaskChange {
  if (input.expected_version !== undefined && input.expected_version !== task.version) {
    throw new BridgeError(`${task.key} is at version ${task.version}, not ${input.expected_version}: someone changed it. Read it again with task_get and retry.`);
  }
  // Device permissions (hub/trust.ts): may_act_as_person or may_edit_tasks off drops the owner role; may_edit_tasks on
  // widens a cloud session's edits (assertAllowed).
  const perms = callerPermissions(sql, caller);
  const roles = rolesOf(caller, task, members).filter((r) => r !== "owner" || (perms.actAsPerson !== false && perms.editTasks !== false));
  assertAllowed(task, caller, roles, input, members, perms);
  const next: Record<string, unknown> = {};
  const set = (field: keyof Task, value: unknown) => {
    if (value !== task[field]) next[field] = value;
  };
  if (input.title !== undefined) set("title", requiredText(input.title, MAX_TASK_TITLE, "title"));
  if (input.brief !== undefined) set("brief", checkBrief(input.brief));
  if (input.owner !== undefined) set("owner", personFor(input.owner, members));
  if (input.assignee !== undefined) set("assignee", input.assignee === null ? null : memberFor(input.assignee, members, "assignee"));
  if (input.priority !== undefined) set("priority", checkPriority(input.priority));
  if (input.repo !== undefined) set("repo", optText(input.repo, 200, "repo"));
  if (input.branch !== undefined) set("branch", optText(input.branch, 200, "branch"));
  if (input.pr_url !== undefined) set("pr_url", checkUrl(input.pr_url));
  if (input.due !== undefined) set("due", checkDue(input.due));
  const by = roles;
  const bridge = by.includes("github") || by.includes("system");
  // T-53: which epic a task belongs to, and whether a task is an epic, are the owner's calls.
  if (input.parent !== undefined || input.kind !== undefined) epicEdit(sql, task, input, by, set);
  // Labels change by add/remove; a full replace is a blind overwrite, so it needs expected_version.
  if (input.labels !== undefined || input.add_labels !== undefined || input.remove_labels !== undefined) {
    if (input.labels !== undefined && input.expected_version === undefined && !bridge) {
      throw new BridgeError(`replacing all the labels of ${task.key} needs expected_version (now ${task.version}); or use add_labels / remove_labels`);
    }
    const remove = input.remove_labels ?? [];
    const labels = checkLabels([...(input.labels ?? task.labels).filter((l) => !remove.includes(l)), ...(input.add_labels ?? [])]);
    const cleared = task.labels.filter((l) => SYSTEM_LABELS.includes(l) && !labels.includes(l));
    if (cleared.length && !bridge && !by.includes("owner")) {
      throw new BridgeError(`${cleared.join(", ")} on ${task.key} is set by the bridge; only the bridge (when the cause is fixed) or ${task.owner} clears it`);
    }
    if (JSON.stringify(labels) !== JSON.stringify(task.labels)) next.labels = labels;
  }
  // Every claim takes the claim path, for the assignee named in the same call or else the caller: state claim, or claimed.
  let claimer: string | null = null;
  if (input.state !== undefined) {
    const state = stateOf(input.state);
    if (state === "claim" || state === "claimed") {
      if (input.assignee === null) throw new BridgeError(`a claim needs a holder: ${task.key} cannot be claimed with no assignee`);
      claimer = input.assignee === undefined ? caller : memberFor(input.assignee, members, "assignee");
      if (isCloudParent(claimer)) throw new BridgeError(`${claimer} cannot hold a claim: ${CLOUD_PARENT_CLAIM}`);
      const closed = refusal(task, "claimed", by, {}, true);
      if (closed) throw new BridgeError(closed);
      // A session that already has an anchor task may only add tasks the bridge judges related, inside its caps.
      if (task.claim_session !== claimer) checkWarmClaim(sql, claimer, task);
      // Taking over someone else's live claim needs expected_version, so two sessions cannot grab one task by accident.
      if (task.assignee && task.assignee !== claimer && WORKING_STATES.includes(task.state) && input.expected_version === undefined) {
        throw new BridgeError(`${task.key} is already ${task.state} by ${task.assignee}. Ask them with bridge_send, or pass expected_version ${task.version} to take it over.`);
      }
      set("assignee", claimer);
      set("state", "claimed");
    } else {
      set("state", state);
    }
  }
  // The epic checks above each read the old kind: a claim and a conversion to epic in one call would make a claimed epic.
  if (claimer && (next.kind ?? task.kind) === "epic") throw new BridgeError(`${task.key} cannot be claimed and made an epic in one call: an epic is never claimed`);
  // Editing a task you do not hold is a blind write unless you say which version you read. Claims, states and notes are
  // free; so is the owner of a task nobody holds.
  // add_labels / remove_labels merge with what is there, so they are not blind (protected labels are checked above).
  const merged = input.labels === undefined && "labels" in next;
  const edited = Object.keys(next).filter((f) => f !== "state" && !(claimer && f === "assignee") && !(merged && f === "labels"));
  const holder = claimer === caller || task.claim_session === caller;
  if (edited.length && input.expected_version === undefined && !bridge && !holder && !(by.includes("owner") && !task.claim_session)) {
    throw new BridgeError(`${task.key} is not yours to edit blind: changing ${edited.join(", ")} needs expected_version (now ${task.version}). Read it with task_get and pass its version.`);
  }
  const now = new Date().toISOString();
  const closing = typeof next.state === "string" && CLOSED_STATES.includes(next.state);
  const reopening = typeof next.state === "string" && !CLOSED_STATES.includes(next.state) && CLOSED_STATES.includes(task.state);
  // A branch or PR left on a finished task is what the webhook later mis-matches. Closing frees the branch (and the PR of
  // a dropped task); a merged task keeps its pr_url as the record revert and task_get read, the matcher ignores closed
  // tasks anyway. Reopening starts clean. Whatever the caller passes in this same call wins.
  if (closing) {
    next.closed_at = now;
    next.closed_by = caller;
    if (input.branch === undefined && task.branch !== null) next.branch = null;
    if (input.pr_url === undefined && next.state === "dropped" && task.pr_url !== null) next.pr_url = null;
  } else if (reopening) {
    next.closed_at = null;
    next.closed_by = null;
    if (input.branch === undefined && task.branch !== null) next.branch = null;
    if (input.pr_url === undefined && task.pr_url !== null) next.pr_url = null;
  }
  // Two open tasks must never hold the same branch or PR: that is a double match waiting for a webhook. Checked with the
  // values the task ends up with, so a repo-only change still meets another task holding the same branch (T-70).
  const after = <K extends "repo" | "branch" | "pr_url">(f: K) => (f in next ? next[f] : task[f]) as string | null;
  // A reopen checks too: the branch or PR it keeps (or repeats in this call, which set() drops as unchanged) may be held now.
  if (!CLOSED_STATES.includes(String(next.state ?? task.state)) && (reopening || ["repo", "branch", "pr_url", "parent"].some((f) => f in next))) {
    assertFree(sql, task, after("repo"), after("branch"), after("pr_url"), ("parent" in next ? next.parent : task.parent) as string | null);
  }
  const note = input.note?.trim() || null;
  if (note && new TextEncoder().encode(note).length > MAX_BODY) throw new BridgeError(`note is over ${MAX_BODY} bytes`);

  const changed = Object.keys(next);
  let current = task;
  if (changed.length > 0) {
    const fields = Object.fromEntries(changed.filter((f) => f !== "state").map((f) => [f, next[f]]));
    if ("state" in next) transition(sql, task, String(next.state), by, fields, { claim: claimer !== null, at: now });
    else writeTask(sql, task.id, fields, now);
    const kind = closing ? "closed" : reopening ? "reopened" : claimer ? "claimed" : changed.every((f) => f === "state") ? "state" : "updated";
    taskEvent(sql, task.id, caller, kind, next.state === undefined ? next : { ...next, from_state: task.state });
    // A child moved between epics, or a task became an epic: both epics re-derive (a state move already did via transition).
    for (const epic of new Set(["parent" in next ? task.parent : null, "parent" in next ? next.parent : null, next.kind === "epic" ? task.key : null])) {
      if (epic) rollupEpic(sql, String(epic));
    }
    current = taskById(sql, task.id);
  }
  // The claim carries the claiming session and its heartbeat; it ends with the claim.
  const stateNow = String(next.state ?? task.state);
  if (claimer) {
    stampClaim(sql, task.id, claimer);
    current = taskById(sql, task.id);
  } else if (task.claim_session && (closing || "assignee" in next || stateNow === "backlog" || stateNow === "ready")) {
    sql.exec("UPDATE tasks SET claim_session = NULL, claim_beat_at = NULL WHERE id = ?", task.id);
    endClaim(sql, task.id, closing ? (next.state === "done" ? "done" : "dropped") : report ? "reported" : "reassigned");
    current = taskById(sql, task.id);
  }
  // A change of state or assignee is a decision about the orphan: the mark ends, so the old session cannot take it back.
  if (("state" in next || "assignee" in next) && task.orphaned_at !== null) {
    sql.exec("UPDATE tasks SET orphaned_at = NULL, orphaned_from = NULL, orphan_reason = NULL WHERE id = ?", task.id);
    // The epic it left and the one it joined in this call: the new one was rolled up while the child was still orphaned.
    for (const epic of new Set([task.parent, ("parent" in next ? next.parent : task.parent) as string | null])) if (epic) rollupEpic(sql, epic);
    current = taskById(sql, task.id);
  }

  let posted: Message | null = null;
  let notified: string | null = null;
  let refused: string | undefined;
  const finished = next.state === "done";
  const byOwner = (personOf(caller, members) ?? caller) === current.owner;
  if ((finished || report) && !byOwner) {
    posted = taskPost(sql, waiters, current, caller, current.owner, `Task ${current.key} (${current.title}) was ${report ? `reported ${report}` : "finished"} by ${caller}: ${note ?? "no summary given."}`, members);
    notified = current.owner;
  } else if (note) {
    const body = finished ? `Done: ${note}` : report ? `Reported ${report}: ${note}` : note;
    const target = commentTarget(current, caller, members);
    const routed = route && isCloud(target) ? routeNote(sql, current, caller, target, route) : { to: target };
    if (routed.refused) refused = routed.refused;
    posted = taskPost(sql, waiters, current, caller, routed.to ?? target, body, members, routed.reserved_for ?? null);
  }
  // A report is its own event with the full text: the record holds it whatever happens to the thread (T-52).
  if (posted && report) taskEvent(sql, task.id, caller, "report", { verdict: report, text: note ?? "", message_id: posted.id, to: posted.recipient });
  else if (posted) taskEvent(sql, task.id, caller, "comment", { message_id: posted.id, to: posted.recipient, note: (note ?? "").slice(0, 200) });
  return { task: current, changed, message_id: posted?.id ?? null, posted_to: posted?.recipient ?? null, notified, ...(refused ? { note_refused: refused } : {}), ...(report ? { verdict: report } : {}) };
}

// T-56: a note for a cloud device (the parent, or one of its sessions) is addressed the way bridge_send addresses it: the
// live claimant gets it, an idle one leaves it in the shared inbox, nobody on it reserves it for a fresh session (the
// Worker fires). A backlog task fires nothing: the note is kept in the thread as the caller's own record, and the caller
// is told no session will see it. A holder that refuses (a Mac session) leaves the note where it was going, with why.
function routeNote(sql: SqlStorage, task: Task, caller: string, target: string, route: NoteRouter): { to?: string; reserved_for?: string; refused?: string } {
  const parent = isCloudParent(target) ? target : parentOf(sql, target) ?? target;
  if (!route.applies(parent)) return { to: target };
  // `task` is the task after this call's own change: a note on a closed task (or one that closes it, "merged, thanks")
  // starts nothing; it is a plain comment to the target.
  if (CLOSED_STATES.includes(task.state)) return { to: target };
  // An epic is never claimed (T-53): a note on one is a plain comment, never a fire; its children are the work.
  if (task.kind === "epic") return { to: target };
  if (task.state === "backlog") {
    return { to: caller, refused: `${task.key} is in backlog: no session will see this; set it ready and assign it to fire one, or send it with bridge_send.` };
  }
  try {
    const routed = route.router(parent, `Task ${task.key}: ${task.title}`, task.thread_id || null);
    // Reserved for a fire: addressed to the parent, whose inbox the fired session reads (a dead child's would be lost).
    return routed ? { to: parent, ...routed } : { to: target };
  } catch (err) {
    if (err instanceof BridgeError) return { to: target, refused: err.message };
    throw err;
  }
}

// The task whose brief opened this thread, if any.
export function taskByThread(sql: SqlStorage, threadId: number): Task | null {
  if (!threadId) return null;
  const row = sql.exec<TaskRow>("SELECT * FROM tasks WHERE thread_id = ? ORDER BY id LIMIT 1", threadId).toArray()[0];
  return row ? taskOf(row) : null;
}

function epicEdit(sql: SqlStorage, task: Task, input: TaskInput, by: string[], set: (field: keyof Task, value: unknown) => void): void {
  const what = input.kind !== undefined ? "kind" : "parent";
  if (!by.includes("owner")) throw new BridgeError(`only ${task.owner} (or one of their non-cloud devices) sets the ${what} of ${task.key}`);
  const kind = input.kind === undefined ? task.kind : kindOf(input.kind);
  const parent = input.parent === undefined ? task.parent : input.parent === null ? null : parentKey(sql, input.parent, task);
  if (kind === "epic" && parent) throw new BridgeError("an epic cannot have a parent: epics are one level deep");
  if (kind === "epic" && task.kind !== "epic") {
    if (task.claim_session) throw new BridgeError(`${task.key} is claimed by ${task.claim_session}; an epic is never claimed. Release it first`);
    // An epic is never orphaned: its children are the work. A mark left on would list it in the faults for good.
    if (task.orphaned_at !== null) {
      set("orphaned_at", null);
      set("orphaned_from", null);
      set("orphan_reason", null);
    }
  }
  if (kind !== "epic" && task.kind === "epic" && sql.exec("SELECT 1 FROM tasks WHERE parent = ? LIMIT 1", task.key).toArray().length > 0) {
    throw new BridgeError(`${task.key} has children; clear their parent first`);
  }
  set("kind", kind);
  set("parent", parent);
}

// The branch and PR url a task may take: not one an open task already holds (same repo for a branch). Children of one
// epic may share a PR (T-53: one PR closes N); the matcher moves them together.
function assertFree(sql: SqlStorage, self: Task | null, repo: string | null, branch: string | null, prUrl: string | null, parent: string | null = self?.parent ?? null): void {
  const last = (v: string | null) => (v ?? "").trim().toLowerCase().split("/").filter(Boolean).pop() ?? "";
  const held = (column: string, value: string) => sql
    .exec<TaskRow>(`SELECT * FROM tasks WHERE ${column} = ? COLLATE NOCASE AND state NOT IN ('done', 'dropped') AND id != ?`, value, self?.id ?? -1)
    .toArray().map(taskOf);
  if (branch) {
    const other = held("branch", branch).find((t) => last(t.repo) === last(repo));
    if (other) throw new BridgeError(`branch ${branch} is already held by open task ${other.key}. Two open tasks cannot share a branch (the GitHub webhook would match both). Clear it on ${other.key} first, or use another branch.`);
  }
  if (prUrl) {
    const other = held("pr_url", prUrl).find((t) => !parent || t.parent !== parent);
    if (other) throw new BridgeError(`pr_url ${prUrl} is already held by open task ${other.key}. Two open tasks cannot share a PR. Clear it on ${other.key} first.`);
  }
}

// A comment goes to the owner when someone outside the owner's household writes it, else to the assignee if that
// is someone else, else it is kept in the thread as a record.
function commentTarget(task: Task, caller: string, members: string[]): string {
  if ((personOf(caller, members) ?? caller) !== task.owner) return task.owner;
  if (task.assignee && task.assignee !== caller) return task.assignee;
  return caller;
}

function taskPost(sql: SqlStorage, waiters: Waiters, task: Task, caller: string, to: string, body: string, members: string[], reservedFor: string | null = null): Message {
  const subject = firstOf(sql, task.thread_id)?.subject ?? `Task ${task.key}: ${task.title}`;
  return post(sql, waiters, task.thread_id || null, caller, to, subject, body, members, reservedFor);
}

// The task event writer lives with the state machine (state.ts), so the epic rollup can emit without an import cycle;
// it appends to the single record (hub/events.ts), and task_events is the view that reads them back.
export { taskEvent };

// The task a key names, or null (a subject can mention a key that does not exist).
export function findTask(sql: SqlStorage, key: string): Task | null {
  try {
    return taskByKey(sql, key);
  } catch {
    return null;
  }
}

export function stampClaim(sql: SqlStorage, id: number, session: string): void {
  sql.exec("UPDATE tasks SET claim_session = ?, claim_beat_at = ?, orphaned_at = NULL, orphaned_from = NULL, orphan_reason = NULL WHERE id = ?", session, Date.now(), id);
  recordClaim(sql, id, session);
  // The orphan mark just cleared: an epic blocked by it re-derives.
  const parent = sql.exec<{ parent: string | null }>("SELECT parent FROM tasks WHERE id = ?", id).one().parent;
  if (parent) rollupEpic(sql, parent);
}

export function taskById(sql: SqlStorage, id: number): Task {
  return taskOf(sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id).one());
}

// "T-12", "t12", "#12" and "12" all name task 12.
export function taskByKey(sql: SqlStorage, key: string): Task {
  const match = String(key ?? "").trim().match(/^(?:t-?|#)?(\d+)$/i);
  const row = match ? sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", Number(match[1])).toArray()[0] : undefined;
  if (!row) throw new BridgeError(`task ${String(key ?? "").trim() || "(no key)"} not found`);
  return taskOf(row);
}

function taskOf(row: TaskRow): Task {
  return { ...row, labels: parseArray(row.labels) };
}

function parseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
