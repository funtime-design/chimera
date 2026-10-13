import { BridgeError } from "./validate.ts";

// The single record (T-52). Every fact the bridge learns is one append-only row in `events`: what happened to a task, a
// session, a routine fire, or an error a session ran into. Rows are never updated or deleted. The summary columns
// (tasks.state, cloud_fires.fault, task_claims.end_reason, ...) are written after their event, by the code that appends
// it; views (task_get, bridge_faults, bridge_sessions) read those columns or the events, and never write.
// task_events, the old per-task log, is now a view over the task rows of `events`.

// "device": permission changes (hub/trust.ts); "deployment": recorded post-deploy contract checks.
export type SubjectKind = "task" | "session" | "fire" | "error" | "device" | "deployment";
export type EventRow = { id: number; at: string; subject_kind: SubjectKind; subject_id: string; actor: string; kind: string; data: Record<string, unknown> };

const MAX_ERROR_TEXT = 500;

// `transaction` (ctx.storage.transactionSync in the Hub) wraps the one-time migration, so a copy is never half done.
export function initEvents(sql: SqlStorage, transaction: (fn: () => void) => void = (fn) => fn()): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_subject ON events(subject_kind, subject_id, id);
    CREATE INDEX IF NOT EXISTS events_actor ON events(actor, kind, id);
    DROP INDEX IF EXISTS events_task;
  `);
  // Errors' summary (Layer 2): one row per distinct error, written right after each of its events. `key` is the hash of
  // the normalised command and outcome, so repeats find their row by index; open errors are the rows not resolved.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS errors (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      outcome TEXT NOT NULL,
      count INTEGER NOT NULL,
      logged_by TEXT NOT NULL,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      last_by TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolve_note TEXT
    );
    CREATE INDEX IF NOT EXISTS errors_open ON errors(last_at) WHERE resolved_at IS NULL;
  `);
  // A hub from before the record kept task_events as its own table: its rows are copied in, in order, once, and the old
  // table is renamed (not dropped) so the copy never runs twice and nothing is lost.
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events'").toArray().length > 0) {
    transaction(() => {
      sql.exec(
        `INSERT INTO events (at, subject_kind, subject_id, actor, kind, data)
         SELECT at, 'task', CAST(task_id AS TEXT), by, kind, data FROM task_events ORDER BY id`,
      );
      sql.exec("DROP INDEX IF EXISTS task_events_task");
      // A leftover task_events_v1 (an earlier, interrupted try): an empty one goes; one with rows keeps its name and this
      // copy is kept beside it.
      const old = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'task_events_v1'").one().n > 0;
      if (old && sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_events_v1").one().n === 0) sql.exec("DROP TABLE task_events_v1");
      const taken = old && sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events_v1'").toArray().length > 0;
      sql.exec(`ALTER TABLE task_events RENAME TO ${taken ? `task_events_v1_${Date.now()}` : "task_events_v1"}`);
    });
  }
  sql.exec(`CREATE VIEW IF NOT EXISTS task_events AS
    SELECT id, CAST(subject_id AS INTEGER) AS task_id, at, actor AS by, kind, data FROM events WHERE subject_kind = 'task'`);
  // A safety net for code that still inserts into task_events: the row lands in events.
  sql.exec(`CREATE TRIGGER IF NOT EXISTS task_events_insert INSTEAD OF INSERT ON task_events BEGIN
    INSERT INTO events (at, subject_kind, subject_id, actor, kind, data)
    VALUES (COALESCE(NEW.at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 'task', CAST(NEW.task_id AS TEXT), NEW.by, NEW.kind, COALESCE(NEW.data, '{}'));
  END`);
}

export function appendEvent(sql: SqlStorage, subject: SubjectKind, subjectId: string | number, actor: string, kind: string, data: Record<string, unknown> = {}): number {
  return sql.exec<{ id: number }>(
    "INSERT INTO events (at, subject_kind, subject_id, actor, kind, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    new Date().toISOString(), subject, String(subjectId), actor, kind, JSON.stringify(data),
  ).one().id;
}

// The events of one subject, oldest first. `limit` keeps the newest that many; none keeps all.
export function eventsOf(sql: SqlStorage, subject: SubjectKind, subjectId: string | number, limit?: number): { events: EventRow[]; total: number } {
  const id = String(subjectId);
  const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE subject_kind = ? AND subject_id = ?", subject, id).one().n;
  const rows = sql.exec<Omit<EventRow, "data"> & { data: string }>(
    "SELECT * FROM events WHERE subject_kind = ? AND subject_id = ? ORDER BY id DESC LIMIT ?", subject, id, limit && limit > 0 ? limit : -1,
  ).toArray().reverse();
  return { events: rows.map((e) => ({ ...e, data: parseObject(e.data) })), total };
}

// The last report a session (by its bridge name) made, for bridge_sessions' ended rows.
export type ReportPointer = { event_id: number; message_id: number | null; verdict: string; task_id: number };
export function lastReport(sql: SqlStorage, actor: string): ReportPointer | null {
  const row = sql.exec<{ id: number; subject_id: string; data: string }>(
    "SELECT id, subject_id, data FROM events WHERE actor = ? AND kind = 'report' ORDER BY id DESC LIMIT 1", actor,
  ).toArray()[0];
  if (!row) return null;
  const d = parseObject(row.data);
  return { event_id: row.id, message_id: typeof d.message_id === "number" ? d.message_id : null, verdict: String(d.verdict ?? ""), task_id: Number(row.subject_id) };
}

// Errors (T-39): a session logs a command that failed and what happened. The same command and outcome again is the same
// error (E-<id of its first event>), seen once more; a resolved error that comes back says who resolved it and how.
export type ErrorLogged = { id: string; count: number; previously_resolved: { by: string; at: string; note: string | null } | null };
export type OpenError = { id: string; command: string; outcome: string; count: number; first_at: string; last_at: string; last_by: string };

// Light normalisation so the same failure with a different temp path, port or hash is the same error: whitespace
// collapsed, case folded, paths down to their last part, hex runs (7+) and digit runs to one placeholder each.
export function errorKey(command: string, outcome: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ")
    .replace(/(?:[a-z]:)?(?:[\w.~-]*\/)+([\w.-]+)/g, "…/$1").replace(/\b[0-9a-f]{7,}\b/g, "#").replace(/\d+/g, "0");
  const text = `${norm(command)}\n${norm(outcome)}`;
  // FNV-1a, two 32-bit lanes: synchronous (the Durable Object call stays one turn), 64 bits is plenty for this table.
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

type ErrorRow = { id: string; count: number; logged_by: string; resolved_at: string | null; resolved_by: string | null; resolve_note: string | null };

export function logError(sql: SqlStorage, actor: string, input: { command?: unknown; outcome?: unknown }): ErrorLogged {
  const text = (v: unknown, name: string) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) throw new BridgeError(`${name} is required: ${name === "command" ? "what was run" : "what happened"}`);
    if (s.length > MAX_ERROR_TEXT) throw new BridgeError(`${name} is over ${MAX_ERROR_TEXT} characters`);
    return s;
  };
  const command = text(input.command, "command");
  const outcome = text(input.outcome, "outcome");
  const key = errorKey(command, outcome);
  const known = sql.exec<ErrorRow>("SELECT id, count, logged_by, resolved_at, resolved_by, resolve_note FROM errors WHERE key = ?", key).toArray()[0];
  if (!known) {
    // The id is the first event's own: E-<event id>.
    const first = sql.exec<{ id: number }>(
      "INSERT INTO events (at, subject_kind, subject_id, actor, kind, data) VALUES (?, 'error', '', ?, 'logged', ?) RETURNING id",
      new Date().toISOString(), actor, JSON.stringify({ command, outcome, key }),
    ).one().id;
    const id = `E-${first}`;
    sql.exec("UPDATE events SET subject_id = ? WHERE id = ?", id, first);
    const at = new Date().toISOString();
    sql.exec("INSERT INTO errors (id, key, command, outcome, count, logged_by, first_at, last_at, last_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)", id, key, command, outcome, actor, at, at, actor);
    return { id, count: 1, previously_resolved: null };
  }
  appendEvent(sql, "error", known.id, actor, "logged", { command, outcome, key });
  sql.exec("UPDATE errors SET count = count + 1, last_at = ?, last_by = ?, resolved_at = NULL WHERE id = ?", new Date().toISOString(), actor, known.id);
  const prior = known.resolved_by ? { by: known.resolved_by, at: known.resolved_at ?? "", note: known.resolve_note } : null;
  return { id: known.id, count: known.count + 1, previously_resolved: prior };
}

// Errors are bridge-wide, but only the household that logged one (the person and their devices and sessions) resolves it.
export function resolveError(sql: SqlStorage, actor: string, members: string[], id: string, note?: unknown): { id: string; already: boolean } {
  const key = `E-${String(id ?? "").trim().replace(/^e-?/i, "")}`;
  const row = sql.exec<ErrorRow>("SELECT id, count, logged_by, resolved_at, resolved_by, resolve_note FROM errors WHERE id = ?", key).toArray()[0];
  if (!row) throw new BridgeError(`error ${key} not found`);
  // A person is a member with no "<person>-" prefix; alice-laptop and alice-cloud-x7k are alice's (roster.personOf's rule;
  // not imported, as this file is loaded by Node directly in unit tests and roster.ts's imports carry no .ts).
  const person = (name: string) => { const p = name.split("-")[0]; return members.includes(p) ? p : name; };
  if (person(actor) !== person(row.logged_by)) throw new BridgeError(`${key} was logged by ${row.logged_by}; only ${person(row.logged_by)} (or their devices) can resolve it`);
  if (row.resolved_at) return { id: key, already: true };
  const text = typeof note === "string" ? note.trim().slice(0, MAX_ERROR_TEXT) : "";
  appendEvent(sql, "error", key, actor, "resolved", { note: text || null });
  sql.exec("UPDATE errors SET resolved_at = ?, resolved_by = ?, resolve_note = ? WHERE id = ?", new Date().toISOString(), actor, text || null, key);
  return { id: key, already: false };
}

// The open errors, newest first: one indexed read of the summary, no per-row subqueries.
export function openErrors(sql: SqlStorage): OpenError[] {
  return sql.exec<OpenError>(
    "SELECT id, command, outcome, count, first_at, last_at, last_by FROM errors WHERE resolved_at IS NULL ORDER BY last_at DESC LIMIT 50",
  ).toArray();
}

export function parseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// The newest event of one kind on one subject kind, or null: e.g. the last recorded contract check.
export function lastEvent(sql: SqlStorage, subject: SubjectKind, kind: string): EventRow | null {
  const row = sql.exec<Omit<EventRow, "data"> & { data: string }>("SELECT * FROM events WHERE subject_kind = ? AND kind = ? ORDER BY id DESC LIMIT 1", subject, kind).toArray()[0];
  return row ? { ...row, data: parseObject(row.data) } : null;
}
