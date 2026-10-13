import { CLOUD_PARENT_LIKE } from "../config/names";
import { WORK_THREAD_KEEP_MS } from "./settings";
import type { Waiters } from "./messages";
import { fireTag, firstOf, handBack, post } from "./messages";
import { addMissingColumns } from "./schema";
import { taskEvent } from "./tasks";
import { appendEvent, openErrors, type OpenError } from "./events";

// The durable record behind "who holds what, and did it end cleanly".
//   task_claims: one row per claim, which session (child device) took which task, when, and how it ended.
//   cloud_fires: one row per routine fire, tying the fire message to the cloud session it started (the id the
//   routines API returns) and, once that session first calls the bridge, to its child device.
// A fire whose session never calls the bridge, or a session that goes dark without ever replying, is a fault that is
// posted to the person who asked, not a clean finish. A claim released for silence leaves its task orphaned (ready
// again, with orphaned_at set) until someone claims it anew.

export function initFaults(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS task_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      session TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS task_claims_task ON task_claims(task_id, id);
    CREATE TABLE IF NOT EXISTS cloud_fires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member TEXT NOT NULL,
      requester TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      task_key TEXT,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      url TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      child TEXT,
      first_seen_at INTEGER,
      fault TEXT,
      fault_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS cloud_fires_key ON cloud_fires(member, session_key);
    CREATE INDEX IF NOT EXISTS cloud_fires_child ON cloud_fires(child);
  `);
  // Why a fire failed (fault 'fire_failed'), T-69.
  // work_thread: a fire with no task whose text is about real work (T-58, hub/workthread.ts).
  addMissingColumns(sql, "cloud_fires", { error: "TEXT", work_thread: "INTEGER NOT NULL DEFAULT 0" });
  sql.exec("CREATE INDEX IF NOT EXISTS cloud_fires_task ON cloud_fires(member, task_key)");
}

// The routines API says "session_01AB..." and a session's own id header says "cse_01AB...": the part after the prefix is shared.
export const sessionKey = (id: string): string => id.replace(/^[A-Za-z]+_/, "");

// Claims are session events first (T-52): claim_started / claim_ended on the session, then the task_claims row.
export function recordClaim(sql: SqlStorage, taskId: number, session: string): void {
  endClaim(sql, taskId, "superseded");
  appendEvent(sql, "session", session, "system", "claim_started", { task_id: taskId });
  sql.exec("INSERT INTO task_claims (task_id, session, claimed_at) VALUES (?, ?, ?)", taskId, session, Date.now());
}

export function endClaim(sql: SqlStorage, taskId: number, reason: string): void {
  for (const c of sql.exec<{ session: string }>("SELECT session FROM task_claims WHERE task_id = ? AND ended_at IS NULL", taskId).toArray()) {
    appendEvent(sql, "session", c.session, "system", "claim_ended", { task_id: taskId, reason });
  }
  sql.exec("UPDATE task_claims SET ended_at = ?, end_reason = ? WHERE task_id = ? AND ended_at IS NULL", Date.now(), reason, taskId);
}

export type Fire = { member: string; requester: string; message_id: number; thread_id: number; task_key: string | null; session_id: string; url: string };

export function recordFire(sql: SqlStorage, f: Fire): number {
  const id = sql.exec<{ id: number }>(
    "INSERT INTO cloud_fires (member, requester, message_id, thread_id, task_key, session_id, session_key, url, fired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    f.member, f.requester, f.message_id, f.thread_id, f.task_key, f.session_id, sessionKey(f.session_id), f.url, Date.now(),
  ).one().id;
  // Recorded after the routines API answered, so the session may already have called: link it now, as fired() does. Matched
  // on the session key alone: fired_at is after the child was created here.
  if (f.session_id) {
    const child = sql.exec<{ name: string; session: string }>("SELECT name, session FROM cloud_devices WHERE parent = ?", f.member)
      .toArray().find((d) => sessionKey(d.session) === sessionKey(f.session_id));
    if (child) linkSession(sql, f.member, child.session, child.name);
  }
  return id;
}

// T-69: a fire is an intent row first, written before the routines API is called, so a second send for the same task
// (or thread) finds it and joins instead of starting a second session, and a Worker that dies mid-fire leaves a row the
// sweep flags never_started. The Worker fills it in (fired) or marks it failed (fireFailed).
export type Intent = Omit<Fire, "session_id" | "url">;

export function intendFire(sql: SqlStorage, f: Intent): number {
  return sql.exec<{ id: number }>(
    "INSERT INTO cloud_fires (member, requester, message_id, thread_id, task_key, session_id, session_key, url, fired_at) VALUES (?, ?, ?, ?, ?, '', '', '', ?) RETURNING id",
    f.member, f.requester, f.message_id, f.thread_id, f.task_key, Date.now(),
  ).one().id;
}

export function fired(sql: SqlStorage, id: number, session_id: string, url: string): void {
  sql.exec("UPDATE cloud_fires SET session_id = ?, session_key = ?, url = ? WHERE id = ?", session_id, sessionKey(session_id), url, id);
  const row = sql.exec<{ member: string; fired_at: number; message_id: number }>("SELECT member, fired_at, message_id FROM cloud_fires WHERE id = ?", id).toArray()[0];
  // The message the fire carried is in the session's prompt: it, and only it (by id), is done for the parent. Nothing
  // else in the thread is acked (the "started" notice is posted as system, T-67).
  if (row?.message_id) {
    sql.exec(
      `INSERT INTO deliveries (message_id, member, claimed_at, done_at) SELECT id, recipient, ?, ? FROM messages WHERE id = ? AND recipient = ?
       ON CONFLICT(message_id, member) DO UPDATE SET done_at = COALESCE(deliveries.done_at, excluded.done_at)`,
      Date.now(), new Date().toISOString(), row.message_id, row.member,
    );
  }
  // The session may have called before the routines API answered: link it now, or linkSession never would.
  if (!row || !session_id) return;
  const child = sql.exec<{ name: string; session: string }>("SELECT name, session FROM cloud_devices WHERE parent = ? AND created_at >= ?", row.member, row.fired_at)
    .toArray().find((d) => sessionKey(d.session) === sessionKey(session_id));
  if (child) linkSession(sql, row.member, child.session, child.name);
}

// The routines API refused or failed: the failure is on record (GET /v1/faults), what waited for it is free again, and
// the requester is told in the thread. The notice is posted by "system", not the cloud parent: a post from the parent
// counts as its reply and would mark the unhandled request done (the T-67 trap).
export function fireFailed(sql: SqlStorage, waiters: Waiters, id: number, error: string): void {
  if (sql.exec("SELECT 1 FROM cloud_fires WHERE id = ? AND fault IS NULL", id).toArray().length > 0) fireEvent(sql, id, "fault", { fault: "fire_failed", error: error.slice(0, 500) });
  sql.exec("UPDATE cloud_fires SET fault = 'fire_failed', fault_at = ?, error = ? WHERE id = ? AND fault IS NULL", Date.now(), error.slice(0, 500), id);
  sql.exec("UPDATE messages SET reserved_for = NULL WHERE reserved_for = ?", fireTag(id));
  const f = sql.exec<FireRow>("SELECT * FROM cloud_fires WHERE id = ?", id).toArray()[0];
  if (!f) return;
  const subject = firstOf(sql, f.thread_id)?.subject ?? "cloud session fault";
  post(sql, waiters, f.thread_id || null, "system", f.requester, subject, `${f.member} could not start a cloud session (${error}).`, []);
}

// A fire for this parent and task (or, with no task, this thread) that a new message should join instead of firing
// again: not faulted, and either still booting (fired within `bootMs`, no session yet) or booted into a child that is
// showing life. The idempotency key is (parent, task or thread).
export function pendingFire(sql: SqlStorage, parent: string, taskKey: string | null, threadId: number | null, bootMs: number, leaseMs: number): { id: number; session_id: string; child: string | null } | null {
  if (!taskKey && !threadId) return null;
  const now = Date.now();
  return sql.exec<{ id: number; session_id: string; child: string | null }>(
    `SELECT id, session_id, child FROM cloud_fires
     WHERE member = ? AND fault IS NULL AND ${taskKey ? "task_key = ?" : "(task_key IS NULL OR work_thread = 1) AND thread_id = ?"}
       AND ((child IS NULL AND fired_at >= ?) OR child IN (SELECT name FROM cloud_devices WHERE seen_at >= ?))
     ORDER BY id DESC LIMIT 1`,
    parent, taskKey ?? threadId, now - bootMs, now - leaseMs,
  ).toArray()[0] ?? null;
}

// A session called the bridge: if a fire started it, the fire now knows its child device. Returns the task keys of the
// work-thread fires it linked whose task was attached before the session checked in (T-58): the caller claims those
// for the child (workthread.claimFor), since attaching could not.
export function linkSession(sql: SqlStorage, parent: string, session: string, child: string): string[] {
  const fires = sql.exec<{ id: number; task_key: string | null; work_thread: number }>(
    "SELECT id, task_key, work_thread FROM cloud_fires WHERE member = ? AND session_key = ? AND session_key != '' AND first_seen_at IS NULL", parent, sessionKey(session),
  ).toArray();
  for (const f of fires) {
    sql.exec("UPDATE cloud_fires SET child = ?, first_seen_at = ? WHERE id = ?", child, Date.now(), f.id);
    // What was reserved for "the session this fire starts" is this child's now.
    sql.exec("UPDATE messages SET reserved_for = ? WHERE reserved_for = ?", child, fireTag(f.id));
  }
  return fires.filter((f) => f.work_thread && f.task_key).map((f) => f.task_key!);
}

type FireRow = Fire & { id: number; session_key: string; fired_at: number; child: string | null; first_seen_at: number | null; fault: string | null; fault_at: number | null };

// A reply in the fire's thread, or in the thread of the task the fire works on (a work thread's `task: new` makes one).
export const REPLIED = "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id IN (f.thread_id, COALESCE((SELECT t.thread_id FROM tasks t WHERE t.key = f.task_key), f.thread_id)) AND m.sender = f.child AND m.id > f.message_id)";

// Flags fires that went wrong; each is flagged once. Returns the rows flagged.
export function sweepFires(sql: SqlStorage, waiters: Waiters, bootMs: number, leaseMs: number): FireRow[] {
  const now = Date.now();
  const never = sql.exec<FireRow>("SELECT f.* FROM cloud_fires f WHERE f.fault IS NULL AND f.first_seen_at IS NULL AND f.fired_at <= ?", now - bootMs).toArray();
  const died = sql.exec<FireRow>(
    `SELECT f.* FROM cloud_fires f JOIN cloud_devices d ON d.name = f.child
     WHERE f.fault IS NULL AND f.thread_id != 0 AND f.first_seen_at IS NOT NULL AND MAX(d.seen_at, COALESCE(d.process_at, 0)) < ? AND NOT ${REPLIED}`, now - leaseMs,
  ).toArray();
  const flag = (rows: FireRow[], fault: string, text: (f: FireRow) => string) => {
    for (const f of rows) {
      fireEvent(sql, f.id, "fault", { fault, session: f.session_id, child: f.child, task_key: f.task_key });
      sql.exec("UPDATE cloud_fires SET fault = ?, fault_at = ? WHERE id = ?", fault, now, f.id);
      // Nothing will come for what was reserved for this fire: it waits in the parent's inbox for any session.
      sql.exec("UPDATE messages SET reserved_for = NULL WHERE reserved_for = ?", fireTag(f.id));
      if (f.child) handBack(sql, waiters, f.child);
      const body = `FAULT ${fault}: ${text(f)}`;
      const id = f.task_key ? Number(/\d+/.exec(f.task_key)?.[0]) : NaN;
      if (Number.isFinite(id)) taskEvent(sql, id, "system", "fault", { fault, session: f.session_id, child: f.child, url: f.url });
      const subject = firstOf(sql, f.thread_id)?.subject ?? "cloud session fault";
      post(sql, waiters, f.thread_id || null, "system", f.requester, subject, body, []);
    }
  };
  flag(never, "never_started", (f) => `${f.url ? `the cloud session ${f.url} was fired` : "a cloud session was being started (the routines API never answered back)"} for message ${f.message_id} but has not called the bridge in ${Math.round(bootMs / 1000)}s. It likely failed to boot; the request was not handled. Send it again to start a fresh session.`);
  flag(died, "died_without_reply", (f) => `the cloud session ${f.url} (${f.child}) started, then went silent without replying in thread ${f.thread_id}. The request was not completed.`);
  return [...never, ...died];
}

// A child flagged died_without_reply called the bridge again: it was a long silence, not a death. The fault is lifted
// and the requester told once; nothing is fired again. never_started stays: a session that never booted cannot be back.
export function resurfaceFires(sql: SqlStorage, waiters: Waiters, child: string): void {
  const rows = sql.exec<FireRow>("SELECT * FROM cloud_fires WHERE child = ? AND fault = 'died_without_reply'", child).toArray();
  for (const f of rows) {
    fireEvent(sql, f.id, "fault_cleared", { fault: "died_without_reply", child });
    sql.exec("UPDATE cloud_fires SET fault = NULL, fault_at = NULL WHERE id = ?", f.id);
    const id = f.task_key ? Number(/\d+/.exec(f.task_key)?.[0]) : NaN;
    if (Number.isFinite(id)) taskEvent(sql, id, "system", "resurfaced", { session: child, fire: f.session_id });
    const subject = firstOf(sql, f.thread_id)?.subject ?? "cloud session fault";
    post(sql, waiters, f.thread_id || null, "system", f.requester, subject, `session ${child} is back; the earlier died_without_reply notice was a long silence, work continues.`, []);
  }
}

// A killed child's fires are settled: the kill is its own record, so the sweep must not later call it a silent death.
export function markKilled(sql: SqlStorage, child: string): void {
  for (const f of sql.exec<{ id: number }>("SELECT id FROM cloud_fires WHERE child = ? AND fault IS NULL", child).toArray()) fireEvent(sql, f.id, "fault", { fault: "killed", child });
  sql.exec("UPDATE cloud_fires SET fault = 'killed', fault_at = ? WHERE child = ? AND fault IS NULL", Date.now(), child);
}

// The thread the routine fire for this child started from, newest fire first.
export function fireOf(sql: SqlStorage, child: string): { thread_id: number; requester: string } | null {
  return sql.exec<{ thread_id: number; requester: string }>("SELECT thread_id, requester FROM cloud_fires WHERE child = ? ORDER BY id DESC LIMIT 1", child).toArray()[0] ?? null;
}

// Is there something a sweep still has to judge? The alarm keeps running while so.
export function openWork(sql: SqlStorage): boolean {
  const claims = sql.exec("SELECT 1 FROM tasks t JOIN cloud_devices c ON c.name = t.claim_session WHERE t.state IN ('claimed', 'in_progress', 'blocked') LIMIT 1").toArray();
  if (claims.length > 0) return true;
  if (sql.exec("SELECT 1 FROM tasks WHERE deploy_state = 'pending' LIMIT 1").toArray().length > 0) return true;
  // A reviewer reservation whose dispatch has not reported back yet (hub/github.ts sweepReviews).
  if (sql.exec("SELECT 1 FROM review_fires WHERE session_id IS NULL LIMIT 1").toArray().length > 0) return true;
  // A message not done that is reserved for a fire or a cloud session, or routed to a cloud session: the sweep must keep
  // running until it is delivered or handed back (messages.handBackDead), or it stays hidden when that session dies.
  if (sql.exec(
    `SELECT 1 FROM messages m WHERE (m.reserved_for LIKE '(fire %'
       OR m.reserved_for IN (SELECT name FROM cloud_devices WHERE parent LIKE ?)
       OR m.recipient IN (SELECT name FROM cloud_devices WHERE parent LIKE ? AND parent != m.sender))
     AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.done_at IS NOT NULL) LIMIT 1`, CLOUD_PARENT_LIKE, CLOUD_PARENT_LIKE,
  ).toArray().length > 0) return true;
  // A threadless fire (fire_routine with no thread) is judged only on booting: once linked, nothing is left to wait for.
  return sql.exec(`SELECT 1 FROM cloud_fires f WHERE f.fault IS NULL AND NOT (f.thread_id = 0 AND f.first_seen_at IS NOT NULL) AND NOT ${REPLIED} LIMIT 1`).toArray().length > 0;
}

// A fire's fault (or its clearing) is an event on the fire before cloud_fires.fault is set (T-52).
function fireEvent(sql: SqlStorage, id: number, kind: string, data: Record<string, unknown>): void {
  appendEvent(sql, "fire", id, "system", kind, data);
}

export type Faults = {
  orphaned_tasks: { key: string; title: string; owner: string; state: string; orphaned_at: number; orphaned_from: string; reason: string | null }[];
  fires: { session_id: string; url: string; child: string | null; thread_id: number; task_key: string | null; fault: string; fault_at: number; error: string | null }[];
  errors: OpenError[];
  // Fires of the last 24 h flagged as work with no task (T-58); task_key is set once a reply attached one.
  work_threads: { thread_id: number; member: string; requester: string; child: string | null; session_id: string; task_key: string | null; fired_at: number }[];
};

export function faults(sql: SqlStorage): Faults {
  return {
    errors: openErrors(sql),
    orphaned_tasks: sql.exec<Faults["orphaned_tasks"][number]>(
      "SELECT key, title, owner, state, orphaned_at, orphaned_from, orphan_reason AS reason FROM tasks WHERE orphaned_at IS NOT NULL ORDER BY orphaned_at DESC LIMIT 50",
    ).toArray(),
    fires: sql.exec<Faults["fires"][number]>(
      "SELECT session_id, url, child, thread_id, task_key, fault, fault_at, error FROM cloud_fires WHERE fault IS NOT NULL ORDER BY fault_at DESC LIMIT 50",
    ).toArray(),
    work_threads: sql.exec<Faults["work_threads"][number]>(
      "SELECT thread_id, member, requester, child, session_id, task_key, fired_at FROM cloud_fires WHERE work_thread = 1 AND fired_at >= ? ORDER BY id DESC LIMIT 50",
      Date.now() - WORK_THREAD_KEEP_MS,
    ).toArray(),
  };
}

export type ClaimRecord = { session: string; claimed_at: number; ended_at: number | null; end_reason: string | null };

// Every claim a task has had, newest first: which session held it, and how that ended.
export function claimsOf(sql: SqlStorage, taskId: number): ClaimRecord[] {
  return sql.exec<ClaimRecord>("SELECT session, claimed_at, ended_at, end_reason FROM task_claims WHERE task_id = ? ORDER BY id DESC LIMIT 10", taskId).toArray();
}
