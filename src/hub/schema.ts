// Explicit .ts: validate.ts, and so this file, is imported by Node directly in the unit tests (test/registered.test.mjs).
import { initEvents } from "./events.ts";

export const MAX_BODY = 64 * 1024;
export const INBOX_LIMIT = 50;
export const MAX_THREAD_MESSAGES = 20;
export const MAX_SUMMARY = 500;
export const MAX_TASK_TITLE = 200;
export const TASK_LIST_LIMIT = 200;

// Tasks: a backlog per person that every agent reads and works through the same tools. State is free text so new
// states need no migration; done and dropped are the closed ones.
export const TASK_STATES = ["backlog", "ready", "claimed", "in_progress", "blocked", "review", "done", "dropped"];

export type DeliveryState = "unread" | "claimed" | "done";

export type Message = {
  id: number;
  thread_id: number;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  created_at: string;
};

export type ThreadMessage = Message & { status: Record<string, DeliveryState> };

export type SendInput = {
  to?: string;
  subject?: string;
  body: string;
  thread_id?: number;
};

export type StatusInput = { state?: string; repo?: string; branch?: string; summary?: string };

// Sessions: a lane per Claude Code session, posted by a hook after every turn.
export const MAX_SESSION_LINE = 300;
export const SESSION_LOG_LINES = 20;
export { SESSION_TTL_MS } from "../config/defaults.ts";
export type SessionInput = { session?: string; title?: string; cwd?: string; line?: string };
export type SessionRow = { member: string; session: string; title: string | null; cwd: string | null; started_at: number; updated_at: number; last_line: string | null; liveness?: string };
export type SessionLine = { id: number; at: number; line: string };

export type StatusRow = {
  member: string;
  state: string | null;
  repo: string | null;
  branch: string | null;
  summary: string | null;
  updated_at: number | null;
  seen_at: number;
};

// Every task column but id. A column added here later is added to existing hubs on start (ALTER TABLE ADD COLUMN),
// so a NOT NULL column needs a default.
export const TASK_COLUMNS: Record<string, string> = {
  key: "TEXT",
  title: "TEXT NOT NULL DEFAULT ''",
  brief: "TEXT NOT NULL DEFAULT ''",
  owner: "TEXT NOT NULL DEFAULT ''",
  assignee: "TEXT",
  state: "TEXT NOT NULL DEFAULT 'backlog'",
  priority: "INTEGER NOT NULL DEFAULT 3",
  repo: "TEXT",
  branch: "TEXT",
  pr_url: "TEXT",
  labels: "TEXT NOT NULL DEFAULT '[]'",
  due: "TEXT",
  thread_id: "INTEGER NOT NULL DEFAULT 0",
  created_by: "TEXT NOT NULL DEFAULT ''",
  created_at: "TEXT NOT NULL DEFAULT ''",
  updated_at: "TEXT NOT NULL DEFAULT ''",
  closed_at: "TEXT",
  closed_by: "TEXT",
  version: "INTEGER NOT NULL DEFAULT 1",
  // The cloud session (child device) holding the claim and when it last showed life; both null when unclaimed.
  claim_session: "TEXT",
  claim_beat_at: "INTEGER",
  // Set when a claim was released because its session went silent; cleared by the next claim or when the task closes.
  orphaned_at: "INTEGER",
  orphaned_from: "TEXT",
  orphan_reason: "TEXT",
  // Set when GitHub reports the PR merged to trunk (src/hub/github.ts). deploy_state tells merged from live:
  // pending (merged, deploy not reported yet), live, failed, not_seen (no deploy result inside the timeout).
  merged_sha: "TEXT",
  merged_at: "INTEGER",
  deploy_state: "TEXT",
  deployed_at: "INTEGER",
  // T-53 epics: a child names its epic's key in parent; an epic (kind "epic") is never claimed, its state follows its children.
  parent: "TEXT",
  kind: "TEXT NOT NULL DEFAULT 'task'",
};

export type Task = {
  id: number;
  key: string;
  title: string;
  brief: string;
  owner: string;
  assignee: string | null;
  state: string;
  priority: number;
  repo: string | null;
  branch: string | null;
  pr_url: string | null;
  labels: string[];
  due: string | null;
  thread_id: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  version: number;
  claim_session: string | null;
  claim_beat_at: number | null;
  orphaned_at: number | null;
  orphaned_from: string | null;
  orphan_reason: string | null;
  merged_sha: string | null;
  merged_at: number | null;
  deploy_state: string | null;
  deployed_at: number | null;
  parent: string | null;
  kind: string;
};

// What an epic's children add up to (task_list shows it under the epic). Dropped children do not count.
export type Rollup = { total: number; done: number; review: number; blocked: number; orphaned: number; ci_red: number; deploy: Record<string, number> };

export type TaskSummary = Omit<Task, "brief"> & { rollup?: Rollup };

export type TaskRow = Omit<Task, "labels"> & { labels: string };

export type TaskEvent = { id: number; task_id: number; at: string; by: string; kind: string; data: Record<string, unknown> };

// undefined leaves a field as it is; null clears it.
export type TaskInput = {
  title?: string;
  brief?: string;
  owner?: string;
  assignee?: string | null;
  repo?: string | null;
  branch?: string | null;
  pr_url?: string | null;
  priority?: number;
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  due?: string | null;
  parent?: string | null;
  kind?: string;
  state?: string;
  note?: string;
  expected_version?: number;
};

export type TaskQuery = { scope?: string; states?: string[]; repo?: string; limit?: number };

// `notified` is the owner when a finish by someone else sent them the done message.
// `note_refused`: a note for a cloud device that no session will see (the task is in backlog, or its holder cannot take it).
export type TaskChange = { task: Task; changed: string[]; message_id: number | null; posted_to: string | null; notified: string | null; note_refused?: string; verdict?: string };

export function initSchema(sql: SqlStorage, transaction?: (fn: () => void) => void): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient);
    CREATE TABLE IF NOT EXISTS deliveries (
      message_id INTEGER NOT NULL,
      member TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      done_at TEXT,
      PRIMARY KEY (message_id, member)
    );
    CREATE TABLE IF NOT EXISTS status (
      member TEXT PRIMARY KEY,
      state TEXT,
      repo TEXT,
      branch TEXT,
      summary TEXT,
      updated_at INTEGER,
      seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      member TEXT NOT NULL,
      session TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (member, session)
    );
    CREATE TABLE IF NOT EXISTS session_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member TEXT NOT NULL,
      session TEXT NOT NULL,
      at INTEGER NOT NULL,
      line TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_lines_session ON session_lines(member, session, id);
  `);
  // T-50: a message for a cloud parent can be reserved for one session (a child name, or a fire tag, messages.fireTag,
  // until the fired session first calls); siblings reading the parent's inbox do not see it.
  addMissingColumns(sql, "messages", { reserved_for: "TEXT" });
  // Databases from before claims kept one read cursor per member; everything at or below it counts as done.
  // The old table is renamed, not dropped, so the migration runs once and keeps the data.
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cursors'").toArray().length > 0) {
    sql.exec(
      `INSERT OR IGNORE INTO deliveries (message_id, member, claimed_at, done_at)
       SELECT m.id, c.member, 0, ? FROM cursors c
       JOIN messages m ON m.id <= c.last_id AND m.sender != c.member AND (m.recipient = c.member OR m.recipient = 'all')`,
      new Date().toISOString(),
    );
    sql.exec("ALTER TABLE cursors RENAME TO cursors_v1");
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${Object.entries(TASK_COLUMNS).map(([name, type]) => `${name} ${type}`).join(",\n      ")}
    );
  `);
  // The task log is a view over the single record (hub/events.ts, T-52); an older hub's task_events table is migrated there.
  initEvents(sql, transaction);
  addMissingColumns(sql, "tasks", TASK_COLUMNS);
  sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_key ON tasks(key);
    CREATE INDEX IF NOT EXISTS tasks_owner_state ON tasks(owner, state);
    CREATE INDEX IF NOT EXISTS tasks_assignee_state ON tasks(assignee, state);
    CREATE INDEX IF NOT EXISTS tasks_repo_state ON tasks(repo, state);
    CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_id);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent) WHERE parent IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tasks_orphaned_from ON tasks(orphaned_from) WHERE orphaned_from IS NOT NULL;
  `);
}

export function addMissingColumns(sql: SqlStorage, table: string, columns: Record<string, string>): void {
  const have = new Set(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}
