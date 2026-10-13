import { deploymentDefaults } from "../deployment";
import type { SessionInput, SessionLine, SessionRow } from "./schema";
import { MAX_SESSION_LINE, SESSION_LOG_LINES, SESSION_TTL_MS } from "./schema";
import { REPLIED, sessionKey } from "./faults";
import { personOf } from "./roster";
import { BridgeError } from "./validate";
import { SIGNALS, describe, type Signals } from "./claims";
import { lastReport, type ReportPointer } from "./events";

// A session is one Claude Code (or other) session of a person: a lane on the board with its own short log, posted by a
// hook after every turn. A line is what the session just did or said, one short sentence.
export function sessionPost(sql: SqlStorage, member: string, input: SessionInput): SessionRow {
  const session = (input.session ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(session)) throw new BridgeError(`session is required: a short id such as ${deploymentDefaults.name}-7fe16185`);
  const line = (input.line ?? "").trim().replace(/\s+/g, " ");
  if (line.length > MAX_SESSION_LINE) throw new BridgeError(`line is over ${MAX_SESSION_LINE} characters`);
  const title = (input.title ?? "").trim().slice(0, 200);
  const cwd = (input.cwd ?? "").trim().slice(0, 300);
  const now = Date.now();
  sql.exec(
    `INSERT INTO sessions (member, session, title, cwd, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(member, session) DO UPDATE SET title = COALESCE(NULLIF(excluded.title, ''), sessions.title),
       cwd = COALESCE(NULLIF(excluded.cwd, ''), sessions.cwd), updated_at = excluded.updated_at`,
    member, session, title || null, cwd || null, now,
  );
  // A lane stamped by touch() (no lines) under another name is this same session: the posted lane replaces it.
  sql.exec(
    "DELETE FROM sessions WHERE session = ?1 AND member != ?2 AND NOT EXISTS (SELECT 1 FROM session_lines l WHERE l.member = sessions.member AND l.session = sessions.session)",
    session, member,
  );
  if (line) {
    sql.exec("INSERT INTO session_lines (member, session, at, line) VALUES (?, ?, ?, ?)", member, session, now, line);
    // Only the last SESSION_LOG_LINES lines stay; the log is a glance, not a transcript.
    sql.exec(
      `DELETE FROM session_lines WHERE member = ?1 AND session = ?2 AND id NOT IN
         (SELECT id FROM session_lines WHERE member = ?1 AND session = ?2 ORDER BY id DESC LIMIT ?3)`,
      member, session, SESSION_LOG_LINES,
    );
  }
  return sessionRow(sql, member, session)!;
}

function sessionRow(sql: SqlStorage, member: string, session: string): SessionRow | undefined {
  return sql.exec<SessionRow>(
    `SELECT s.member, s.session, s.title, s.cwd, s.started_at, s.updated_at,
            (SELECT line FROM session_lines l WHERE l.member = s.member AND l.session = s.session ORDER BY id DESC LIMIT 1) AS last_line
     FROM sessions s WHERE s.member = ? AND s.session = ?`,
    member, session,
  ).toArray()[0];
}

// A cloud child proves it is alive by calling the bridge (Hub.identify): that stamps its lane here, so a session that
// makes bridge calls but posts no lines still shows on the board. If the session already has a lane (under any member,
// as the per-turn hook posts it; a later post replaces a lane that has no lines), that lane is stamped; a new one is made only when there is none, so a session is never
// listed twice. No line is added: lines are what a session says. Liveness for the lease is cloud_devices.seen_at (see sessions()).
export function touch(sql: SqlStorage, child: string, session: string, context: string | null): void {
  const now = Date.now();
  const stamped = sql.exec("UPDATE sessions SET updated_at = ? WHERE session = ?", now, session).rowsWritten;
  if (stamped > 0) return;
  sql.exec(
    "INSERT INTO sessions (member, session, title, cwd, started_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
    child, session, context || null, now,
  );
}

// Every live session, newest first. A session silent for SESSION_TTL_MS has ended as far as the board is concerned.
// A session that is a cloud child (cloud_devices.session) is judged by the same clock as its claims: it is live while
// the child was seen within `leaseMs`, so one gone silent (or wound down) drops off without waiting out the TTL.
// `member` narrows the board through rowsFor: a person, a device or a child, whichever name the lines were posted under.
export function sessions(sql: SqlStorage, leaseMs: number, members: string[], member?: string): SessionRow[] {
  const now = Date.now();
  // Not dead: any signal within the lease, the process loop included (claims.liveness). Each child row says its verdict
  // and which signals are fresh, e.g. "working: tool 12s, poll 3s" or "idle: process 40s, tool 9m".
  const alive = "s.killed_at IS NULL AND s.updated_at >= ?1 AND NOT EXISTS (SELECT 1 FROM cloud_devices c WHERE c.session = s.session AND (c.seen_at = 0 OR MAX(c.seen_at, COALESCE(c.process_at, 0)) < ?2))";
  let rows = sql.exec<SessionRow>(sessionsQuery(`WHERE ${alive}`), now - SESSION_TTL_MS, now - leaseMs).toArray();
  if (member) {
    const kids = rowsFor(sql, members, member);
    const names = new Set([member, ...kids.map((k) => k.name)]);
    const ids = new Set(kids.map((k) => k.session));
    rows = rows.filter((r) => names.has(r.member) || ids.has(r.session) || personOf(r.member, members) === member);
  }
  return rows.map((r) => {
    const sig = sql.exec<Signals>(`SELECT ${SIGNALS} FROM cloud_devices c WHERE c.session = ?`, r.session).toArray()[0];
    return sig ? { ...r, liveness: describe(sig, leaseMs, now) } : r;
  });
}

export type ChildRow = { name: string; parent: string; session: string; seen_at: number; killed_at: number | null; killed_by: string | null };

const childRows = (sql: SqlStorage): ChildRow[] =>
  sql.exec<ChildRow>("SELECT name, parent, session, seen_at, killed_at, killed_by FROM cloud_devices").toArray();

// One cloud child by its bridge name or session id (the same id under either routine prefix counts); undefined otherwise.
export function childFor(sql: SqlStorage, target: string, all: ChildRow[] = childRows(sql)): ChildRow | undefined {
  const t = target.trim();
  const key = sessionKey(t);
  return all.find((r) => r.name === t || r.session === t) ?? (key.length >= 8 ? all.find((r) => sessionKey(r.session) === key) : undefined);
}

// The cloud children (cloud_devices rows) a name covers. A child is itself (childFor); a device (alice-laptop, alice-cloud)
// covers its children; a person (alice) covers the children of every device of theirs (roster.personOf). The one
// resolver for bridge_sessions and kill.
export function rowsFor(sql: SqlStorage, members: string[], target: string): ChildRow[] {
  const t = target.trim();
  const all = childRows(sql);
  const self = childFor(sql, t, all);
  if (self) return [self];
  return all.filter((r) => r.parent === t || personOf(r.parent, members) === t);
}

export type EndedLane = { member: string | null; session: string | null; parent: string; child: string | null; session_id: string; fault: string | null; fired_at: number; ended_at: number | null; thread_id: number; task_key: string | null; work_thread: number; report?: ReportPointer | null };

// Fired cloud sessions that are over: flagged (never_started, died_without_reply, killed) or their child silent past the
// lease without having replied. Faults and kills rank first, so plain completions do not crowd them out.
// member/session name the lane bridge_session_log reads (null when the session never posted one).
export function ended(sql: SqlStorage, leaseMs: number, members: string[], member?: string): EndedLane[] {
  let filter = "";
  const binds: (string | number)[] = [Date.now() - leaseMs];
  if (member) {
    const children = [member, ...rowsFor(sql, members, member).map((k) => k.name)];
    const parents = sql.exec<{ member: string }>("SELECT DISTINCT member FROM cloud_fires").toArray()
      .map((r) => r.member).filter((p) => p === member || personOf(p, members) === member);
    filter = "AND (f.child IN (SELECT value FROM json_each(?2)) OR f.member IN (SELECT value FROM json_each(?3)))";
    binds.push(JSON.stringify(children), JSON.stringify(parents));
  }
  // Each ended lane carries a pointer to the session's last report (T-52), so what it said at the end is one read away.
  return sql.exec<Omit<EndedLane, "report">>(
    `SELECT (SELECT s.member FROM sessions s WHERE s.session = d.session ORDER BY s.updated_at DESC LIMIT 1) AS member,
            d.session AS session, f.member AS parent, f.child, f.session_id, f.fault, f.fired_at,
            COALESCE(f.fault_at, d.killed_at, NULLIF(d.seen_at, 0), f.fired_at) AS ended_at, f.thread_id, f.task_key, f.work_thread
     FROM cloud_fires f LEFT JOIN cloud_devices d ON d.name = f.child
     WHERE (f.fault IS NOT NULL OR d.killed_at IS NOT NULL OR ((d.seen_at = 0 OR MAX(d.seen_at, COALESCE(d.process_at, 0)) < ?1) AND NOT ${REPLIED})) ${filter}
     ORDER BY (f.fault IS NOT NULL OR d.killed_at IS NOT NULL) DESC, f.id DESC LIMIT 50`, ...binds,
  ).toArray().map((r) => ({ ...r, report: r.child ? lastReport(sql, r.child) : null }));
}

function sessionsQuery(where: string): string {
  return `SELECT s.member, s.session, s.title, s.cwd, s.started_at, s.updated_at,
            (SELECT line FROM session_lines l WHERE l.member = s.member AND l.session = s.session ORDER BY id DESC LIMIT 1) AS last_line
          FROM sessions s ${where} ORDER BY s.updated_at DESC`;
}

export function sessionLog(sql: SqlStorage, member: string, session: string): { session: SessionRow; lines: SessionLine[] } {
  const row = sessionRow(sql, member, session);
  if (!row) throw new BridgeError(`session ${member}/${session} not found`);
  const lines = sql.exec<SessionLine>("SELECT id, at, line FROM session_lines WHERE member = ? AND session = ? ORDER BY id", member, session).toArray();
  return { session: row, lines };
}
