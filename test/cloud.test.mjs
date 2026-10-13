import { CONTEXT_HEADER, OTHER, OTHER_CLOUD, OWNER, OWNER_CLOUD, OWNER_DEVICE, PRODUCT, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Messages and tasks to a cloud device fire that person's routine (a fake routines API stands in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  base, ownerToken, ownerCloudToken, otherCloudToken, rest, callTool, drain, useFakeRoutines, sleep, serverWindows,
} from "./helpers.mjs";

// Draining a device's inbox marks it online, and an online cloud device is not fired; wait that window out.
const pastOnline = async () => sleep(((await serverWindows()).online_seconds ?? 4) * 1000 + 1000);

const fakeRoutines = useFakeRoutines();

test("a message or task to a cloud device fires that person's routine and the session link comes back in the thread", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken); await drain(otherCloudToken);
  await pastOnline();
  const before = fakeRoutines.fires.length;
  // 1. bridge_send to alice-cloud.
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "Rename the README heading", body: "In example-repo, make the README heading say Example." });
  assert.match(sent.content[0].text, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}: https:\/\/claude\.ai\/code\/session_fake\d+`, ""));
  const fire = fakeRoutines.fires[before];
  assert.equal(fire.trigger, "trig_local_test");
  assert.match(fire.text, new RegExp(String.raw`^${PRODUCT} thread \d+: message \d+ from ${escapeRegex(OWNER)} to ${escapeRegex(OWNER_CLOUD)}\.`, ""));
  assert.match(fire.text, /bridge_thread \d+/);
  assert.match(fire.text, /make the README heading say Example/);
  const threadId = Number(sent.content[0].text.match(/thread (\d+)/)[1]);
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body;
  assert.equal(thread.length, 2);
  assert.equal(thread[1].sender, "system", "the notice is the bridge's, so it acks nothing (T-67)");
  assert.match(thread[1].body, new RegExp(String.raw`^started cloud session https:\/\/claude\.ai\/code\/session_fake\d+ \(session [^)]+\) on ${escapeRegex(OWNER)}'s account`, ""));
  assert.deepEqual(thread[0].status, { [OWNER_CLOUD]: "done" }, "the device copy is marked done, the session works from the thread");
  // 2. task_create assigned to alice-cloud fires with the task named.
  const made = (await callTool(ownerToken, "task_create", { title: "Cloud task", brief: "Do the thing in example-repo.", owner: OWNER, repo: "example-repo", assignee: OWNER_CLOUD })).content[0].text;
  const key = made.match(/^Created (T-\d+) /)[1];
  assert.match(made, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}`, ""));
  assert.match(fakeRoutines.fires.at(-1).text, new RegExp(`Bridge task ${key}: "Cloud task".*task_done ${key}`));
  // 3. task_update assigning an existing task to alice-cloud fires too; other changes do not.
  const made2 = (await callTool(ownerToken, "task_create", { title: "Later cloud task", brief: "Later.", owner: OWNER, repo: "example-repo" })).content[0].text;
  const key2 = made2.match(/^Created (T-\d+) /)[1];
  const n = fakeRoutines.fires.length;
  await callTool(ownerToken, "task_update", { key: key2, priority: 3 });
  assert.equal(fakeRoutines.fires.length, n, "a priority change fires nothing");
  const assigned = (await callTool(ownerToken, "task_update", { key: key2, assignee: OWNER_CLOUD })).content[0].text;
  assert.match(assigned, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}`, ""));
  assert.equal(fakeRoutines.fires.length, n + 1);
  // 4. bob has no routine: a message to bob-cloud waits in its inbox as before, nothing fires.
  const quiet = await callTool(ownerToken, "bridge_send", { to: OTHER_CLOUD, subject: "No routine", body: "In example-repo, nothing to start." });
  assert.ok(!quiet.content[0].text.includes("Cloud session"));
  assert.equal(fakeRoutines.fires.length, n + 1);
  // 5. a failed fire is reported in the thread (by system, so it does not count as the device's reply), and the message stays in its inbox.
  const failed = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "Will fail", body: "MAKE-IT-FAIL in example-repo." });
  assert.match(failed.content[0].text, new RegExp(String.raw`${escapeRegex(OWNER_CLOUD)} could not start a cloud session \(rate limited\)`, ""));
  const failedThread = Number(failed.content[0].text.match(/thread (\d+)/)[1]);
  const failedMessages = (await rest(ownerToken, "GET", `/v1/threads/${failedThread}`)).body;
  assert.match(failedMessages[1].body, /could not start a cloud session/);
  assert.deepEqual(failedMessages[0].status, { [OWNER_CLOUD]: "unread" }, `the request itself is still unread for ${OWNER_CLOUD} after the notice`);
  assert.ok((await rest(ownerCloudToken, "GET", "/v1/inbox?peek=1")).body.some((m) => m.id === failedMessages[0].id), "and waits in its inbox");
  for (const k of [key, key2]) await callTool(ownerToken, "task_update", { key: k, state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken); await drain(otherCloudToken);
});

test("a cloud device with a session open gets the message in its inbox instead of a new session", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const before = fakeRoutines.fires.length;
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "follow-up", body: "One more thing." });
  assert.match(sent.content[0].text, new RegExp(String.raw`${escapeRegex(OWNER_CLOUD)} has a session open \(session [^)]+\); it picks this up from its inbox\.`, ""));
  assert.equal(fakeRoutines.fires.length, before, "nothing fired");
  const inbox = (await rest(ownerCloudToken, "GET", "/v1/inbox")).body;
  assert.ok(inbox.some((m) => m.body === "One more thing."), "the live session gets it");
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("new_session fires a fresh session even when a cloud session is live, and returns its session id", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken); await drain(otherCloudToken);
  // Make alice-cloud look live: it just polled its inbox.
  await drain(ownerCloudToken);
  const before = fakeRoutines.fires.length;
  const plain = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "plain", body: "Plain send." });
  assert.match(plain.content[0].text, /has a session open/);
  assert.equal(fakeRoutines.fires.length, before, "a plain send to a live name does not fire");
  const forced = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "isolated", body: "Own session please.", new_session: true });
  assert.match(forced.content[0].text, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}: https:\/\/claude\.ai\/code\/session_fake\d+ \(session session_fake\d+\)`, ""));
  assert.equal(fakeRoutines.fires.length, before + 1, "new_session fired despite the live session");
  const viaRest = await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "isolated rest", body: "Again.", new_session: true });
  assert.equal(viaRest.body.cloud.forced, true);
  assert.match(viaRest.body.cloud.session_id, /^session_fake\d+$/);
  assert.equal(fakeRoutines.fires.length, before + 2);
  // No routine for bob: the flag errors loudly instead of silently queueing.
  const none = await callTool(ownerToken, "bridge_send", { to: OTHER_CLOUD, subject: "no routine", body: "x", new_session: true });
  assert.match(none.content[0].text, /could not start a cloud session \(new_session needs/);
  assert.equal(fakeRoutines.fires.length, before + 2);
  await drain(ownerToken); await drain(ownerCloudToken); await drain(otherCloudToken);
});

test("a session live on task A does not swallow a send for task B: B cold-starts its own session", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const session = `cse_${randomBytes(8).toString("hex")}`;
  const as = async (method, path, body) => (await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json();
  const make = async (title) => (await rest(ownerToken, "POST", "/v1/tasks", { title, brief: "Routing test.", owner: OWNER, repo: REPO })).body.key;
  const a = await make("Task A"); const b = await make("Task B");
  await as("PATCH", `/v1/tasks/${a}`, { state: "claim" });
  const child = (await as("GET", "/v1/me")).member;
  const before = fakeRoutines.fires.length;
  // A send about A is routed to the session holding A, and names it.
  const forA = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${a}: follow-up`, body: "More on A." });
  assert.match(forA.content[0].text, new RegExp(`session open \\(session ${child}\\)`));
  assert.equal(fakeRoutines.fires.length, before, "A's session takes A's message");
  // A send about B is not: the only live session is busy on A, so B cold-starts its own. A's session polls the shared
  // inbox while that dispatch is in flight (SLOW-FIRE) and must not get B's message.
  const poll = as("GET", "/v1/inbox?wait=3");
  await sleep(300);
  const forB = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${b}: start`, body: "Do B. SLOW-FIRE" });
  assert.match(forB.content[0].text, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}: .*\(session session_fake\d+\)`, ""));
  assert.ok(!forB.content[0].text.includes("session open"), "not inbox-routed");
  assert.equal(fakeRoutines.fires.length, before + 1);
  const bId = Number(forB.content[0].text.match(/Sent message (\d+)/)[1]);
  const polled = await poll;
  assert.ok(Array.isArray(polled), JSON.stringify(polled));
  assert.ok(!polled.some((m) => m.id === bId), "the busy sibling did not take B's message during the dispatch");
  for (const k of [a, b]) await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
});

// T-67: the "session is live" notice used to be posted as the parent, and a post from the parent counts as its reply,
// so the request went from unread to done before any session had fetched it.
test("a send to a live cloud device stays unread until a session fetches it; the sender learns the session from the result", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const before = fakeRoutines.fires.length;
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "live notice", body: "Do not lose me." })).body;
  assert.equal(sent.cloud.live, true, "the result says a session is live");
  assert.ok(sent.cloud.session_id, "and names it");
  assert.equal(fakeRoutines.fires.length, before, "nothing fired");
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body;
  assert.equal(thread.length, 1, `no notice posted as ${OWNER_CLOUD}`);
  assert.deepEqual(thread[0].status, { [OWNER_CLOUD]: "unread" }, "the request is still unread");
  const peek = (await rest(ownerCloudToken, "GET", "/v1/inbox?peek=1")).body;
  assert.ok(peek.some((m) => m.id === sent.id), "still claimable from the inbox");
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a cloud child's reply still acknowledges what its parent was sent", async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const session = `cse_${randomBytes(8).toString("hex")}`;
  const as = async (method, path, body) => (await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json();
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "child ack", body: "Answer me." })).body;
  const got = await as("GET", "/v1/inbox");
  assert.ok(got.some((m) => m.id === sent.id), "the child fetches the parent's message");
  await as("POST", "/v1/send", { thread_id: sent.thread_id, body: "Answered." });
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body;
  assert.equal(thread[0].status[OWNER_CLOUD], "done", "the child's reply marks the parent's copy done");
  // End the session so later files do not see alice-cloud as live.
  await as("POST", "/v1/status", { state: "offline", summary: "session ended" });
  await drain(ownerToken); await drain(ownerCloudToken);
});

// T-50: per-child addressing. A message for a cloud parent used to be stored in the shared parent inbox before anything
// decided who should get it, so whichever child polled first took it.
const skipCloud = !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars";
const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
const asSession = (token, session) => async (method, path, body) => {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const endSessions = async (...callers) => { for (const c of callers) await c("POST", "/v1/status", { state: "offline", summary: "test over" }); };
const makeTask = async (title) => (await rest(ownerToken, "POST", "/v1/tasks", { title, brief: "Addressing test.", owner: OWNER, repo: REPO })).body.key;

test("new_session while a sibling long-polls: the sibling never gets it, the fired session does", { skip: skipCloud }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const sibling = asSession(ownerCloudToken, newSession());
  await sibling("GET", "/v1/me");
  const poll = sibling("GET", "/v1/inbox?wait=3");
  await sleep(300);
  const before = fakeRoutines.fires.length;
  const subject = `isolated race ${randomBytes(4).toString("hex")}`;
  const sending = rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject, body: "Mine alone. SLOW-FIRE", new_session: true });
  // While the routines API is still answering, a follow-up joins the thread (it is reserved for the fire, T-69).
  let threadId;
  while (!threadId) { await sleep(100); threadId = (await rest(ownerToken, "GET", "/v1/threads")).body.find((t) => t.subject === subject)?.thread_id; }
  const follow = (await rest(ownerToken, "POST", "/v1/send", { thread_id: threadId, body: "And one more thing." })).body;
  assert.equal(follow.cloud?.live, true, JSON.stringify(follow));
  const sent = (await sending).body;
  assert.equal(sent.cloud.forced, true, JSON.stringify(sent));
  const got = (await poll).body;
  assert.ok(!got.some((m) => m.id === sent.id), "the polling sibling did not take the new_session message");
  assert.equal(fakeRoutines.fires.length, before + 1, "exactly one session handles it");
  assert.match(fakeRoutines.fires.at(-1).text, new RegExp(`message ${sent.id} from ${OWNER}`), "the fired session has it");
  // The fired session checks in: it reads the thread it was fired for, and gets the follow-up in its own inbox.
  const fired = asSession(ownerCloudToken, sent.cloud.session_id.replace(/^session_/, "cse_"));
  assert.match((await fired("GET", "/v1/me")).body.member, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-`, ""));
  assert.ok((await fired("GET", `/v1/threads/${sent.thread_id}`)).body.some((m) => m.id === sent.id), "the fired session reads its message");
  assert.ok((await fired("GET", "/v1/inbox")).body.some((m) => m.id === follow.id), "the follow-up reached the fired session, unacked by the start notice");
  assert.ok(!(await sibling("GET", "/v1/inbox")).body.some((m) => m.id === follow.id), "never the sibling");
  await endSessions(sibling, fired);
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a task message to the cloud parent goes to the live claimant only, not to a sibling", { skip: skipCloud }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const claimant = asSession(ownerCloudToken, newSession()), sibling = asSession(ownerCloudToken, newSession());
  const key = await makeTask("Claimed by one child");
  assert.equal((await claimant("PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  const name = (await claimant("GET", "/v1/me")).body.member;
  await sibling("GET", "/v1/me");
  const before = fakeRoutines.fires.length;
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: follow-up`, body: "For the claimant." })).body;
  assert.equal(sent.recipient, name, "re-addressed to the session holding the claim");
  assert.equal(sent.cloud.session_id, name);
  assert.equal(fakeRoutines.fires.length, before);
  assert.ok(!(await sibling("GET", "/v1/inbox")).body.some((m) => m.id === sent.id), "the sibling never sees it");
  assert.ok((await claimant("GET", "/v1/inbox")).body.some((m) => m.id === sent.id), "the claimant does");
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await endSessions(claimant, sibling);
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a task held by a Mac session: a send to the cloud parent is refused with the session's name", { skip: skipCloud }, async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const mac = asSession(ownerDeviceToken, newSession());
  const key = await makeTask("Claimed on a Mac");
  assert.equal((await mac("PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  const name = (await mac("GET", "/v1/me")).body.member;
  assert.match(name, new RegExp(String.raw`^${escapeRegex(OWNER_DEVICE)}-`, ""));
  const before = fakeRoutines.fires.length;
  const sent = await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: follow-up`, body: "Who has it?" });
  assert.equal(sent.status, 400, JSON.stringify(sent.body));
  assert.match(sent.body.error, new RegExp(`${key} is held by ${name} \\(a Mac session\\)`));
  assert.equal(fakeRoutines.fires.length, before);
  // The Mac window goes quiet past the lease: the task stays reachable, the message waits in the cloud inbox with a note.
  const { claim_lease_seconds } = (await rest(ownerToken, "GET", "/v1/me")).body;
  await sleep(claim_lease_seconds * 1000 + 1000);
  const later = await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: follow-up`, body: "Still there?" });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(later.body.recipient, OWNER_CLOUD);
  assert.match(later.body.cloud.note, new RegExp(`${key} is held by ${name} \\(a Mac session, not seen for \\d+m\\); the message is left in ${OWNER_CLOUD}'s inbox`));
  assert.equal(fakeRoutines.fires.length, before);
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await endSessions(mac);
  await drain(ownerCloudToken);
});

test("a task claimed by a device with no session id (the responder) is held, not handed to a new cloud session", { skip: skipCloud }, async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const key = await makeTask("Claimed by the responder");
  assert.equal((await rest(ownerDeviceToken, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  await rest(ownerDeviceToken, "GET", "/v1/inbox?peek=1");
  const before = fakeRoutines.fires.length;
  const sent = await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: follow-up`, body: "Who has it?" });
  assert.equal(sent.status, 400, JSON.stringify(sent.body));
  assert.match(sent.body.error, new RegExp(`${key} is held by ${OWNER_DEVICE} \\(a device, not a cloud session\\)`));
  assert.equal(fakeRoutines.fires.length, before);
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
});

test("a session that dies or is killed hands back what was reserved or routed to it", { skip: skipCloud }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  // 1. A message that joined a starting fire is reserved for that session; the session checks in, then is killed unread.
  const first = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "hand back", body: "Start.", new_session: true })).body;
  assert.ok(first.cloud.url, JSON.stringify(first));
  const second = (await rest(ownerToken, "POST", "/v1/send", { thread_id: first.thread_id, body: "And this too." })).body;
  assert.equal(second.cloud.live, true, "joins the starting session");
  const fired = asSession(ownerCloudToken, first.cloud.session_id.replace(/^session_/, "cse_"));
  const firedName = (await fired("GET", "/v1/me")).body.member;
  const peek = async () => (await rest(ownerCloudToken, "GET", "/v1/inbox?peek=1")).body.map((m) => m.id);
  assert.ok(!(await peek()).includes(second.id), "reserved for the fired session");
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: firedName, reason: "test" })).body.killed, true);
  assert.ok((await peek()).includes(second.id), "back in the shared inbox after the kill");
  // 2. A task message routed to its claimant's own inbox goes back to the parent when that session is killed.
  const claimant = asSession(ownerCloudToken, newSession());
  const key = await makeTask("Routed then killed");
  assert.equal((await claimant("PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  const name = (await claimant("GET", "/v1/me")).body.member;
  const routed = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: more`, body: "For the claimant." })).body;
  assert.equal(routed.recipient, name);
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: name, reason: "test" })).body.killed, true);
  assert.ok((await peek()).includes(routed.id), "back in the shared inbox");
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  // 3. Killed before it ever checked in: what joined its fire is free again.
  const early = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "hand back early", body: "Start.", new_session: true })).body;
  const joined = (await rest(ownerToken, "POST", "/v1/send", { thread_id: early.thread_id, body: "Joins the fire." })).body;
  assert.equal(joined.cloud.live, true);
  assert.ok(!(await peek()).includes(joined.id), "reserved for the fire");
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: early.cloud.session_id, reason: "test" })).body.killed, true);
  assert.ok((await peek()).includes(joined.id), "back in the shared inbox after a kill before check-in");
  // 4. Posting offline, 5. silence past the lease, 6. a claim released by hand (the owner reassigned it) and then silence.
  const routedTo = async (title) => {
    const c = asSession(ownerCloudToken, newSession());
    const k = await makeTask(title);
    assert.equal((await c("PATCH", `/v1/tasks/${k}`, { state: "claim" })).status, 200);
    const n = (await c("GET", "/v1/me")).body.member;
    const m = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${k}: more`, body: `For ${title}.` })).body;
    assert.equal(m.recipient, n, `${title}: routed to the claimant`);
    return { c, k, m };
  };
  const off = await routedTo("offline");
  await off.c("POST", "/v1/status", { state: "offline", summary: "test over" });
  assert.ok((await peek()).includes(off.m.id), "back after offline");
  const silent = await routedTo("silent");
  const manual = await routedTo("released by hand");
  const version = (await rest(ownerToken, "GET", `/v1/tasks/${manual.k}`)).body.task.version;
  const reassigned = await rest(ownerToken, "PATCH", `/v1/tasks/${manual.k}`, { assignee: OWNER, expected_version: version });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
  assert.ok(!(await peek()).includes(manual.m.id), "a live child keeps what was routed to it after a manual release");
  const { claim_lease_seconds } = (await rest(ownerToken, "GET", "/v1/me")).body;
  await sleep(claim_lease_seconds * 1000 + 1000);
  await rest(ownerToken, "GET", "/v1/faults"); // a sweep
  assert.ok((await peek()).includes(silent.m.id), "back after silence past the lease");
  assert.ok((await peek()).includes(manual.m.id), "back once the hand-released child died too");
  for (const k of [off.k, silent.k, manual.k]) await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a task held by another person's cloud session does not make this person's cloud look live", { skip: skipCloud }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const tims = asSession(otherCloudToken, newSession());
  const key = await makeTask(`Claimed by ${OTHER}'s cloud`);
  // Ready: from outside alice's household, bob's session may claim only a ready task (T-60).
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "ready" });
  assert.equal((await tims("PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  const before = fakeRoutines.fires.length;
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${key}: yours now`, body: "Start on it." });
  assert.match(sent.content[0].text, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}`, ""));
  assert.equal(fakeRoutines.fires.length, before + 1);
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await endSessions(tims);
  await drain(ownerToken); await drain(ownerCloudToken); await drain(otherCloudToken);
});

test("a child is addressable for the whole lease; a killed or dead child is refused with when and why", { skip: skipCloud }, async () => {
  const { online_seconds, claim_lease_seconds } = (await rest(ownerToken, "GET", "/v1/me")).body;
  assert.ok(online_seconds < claim_lease_seconds, "tests need the online window shorter than the lease");
  const quiet = asSession(ownerCloudToken, newSession()), killed = asSession(ownerCloudToken, newSession());
  const quietName = (await quiet("GET", "/v1/me")).body.member;
  const killedName = (await killed("GET", "/v1/me")).body.member;
  await sleep(online_seconds * 1000 + 1000);
  const toQuiet = await rest(ownerToken, "POST", "/v1/send", { to: quietName, subject: "still there?", body: "Inside the lease." });
  assert.equal(toQuiet.status, 200, JSON.stringify(toQuiet.body));
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: killedName, reason: "test" })).body.killed, true);
  const toKilled = await rest(ownerToken, "POST", "/v1/send", { to: killedName, subject: "gone", body: "x" });
  assert.equal(toKilled.status, 400);
  assert.match(toKilled.body.error, new RegExp(`${killedName} was killed by ${OWNER}`));
  await sleep((claim_lease_seconds - online_seconds) * 1000 + 1000);
  const toDead = await rest(ownerToken, "POST", "/v1/send", { to: quietName, subject: "gone", body: "x" });
  assert.equal(toDead.status, 400);
  assert.match(toDead.body.error, new RegExp(`${quietName} is not live: last seen .* ago`));
  assert.match(toDead.body.error, new RegExp(String.raw`send to ${escapeRegex(OWNER_CLOUD)}`, ""));
  await drain(ownerToken); await drain(ownerCloudToken);
});

// T-69: a fire is recorded as an intent before the routines API is called, keyed by (parent, task or thread).
test("two sends at once for one unclaimed task start one session; the second joins it", { skip: skipCloud }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const key = await makeTask("Two at once");
  const send = (i) => rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: part ${i}`, body: `Part ${i}. SLOW-FIRE` });
  const [a, b] = await Promise.all([send(1), send(2)]);
  assert.equal(fakeRoutines.fires.filter((f) => f.text.includes(`Bridge task ${key}:`)).length, 1, "one session for the task");
  const started = [a, b].filter((r) => r.body.cloud?.url), joined = [a, b].filter((r) => r.body.cloud?.live);
  assert.equal(started.length, 1, JSON.stringify([a.body, b.body]));
  assert.equal(joined.length, 1);
  // The joining message waits for that session, not for any sibling.
  const sibling = asSession(ownerCloudToken, newSession());
  assert.ok(!(await sibling("GET", "/v1/inbox")).body.some((m) => m.id === joined[0].body.id));
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await endSessions(sibling);
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a fire that fails is recorded as a fault, not only posted", { skip: skipCloud }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "fail recorded", body: "MAKE-IT-FAIL please.", new_session: true })).body;
  assert.match(sent.cloud.error, /rate limited/);
  const f = (await rest(ownerToken, "GET", "/v1/faults")).body.fires.find((x) => x.thread_id === sent.thread_id);
  assert.equal(f?.fault, "fire_failed", "the failed fire is on record");
  assert.match(f.error, /rate limited/);
  assert.ok((await rest(ownerCloudToken, "GET", "/v1/inbox?peek=1")).body.some((m) => m.id === sent.id), "the message waits in the inbox");
  await drain(ownerToken); await drain(ownerCloudToken);
});
