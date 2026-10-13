import { CONTEXT_HEADER, GITHUB_OWNER, OWNER, OWNER_CLOUD, OWNER_DEVICE, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Per-claim liveness: a task claimed by a cloud session is stamped with that session and kept alive by its heartbeat.
// A claim with no heartbeat for the lease (GOONBRIDGE_CLAIM_LEASE_SECONDS, a few seconds in .dev.vars) is released, and a
// message about the task starts a new session even while a sibling session is active.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { devVars,  base, ownerToken, ownerDeviceToken, ownerCloudToken, rest, callTool, drain, sleep, useFakeRoutines  } from "./helpers.mjs";

const fakeRoutines = useFakeRoutines();
const skip = !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars";

const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
async function as(session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const lease = async () => (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
const getTask = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
async function claimed(session) {
  const name = (await as(session, "GET", "/v1/me")).body.member;
  const made = await rest(ownerToken, "POST", "/v1/tasks", { title: "Claim liveness", brief: "A task for the claim tests.", owner: OWNER, repo: REPO });
  const key = made.body.key;
  assert.equal((await as(session, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  return { name, key };
}
const cleanup = async (...keys) => {
  for (const k of keys) await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
};

test("a claim is stamped with the claiming session and stays while the session shows life", async () => {
  const ms = await lease();
  assert.ok(ms <= 10000, "set GOONBRIDGE_CLAIM_LEASE_SECONDS to a few seconds for tests");
  const s = newSession();
  const { name, key } = await claimed(s);
  let t = await getTask(key);
  assert.equal(t.claim_session, name);
  assert.equal(t.assignee, name);
  assert.ok(t.claim_beat_at > 0);
  // Poll for longer than the lease: every call is a heartbeat, so the claim holds.
  for (let i = 0; i < 3; i++) { await sleep(ms / 2 + 300); await as(s, "GET", "/v1/inbox"); }
  t = await getTask(key);
  assert.equal(t.state, "claimed");
  assert.equal(t.claim_session, name);
  await cleanup(key);
});

test("POST /v1/heartbeat keeps a claim alive between other calls", async () => {
  const ms = await lease();
  const s = newSession();
  const { name, key } = await claimed(s);
  for (let i = 0; i < 3; i++) { await sleep(ms / 2 + 300); assert.equal((await as(s, "POST", "/v1/heartbeat")).status, 200); }
  assert.equal((await getTask(key)).claim_session, name);
  await cleanup(key);
});

test("a claim with no heartbeat is released on the next look and goes back to the session's parent", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  await sleep(ms + 1000);
  const t = await getTask(key);
  assert.equal(t.state, "ready");
  assert.equal(t.assignee, OWNER_CLOUD);
  assert.equal(t.claim_session, null);
  const events = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.events;
  assert.ok(events.some((e) => e.kind === "released" && e.data.reason === "no heartbeat"));
  // A new session can claim it without expected_version.
  assert.equal((await as(newSession(), "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  await cleanup(key);
});

test("a claimant that goes silent is replaced by a new session even while a sibling session is active", { skip }, async () => {
  const ms = await lease();
  await drain(ownerToken); await drain(ownerCloudToken);
  const dead = newSession(), sibling = newSession();
  const { key } = await claimed(dead);
  await as(sibling, "GET", "/v1/inbox");
  const send = async (body) => (await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${key}: Claim liveness`, body })).content[0].text;
  const before = fakeRoutines.fires.length;
  assert.match(await send("while the claimant is alive"), /has a session open/);
  assert.equal(fakeRoutines.fires.length, before, "a live claimant gets it from its inbox");
  // The claimant dies; the sibling keeps polling, which used to keep the parent looking online.
  const until = Date.now() + ms + 1000;
  while (Date.now() < until) { await as(sibling, "GET", "/v1/inbox"); await sleep(500); }
  // The sibling long-polls while the replacement is being dispatched (SLOW-FIRE): it must not take the message.
  const poll = as(sibling, "GET", "/v1/inbox?wait=3");
  await sleep(300);
  const replaced = await send("claimant is gone SLOW-FIRE");
  assert.match(replaced, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}`, ""));
  assert.equal(fakeRoutines.fires.length, before + 1, "a fresh session was started");
  const id = Number(replaced.match(/Sent message (\d+)/)[1]);
  assert.ok(!(await poll).body.some((m) => m.id === id), "the sibling polling during the dispatch did not get it");
  assert.equal((await getTask(key)).claim_session, null);
  await cleanup(key);
});

test("posting offline gives up the session's claims at once", async () => {
  const s = newSession();
  const { key } = await claimed(s);
  await as(s, "POST", "/v1/status", { state: "offline", summary: "session ended" });
  const t = await getTask(key);
  assert.equal(t.state, "ready");
  assert.equal(t.claim_session, null);
  await cleanup(key);
});

test("a claim by a device with no heartbeat (a Mac) is never auto-released", async () => {
  const ms = await lease();
  const made = await rest(ownerToken, "POST", "/v1/tasks", { title: "Mac claim", brief: "Claimed from a Mac.", owner: OWNER, repo: REPO });
  const key = made.body.key;
  assert.equal((await rest(ownerDeviceToken, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  await sleep(ms + 1000);
  const t = await getTask(key);
  assert.equal(t.state, "claimed");
  assert.equal(t.assignee, OWNER_DEVICE);
  await cleanup(key);
});

// T-48: a release for silence can be false (one long tool call starves the heartbeat). The task keeps its PR link, so a
// later merge still finds it, and the same session coming back takes its claim back instead of being a stranger.
// Sessions that ended a test alive say so, or later files would see alice-cloud with a session open.
const offline = async (...sessions) => { for (const x of sessions) await as(x, "POST", "/v1/status", { state: "offline", summary: "test over" }); };
const orphaned = async (key, ms) => {
  const until = Date.now() + ms * 3;
  while (Date.now() < until) {
    const t = await getTask(key);
    if (t.orphaned_at) return t;
    await sleep(300);
  }
  assert.fail(`${key} was never orphaned`);
};
async function hook(payload) {
  const text = JSON.stringify(payload);
  const res = await fetch(new URL("/v1/github/webhook", base), {
    method: "POST", body: text,
    headers: {
      "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": randomBytes(8).toString("hex"),
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", (devVars.GOONBRIDGE_GITHUB_WEBHOOK_SECRET ?? "test-webhook-secret")).update(text).digest("hex")}`,
    },
  });
  return { status: res.status, body: await res.json() };
}

test("an orphan release keeps branch and pr_url, so a later merge of that PR still closes the task", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  const repo = `orph${Date.now()}`;
  const branch = `claude/busy-ride-${randomBytes(3).toString("hex")}`;
  const url = `https://github.com/${GITHUB_OWNER}/${repo}/pull/7`;
  const sha = randomBytes(20).toString("hex");
  assert.equal((await as(s, "PATCH", `/v1/tasks/${key}`, { state: "in_progress", repo: `${GITHUB_OWNER}/${repo}`, branch, pr_url: url })).status, 200);
  const t = await orphaned(key, ms);
  assert.equal(t.state, "ready");
  assert.equal(t.branch, branch, "release keeps the branch");
  assert.equal(t.pr_url, url, "release keeps the PR link");
  // The merge names no T-NN and comes from another branch name: only pr_url can match it.
  const res = await hook({
    action: "closed", repository: { full_name: `${GITHUB_OWNER}/${repo}`, default_branch: "main", owner: { login: GITHUB_OWNER } },
    pull_request: { number: 7, title: "A change", draft: false, html_url: url, merged: true, merge_commit_sha: sha, merged_by: { login: OWNER }, head: { ref: "claude/other-name" }, base: { ref: "main" } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.outcome, "done", JSON.stringify(res.body));
  const done = await getTask(key);
  assert.equal(done.state, "done");
  assert.equal(done.merged_sha, sha);
  await offline(s);
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("the same session coming back after an orphan release takes its claim back and clears the fault", async () => {
  const ms = await lease();
  const s = newSession();
  const { name, key } = await claimed(s);
  assert.equal((await as(s, "PATCH", `/v1/tasks/${key}`, { state: "in_progress" })).status, 200);
  await orphaned(key, ms);
  // Any bridge call from that session is the check-in; a heartbeat is the smallest one.
  assert.equal((await as(s, "POST", "/v1/heartbeat")).status, 200);
  const got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.state, "claimed", "the claim resumes as claimed; the session sets in_progress again itself");
  assert.equal(got.task.claim_session, name);
  assert.equal(got.task.assignee, name);
  assert.ok(got.task.claim_beat_at > 0);
  assert.equal(got.task.orphaned_at, null);
  assert.equal(got.task.orphaned_from, null);
  assert.equal(got.task.orphan_reason, null);
  assert.ok(!(await rest(ownerToken, "GET", "/v1/faults")).body.orphaned_tasks.some((t) => t.key === key), "the orphan fault is off the faults list");
  // (A fired session's died_without_reply fault is cleared the same way: test/verify-fixes.test.mjs and orphans.test.mjs.)
  assert.ok(got.events.some((e) => e.kind === "resurfaced" && e.data.session === name));
  assert.equal(got.claims[0].session, name);
  assert.equal(got.claims[0].ended_at, null, "a live claim row again");
  assert.equal(got.claims[1].end_reason, "orphaned: no heartbeat", "the history still shows the gap");
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${got.task.thread_id}`)).body;
  assert.equal(thread.filter((m) => m.body.startsWith(`session ${name} is back`)).length, 1, "one line in the task thread");
  // A second call does not resurface it again.
  await as(s, "GET", "/v1/inbox");
  const again = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(again.events.filter((e) => e.kind === "resurfaced").length, 1);
  await offline(s);
  await cleanup(key);
});

test("a different session claiming after an orphan release takes it as before; the old session does not take it back", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  await orphaned(key, ms);
  const other = newSession();
  const otherName = (await as(other, "GET", "/v1/me")).body.member;
  assert.equal((await as(other, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  let t = await getTask(key);
  assert.equal(t.claim_session, otherName);
  assert.equal(t.orphaned_at, null);
  // The first session wakes up later: the task is someone else's now, so nothing changes.
  await as(s, "POST", "/v1/heartbeat");
  t = await getTask(key);
  assert.equal(t.claim_session, otherName);
  assert.equal(t.state, "claimed");
  await offline(s, other);
  await cleanup(key);
});

test("the owner reassigning an orphaned task ends the mark; the old session coming back takes nothing", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  await orphaned(key, ms);
  assert.equal((await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { assignee: OWNER_DEVICE })).status, 200);
  let t = await getTask(key);
  assert.equal(t.orphaned_at, null, "a person's decision ends the orphan mark");
  await as(s, "POST", "/v1/heartbeat");
  t = await getTask(key);
  assert.equal(t.state, "ready");
  assert.equal(t.assignee, OWNER_DEVICE);
  assert.equal(t.claim_session, null);
  await offline(s);
  await cleanup(key);
});

test("a session line (the per-turn hook, posted as the person) also brings an orphaned session back", async () => {
  const ms = await lease();
  const s = newSession();
  const { name, key } = await claimed(s);
  await orphaned(key, ms);
  assert.equal((await rest(ownerToken, "POST", "/v1/sessions", { session: s, line: "still working" })).status, 200);
  const t = await getTask(key);
  assert.equal(t.state, "claimed");
  assert.equal(t.claim_session, name);
  assert.equal(t.orphaned_at, null);
  await offline(s);
  await cleanup(key);
});

test("a session posting offline inside the window is not brought back first", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  await orphaned(key, ms);
  await offline(s);
  const got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.state, "ready");
  assert.equal(got.task.claim_session, null);
  assert.ok(!got.events.some((e) => e.kind === "resurfaced"));
  await cleanup(key);
});

test("posting \" Offline\" (any case, padded) after an orphan release is the same: nothing is brought back", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  await orphaned(key, ms);
  assert.equal((await as(s, "POST", "/v1/status", { state: " Offline", summary: "test over" })).status, 200);
  const got = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
  assert.equal(got.task.claim_session, null);
  assert.ok(!got.events.some((e) => e.kind === "resurfaced"), "no resurface, so no second fault");
  await cleanup(key);
});

// T-49: the lease is judged on the session's own evidence (cloud_devices.seen_at, refreshed by any identified call) for
// every open claim state. A claim in review or blocked used to get no heartbeat and was never released; and a push to a
// PR in review (synchronize) moved it back to in_progress with a stale heartbeat, so the next sweep orphaned a live session.
const pr = (repo, n, action, head) => ({
  action, repository: { full_name: `${GITHUB_OWNER}/${repo}`, default_branch: "main", owner: { login: GITHUB_OWNER } },
  pull_request: { number: n, title: "A change", draft: false, html_url: `https://github.com/${GITHUB_OWNER}/${repo}/pull/${n}`, merged: false, merge_commit_sha: null, merged_by: null, head: { ref: head }, base: { ref: "main" } },
});

test("a live session's claim in review survives a push (synchronize) that moves it back to in_progress", async () => {
  const ms = await lease();
  const s = newSession();
  const { name, key } = await claimed(s);
  const repo = `sync${Date.now()}`;
  const branch = `claude/sync-${randomBytes(3).toString("hex")}`;
  assert.equal((await as(s, "PATCH", `/v1/tasks/${key}`, { state: "in_progress", repo: `${GITHUB_OWNER}/${repo}`, branch })).status, 200);
  const opened = await hook(pr(repo, 3, "opened", branch));
  assert.equal(opened.body.outcome, "review", JSON.stringify(opened.body));
  // The session stays alive for longer than the lease while its PR is in review.
  for (let i = 0; i < 3; i++) { await sleep(ms / 2 + 300); assert.equal((await as(s, "POST", "/v1/heartbeat")).status, 200); }
  const pushed = await hook(pr(repo, 3, "synchronize", branch));
  assert.equal(pushed.body.outcome, "review_stale", JSON.stringify(pushed.body));
  const t = await getTask(key);
  assert.equal(t.state, "in_progress", "a live session keeps its claim after the push");
  assert.equal(t.claim_session, name);
  assert.equal(t.orphaned_at, null);
  await offline(s);
  await cleanup(key);
});

test("a blocked claim is released for silence like a working one, keeping its PR link", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  const url = `https://github.com/${GITHUB_OWNER}/rel${Date.now()}/pull/1`;
  assert.equal((await as(s, "PATCH", `/v1/tasks/${key}`, { state: "blocked", pr_url: url })).status, 200);
  const t = await orphaned(key, ms);
  assert.equal(t.state, "ready");
  assert.equal(t.claim_session, null);
  assert.equal(t.pr_url, url);
  await cleanup(key);
});

// A session whose PR is up for review is done with its part; going quiet then is the normal end, not a fault. The claim
// stays in review; a push that moves the task back to in_progress makes it work again, and then silence releases it.
test("a silent session's claim in review is no fault; after a push it is released like any working claim", async () => {
  const ms = await lease();
  const s = newSession();
  const { key } = await claimed(s);
  const repo = `quiet${Date.now()}`;
  const branch = `claude/quiet-${randomBytes(3).toString("hex")}`;
  assert.equal((await as(s, "PATCH", `/v1/tasks/${key}`, { state: "in_progress", repo: `${GITHUB_OWNER}/${repo}`, branch })).status, 200);
  assert.equal((await hook(pr(repo, 4, "opened", branch))).body.outcome, "review");
  await sleep(ms + 1500);
  let t = await getTask(key);
  assert.equal(t.state, "review");
  assert.equal(t.orphaned_at, null, "a quiet session in review is not an orphan");
  assert.equal((await hook(pr(repo, 4, "synchronize", branch))).body.outcome, "review_stale");
  t = await orphaned(key, ms);
  assert.equal(t.state, "ready");
  assert.equal(t.claim_session, null);
  await cleanup(key);
});

// T-69 (closes a T-48 gap): once a replacement session is fired for an orphaned task, the old session coming back must
// not take the claim first; the work is the fresh session's now.
test("after a replacement is fired for an orphaned task, the old session coming back does not take it", { skip }, async () => {
  const ms = await lease();
  await drain(ownerToken); await drain(ownerCloudToken);
  const s = newSession();
  const { key } = await claimed(s);
  await orphaned(key, ms);
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${key}: Claim liveness`, body: "Pick it up again." });
  assert.match(sent.content[0].text, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}`, ""));
  assert.equal((await as(s, "POST", "/v1/heartbeat")).status, 200);
  const t = await getTask(key);
  assert.equal(t.state, "ready", "still waiting for the fired session");
  assert.equal(t.claim_session, null);
  await offline(s);
  await cleanup(key);
});

test("a replacement fire that failed does not stop the old session taking its claim back", { skip }, async () => {
  const ms = await lease();
  await drain(ownerToken); await drain(ownerCloudToken);
  const s = newSession();
  const { name, key } = await claimed(s);
  await orphaned(key, ms);
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${key}: Claim liveness`, body: "Pick it up again. MAKE-IT-FAIL" });
  assert.match(sent.content[0].text, /could not start a cloud session/);
  assert.ok((await rest(ownerToken, "GET", "/v1/faults")).body.fires.some((f) => f.task_key === key && f.fault === "fire_failed"), "the replacement is faulted");
  assert.equal((await as(s, "POST", "/v1/heartbeat")).status, 200);
  const t = await getTask(key);
  assert.equal(t.claim_session, name, "a faulted replacement starts no session, so the old one takes it back");
  assert.equal(t.state, "claimed");
  await offline(s);
  await cleanup(key);
});

test("a session making only heartbeat calls reads online on the board, as it does in bridge_sessions", async () => {
  const s = newSession();
  const beat = await as(s, "POST", "/v1/heartbeat");
  assert.equal(beat.status, 200);
  const name = beat.body.member;
  const row = (await rest(ownerToken, "GET", "/v1/status")).body.find((r) => r.member === name);
  assert.ok(row, `${name} is on the board`);
  assert.equal(row.online, true, "the board reads the session's own evidence, not only inbox polls and status posts");
  await offline(s);
});

// Liveness from several signals, never one (T-28): tool and call mean working, process (the in-run loop) or inbox reads
// alone mean idle, nothing means dead (the release tests above).

test("a session with only process beats is idle: it keeps its claim, but a task message is not routed to it", { skip }, async () => {
  const ms = await lease();
  await drain(ownerToken); await drain(ownerCloudToken);
  const s = newSession();
  const { name, key } = await claimed(s);
  // The agent stops acting; only the loop says the process lives.
  const until = Date.now() + ms + 1500;
  while (Date.now() < until) { assert.equal((await as(s, "POST", "/v1/heartbeat?signal=process")).status, 200); await sleep(1000); }
  const t = await getTask(key);
  assert.equal(t.state, "claimed", "idle is not dead: the claim is kept");
  assert.equal(t.claim_session, name);
  const lane = (await rest(ownerToken, "GET", "/v1/sessions")).body.find((r) => r.session === s);
  assert.match(lane?.liveness ?? "", /^idle: .*process \d+s/);
  const before = fakeRoutines.fires.length;
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: `Task ${key}: Claim liveness`, body: "Anyone?" })).body;
  assert.equal(sent.recipient, OWNER_CLOUD, "left in the shared inbox, not routed into the idle session's own");
  assert.match(sent.cloud.note, new RegExp(`session ${name} is idle \\(alive, no tool activity for \\d+m\\)`));
  assert.equal(fakeRoutines.fires.length, before, "and no second session for a claimed task");
  // Addressed directly by name, it is not reachable: only a call (not the process beat) keeps a child addressable.
  const direct = await rest(ownerToken, "POST", "/v1/send", { to: name, subject: "direct", body: "Are you there?" });
  assert.equal(direct.status, 400, JSON.stringify(direct.body));
  assert.match(direct.body.error, new RegExp(`${name} is not live`));
  // A tool finishing makes it working again.
  await as(s, "POST", "/v1/heartbeat");
  const working = (await rest(ownerToken, "GET", "/v1/sessions")).body.find((r) => r.session === s);
  assert.match(working.liveness, /^working: tool \d+s/);
  await offline(s);
  await cleanup(key);
});

test("a blocked claim of a session that posts offline is dropped quietly; the task stays blocked", async () => {
  await drain(ownerToken);
  const s = newSession();
  const { key } = await claimed(s);
  assert.equal((await as(s, "PATCH", `/v1/tasks/${key}`, { state: "blocked" })).status, 200);
  await offline(s);
  const t = await getTask(key);
  assert.equal(t.state, "blocked");
  assert.equal(t.claim_session, null);
  assert.equal(t.orphaned_at, null);
  assert.ok(!(await rest(ownerToken, "GET", "/v1/inbox")).body.some((m) => m.body.startsWith(`FAULT orphaned: ${key}`)), "no fault for a parked task");
  await cleanup(key);
});
