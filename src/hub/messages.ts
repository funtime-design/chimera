import { CLOUD_PARENT_LIKE } from "../config/names";
import type { DeliveryState, Message, SendInput, ThreadMessage } from "./schema";
import { INBOX_LIMIT, MAX_BODY, MAX_THREAD_MESSAGES } from "./schema";
import { household, personOf, receivesAll } from "./roster";
import { touch } from "./status";
import { parentOf } from "./devices";
import { BridgeError } from "./validate";
import { appendEvent } from "./events";

const MAX_WAIT_SECONDS = 25;

// Callbacks of inbox calls waiting for a new message; every post wakes them all.
export type Waiters = Set<() => void>;

// ?1 = member, ?2 = claims older than this (epoch ms) have expired, ?3 = 1 if the member gets "all" messages, ?4 = the
// caller (a child reading its parent's inbox sees a message reserved for a session only when it is that session).
const VISIBLE_FROM = `FROM messages m LEFT JOIN deliveries d ON d.message_id = m.id AND d.member = ?1
  WHERE m.sender != ?1 AND (m.recipient = ?1 OR (m.recipient = 'all' AND ?3 = 1))
    AND (m.reserved_for IS NULL OR m.reserved_for = ?4)
    AND (d.message_id IS NULL OR (d.done_at IS NULL AND d.claimed_at < ?2))`;

// A message for a cloud parent that the session a routine fire is starting must get, not a sibling polling the parent's
// inbox, is reserved for that fire (its cloud_fires row). At the fired session's first call (faults.linkSession) it
// becomes that session's child name; a fire that fails or never starts clears it.
export const fireTag = (fireId: number): string => `(fire ${fireId})`;

// Decides, once `to` and the subject are known and before the message is stored, who really gets it (T-50): another
// recipient (the child holding the task), a reservation, or nothing (null) to store it as addressed. May throw.
export type Router = (to: string, subject: string, threadId: number | null) => { to?: string; reserved_for?: string } | null;

export function send(sql: SqlStorage, waiters: Waiters, sender: string, members: string[], input: SendInput, route?: Router): Message {
  const body = (input.body ?? "").trim();
  if (!body) throw new BridgeError("body is empty");
  if (new TextEncoder().encode(body).length > MAX_BODY) throw new BridgeError(`body is over ${MAX_BODY} bytes`);

  let threadId = input.thread_id ?? null;
  let subject = (input.subject ?? "").trim();
  let to = (input.to ?? "").trim();

  if (threadId !== null) {
    const first = firstOf(sql, threadId);
    if (!first) throw new BridgeError(`thread ${threadId} not found`);
    if (!canSee(sql, sender, members, first, threadId)) throw new BridgeError(`thread ${threadId} not found`);
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", threadId).one().n;
    if (count >= MAX_THREAD_MESSAGES) {
      throw new BridgeError(`thread ${threadId} has reached ${MAX_THREAD_MESSAGES} messages. The thread is full: report results with task_report on the task, or ask the owner. Start a new thread (to + body) if there is new work, or ask your owner before going on.`);
    }
    subject = first.subject;
    if (!to) to = first.sender === sender ? first.recipient : first.sender;
  } else {
    if (!to) throw new BridgeError("to is required for a new thread");
    if (!subject) subject = body.split("\n")[0].slice(0, 80);
  }

  if (to !== "all" && !members.includes(to)) throw new BridgeError(notLive(sql, to) ?? `unknown member "${to}"; members: ${members.join(", ")}, all`);
  if (to === sender) throw new BridgeError("cannot send to yourself");

  const routed = route?.(to, subject, threadId) ?? null;
  const message = post(sql, waiters, threadId, sender, routed?.to ?? to, subject, body, members, routed?.reserved_for ?? null);
  // A message in a task's thread is part of that task's record (T-56), so task_get and bridge_thread hold the same history.
  const task = threadId === null ? undefined : sql.exec<{ id: number }>("SELECT id FROM tasks WHERE thread_id = ? ORDER BY id LIMIT 1", threadId).toArray()[0];
  if (task) appendEvent(sql, "task", task.id, sender, "reply", { message_id: message.id, sender, to: message.recipient });
  return message;
}

// A session name that is no longer a member: killed, or silent past the lease. Says when, and what it said last.
function notLive(sql: SqlStorage, name: string): string | null {
  const d = sql.exec<{ parent: string; seen_at: number; killed_at: number | null; killed_by: string | null }>(
    "SELECT parent, seen_at, killed_at, killed_by FROM cloud_devices WHERE name = ?", name,
  ).toArray()[0];
  if (!d) return null;
  const ago = (t: number) => `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`;
  const last = sql.exec<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE sender = ? ORDER BY id DESC LIMIT 1", name).toArray()[0];
  const report = last ? ` Its last message: ${last.id} in thread ${last.thread_id}.` : " It never sent a message.";
  const why = d.killed_at ? `${name} was killed by ${d.killed_by} ${ago(d.killed_at)}` : `${name} is not live: last seen ${d.seen_at ? ago(d.seen_at) : "when it posted offline"}`;
  return `${why}.${report} To reach a live session, send to ${d.parent}.`;
}

// Stores a checked message. Task posts come straight here: they skip the reply cap, and a post to yourself
// (a task you own with nobody else on it) is kept in the thread as a record, already done.
export function post(sql: SqlStorage, waiters: Waiters, threadId: number | null, sender: string, to: string, subject: string, body: string, members: string[], reservedFor: string | null = null): Message {
  const now = new Date().toISOString();
  const row = sql
    .exec<{ id: number }>(
      "INSERT INTO messages (thread_id, sender, recipient, subject, body, created_at, reserved_for) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      threadId ?? 0, sender, to, subject, body, now, reservedFor,
    )
    .one();
  if (threadId === null) {
    threadId = row.id;
    sql.exec("UPDATE messages SET thread_id = ? WHERE id = ?", threadId, row.id);
  } else {
    // A reply answers everything the replier was sent earlier in the thread, and what its cloud parent was sent, except
    // what is reserved for another session (a fire's, or a sibling's): that one has not seen it yet (T-50).
    for (const who of inboxNames(sql, sender)) {
      sql.exec(
        `INSERT INTO deliveries (message_id, member, claimed_at, done_at)
         SELECT id, ?1, ?2, ?3 FROM messages
         WHERE thread_id = ?4 AND id < ?5 AND sender != ?1 AND (recipient = ?1 OR (recipient = 'all' AND ?6 = 1))
           AND (reserved_for IS NULL OR reserved_for = ?7)
         ON CONFLICT(message_id, member) DO UPDATE SET done_at = COALESCE(deliveries.done_at, excluded.done_at)`,
        who, Date.now(), now, threadId, row.id, receivesAll(who, members) ? 1 : 0, sender,
      );
    }
  }
  if (to === sender) {
    sql.exec("INSERT INTO deliveries (message_id, member, claimed_at, done_at) VALUES (?, ?, ?, ?)", row.id, sender, Date.now(), now);
  }

  for (const wake of waiters) wake();
  waiters.clear();

  return { id: row.id, thread_id: threadId, sender, recipient: to, subject, body, created_at: now };
}

// Visible = addressed to me or to all, not sent by me, not done, and not under a live claim.
// Fetching claims the messages so another client of the same member doesn't get them until the claim expires.
// Every poll also counts as "seen", which is what the status board's online flag reads.
export async function inbox(
  sql: SqlStorage, waiters: Waiters, claimMs: number, member: string, members: string[], waitSeconds = 0, peek = false,
): Promise<{ messages: Message[]; more: number }> {
  const names = inboxNames(sql, member);
  // Only the caller is marked seen. A child's polls no longer stand in for its parent (or its siblings): whether a
  // message needs a new session is decided per claim (see cloud.ts), not by whether anyone under the parent is around.
  touch(sql, member);
  const all = receivesAll(member, members);
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  let rows = visibleAll(sql, claimMs, names, all);
  while (rows.length === 0 && Date.now() < deadline) {
    const woken = await new Promise<boolean>((resolve) => {
      const wake = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { waiters.delete(wake); resolve(false); }, deadline - Date.now());
      waiters.add(wake);
    });
    rows = visibleAll(sql, claimMs, names, all);
    if (!woken) break;
  }
  const more = rows.length === INBOX_LIMIT ? names.reduce((n, who) => n + visibleCount(sql, claimMs, who, all && who === member, member), 0) - rows.length : 0;
  if (!peek) {
    const claimedAt = Date.now();
    for (const m of rows) {
      sql.exec(
        "INSERT INTO deliveries (message_id, member, claimed_at) VALUES (?, ?, ?) ON CONFLICT(message_id, member) DO UPDATE SET claimed_at = excluded.claimed_at",
        m.id, names.includes(m.recipient) ? m.recipient : member, claimedAt,
      );
    }
  }
  return { messages: rows, more };
}

// A session is gone (died, killed, released for silence, posted offline): what was reserved for it or re-addressed to
// it and is not finished goes back to its parent's inbox, so a live sibling or a fresh session can take it. Without this,
// a message reserved for a dead child would be invisible to everyone for good.
export function handBack(sql: SqlStorage, waiters: Waiters, child: string): void {
  const parent = parentOf(sql, child);
  if (!parent) return;
  const open = "NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = messages.id AND d.done_at IS NOT NULL)";
  // A message for the parent that the child fetched is claimed under the parent's name (see inbox): that claim goes too,
  // or the handed-back message stays hidden from every sibling until the claim expires.
  sql.exec("DELETE FROM deliveries WHERE member = ? AND done_at IS NULL AND message_id IN (SELECT id FROM messages WHERE reserved_for = ?)", parent, child);
  sql.exec(`UPDATE messages SET reserved_for = NULL WHERE reserved_for = ? AND ${open}`, child);
  sql.exec(`UPDATE messages SET recipient = ? WHERE recipient = ? AND sender != ? AND ${open}`, parent, child, parent);
  // Claims the dead child took on them (under its own name) no longer apply to the parent's inbox.
  sql.exec("DELETE FROM deliveries WHERE member = ? AND done_at IS NULL", child);
  for (const wake of waiters) wake();
  waiters.clear();
}

// The sweep's catch-all: a cloud session dead past the lease (no signal of any kind, its process included) that still has
// open messages routed or reserved to it hands them back, whatever ended it. A claim the sweep never releases (review), a
// claim released by hand, or no claim at all would otherwise leave them in an inbox nobody reads. Mac sessions are left
// alone: one can sit quiet for an hour with a person in front of it (claims.releaseStale).
export function handBackDead(sql: SqlStorage, waiters: Waiters, leaseMs: number): string[] {
  const open = "NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.done_at IS NOT NULL)";
  const dead = sql.exec<{ name: string }>(
    `SELECT c.name FROM cloud_devices c WHERE c.parent LIKE ? AND MAX(c.seen_at, COALESCE(c.process_at, 0)) < ?
       AND (EXISTS (SELECT 1 FROM messages m WHERE m.recipient = c.name AND m.sender != c.parent AND ${open})
         OR EXISTS (SELECT 1 FROM messages m WHERE m.reserved_for = c.name AND ${open}))`, CLOUD_PARENT_LIKE, Date.now() - leaseMs,
  ).toArray().map((r) => r.name);
  for (const name of dead) handBack(sql, waiters, name);
  return dead;
}

// A bridge notice in a thread the caller can see (a fire's "started" line, an auto-review start): posted as `system`, so
// it answers nothing. Posted as the caller it would count as the caller's reply and mark every earlier unreserved message
// to it done (the T-67 trap). `to` defaults to the thread's other party, as a reply from the caller would go.
export function notice(sql: SqlStorage, waiters: Waiters, caller: string, members: string[], threadId: number, body: string, to?: string): Message {
  const first = firstOf(sql, threadId);
  if (!first || !canSee(sql, caller, members, first, threadId)) throw new BridgeError(`thread ${threadId} not found`);
  return post(sql, waiters, threadId, "system", to ?? (first.sender === caller ? first.recipient : first.sender), first.subject, body, members);
}

export function done(sql: SqlStorage, member: string, members: string[], messageId: number): { message_id: number; done_at: string } {
  const m = sql.exec<Message & { reserved_for: string | null }>("SELECT * FROM messages WHERE id = ?", messageId).toArray()[0];
  const names = inboxNames(sql, member);
  if (!m || names.includes(m.sender) || (!names.includes(m.recipient) && !(m.recipient === "all" && receivesAll(member, members)))) {
    throw new BridgeError(`message ${messageId} not found in your inbox`);
  }
  // A message reserved for one session (or for the session a fire is starting) is that session's to finish: a sibling
  // reading the parent's inbox must not take it by id. The owner's person may still clear it.
  if (m.reserved_for && m.reserved_for !== member && member !== personOf(m.recipient, members)) {
    throw new BridgeError(`message ${messageId} is reserved for ${m.reserved_for}; only that session can mark it done`);
  }
  // What was sent to a cloud parent is finished under the parent's name, for every child.
  if (m.recipient !== "all") member = m.recipient;
  const now = new Date().toISOString();
  sql.exec(
    `INSERT INTO deliveries (message_id, member, claimed_at, done_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, member) DO UPDATE SET done_at = COALESCE(deliveries.done_at, excluded.done_at)`,
    messageId, member, Date.now(), now,
  );
  const doneAt = sql.exec<{ done_at: string }>("SELECT done_at FROM deliveries WHERE message_id = ? AND member = ?", messageId, member).one().done_at;
  return { message_id: messageId, done_at: doneAt };
}

// Each message carries its delivery state per recipient, so the sender can see who picked it up.
export function thread(sql: SqlStorage, claimMs: number, member: string, members: string[], threadId: number): ThreadMessage[] {
  const first = firstOf(sql, threadId);
  if (!first || !canSee(sql, member, members, first, threadId)) throw new BridgeError(`thread ${threadId} not found`);
  const rows = sql.exec<Message>("SELECT id, thread_id, sender, recipient, subject, body, created_at FROM messages WHERE thread_id = ? ORDER BY id", threadId).toArray();
  const deliveries = new Map<string, { claimed_at: number; done_at: string | null }>();
  for (const d of sql.exec<{ message_id: number; member: string; claimed_at: number; done_at: string | null }>(
    "SELECT d.* FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.thread_id = ?", threadId,
  )) deliveries.set(`${d.message_id}:${d.member}`, d);
  const liveAfter = Date.now() - claimMs;
  return rows.map((m) => {
    const status: Record<string, DeliveryState> = {};
    for (const r of m.recipient === "all" ? members.filter((x) => x !== m.sender && receivesAll(x, members)) : [m.recipient]) {
      const d = deliveries.get(`${m.id}:${r}`);
      status[r] = d?.done_at ? "done" : d && d.claimed_at >= liveAfter ? "claimed" : "unread";
    }
    return { ...m, status };
  });
}

export type ThreadSummary = { thread_id: number; subject: string; started_by: string; with: string; messages: number; last_from: string; last_at: string };

export function threads(sql: SqlStorage, member: string, limit = 20): ThreadSummary[] {
  return sql
    .exec<ThreadSummary>(
      `SELECT t.thread_id, f.subject, f.sender AS started_by, f.recipient AS "with", t.messages, l.sender AS last_from, l.created_at AS last_at
       FROM (SELECT thread_id, COUNT(*) AS messages, MAX(id) AS last_id FROM messages
             WHERE thread_id IN (SELECT DISTINCT thread_id FROM messages WHERE sender = ?1 OR recipient = ?1 OR recipient = 'all')
             GROUP BY thread_id) t
       JOIN messages f ON f.id = t.thread_id
       JOIN messages l ON l.id = t.last_id
       ORDER BY t.last_id DESC LIMIT ?2`,
      member, Math.min(Math.max(limit, 1), 100),
    )
    .toArray();
}

export function firstOf(sql: SqlStorage, threadId: number): Message | undefined {
  return sql.exec<Message>("SELECT * FROM messages WHERE id = ? AND thread_id = ?", threadId, threadId).toArray()[0];
}

// Any member of a household may read and answer a thread one of them is in (or that a task of theirs lives in).
function canSee(sql: SqlStorage, member: string, members: string[], first: Message, threadId: number): boolean {
  const family = household(member, members);
  if (first.recipient === "all" || family.includes(first.sender) || family.includes(first.recipient)) return true;
  // A task's thread is also open to the owner's household and the assignee's and claimant's (T-60).
  const onTask = sql.exec<{ owner: string; assignee: string | null; claim_session: string | null }>(
    "SELECT owner, assignee, claim_session FROM tasks WHERE thread_id = ?", threadId,
  ).toArray();
  const me = personOf(member, members) ?? member;
  if (onTask.some((t) => [t.owner, t.assignee, t.claim_session].some((n) => n !== null && (personOf(n, members) ?? n) === me))) return true;
  const marks = family.map(() => "?").join(",");
  return sql.exec(`SELECT 1 FROM messages WHERE thread_id = ? AND (sender IN (${marks}) OR recipient IN (${marks})) LIMIT 1`, threadId, ...family, ...family).toArray().length > 0;
}

// The names whose inbox a member reads: its own, and its cloud parent's when it is a cloud child.
function inboxNames(sql: SqlStorage, member: string): string[] {
  const parent = parentOf(sql, member);
  return parent ? [member, parent] : [member];
}

function visibleAll(sql: SqlStorage, claimMs: number, names: string[], all: boolean): Message[] {
  if (names.length === 1) return visible(sql, claimMs, names[0], all, names[0]);
  // A child's own messages and its parent's, in order, less what the child itself sent its parent.
  const rows = names.flatMap((n, i) => visible(sql, claimMs, n, all && i === 0, names[0])).filter((m) => m.sender !== names[0]);
  return rows.sort((a, b) => a.id - b.id).slice(0, INBOX_LIMIT);
}

function visible(sql: SqlStorage, claimMs: number, member: string, all: boolean, caller: string): Message[] {
  return sql
    .exec<Message>(`SELECT m.id, m.thread_id, m.sender, m.recipient, m.subject, m.body, m.created_at ${VISIBLE_FROM} ORDER BY m.id LIMIT ?5`, member, Date.now() - claimMs, all ? 1 : 0, caller, INBOX_LIMIT)
    .toArray();
}

function visibleCount(sql: SqlStorage, claimMs: number, member: string, all: boolean, caller: string): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n ${VISIBLE_FROM}`, member, Date.now() - claimMs, all ? 1 : 0, caller).one().n;
}
