import { deploymentDefaults } from "../deployment";
import { resolveConfig } from "../config/resolve";
import { isCloud, isCloudParent } from "../config/names";
export { isCloud, isCloudParent } from "../config/names";
import type { Rollup, Task } from "./schema";
import { personOf } from "./roster";
import { appendEvent } from "./events";
import { BridgeError } from "./validate";

const labels = resolveConfig().labels;

// The task state machine. transition() is the only writer of tasks.state; writeTask() writes the other fields. Both bump
// version and updated_at, so every change invalidates an older expected_version. (The claim stamp and heartbeat columns,
// written right after a claim transition or by the heartbeat, do not bump on their own.) Who may move a task where is the
// TRANSITIONS table below; anything not in it is refused.

export const OPEN_STATES = ["backlog", "ready", "claimed", "in_progress", "blocked", "review"];
// Tasks of these kinds never own a PR (the webhook matcher skips them), so their owner closes them by hand.
export const EXEMPT_LABELS = labels.exempt;
// Labels the bridge sets when something is wrong; a session cannot clear them, only the bridge or the owner.
export const LABEL_CI_RED = labels.ciRed;
export const LABEL_BRANCH_GONE = labels.branchGone;
export const LABEL_DEPLOY_FAILED = labels.deployFailed;
export const SYSTEM_LABELS = [LABEL_CI_RED, LABEL_BRANCH_GONE, LABEL_DEPLOY_FAILED];

// owner: the task's person or one of their non-cloud devices. claimant: the session holding the claim (claim_session).
// session: any other member. github and system are the bridge itself (the webhook; sweeps, releases and kills).
export type Actor = "owner" | "claimant" | "session" | "github" | "system";
type Rule = { from: string[]; to: string; by: Actor[]; needs?: (after: Task, by: Actor[]) => string | null };

const exempt = (t: Task) => t.labels.some((l) => EXEMPT_LABELS.includes(l.toLowerCase()));
const WORKING = ["claimed", "in_progress", "blocked", "review"];

export const TRANSITIONS: Rule[] = [
  // Only through the claim path (state "claim"): warm checks, the take-over guard and a stamped claim_session.
  { from: OPEN_STATES, to: "claimed", by: ["owner", "claimant", "session", "system"] },
  { from: ["claimed", "blocked", "review"], to: "in_progress", by: ["claimant", "owner", "github"] },
  { from: ["ready", "claimed", "in_progress", "blocked"], to: "review", by: ["github", "claimant", "owner"],
    needs: (t, by) => by.includes("github") || by.includes("owner") || t.pr_url ? null : "set pr_url first: review means a PR is up" },
  { from: WORKING, to: "ready", by: ["claimant", "owner", "github", "system"] },
  { from: OPEN_STATES, to: "blocked", by: ["claimant", "owner"] },
  { from: OPEN_STATES, to: "in_progress", by: ["owner"] },
  { from: OPEN_STATES, to: "backlog", by: ["owner"] },
  { from: OPEN_STATES, to: "ready", by: ["owner"] },
  // done is the merge. The owner closes by hand only a task that never has a PR (an exempt label) or whose merge is recorded.
  { from: OPEN_STATES, to: "done", by: ["github", "owner"],
    needs: (t, by) => by.includes("github") || t.merged_sha || (by.includes("owner") && exempt(t)) ? null : `done comes from the merge of its PR; only the owner closes a task by hand, and only one labelled ${EXEMPT_LABELS.join(", ")}` },
  { from: [...OPEN_STATES, "done"], to: "dropped", by: ["owner"] },
  { from: ["done", "dropped"], to: "ready", by: ["owner"] },
  { from: ["done", "dropped"], to: "backlog", by: ["owner"] },
];

// A person's cloud member itself (alice-cloud), not one of its sessions: nothing heartbeats it, so it never holds a claim.
export const CLOUD_PARENT_CLAIM = `assign it (state ready, assignee ${deploymentDefaults.exampleCloud}) and the bridge fires a session; a claim belongs to a session`;

export function rolesOf(caller: string, task: Pick<Task, "owner" | "claim_session">, members: string[]): Actor[] {
  if (caller === "github" || caller === "system") return [caller];
  const roles: Actor[] = ["session"];
  if (task.claim_session === caller) roles.push("claimant");
  if (!isCloud(caller) && (personOf(caller, members) ?? caller) === task.owner) roles.push("owner");
  return roles;
}

// Why `by` may not move `task` to `to` with `fields` applied, or null when it may.
export function refusal(task: Task, to: string, by: Actor[], fields: Record<string, unknown> = {}, claim = false): string | null {
  if (task.kind === "epic") return epicRefusal(task, to, by);
  if (to === "claimed" && !claim) return `use state "claim" to take ${task.key}; claimed is set only by a claim`;
  if (to === "claimed" && !OPEN_STATES.includes(task.state)) return `${task.key} is ${task.state}; a closed task is not claimed. The owner reopens it first (state ready)`;
  const rules = TRANSITIONS.filter((r) => r.to === to && r.from.includes(task.state));
  const allowed = rules.filter((r) => r.by.some((a) => by.includes(a)));
  if (allowed.length === 0) {
    const who = [...new Set(rules.flatMap((r) => r.by))];
    const done = to === "done" ? " Done comes from the merge of its PR; report finished work with task_done." : "";
    const claim = OPEN_STATES.includes(task.state) && !by.includes("claimant") && !by.includes("owner") ? " Claim it first (task_update state claim), then report." : "";
    const hint = done + claim;
    return `${task.key} cannot go from ${task.state} to ${to} as ${by.filter((a) => a !== "session").join("/") || "a session that does not hold it"}${who.length ? ` (allowed: ${who.join(", ")})` : " (no such move)"}.${hint}`;
  }
  const after = { ...task, ...fields } as Task;
  const whys = allowed.map((r) => r.needs?.(after, by) ?? null);
  return whys.includes(null) ? null : `${task.key} cannot go to ${to}: ${whys[0]}.`;
}

// The one state writer: check the move, then write state with `fields` in one update. A child's move re-derives its epic.
export function transition(sql: SqlStorage, task: Task, to: string, by: Actor[], fields: Record<string, unknown> = {}, opts: { claim?: boolean; at?: string } = {}): void {
  const why = refusal(task, to, by, fields, opts.claim);
  if (why) throw new BridgeError(why);
  writeTask(sql, task.id, { ...fields, state: to }, opts.at);
  if (task.parent) rollupEpic(sql, task.parent);
  if ("parent" in fields && fields.parent && fields.parent !== task.parent) rollupEpic(sql, String(fields.parent));
}

// T-53 epics. An epic is never claimed and nobody moves it by hand, except the owner dropping (or reopening) it; the
// bridge ("system") moves it to the state its children add up to.
const EPIC_STATES = ["ready", "review", "blocked", "done"];
function epicRefusal(task: Task, to: string, by: Actor[]): string | null {
  if (to === "claimed") return `${task.key} is an epic: claim a child task instead (task_list shows them under it)`;
  if (by.includes("system") && EPIC_STATES.includes(to)) return null;
  if (by.includes("owner") && (to === "dropped" || (task.state === "dropped" && to === "ready"))) return null;
  return `${task.key} is an epic: its state follows its children; only its owner drops it (or reopens a dropped one)`;
}

// What the children of `parentKey` add up to. A dropped child does not count.
export function rollupOf(sql: SqlStorage, parentKey: string): Rollup {
  const rows = sql.exec<{ state: string; labels: string; orphaned_at: number | null; deploy_state: string | null }>(
    "SELECT state, labels, orphaned_at, deploy_state FROM tasks WHERE parent = ? AND state != 'dropped'", parentKey,
  ).toArray();
  const r: Rollup = { total: rows.length, done: 0, review: 0, blocked: 0, orphaned: 0, ci_red: 0, deploy: {} };
  for (const c of rows) {
    if (c.state === "done") r.done++;
    if (c.state === "review") r.review++;
    if (c.state === "blocked") r.blocked++;
    if (c.orphaned_at !== null && c.state !== "done") r.orphaned++;
    if (c.labels.includes(`"${LABEL_CI_RED}"`)) r.ci_red++;
    if (c.deploy_state) r.deploy[c.deploy_state] = (r.deploy[c.deploy_state] ?? 0) + 1;
  }
  return r;
}

// blocked if any child is blocked or orphaned; done when all are done; review when all are in review or done; else
// ready. Null with no counted children (the epic keeps what it has).
export function epicState(r: Rollup): string | null {
  if (r.total === 0) return null;
  if (r.blocked > 0 || r.orphaned > 0) return "blocked";
  if (r.done === r.total) return "done";
  if (r.done + r.review === r.total) return "review";
  return "ready";
}

// Re-derive one epic's state: called by transition() on every child move, and by changeTask when a parent or kind
// changes. A dropped epic stays dropped. Done/reopen stamp closed_at like any close.
export function rollupEpic(sql: SqlStorage, parentKey: string): void {
  const row = sql.exec<Omit<Task, "labels"> & { labels: string }>("SELECT * FROM tasks WHERE key = ?", parentKey).toArray()[0];
  if (!row || row.kind !== "epic" || row.state === "dropped") return;
  const to = epicState(rollupOf(sql, parentKey));
  if (!to || to === row.state) return;
  const now = new Date().toISOString();
  const closed = to === "done" ? { closed_at: now, closed_by: "system" } : row.closed_at ? { closed_at: null, closed_by: null } : {};
  transition(sql, { ...row, labels: [] }, to, ["system"], closed, { at: now });
  // The same event kinds changeTask uses for a close, a reopen and a plain move.
  const kind = to === "done" ? "closed" : row.closed_at ? "reopened" : "state";
  taskEvent(sql, row.id, "system", kind, { state: to, from_state: row.state, reason: "epic rollup", ...closed });
}

// A task's event is a row of the single record (hub/events.ts); task_events is the view that reads them back.
export function taskEvent(sql: SqlStorage, taskId: number, by: string, kind: string, data: Record<string, unknown>): number {
  return appendEvent(sql, "task", taskId, by, kind, data);
}

// Any other task write: version and updated_at move with it.
export function writeTask(sql: SqlStorage, id: number, fields: Record<string, unknown>, at = new Date().toISOString()): void {
  const keys = Object.keys(fields);
  sql.exec(
    `UPDATE tasks SET ${keys.map((k) => `${k} = ?, `).join("")}version = version + 1, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => (Array.isArray(fields[k]) ? JSON.stringify(fields[k]) : fields[k])), at, id,
  );
}
