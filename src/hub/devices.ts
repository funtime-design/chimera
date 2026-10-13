import { BridgeError } from "./validate";
import { addMissingColumns } from "./schema";

// Cloud child devices. Every cloud session authenticates with its person's one cloud token (alice-cloud), so concurrent
// sessions would share a name, a status line and an inbox. A session that sends Goonbridge-Session (its session id) gets
// a child name of its own instead, fixed for the life of the session: <parent>-<rand>-<context>, e.g.
// alice-cloud-x7k-goonbridge. Names are never reused: every name ever handed out stays in the table, and a candidate
// that is on the roster or in the table is redrawn. The Durable Object runs one call at a time, so two sessions starting
// together cannot both take a name.
// A child is a member (on the board, reachable by name) while it is online: it called the bridge within the online
// window, as a session looping on bridge_inbox does. A child that went quiet drops off; its name stays reserved.
// A child still gets what is sent to its parent: those messages are claimed and finished under the parent's name, so
// one child picks each one up, as two clients of one member always have.

const RAND_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function initDevices(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cloud_devices (
      name TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      session TEXT NOT NULL,
      context TEXT,
      created_at INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      UNIQUE (parent, session)
    );
  `);
  // Liveness signals, one column per kind (see claims.liveness): tool = the PostToolUse hook, process = the in-run
  // heartbeat loop (the process is alive, not that the agent acts), poll = an inbox read, call = any other identified
  // call. seen_at stays the latest of tool, poll and call; a process beat alone never refreshes it.
  addMissingColumns(sql, "cloud_devices", { tool_at: "INTEGER", process_at: "INTEGER", poll_at: "INTEGER", call_at: "INTEGER" });
}

export type Signal = "tool" | "process" | "poll" | "call";

function stamp(sql: SqlStorage, name: string, signal: Signal, now: number): void {
  if (signal === "process") sql.exec("UPDATE cloud_devices SET process_at = ? WHERE name = ?", now, name);
  else sql.exec(`UPDATE cloud_devices SET seen_at = ?1, ${signal}_at = ?1 WHERE name = ?2`, now, name);
}

// The repo or other context a session names, as a name part: lowercase, dashes, at most 40 characters.
export function contextPart(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

export function validSession(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/.test(s) ? s : null;
}

function randPart(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => RAND_CHARS[b % RAND_CHARS.length]).join("");
}

// When this parent's session last called, before this call refreshes it; null for a session not seen yet.
export function lastSeen(sql: SqlStorage, parent: string, session: string): number | null {
  return sql.exec<{ seen_at: number }>("SELECT seen_at FROM cloud_devices WHERE parent = ? AND session = ?", parent, session).toArray()[0]?.seen_at ?? null;
}

// The child name for this parent and session: the one it already has, or a new one that no member or earlier child holds.
export function childFor(sql: SqlStorage, parent: string, session: string, context: string | null, roster: string[], signal: Signal = "call"): string {
  const now = Date.now();
  const have = sql.exec<{ name: string }>("SELECT name FROM cloud_devices WHERE parent = ? AND session = ?", parent, session).toArray()[0];
  if (have) {
    stamp(sql, have.name, signal, now);
    return have.name;
  }
  const ctx = contextPart(context);
  // Three characters give 46,656 names per context; widen if a draw keeps colliding.
  for (let attempt = 0; attempt < 12; attempt++) {
    const name = `${parent}-${randPart(attempt < 6 ? 3 : 5)}${ctx ? `-${ctx}` : ""}`;
    if (roster.includes(name)) continue;
    if (sql.exec("SELECT 1 FROM cloud_devices WHERE name = ?", name).toArray().length > 0) continue;
    // A process beat says the process lives, not that the agent acts: as first contact it must not make the session look
    // seen (seen_at = 1, not 0, which means offline).
    sql.exec(
      "INSERT INTO cloud_devices (name, parent, session, context, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      name, parent, session, ctx || null, now, signal === "process" ? 1 : now,
    );
    stamp(sql, name, signal, now);
    return name;
  }
  throw new BridgeError("could not find a free cloud device name; try again");
}

// A session line posted under this session id is proof of life for the child that session is (cloud_devices.session).
// The per-turn hook posts with whatever token it has, so the post may arrive as the person, not as the child, and
// never pass through childFor(). Returns the child name, or null when the id is not a cloud child's.
// `seen_at` in the result is the time before this touch.
export function touchBySession(sql: SqlStorage, session: string): { name: string; seen_at: number } | null {
  const have = sql.exec<{ name: string; seen_at: number }>("SELECT name, seen_at FROM cloud_devices WHERE session = ?", session).toArray()[0];
  if (have) stamp(sql, have.name, "call", Date.now());
  return have ?? null;
}

// Children seen within the last `windowMs`, oldest first.
export function activeChildren(sql: SqlStorage, windowMs: number): string[] {
  return sql.exec<{ name: string }>("SELECT name FROM cloud_devices WHERE seen_at >= ? ORDER BY created_at", Date.now() - windowMs)
    .toArray().map((r) => r.name);
}

export function parentOf(sql: SqlStorage, member: string): string | null {
  return sql.exec<{ parent: string }>("SELECT parent FROM cloud_devices WHERE name = ?", member).toArray()[0]?.parent ?? null;
}
