import { firstOf, post, type Waiters } from "./messages";
import type { Message } from "./schema";
import { MAX_TASK_TITLE } from "./schema";
import { personOf } from "./roster";
import { changeTask, findTask, taskCreate } from "./tasks";
import { BridgeError } from "./validate";

// Work threads (T-58). A fire with no task behind it whose text talks about real work (merging, a PR, a branch, a deploy,
// a push, a revert) breaks the rule that work maps to a task: no claim, no webhook match, no orphan handling. The bridge
// flags the fire (cloud_fires.work_thread) and asks in the thread, as system, for a task. A `task: T-n` or `task: new`
// reply in that thread attaches one: the fire's task_key is set, and the fired session claims the task if it is ready
// (now, or when it first checks in: faults.linkSession).

// Inflected forms count; "push notification(s)" does not.
export const WORK_WORDS = /\b(merg(e|ed|es|ing)|deploy(s|ed|ing)?|push(es|ed|ing)?(?!\s+notifications?\b)|revert(s|ed|ing)?|branch(es)?|pull requests?|PRs?)\b/i;
export const WORK_PROMPT = "no task backs this; reply `task: T-n` to attach or `task: new` to create one";
const COMMAND = /^\s*task:\s*(T-\d+|new)\s*$/i;

type FireRow = { id: number; member: string; requester: string; thread_id: number; task_key: string | null; child: string | null };

// Called once the fire's row exists. Flags it and posts the prompt when it has no task and the text is about work.
export function flagWorkThread(sql: SqlStorage, waiters: Waiters, fireId: number, text: string, members: string[]): boolean {
  const f = sql.exec<FireRow>("SELECT * FROM cloud_fires WHERE id = ?", fireId).toArray()[0];
  if (!f || f.task_key || !WORK_WORDS.test(text)) return false;
  sql.exec("UPDATE cloud_fires SET work_thread = 1 WHERE id = ?", fireId);
  const first = f.thread_id ? firstOf(sql, f.thread_id) : undefined;
  if (first) post(sql, waiters, f.thread_id, "system", f.requester, first.subject, WORK_PROMPT, members);
  return true;
}

// A `task: T-n` / `task: new` reply in a flagged thread, by the requester's person (or one of their devices or sessions).
// Returns null when the message is not such a command in such a thread (it is then sent like any other); otherwise the
// record of what was done: one note from system to the sender, already done. The command itself is not stored as the
// sender's message, so it neither acks what the sender was sent in the thread nor counts as a session's reply.
export function attachCommand(sql: SqlStorage, waiters: Waiters, sender: string, members: string[], threadId: number, body: string): Message | null {
  const cmd = COMMAND.exec(body)?.[1];
  if (!cmd) return null;
  const person = (n: string) => personOf(n, members) ?? n;
  const flagged = sql.exec<FireRow>("SELECT * FROM cloud_fires WHERE thread_id = ? AND work_thread = 1 AND task_key IS NULL ORDER BY id DESC", threadId).toArray();
  if (flagged.length === 0) return null;
  // The sender's own household's fires: a thread may hold another person's flagged fire too, and that one is not theirs.
  const fires = flagged.filter((f) => person(f.requester) === person(sender));
  if (fires.length === 0) {
    const asker = person(flagged[0].requester);
    throw new BridgeError(`only ${asker} (or one of their devices or sessions) attaches a task to this work thread; ask ${asker}`);
  }
  const owner = person(fires[0].requester);
  let task = findTask(sql, cmd);
  if (cmd.toLowerCase() === "new") {
    const first = firstOf(sql, threadId);
    if (!first) throw new BridgeError(`thread ${threadId} not found`);
    task = taskCreate(sql, waiters, sender, members, { title: first.subject.slice(0, MAX_TASK_TITLE), brief: first.body, owner, state: "ready" });
  } else if (!task) {
    throw new BridgeError(`task ${cmd} not found; reply \`task: T-n\` with a task that exists, or \`task: new\``);
  } else if (task.owner !== owner || task.state === "done" || task.state === "dropped") {
    throw new BridgeError(`${task.key} cannot back this work thread: it must be an open task of ${owner} (it is ${task.owner}'s, ${task.state})`);
  }
  for (const f of fires) sql.exec("UPDATE cloud_fires SET task_key = ? WHERE id = ?", task.key, f.id);
  const child = fires.find((f) => f.child)?.child;
  const claim = child ? claimFor(sql, waiters, child, members, task.key) : "";
  const first = firstOf(sql, threadId)!;
  const note = post(sql, waiters, threadId, "system", sender, first.subject, `${sender}: task: ${cmd}. Attached ${task.key} to the fire in thread ${threadId}.${claim}`, members);
  sql.exec("INSERT INTO deliveries (message_id, member, claimed_at, done_at) VALUES (?, ?, ?, ?)", note.id, sender, Date.now(), note.created_at);
  return note;
}

// The fired session takes the attached task if it is still ready and unclaimed. Never throws: says what happened.
export function claimFor(sql: SqlStorage, waiters: Waiters, child: string, members: string[], key: string): string {
  const task = findTask(sql, key);
  if (!task || task.state !== "ready" || task.claim_session) return "";
  try {
    changeTask(sql, waiters, child, members, task, { state: "claim" });
    return ` ${child} now holds the claim.`;
  } catch (err) {
    return ` ${child} could not claim it: ${err instanceof Error ? err.message : String(err)}`;
  }
}
