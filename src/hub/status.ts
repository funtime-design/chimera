import type { StatusInput, StatusRow } from "./schema";
import { MAX_SUMMARY } from "./schema";
import { BridgeError } from "./validate";
import { parentOf } from "./devices";
import { releaseSession } from "./claims";
import { handBack, type Waiters } from "./messages";

// "offline" is a wind-down: the member is gone now, so it must not read as online for another online window. A cloud
// child going offline also gives up its task claims at once, and stops keeping its parent online unless a sibling
// child is still showing life (seen within the claim lease).
export function setStatus(sql: SqlStorage, member: string, input: StatusInput, leaseMs = 0, waiters: Waiters = new Set()): StatusRow {
  const state = (input.state ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,19}$/.test(state)) throw new BridgeError("state is required: one short word such as idle, working or offline");
  const summary = (input.summary ?? "").trim();
  if (summary.length > MAX_SUMMARY) throw new BridgeError(`summary is over ${MAX_SUMMARY} characters`);
  const repo = (input.repo ?? "").trim().slice(0, 200);
  const branch = (input.branch ?? "").trim().slice(0, 200);
  const now = Date.now();
  const gone = state === "offline";
  sql.exec(
    `INSERT INTO status (member, state, repo, branch, summary, updated_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(member) DO UPDATE SET state = excluded.state, repo = excluded.repo, branch = excluded.branch,
       summary = excluded.summary, updated_at = excluded.updated_at, seen_at = excluded.seen_at`,
    member, state, repo || null, branch || null, summary || null, now, gone ? 0 : now,
  );
  if (gone) windDown(sql, waiters, member, leaseMs);
  return sql.exec<StatusRow>("SELECT * FROM status WHERE member = ?", member).one();
}

// A child's "seen" is also its session evidence (cloud_devices.seen_at, refreshed by any identified call, heartbeats
// included), so the board, bridge_members and bridge_sessions read the same fact; each keeps its own deadline.
export function statuses(sql: SqlStorage): StatusRow[] {
  return sql.exec<StatusRow>(
    `SELECT s.member, s.state, s.repo, s.branch, s.summary, s.updated_at, MAX(s.seen_at, COALESCE(c.seen_at, 0)) AS seen_at
     FROM status s LEFT JOIN cloud_devices c ON c.name = s.member
     UNION ALL
     SELECT c.name, NULL, NULL, NULL, NULL, NULL, c.seen_at FROM cloud_devices c WHERE c.name NOT IN (SELECT member FROM status)
     ORDER BY 1`,
  ).toArray();
}

// Counts as "seen", which is what the status board's online flag reads.
export function touch(sql: SqlStorage, member: string): void {
  sql.exec(
    "INSERT INTO status (member, seen_at) VALUES (?1, ?2) ON CONFLICT(member) DO UPDATE SET seen_at = excluded.seen_at",
    member, Date.now(),
  );
}

function windDown(sql: SqlStorage, waiters: Waiters, member: string, leaseMs: number): void {
  const parent = parentOf(sql, member);
  if (!parent) return;
  releaseSession(sql, waiters, member);
  handBack(sql, waiters, member);
  quiet(sql, member, parent, leaseMs);
}

// The child no longer shows life, and neither does its parent unless a sibling child still does.
export function quiet(sql: SqlStorage, member: string, parent: string, leaseMs: number): void {
  sql.exec("UPDATE cloud_devices SET seen_at = 0 WHERE name = ?", member);
  const siblings = sql.exec("SELECT 1 FROM cloud_devices WHERE parent = ? AND seen_at >= ?", parent, Date.now() - leaseMs).toArray();
  if (siblings.length === 0) sql.exec("UPDATE status SET seen_at = 0 WHERE member = ?", parent);
}
