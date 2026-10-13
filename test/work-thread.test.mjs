import { CONTEXT_HEADER, OTHER, OWNER, OWNER_CLOUD, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Work threads (T-58): a fire with no task behind it whose text talks about merges, PRs, branches, deploys, pushes or
// reverts is flagged. The bridge asks in the thread for a task, and a `task: T-n` or `task: new` reply attaches one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base, ownerToken, ownerDeviceToken, ownerCloudToken, otherToken, otherDeviceToken, rest, callTool, drain, useFakeRoutines, sleep, serverWindows } from "./helpers.mjs";

// A call as a cloud session with this session id (the fired session's first check-in).
async function asSession(token, session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: "wt" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const pastOnline = async () => sleep(((await serverWindows()).online_seconds ?? 4) * 1000 + 1000);
const fakeRoutines = useFakeRoutines();
const skip = !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars";
const PROMPT = "no task backs this; reply `task: T-n` to attach or `task: new` to create one";
const made = [];

// A fresh session each time (new_session), so a live child from another test never swallows the send.
async function fire(body) {
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, body, new_session: true });
  assert.ok(!sent.isError, sent.content[0].text);
  const threadId = Number(sent.content[0].text.match(/thread (\d+)/)[1]);
  return { threadId, thread: (await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body };
}
const fireRow = async (threadId) => (await rest(ownerToken, "GET", "/v1/faults")).body.work_threads.find((w) => w.thread_id === threadId);

test("a bare send about a merge gets the system note and is flagged a work thread", { skip }, async () => {
  await pastOnline();
  const { threadId, thread } = await fire(`Merge PR #12 on example-repo once CI is green (${Date.now()}).`);
  const note = thread.find((m) => m.sender === "system" && !m.body.startsWith("started cloud session"));
  assert.ok(note, JSON.stringify(thread));
  assert.equal(note.body, PROMPT);
  assert.equal(note.recipient, OWNER);
  const row = await fireRow(threadId);
  assert.ok(row, "listed in faults.work_threads");
  assert.equal(row.task_key, null);
});

test("a send without those words gets no note and no flag", { skip }, async () => {
  const { threadId, thread } = await fire(`What does the SyncEngine backoff do? (${Date.now()})`);
  // (The "started cloud session" notice is from system too, T-67; only the work-thread prompt must be absent.)
  assert.ok(!thread.some((m) => m.sender === "system" && m.body === PROMPT), JSON.stringify(thread));
  assert.equal(await fireRow(threadId), undefined);
});

test("`task: T-n` in the thread attaches the task to the fire", { skip }, async () => {
  const t = (await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Attach me", brief: "Merge it.", state: "ready", repo: `wt-${Date.now()}` })).body;
  made.push(t.key);
  const { threadId } = await fire(`Push the branch for the fix (${Date.now()}).`);
  const reply = await callTool(ownerToken, "bridge_send", { thread_id: threadId, body: `task: ${t.key}` });
  assert.ok(!reply.isError, reply.content[0].text);
  assert.match(reply.content[0].text, new RegExp(`Attached ${t.key}`));
  assert.equal((await fireRow(threadId)).task_key, t.key);
});

test("`task: new` creates a ready task from the thread's first message, owned by the requester, and attaches it", { skip }, async () => {
  const body = `Deploy the worker after the revert (${Date.now()}).`;
  const { threadId } = await fire(body);
  const reply = await callTool(ownerToken, "bridge_send", { thread_id: threadId, body: "task: new" });
  assert.ok(!reply.isError, reply.content[0].text);
  const key = reply.content[0].text.match(/Attached (T-\d+)/)?.[1];
  assert.ok(key, reply.content[0].text);
  made.push(key);
  const task = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
  assert.equal(task.owner, OWNER);
  assert.equal(task.state, "ready");
  assert.equal(task.brief, body);
  assert.equal((await fireRow(threadId)).task_key, key);
});

test("the regex: inflected work words count; push notifications and plain questions do not", { skip }, async () => {
  for (const body of [`Merged it? Then deploying is next (${Date.now()}).`, `Two PRs need a look (${Date.now()}).`]) {
    const { threadId } = await fire(body);
    assert.ok(await fireRow(threadId), body);
  }
  const { threadId } = await fire(`Why do push notifications arrive late on iOS? (${Date.now()})`);
  assert.equal(await fireRow(threadId), undefined);
});

test("a `task:` reply acks nothing: what the session asked the requester stays unread, and it is no session reply", { skip }, async () => {
  await drain(ownerToken);
  const { threadId } = await fire(`Merge the fix branch (${Date.now()}).`);
  const s = (await fireRow(threadId)).session_id.replace(/^session_/, "cse_");
  const question = await asSession(ownerCloudToken, s, "POST", "/v1/send", { thread_id: threadId, to: OWNER, body: "Which base branch?" });
  assert.equal(question.status, 200, JSON.stringify(question.body));
  const reply = await callTool(ownerToken, "bridge_send", { thread_id: threadId, body: "task: new" });
  assert.match(reply.content[0].text, /Attached T-\d+/);
  made.push(reply.content[0].text.match(/Attached (T-\d+)/)[1]);
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body;
  const asked = thread.find((m) => m.id === question.body.id);
  assert.equal(asked.status[OWNER], "unread", `the session's question is still waiting for ${OWNER}`);
  assert.ok(!thread.some((m) => m.sender === OWNER && /^task:/.test(m.body)), `the command is not stored as ${OWNER}'s message`);
  const record = thread.at(-1);
  assert.equal(record.sender, "system");
  assert.equal(record.status[OWNER], "done");
  // "No session reply": the command adds nothing from the session; its question is its only message here, and that is
  // what the fault sweep counts. Past the lease the fire is judged on it: replied, so no died_without_reply.
  const child = (await asSession(ownerCloudToken, s, "GET", "/v1/me")).body.member;
  assert.deepEqual(thread.filter((m) => m.sender === child).map((m) => m.id), [question.body.id], "only the session's own question is from the session");
  const { claim_lease_seconds } = (await rest(ownerToken, "GET", "/v1/me")).body;
  await sleep(claim_lease_seconds * 1000 + 1000);
  const fires = (await rest(ownerToken, "GET", "/v1/faults")).body.fires;
  assert.ok(!fires.some((f) => f.thread_id === threadId && f.fault === "died_without_reply"), "classified as replied (by its question), not died_without_reply");
  await asSession(ownerCloudToken, s, "POST", "/v1/status", { state: "offline", summary: "test over" });
  await drain(ownerToken);
});

test("only the requester's household attaches, and `task: T-n` must be an open task of theirs", { skip }, async () => {
  const { threadId } = await fire(`Deploy the worker (${Date.now()}).`);
  // bob (another person) cannot attach, by device or as a person.
  const outsider = await callTool(otherDeviceToken, "bridge_send", { thread_id: threadId, body: "task: new" });
  assert.equal(outsider.isError, true);
  const timsTask = (await rest(otherToken, "POST", "/v1/tasks", { owner: OTHER, title: `${OTHER}'s`, brief: "x", state: "ready" })).body;
  made.push(timsTask.key);
  const foreign = await callTool(ownerToken, "bridge_send", { thread_id: threadId, body: `task: ${timsTask.key}` });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, new RegExp(String.raw`open task of ${escapeRegex(OWNER)}`, ""));
  const closed = (await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Closed", brief: "x", state: "dropped" })).body;
  assert.match((await callTool(ownerToken, "bridge_send", { thread_id: threadId, body: `task: ${closed.key}` })).content[0].text, new RegExp(String.raw`open task of ${escapeRegex(OWNER)}`, ""));
  // A device of the requester's person may.
  const ok = await callTool(ownerDeviceToken, "bridge_send", { thread_id: threadId, body: "task: new" });
  assert.match(ok.content[0].text, /Attached T-\d+/);
  made.push(ok.content[0].text.match(/Attached (T-\d+)/)[1]);
});

test("a cloud child sending `task: new` is refused unless its person asked for the fire", { skip }, async () => {
  const sent = await callTool(otherToken, "bridge_send", { to: OWNER_CLOUD, body: `Push the hotfix branch (${Date.now()}).`, new_session: true });
  const threadId = Number(sent.content[0].text.match(/thread (\d+)/)[1]);
  assert.ok(await fireRow(threadId), "flagged");
  const s = (await fireRow(threadId)).session_id.replace(/^session_/, "cse_");
  const child = await asSession(ownerCloudToken, s, "POST", "/v1/send", { thread_id: threadId, body: "task: new" });
  assert.equal(child.status, 400, JSON.stringify(child.body));
  assert.match(child.body.error, new RegExp(String.raw`only ${escapeRegex(OTHER)}`, ""));
  await asSession(ownerCloudToken, s, "POST", "/v1/status", { state: "offline", summary: "test over" });
  await drain(otherToken);
});

test("a task attached before the fired session checks in is claimed at its first call", { skip }, async () => {
  const { threadId } = await fire(`Revert the bad deploy (${Date.now()}).`);
  const t = (await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Claim on check-in", brief: "x", state: "ready", repo: `wt-claim-${Date.now()}` })).body;
  made.push(t.key);
  const reply = await callTool(ownerToken, "bridge_send", { thread_id: threadId, body: `task: ${t.key}` });
  assert.doesNotMatch(reply.content[0].text, /holds the claim/, "nobody to claim it yet");
  const s = (await fireRow(threadId)).session_id.replace(/^session_/, "cse_");
  await asSession(ownerCloudToken, s, "GET", "/v1/me");
  const task = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.task;
  assert.equal(task.state, "claimed");
  assert.match(task.claim_session, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-`, ""));
  await asSession(ownerCloudToken, s, "POST", "/v1/status", { state: "offline", summary: "test over" });
});

test("cleanup", async () => {
  for (const k of made) await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
});
