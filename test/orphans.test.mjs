import { CONTEXT_HEADER, OWNER, OWNER_CLOUD, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// T-21: a claim is recorded against the session that holds it, and a task whose session dies is surfaced as an
// orphan (back to ready, flagged, owner told), not left reading as claimed or done. A fired session that never boots,
// or dies without replying, is a fault too, not a clean finish. Needs GOONBRIDGE_CLAIM_LEASE_SECONDS and
// GOONBRIDGE_BOOT_SECONDS of a few seconds in .dev.vars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base, ownerToken, ownerCloudToken, rest, callTool, drain, sleep, serverWindows, useFakeRoutines } from "./helpers.mjs";

const fakeRoutines = useFakeRoutines();
const skip = !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars";

// A request as the cloud session that the routines API named `sessionId` (its Goonbridge-Session header carries a cse_ id).
async function as(sessionId, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: sessionId.replace(/^session_/, "cse_"), [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const pastOnline = async () => sleep(((await serverWindows()).online_seconds ?? 4) * 1000 + 1000);
const sessionIn = (text) => text.match(/session_fake\d+/)[0];
const faults = async () => (await rest(ownerToken, "GET", "/v1/faults")).body;

test("a task whose session dies is orphaned and flagged, not left claimed or done", { skip }, async () => {
  const lease = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  assert.ok(lease <= 10000, "set GOONBRIDGE_CLAIM_LEASE_SECONDS to a few seconds for tests");
  await drain(ownerToken); await drain(ownerCloudToken);
  await pastOnline();

  // Start a session for a task through the bridge, as production does.
  const made = (await callTool(ownerToken, "task_create", { title: "Orphan me", brief: "Acceptance test for T-21.", owner: OWNER, repo: REPO, assignee: OWNER_CLOUD, branch: `claude/orphan-${Date.now()}` })).content[0].text;
  const key = made.match(/^Created (T-\d+) /)[1];
  const sessionId = sessionIn(made);

  // The session boots (first bridge call), which ties the fire to its child device, then claims the task.
  const me = await as(sessionId, "GET", "/v1/me");
  const child = me.body.member;
  assert.match(child, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-[a-z0-9]+-${REPO}$`, ""));
  assert.equal((await as(sessionId, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);

  // 1. The association is recorded durably, not just in a status string.
  let got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.claim_session, child);
  assert.equal(got.claims[0].session, child);
  assert.equal(got.claims[0].ended_at, null);
  assert.equal(got.task.orphaned_at, null);
  assert.deepEqual((await faults()).fires.filter((f) => f.session_id === sessionId), [], "a booted session is no fault");

  // 2. The session is killed: it makes no more calls. After the lease the task is orphaned, with no one asking:
  // the hub's alarm sweeps, and the owner's inbox gets the fault.
  await sleep(lease + 4000);
  const inbox = (await rest(ownerToken, "GET", "/v1/inbox")).body;
  assert.ok(inbox.some((m) => m.body.startsWith(`FAULT orphaned: ${key}`)), "the owner was told, by the alarm, with no read of the task");
  assert.ok(inbox.some((m) => m.body.startsWith("FAULT died_without_reply") && m.body.includes(child)), "the fire is flagged as a session that died without replying");

  // 3. The task reads orphaned, not claimed and not done, and the claim record says how it ended.
  got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.state, "ready");
  assert.match(got.task.branch, /^claude\/orphan-\d+$/, "a released task keeps its branch: the release may be false and the PR still live (T-48)");
  assert.equal(got.task.assignee, OWNER_CLOUD);
  assert.equal(got.task.claim_session, null);
  assert.equal(got.task.orphaned_from, child);
  assert.ok(got.task.orphaned_at > 0);
  assert.equal(got.claims[0].end_reason, "orphaned: no heartbeat");
  assert.ok(got.events.some((e) => e.kind === "orphaned" && e.data.was === child));
  const f = await faults();
  assert.ok(f.orphaned_tasks.some((t) => t.key === key && t.orphaned_from === child && t.state === "ready"));
  assert.ok(f.fires.some((x) => x.session_id === sessionId && x.fault === "died_without_reply"));

  // 4. A new session claiming it clears the orphan mark; finishing it closes the record.
  await drain(ownerToken);
  // A fresh id each run: the dev state outlives a run, and a reused session would carry its old anchor and claims.
  const next = `session_fake9${Date.now()}`;
  const reclaimed = await as(next, "PATCH", `/v1/tasks/${key}`, { state: "claim" });
  assert.equal(reclaimed.status, 200, JSON.stringify(reclaimed.body));
  got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.orphaned_at, null);
  assert.equal(got.claims.length, 2);
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  // The replacement session ends here. Left alive, it reads as alice-cloud's live session for a whole lease, and the
  // next test's send would go to its inbox instead of firing a session.
  await as(next, "POST", "/v1/status", { state: "offline", summary: "test over" });
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a fired session that never boots is a fault, not a finished request", { skip }, async () => {
  const boot = (await rest(ownerToken, "GET", "/v1/me")).body.boot_seconds * 1000;
  assert.ok(boot <= 10000, "set GOONBRIDGE_BOOT_SECONDS to a few seconds for tests");
  await drain(ownerToken); await drain(ownerCloudToken);
  await pastOnline();
  const sent = (await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "Never boots", body: "In this repo, do a thing." })).content[0].text;
  const sessionId = sessionIn(sent);
  const thread = Number(sent.match(/thread (\d+)/)[1]);
  // The fire message is marked done at fire time; that alone must not read as a clean finish.
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/threads/${thread}`)).body[0].status, { [OWNER_CLOUD]: "done" });
  await sleep(boot + 4000);
  const inbox = (await rest(ownerToken, "GET", "/v1/inbox")).body;
  assert.ok(inbox.some((m) => m.thread_id === thread && m.body.startsWith("FAULT never_started")), "the requester is told the session never booted");
  assert.ok((await faults()).fires.some((x) => x.session_id === sessionId && x.fault === "never_started"));
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a session that replies is a clean finish, not a fault", { skip }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  await pastOnline();
  const sent = (await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "Clean finish", body: "In this repo, say hi." })).content[0].text;
  const sessionId = sessionIn(sent);
  const thread = Number(sent.match(/thread (\d+)/)[1]);
  assert.equal((await as(sessionId, "POST", "/v1/send", { thread_id: thread, to: OWNER, body: "hi" })).status, 200);
  const lease = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  await sleep(lease + 4000);
  assert.ok(!(await faults()).fires.some((x) => x.session_id === sessionId));
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a fired session that went silent and comes back gets its claim back and its died_without_reply fault cleared", { skip }, async () => {
  const lease = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  await drain(ownerToken); await drain(ownerCloudToken);
  await pastOnline();
  const made = (await callTool(ownerToken, "task_create", { title: "Resurface me", brief: "Acceptance test for T-48.", owner: OWNER, repo: REPO, assignee: OWNER_CLOUD })).content[0].text;
  const key = made.match(/^Created (T-\d+) /)[1];
  const sessionId = sessionIn(made);
  const child = (await as(sessionId, "GET", "/v1/me")).body.member;
  assert.equal((await as(sessionId, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  // One long tool call: no heartbeat past the lease. Wait until both faults are on record, then the session speaks again.
  const until = Date.now() + lease * 3;
  let f;
  while (Date.now() < until) {
    f = await faults();
    if (f.orphaned_tasks.some((t) => t.key === key) && f.fires.some((x) => x.session_id === sessionId && x.fault === "died_without_reply")) break;
    await sleep(300);
  }
  assert.ok(f.fires.some((x) => x.session_id === sessionId && x.fault === "died_without_reply"), "the silence was flagged first");
  const before = fakeRoutines.fires.length;
  assert.equal((await as(sessionId, "POST", "/v1/heartbeat")).status, 200);
  const got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.state, "claimed");
  assert.equal(got.task.claim_session, child);
  assert.equal(got.task.orphaned_at, null);
  f = await faults();
  assert.ok(!f.orphaned_tasks.some((t) => t.key === key), "no longer an orphan");
  assert.ok(!f.fires.some((x) => x.session_id === sessionId), "the fire fault is cleared");
  assert.ok(got.events.some((e) => e.kind === "resurfaced"));
  assert.equal(fakeRoutines.fires.length, before, "a resurfaced session fires nothing");
  await as(sessionId, "POST", "/v1/status", { state: "offline", summary: "test over" });
  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
});
