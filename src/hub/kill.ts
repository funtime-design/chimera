import { deploymentDefaults } from "../deployment";
import { releaseKilled } from "./claims";
import { endClaim, markKilled, fireOf, sessionKey } from "./faults";
import { fireTag, firstOf, handBack, post, type Waiters } from "./messages";
import { personOf } from "./roster";
import { childFor } from "./sessions";
import { quiet } from "./status";
import { taskEvent } from "./tasks";
import { writeTask } from "./state";
import { BridgeError } from "./validate";

// Kill is revoke-and-tombstone, not termination. The bridge holds no handle on a running cloud process, so it:
//   1. ends the session's claims at once (the slot frees without waiting out the lease),
//   2. tombstones the session (cloud_devices and the sessions lane: killed_at, killed_by, seen_at zeroed), so the board
//      stops listing it, and
//   (A session fired but not yet registered is tombstoned on its cloud_fires row instead, which evictionFor also reads.)
//   3. answers its next check-in (any bridge call, a session line, an inbox poll) with an eviction, which a cooperating
//      agent obeys by stopping. The process itself exits when its harness next polls.
// All of it happens in one Hub call, which a Durable Object runs without interleaving, inside one storage transaction.

export function initKill(sql: SqlStorage): void {
  for (const table of ["cloud_devices", "sessions", "cloud_fires"]) {
    const have = new Set(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().map((c) => c.name));
    if (!have.has("killed_at")) sql.exec(`ALTER TABLE ${table} ADD COLUMN killed_at INTEGER`);
    if (!have.has("killed_by")) sql.exec(`ALTER TABLE ${table} ADD COLUMN killed_by TEXT`);
  }
}

export type KillResult = {
  killed: boolean;
  message: string;
  session?: string;
  name?: string | null;
  killed_by?: string;
  killed_at?: string;
  released?: string[];
  thread_id?: number;
};

// The tombstone for a session id, as the text its next check-in gets; null when it was not killed.
export function evictionFor(sql: SqlStorage, session: string): string | null {
  const row = sql.exec<{ killed_by: string; killed_at: number }>(
    `SELECT killed_by, killed_at FROM cloud_devices WHERE session = ?1 AND killed_at IS NOT NULL
     UNION ALL SELECT killed_by, killed_at FROM sessions WHERE session = ?1 AND killed_at IS NOT NULL LIMIT 1`, session,
  ).toArray()[0] ?? fireTombstone(sql, session);
  return row ? evictedText(session, row.killed_by, row.killed_at) : null;
}

// A session killed before it ever checked in has its tombstone on the routine fire that started it. The routines API says
// "session_01AB..." and the session's own header says "cse_01AB...", so they are matched on the shared key.
function fireTombstone(sql: SqlStorage, session: string): { killed_by: string; killed_at: number } | undefined {
  const key = sessionKey(session);
  if (key.length < 8) return undefined;
  return sql.exec<{ killed_by: string; killed_at: number }>(
    "SELECT killed_by, killed_at FROM cloud_fires WHERE session_key = ? AND killed_at IS NOT NULL LIMIT 1", key,
  ).toArray()[0];
}

const evictedText = (session: string, by: string, at: number): string =>
  `You have been killed: session ${session} was killed by ${by} at ${new Date(at).toISOString()}. Stop now: end your work and make no further bridge calls or changes. Your claims were released.`;

type Target = { fire?: number; thread_id?: number; name: string | null; session: string; person: string; seen_at: number | null; killed_at: number | null; killed_by: string | null };

// A session id (as the session sent it, or the same id under its routine prefix) or a cloud child's bridge name.
function resolve(sql: SqlStorage, members: string[], raw: string): Target | null {
  const t = raw.trim();
  const key = sessionKey(t);
  // Only a child by its own name or id: a person or device name covers many sessions and kills none.
  const d = childFor(sql, t);
  if (d) return { name: d.name, session: d.session, person: personOf(d.parent, members) ?? d.parent, seen_at: d.seen_at, killed_at: d.killed_at, killed_by: d.killed_by };
  const lane = sql.exec<{ member: string; session: string; killed_at: number | null; killed_by: string | null }>(
    "SELECT member, session, killed_at, killed_by FROM sessions WHERE session = ? ORDER BY updated_at DESC LIMIT 1", t,
  ).toArray()[0];
  if (lane) return { name: null, session: lane.session, person: personOf(lane.member, members) ?? lane.member, seen_at: null, killed_at: lane.killed_at, killed_by: lane.killed_by };
  // Started but not registered yet: a session registers on the board only at its first check-in, seconds after the fire.
  // The fire already holds its id, so it is resolvable the moment it exists.
  if (key.length < 8) return null;
  const fire = sql.exec<{ id: number; member: string; session_id: string; thread_id: number; killed_at: number | null; killed_by: string | null }>(
    "SELECT id, member, session_id, thread_id, killed_at, killed_by FROM cloud_fires WHERE session_key = ? ORDER BY id DESC LIMIT 1", key,
  ).toArray()[0];
  return fire ? { fire: fire.id, thread_id: fire.thread_id, name: null, session: fire.session_id, person: personOf(fire.member, members) ?? fire.member, seen_at: null, killed_at: fire.killed_at, killed_by: fire.killed_by } : null;
}

export function kill(sql: SqlStorage, waiters: Waiters, leaseMs: number, caller: string, members: string[], target: string, reason: string | null): KillResult {
  const raw = (target ?? "").trim();
  if (!raw) throw new BridgeError(`session is required: a session id or a bridge name such as ${deploymentDefaults.exampleSession}`);
  const found = resolve(sql, members, raw);
  if (!found) return { killed: false, message: `No session "${raw}" is known to the bridge (nothing to kill; the id may be wrong or long gone).` };
  const callerPerson = personOf(caller, members) ?? caller;
  if (callerPerson !== found.person) throw new BridgeError(`only ${found.person} can kill ${found.person}'s sessions`);
  const label = found.name ?? found.session;
  const unregistered = found.fire !== undefined;
  if (found.killed_at !== null) {
    return { killed: false, session: found.session, name: found.name, message: `Session ${label} was already killed by ${found.killed_by} at ${new Date(found.killed_at).toISOString()}; nothing to do.` };
  }
  if (found.seen_at === 0) return { killed: false, session: found.session, name: found.name, message: `Session ${label} already ended (it posted offline); nothing to kill.` };

  const now = Date.now();
  const at = new Date(now).toISOString();
  let released: string[] = [];
  let threadId: number | null = null;
  if (found.name) {
    // 1. End the claims: working ones go back to ready as a fault; a claim parked in review or blocked is just dropped
    //    (blocked inside releaseKilled, review below), keeping its state.
    released = releaseKilled(sql, waiters, found.name, caller);
    const parked = sql.exec<{ id: number; key: string; thread_id: number }>("SELECT id, key, thread_id FROM tasks WHERE claim_session = ?", found.name).toArray();
    for (const t of parked) {
      writeTask(sql, t.id, { claim_session: null, claim_beat_at: null }, at);
      endClaim(sql, t.id, `killed by ${caller}`);
      taskEvent(sql, t.id, caller, "released", { was: found.name, reason: `killed by ${caller}` });
      released.push(t.key);
    }
    // 2. Tombstone the device, settle its fire (a kill is not a silent death), and take it off the board.
    sql.exec("UPDATE cloud_devices SET killed_at = ?, killed_by = ?, seen_at = 0 WHERE name = ?", now, caller, found.name);
    const parent = sql.exec<{ parent: string }>("SELECT parent FROM cloud_devices WHERE name = ?", found.name).one().parent;
    sql.exec(
      `INSERT INTO status (member, state, summary, updated_at, seen_at) VALUES (?1, 'killed', ?2, ?3, 0)
       ON CONFLICT(member) DO UPDATE SET state = 'killed', repo = NULL, branch = NULL, summary = excluded.summary, updated_at = excluded.updated_at, seen_at = 0`,
      found.name, `killed by ${caller}`, now,
    );
    quiet(sql, found.name, parent, leaseMs);
    markKilled(sql, found.name);
    handBack(sql, waiters, found.name);
    threadId = fireOf(sql, found.name)?.thread_id ?? null;
  }
  sql.exec("UPDATE sessions SET killed_at = ?, killed_by = ? WHERE session = ?", now, caller, found.session);
  if (found.fire !== undefined) {
    // Pre-tombstone: the session has not checked in yet. The tombstone sits on its fire, which evictionFor reads, so its
    // first check-in is refused before it can register. Settle the fire so the sweep does not call it never_started.
    sql.exec("UPDATE cloud_fires SET killed_at = ?, killed_by = ?, fault = COALESCE(fault, 'killed'), fault_at = COALESCE(fault_at, ?) WHERE id = ?", now, caller, now, found.fire);
    // What was reserved for the session this fire starts will never be fetched: it waits in the parent's inbox again.
    sql.exec("UPDATE messages SET reserved_for = NULL WHERE reserved_for = ?", fireTag(found.fire));
    for (const wake of waiters) wake();
    waiters.clear();
    threadId = found.thread_id || null;
  }

  // 3. Leave a record in the session's thread (the fire's, else the first task it held, else a new one to its person).
  if (!threadId) threadId = sql.exec<{ thread_id: number }>("SELECT thread_id FROM tasks WHERE key IN (" + (released.map(() => "?").join(",") || "''") + ") ORDER BY id LIMIT 1", ...released).toArray()[0]?.thread_id || null;
  const subject = (threadId ? firstOf(sql, threadId)?.subject : null) ?? `Session ${label} killed`;
  const note = post(sql, waiters, threadId, "system", found.person, subject,
    `session ${label}${found.name ? ` (${found.session})` : ""} killed by ${caller} at ${at}${reason ? `: ${reason}` : ""}. ` +
    `${unregistered ? "It had not checked in yet, so it is tombstoned in advance and refused at its first check-in. " : ""}Its claims were ended${released.length ? ` (${released.join(", ")}; working ones are back to ready, a parked review or blocked claim just loses its holder and keeps its state)` : ""}. It is told to stop at its next check-in; the process itself is not force-terminated and exits when its harness next polls.`, members);
  return {
    killed: true, session: found.session, name: found.name, killed_by: caller, killed_at: at, released, thread_id: note.thread_id,
    message: `Killed session ${label}: claims ended${released.length ? ` (${released.join(", ")}; working ones are back to ready, a parked review or blocked claim just loses its holder and keeps its state)` : ""}, tombstoned${unregistered ? " ahead of its first check-in" : ""}, and a note posted in thread ${note.thread_id}. It is told to stop at its next check-in; the process is not force-terminated.`,
  };
}
