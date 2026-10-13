import { CLOUD_PARENT_LIKE } from "../config/names";
import type { Task } from "./schema";
import { stampClaim, taskById, taskEvent } from "./tasks";
import { transition, writeTask } from "./state";
import { endClaim } from "./faults";
import { firstOf, handBack, post, type Waiters } from "./messages";

// Per-claim liveness. A task claimed by a cloud session is stamped with that session's child name (tasks.claim_session).
// Whether that session is alive is judged from several independent signals on its cloud_devices row (see liveness()),
// never from one: a single "seen" stamp kept a finished, idle session looking live and swallowed work (T-28).
// A working claim (claimed, in_progress, blocked) whose session is dead (no signal of any kind for the lease) is
// released, and a new message for the task fires a fresh session instead of waiting in a dead inbox. An idle session
// (process alive, agent not acting) keeps its claims but is not live for routing. A claim in review is not released:
// the PR holds the work and a quiet session is the normal end; a push moves it back to in_progress, and from then on the
// same rule applies. tasks.claim_beat_at is the "last heartbeat" shown on a task; it is not the lease. Only claims of
// cloud children expire.

const WORKING = "('claimed', 'in_progress', 'blocked')";

// The signals, one column each on cloud_devices: tool (PostToolUse hook), call (any other identified call), poll (an
// inbox read), process (the in-run heartbeat loop: the process lives, nothing more). seen_at is the latest of tool,
// call and poll; it is 0 once the session posted offline or was killed.
export type Signals = { tool_at: number | null; call_at: number | null; poll_at: number | null; process_at: number | null; seen_at: number; killed_at?: number | null };
export type Verdict = "working" | "idle" | "dead";
export const SIGNALS = "c.tool_at, c.call_at, c.poll_at, c.process_at, c.seen_at, c.killed_at";

// working: the agent acted within the lease (a tool ran, or it called the bridge). idle: only its inbox reads or its
// process are fresh (alive, not acting). dead: nothing within the lease, or it posted offline or was killed.
export function liveness(d: Signals, leaseMs: number, now = Date.now()): Verdict {
  if (d.killed_at || d.seen_at === 0) return "dead";
  const fresh = (t: number | null) => t !== null && t >= now - leaseMs;
  // A row from before the signal columns has only seen_at.
  if (d.tool_at === null && d.call_at === null && d.poll_at === null && d.process_at === null) return fresh(d.seen_at) ? "working" : "dead";
  if (fresh(d.tool_at) || fresh(d.call_at)) return "working";
  return fresh(d.poll_at) || fresh(d.process_at) ? "idle" : "dead";
}

// For bridge_sessions: the verdict and which signals are fresh, e.g. "working: tool 12s, poll 3s".
export function describe(d: Signals, leaseMs: number, now = Date.now()): string {
  const ago = (t: number) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`; };
  const parts = (["tool", "call", "poll", "process"] as const).flatMap((k) => { const t = d[`${k}_at`]; return t ? [`${k} ${ago(t)}`] : []; });
  return `${liveness(d, leaseMs, now)}: ${parts.join(", ") || "no signals"}`;
}

export function signalsOf(sql: SqlStorage, child: string): (Signals & { parent: string }) | null {
  return sql.exec<Signals & { parent: string }>(`SELECT c.parent, ${SIGNALS} FROM cloud_devices c WHERE c.name = ?`, child).toArray()[0] ?? null;
}

// The session is alive: refresh the shown heartbeat of every open claim it holds, review included.
export function beat(sql: SqlStorage, session: string): void {
  sql.exec("UPDATE tasks SET claim_beat_at = ? WHERE claim_session = ? AND state NOT IN ('done', 'dropped')", Date.now(), session);
}

// The session is gone (it posted offline): let go of its claims now, without waiting out the lease.
export function releaseSession(sql: SqlStorage, waiters: Waiters, session: string): string[] {
  return release(sql, waiters, "t.claim_session = ?", session, "session ended");
}

// The owner killed the session: let go of its working claims now, with the kill as the recorded reason.
export function releaseKilled(sql: SqlStorage, waiters: Waiters, session: string, by: string): string[] {
  return release(sql, waiters, "t.claim_session = ?", session, `killed by ${by}`);
}

// Releases every claim whose cloud session is dead (no signal of any kind, its process included, for `leaseMs`; see
// liveness()). Idle is not released. Returns the keys released. Only children of a <person>-cloud parent: a Mac session
// (a child of alice-laptop) can sit idle for an hour with the work still open in front of a person, so silence there is
// not death.
export function releaseStale(sql: SqlStorage, waiters: Waiters, leaseMs: number): string[] {
  return release(sql, waiters, "c.parent LIKE ? AND MAX(c.seen_at, COALESCE(c.process_at, 0)) < ?", [CLOUD_PARENT_LIKE, Date.now() - leaseMs], "no heartbeat");
}

// A released task goes back to ready, assigned to the session's parent (alice-cloud) so any new session can claim it,
// with an event saying why. It is also marked orphaned and its owner is told, so a lost claim is a visible fault.
// Any release keeps the branch and pr_url: the release can be false (one long tool call starves the heartbeat) and the
// PR still live; a cloud branch carries no T-NN, so pr_url is the only way its merge finds the task. Only close, drop
// and reopen clear them (tasks.ts changeTask).
// A blocked claim is released (with the fault) only for silence; a session that posts offline or is killed while its
// task is blocked is parked legitimately, waiting on a person, so the claim is dropped quietly and the state kept.
function release(sql: SqlStorage, waiters: Waiters, condition: string, param: string | number | (string | number)[], reason: string): string[] {
  type Row = { id: number; key: string; claim_session: string; parent: string; state: string; owner: string; title: string; thread_id: number };
  const all = sql.exec<Row>(
    `SELECT t.id, t.key, t.claim_session, c.parent, t.state, t.owner, t.title, t.thread_id FROM tasks t JOIN cloud_devices c ON c.name = t.claim_session
     WHERE t.state IN ${WORKING} AND ${condition}`, ...(Array.isArray(param) ? param : [param]),
  ).toArray();
  const silence = reason === "no heartbeat";
  const rows = all.filter((r) => silence || r.state !== "blocked");
  for (const r of all.filter((x) => !rows.includes(x))) {
    writeTask(sql, r.id, { claim_session: null, claim_beat_at: null });
    endClaim(sql, r.id, reason);
    taskEvent(sql, r.id, "system", "released", { from_state: r.state, was: r.claim_session, reason });
  }
  // What was routed or reserved to this session and not finished goes back to its parent's inbox (T-50).
  for (const s of new Set(all.map((r) => r.claim_session))) handBack(sql, waiters, s);
  for (const r of rows) {
    // One clock for orphaned_at and updated_at: resurface reads "updated_at still equals orphaned_at" as untouched since.
    const at = Date.now();
    const now = new Date(at).toISOString();
    transition(sql, taskById(sql, r.id), "ready", ["system"],
      { assignee: r.parent, claim_session: null, claim_beat_at: null, orphaned_at: at, orphaned_from: r.claim_session, orphan_reason: reason }, { at: now });
    endClaim(sql, r.id, `orphaned: ${reason}`);
    taskEvent(sql, r.id, "system", "released", { from_state: r.state, was: r.claim_session, reason });
    taskEvent(sql, r.id, "system", "orphaned", { was: r.claim_session, reason });
    const batch = rows.filter((x) => x.claim_session === r.claim_session && x.owner === r.owner);
    if (batch.length > 1) continue; // told once for the whole batch below
    const subject = firstOf(sql, r.thread_id)?.subject ?? `Task ${r.key}: ${r.title}`;
    post(sql, waiters, r.thread_id || null, "system", r.owner, subject,
      `FAULT orphaned: ${r.key} was ${r.state} by ${r.claim_session}, ${reason.startsWith("killed by ") ? `was ${reason}` : `went silent (${reason})`}. It is back to ready, assigned to ${r.parent}. Nothing is finished; claim it again or send it to a session.`, []);
  }
  // A session that held several tasks drops them all at once: one fault message names every key, not one per task.
  const batches = new Map<string, typeof rows>();
  for (const r of rows) batches.set(`${r.claim_session}\n${r.owner}`, [...(batches.get(`${r.claim_session}\n${r.owner}`) ?? []), r]);
  for (const group of batches.values()) {
    if (group.length < 2) continue;
    const g = group[0];
    post(sql, waiters, null, "system", g.owner, `FAULT orphaned: ${g.claim_session} dropped ${group.length} tasks`,
      `FAULT orphaned: ${g.claim_session} went silent (${reason}) while holding ${group.map((x) => `${x.key} (${x.state})`).join(", ")}. All are back to ready, assigned to ${g.parent}, each marked orphaned. Nothing is finished; each can be claimed or sent on its own.`, []);
  }
  return all.map((r) => r.key);
}

// The session a silence release took a task from is back within `windowMs`: the release was false (a long tool call,
// not a death), so the claim is its own again and the orphan mark is cleared. Only a task nobody touched since: still
// ready, still assigned to the session's parent, not edited (updated_at is still the release's), orphaned from this
// very child for silence, and no replacement session fired for it since (T-69: the fresh session gets it, not the old
// one). Kills and offline releases never come back. The claim resumes as `claimed`; the session sets
// in_progress again itself. Returns the keys taken back.
export function resurface(sql: SqlStorage, waiters: Waiters, child: string, windowMs: number): string[] {
  const rows = sql.exec<{ id: number; key: string; title: string; owner: string; thread_id: number; orphaned_at: number; updated_at: string }>(
    `SELECT id, key, title, owner, thread_id, orphaned_at, updated_at FROM tasks
     WHERE orphaned_from = ? AND orphan_reason = 'no heartbeat' AND orphaned_at >= ? AND state = 'ready' AND claim_session IS NULL
       AND assignee = (SELECT parent FROM cloud_devices WHERE name = ?)
       AND NOT EXISTS (SELECT 1 FROM cloud_fires f WHERE f.task_key = tasks.key AND f.fired_at >= tasks.orphaned_at AND f.fault IS NULL)`,
    child, Date.now() - windowMs, child,
  ).toArray().filter((r) => r.updated_at === new Date(r.orphaned_at).toISOString());
  const now = new Date().toISOString();
  for (const r of rows) {
    transition(sql, taskById(sql, r.id), "claimed", ["system"],
      { assignee: child, orphaned_at: null, orphaned_from: null, orphan_reason: null }, { claim: true, at: now });
    stampClaim(sql, r.id, child);
    taskEvent(sql, r.id, "system", "resurfaced", { session: child });
    const subject = firstOf(sql, r.thread_id)?.subject ?? `Task ${r.key}: ${r.title}`;
    post(sql, waiters, r.thread_id || null, "system", r.owner, subject,
      `session ${child} is back; the earlier orphan notice for ${r.key} was a long silence, work continues (claim restored as claimed).`, []);
  }
  return rows.map((r) => r.key);
}

// Is some session of this cloud parent showing life? Used for messages that name no claimed task.
export function liveChild(sql: SqlStorage, parent: string, leaseMs: number): string | null {
  return sql.exec<{ name: string }>("SELECT name FROM cloud_devices WHERE parent = ? AND seen_at >= ? ORDER BY seen_at DESC LIMIT 1", parent, Date.now() - leaseMs).toArray()[0]?.name ?? null;
}

// Is anyone working this task? true / false when its claim settles it, null when it was never claimed (the caller
// then asks whether any session is free to pick it up). A child-held claim is live while its session is working
// (liveness()), whatever the claim's state. A claim by a session with no child name (no session id
// sent) has no heartbeat: its poll or post within `onlineMs` is all there is.
// A task whose last claim was released for silence is false, whoever else is around: its worker is gone.
export function claimantLive(sql: SqlStorage, task: Task, leaseMs: number, onlineMs: number): boolean | null {
  if (task.state === "done" || task.state === "dropped") return false;
  if (!task.claim_session) {
    const last = sql.exec<{ kind: string }>("SELECT kind FROM task_events WHERE task_id = ? AND kind IN ('claimed', 'released') ORDER BY id DESC LIMIT 1", task.id).toArray()[0];
    return last?.kind === "released" ? false : null;
  }
  const child = signalsOf(sql, task.claim_session);
  if (!child) return seenWithin(sql, task.claim_session, onlineMs);
  // Only a session that is acting counts: an idle one (process alive, nothing done for a lease) would leave a message
  // routed to it unread.
  return liveness(child, leaseMs) === "working";
}

export function seenWithin(sql: SqlStorage, member: string, ms: number): boolean {
  return sql.exec("SELECT 1 FROM status WHERE member = ? AND seen_at >= ?", member, Date.now() - ms).toArray().length > 0;
}
