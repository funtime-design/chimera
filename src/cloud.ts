import { cloudParentOf } from "./config/names";
import { onlineSeconds, type Hub, type Message, type SendInput, type Task, type TaskChange, type TaskInput } from "./hub";
import { parseRoutines, startCloud, type CloudStart } from "./routines";
import type { Env } from "./env";
import { reviewOptions, startReviewer } from "./github";

type Reviewer = Awaited<ReturnType<typeof startReviewer>>;

// The message goes to a live session's inbox; say which session in the send result only. Never post a notice in the
// thread as the recipient: a post from the parent counts as its reply and marks the unread request done (T-67).
const liveReply = (sent: Message, session: string | null): CloudStart => ({ member: sent.recipient, live: true, session_id: session ?? sent.recipient });

// bridge_send and POST /v1/send. The hub decides who gets a message for a cloud parent before storing it (Hub.sendRouted:
// the live claimant's own inbox, or reserved for the session a fire starts), so no sibling can take it; then a fire, if
// one is needed, happens here. new_session: the operator demands a fresh session. It skips the household and live-child
// checks, and it fails loudly instead of queueing when no session can be started.
export async function sendToCloud(env: Env, hub: DurableObjectStub<Hub>, member: string, members: string[], input: SendInput, forceNew = false): Promise<{ sent: Message; cloud: CloudStart | null }> {
  const routines = parseRoutines(env.GOONBRIDGE_ROUTINES);
  const { message: sent, route } = await hub.sendRouted(member, members, input, { people: [...routines.keys()], forceNew, onlineMs: onlineSeconds(env) * 1000 });
  if (forceNew && !route) {
    return { sent, cloud: { member: sent.recipient, forced: true, error: "new_session needs a -cloud recipient whose person has a routine configured; the message was delivered to the inbox only" } };
  }
  if (!route) return { sent, cloud: null };
  if (route.note) return { sent, cloud: { member: sent.recipient, note: route.note } };
  if (route.live) return { sent, cloud: liveReply(sent, route.session) };
  // The task the router found: by the thread first (tasks.thread_id), the subject only as a fallback (T-56).
  // Only the task row: its events and claims are not needed to start a session.
  const task: Task | null = route.task_key ? await hub.findTask(route.task_key) : null;
  return { sent, cloud: await startCloud(hub, members, routines, sent, task, env.GOONBRIDGE_ROUTINES_URL, forceNew, route.fire) };
}

// task_update and PATCH /v1/tasks/:key, one path (T-56). A note for a cloud device is routed in the hub like bridge_send
// (live claimant, shared inbox with a note, or reserved for a fire); a fire it asked for starts here, with the task brief
// under the note. An assignee change to a cloud device fires as before (cloudAfterTask), and joins that fire if there is one.
// T-55: a "ready for re-review" note may reserve a reviewer for the PR's new head; it is started here too.
export async function updateTask(env: Env, hub: DurableObjectStub<Hub>, member: string, members: string[], key: string, input: TaskInput): Promise<{ change: TaskChange; cloud: CloudStart | null; reviewer: Reviewer | null }> {
  const routines = parseRoutines(env.GOONBRIDGE_ROUTINES);
  const { route, message, review, ...change } = await hub.taskUpdate(member, members, key, input, { people: [...routines.keys()], onlineMs: onlineSeconds(env) * 1000 }, reviewOptions(env));
  let cloud: CloudStart | null = null;
  if (change.note_refused) cloud = { member: change.posted_to ?? member, note: change.note_refused };
  else if (route?.note) cloud = { member: message?.recipient ?? member, note: route.note };
  else if (route?.live && message) cloud = liveReply(message, route.session);
  else if (route?.fire !== undefined && message) {
    const t = change.task;
    const withBrief = { ...message, body: `${message.body}\n\n---\nTask ${t.key} brief:\n${t.brief}` };
    cloud = await startCloud(hub, members, routines, withBrief, t, env.GOONBRIDGE_ROUTINES_URL, false, route.fire);
  }
  // A note refused on a backlog task said no session will see it: an assignee change in the same call must not fire one.
  const backlogNote = !!change.note_refused && change.task.state === "backlog";
  if (change.changed.includes("assignee") && !backlogNote) cloud = (await cloudAfterTask(env, hub, members, change.task, change.task.thread_id, member)) ?? cloud;
  const reviewer = review ? await startReviewer(env, hub, members, review) : null;
  return { change, cloud, reviewer };
}

// A task assigned to a cloud device: its brief (the thread's first message) is what the routine gets.
export async function cloudAfterTask(env: Env, hub: DurableObjectStub<Hub>, members: string[], task: Task, threadId: number, caller: string): Promise<CloudStart | null> {
  const routines = parseRoutines(env.GOONBRIDGE_ROUTINES);
  // An epic is never claimed (T-53), so assigning one fires no session; its children are the work.
  if (routines.size === 0 || task.kind === "epic" || (!task.assignee || cloudParentOf(task.assignee) === null)) return null;
  // A closed task is nobody's work: changing its assignee starts no paid session.
  if (task.state === "done" || task.state === "dropped") return null;
  // A device of the same person starts cloud sessions itself (the Mac responder does): its assignments fire nothing.
  if (caller.includes("-") && caller.split("-")[0] === task.assignee.split("-")[0]) return null;
  // One Hub call decides and writes the fire intent, so a routed send for this task cannot start a second session.
  const now = await hub.assignFire(task.assignee, task.key, threadId, onlineSeconds(env) * 1000);
  if (now.held || now.note) return { member: task.assignee, note: now.note ?? `${task.key} is held by ${now.held}; nothing was started.` };
  if (now.live) return { member: task.assignee, live: true, ...(now.session ? { session_id: now.session } : {}) };
  if (!now.brief || now.fire === undefined) return null;
  return startCloud(hub, members, routines, { ...now.brief, recipient: task.assignee }, task, env.GOONBRIDGE_ROUTINES_URL, false, now.fire);
}

export const cloudText = (c: CloudStart | null) => (c ? c.note ? ` ${c.note}` : c.live ? ` ${c.member} has a session open (session ${c.session_id ?? "unknown"}); it picks this up from its inbox.` : (c.url ? ` Cloud session started for ${c.member}: ${c.url}${c.session_id ? ` (session ${c.session_id})` : ""}` : ` ${c.member} could not start a cloud session (${c.error}).`) : "");
