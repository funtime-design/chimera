import { GITHUB_OWNER, OTHER, OWNER, OWNER_CLOUD } from "./harness/roles.mjs";
// Defects from the 2026-10-11 independent verification (T-66), each reproduced against the real Hub on an in-memory
// SQLite (test/hub-memory.mjs): the races and timings here cannot be held open over HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, memoryHub, noSqlite, MEMBERS, ROSTER, sleep } from "./hub-memory.mjs";

const skip = noSqlite;
// A call as a cloud session: identify() is what every Worker request does first.
const as = async (hub, session, signal = "call", parent = OWNER_CLOUD) => (await hub.identify(parent, session, "test", ROSTER, 4000, false, signal)).member;

test("DEFECT 1: a session that checks in before recordFire is linked when the fire is recorded", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const child = await as(hub, "cse_0123456789abcdef");
  await hub.recordFire({ member: OWNER_CLOUD, requester: OWNER, message_id: 0, thread_id: 0, task_key: null, session_id: "session_0123456789abcdef", url: "https://example.test/s" });
  await sleep(1200);
  const f = await hub.faults();
  assert.ok(!f.fires.some((x) => x.fault === "never_started"), JSON.stringify(f.fires));
  assert.equal(sql.exec("SELECT child FROM cloud_fires").one().child, child);
});

// A PR opened on a task in progress: the hub reserves one reviewer and returns the request.
let prN = 700;
async function openedPr(hub, fields = {}) {
  const repo = `${GITHUB_OWNER}/vf${Date.now()}${++prN}`;
  const branch = `claude/vf-${prN}`;
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "Review me", brief: "Do it.", repo, branch, state: "in_progress", ...fields });
  const pr = { number: prN, title: "A change", html_url: `https://github.com/${repo}/pull/${prN}`, draft: false, merged: false, merge_commit_sha: null, merged_by: null, head_ref: branch, base_ref: "main", head_sha: `sha${prN}a` };
  let d = 0;
  const event = (action, head = pr.head_sha) => ({ kind: "pr", action, repo: { full_name: repo, default_branch: "main" }, pr: { ...pr, head_sha: head }, label: null });
  const send = (action, head) => hub.githubEvent(MEMBERS, `d-${pr.number}-${++d}`, event(action, head));
  const out = await send("opened");
  return { task, pr, send, review: out.review };
}
const routinesEnv = { GOONBRIDGE_ROUTINES: JSON.stringify({ [OWNER]: { trigger: "trig", token: "tok" } }), GOONBRIDGE_ROUTINES_URL: "http://routines.test/v1/claude_code/routines" };
// The routines API, answered in-process: each fire gets a fresh session id. `hold` delays the answer until released.
// The id counts across every fake in this file: two fires in one millisecond from two fakes must not share a session.
let fireSeq = 0;
function fakeRoutinesApi() {
  const fires = [];
  const real = globalThis.fetch;
  let gate = null;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("http://routines.test/")) return real(url, init);
    fires.push(JSON.parse(init.body).text);
    if (gate) await gate.promise;
    const id = `session_vf${Date.now()}x${++fireSeq}`;
    return new Response(JSON.stringify({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` }), { status: 200 });
  };
  return {
    fires,
    hold: () => { let release; gate = { promise: new Promise((r) => (release = r)) }; gate.release = release; },
    release: () => { const g = gate; gate = null; g?.release(); },
    restore: () => { globalThis.fetch = real; },
  };
}
// The hub with one RPC replaced (a Durable Object RPC that throws).
const failing = (hub, method) => new Proxy(hub, { get: (t, k) => (k === method ? async () => { throw new Error("RPC blip"); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });

test("DEFECT 2: a bookkeeping failure after a reviewer was fired keeps the reservation", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const { startReviewer } = await loadModule("src/github.ts");
  const { review, send } = await openedPr(hub);
  assert.ok(review, "a reviewer was reserved");
  const api = fakeRoutinesApi();
  try {
    const out = await startReviewer(routinesEnv, failing(hub, "recordFire"), MEMBERS, review);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(api.fires.length, 1);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM review_fires WHERE pr_url = ?", review.pr_url).one().n, 1, "the reservation survives");
    assert.equal((await send("ready_for_review")).review, undefined, "a second ready_for_review fires nothing");
  } finally {
    api.restore();
  }
});

const cloudEnv = { ...routinesEnv, GOONBRIDGE_ONLINE_SECONDS: "4" };
const inboxOf = async (hub, member) => (await hub.inbox(member, MEMBERS, 0, true)).messages.map((m) => m.id);
const sessionOf = (sessionId) => sessionId.replace(/^session_/, "cse_");

test("DEFECT 3: a message that joined a starting fire is not acked by the fire's own notice", { skip }, async () => {
  const { hub } = await memoryHub();
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const api = fakeRoutinesApi();
  try {
    api.hold();
    const first = sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: "start", body: "Start something." });
    while (api.fires.length === 0) await sleep(5);
    const m1 = (await hub.threads(OWNER))[0];
    const second = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { thread_id: m1.thread_id, body: "And this too." });
    assert.equal(second.cloud.live, true, "joins the starting fire");
    api.release();
    const started = await first;
    assert.ok(started.cloud.url, JSON.stringify(started.cloud));
    const status = (await hub.thread(OWNER, MEMBERS, m1.thread_id)).find((m) => m.id === second.sent.id).status;
    assert.deepEqual(status, { [OWNER_CLOUD]: "unread" }, "the joined message is still unread");
    const child = await as(hub, sessionOf(started.cloud.session_id));
    assert.ok(await inboxOf(hub, child).then((ids) => ids.includes(second.sent.id)), "the fired session gets it");
  } finally {
    api.restore();
  }
});

// A fire for a fresh session whose session has checked in: returns the message and the child it is reserved for.
async function firedAndCheckedIn(hub, body = "Do the thing.") {
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const api = fakeRoutinesApi();
  try {
    const out = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: "fired", body }, true);
    assert.ok(out.cloud.url, JSON.stringify(out.cloud));
    return { sent: out.sent, session: sessionOf(out.cloud.session_id), child: await as(hub, sessionOf(out.cloud.session_id)) };
  } finally {
    api.restore();
  }
}

test("DEFECT 4: a handed-back message a child had fetched is visible to a sibling at once", { skip }, async () => {
  const { hub , sql } = await memoryHub();
  const { sent, child } = await firedAndCheckedIn(hub);
  const second = await hub.send(OWNER, MEMBERS, { thread_id: sent.thread_id, body: "More." });
  // Reserved for the child once it checked in, the same as a joined message.
  sql.exec("UPDATE messages SET reserved_for = ? WHERE id = ?", child, second.id);
  assert.ok((await hub.inbox(child, MEMBERS)).messages.some((m) => m.id === second.id), "the child fetched it");
  assert.equal((await hub.kill(OWNER, MEMBERS, child, "test")).killed, true);
  const sibling = await as(hub, "cse_sibling0000000001");
  assert.ok((await inboxOf(hub, sibling)).includes(second.id), "a sibling polling right away gets it");
});

test("DEFECT 5: killing a fired session before its first check-in frees what was reserved for its fire", { skip }, async () => {
  const { hub } = await memoryHub();
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const api = fakeRoutinesApi();
  let first;
  try {
    first = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: "kill early", body: "Start." }, true);
  } finally {
    api.restore();
  }
  const second = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { thread_id: first.sent.thread_id, body: "And this." });
  assert.equal(second.cloud.live, true, "joins the starting fire");
  const sibling = await as(hub, "cse_sibling0000000005");
  assert.ok(!(await inboxOf(hub, sibling)).includes(second.sent.id), "reserved for the fire");
  assert.equal((await hub.kill(OWNER, MEMBERS, first.cloud.session_id, "test")).killed, true);
  assert.ok((await inboxOf(hub, sibling)).includes(second.sent.id), "free for a sibling after the kill");
});

test("DEFECT 6: a message routed to a child holding a review claim returns to the parent when the child dies", { skip }, async () => {
  const { hub } = await memoryHub();
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const s = "cse_reviewclaim000006";
  const child = await as(hub, s);
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "Review claim", brief: "x", repo: `vf6-${Date.now()}`, state: "ready" });
  await hub.taskUpdate(child, MEMBERS, task.key, { state: "claim" });
  await hub.taskUpdate(child, MEMBERS, task.key, { state: "review", pr_url: `https://github.com/${GITHUB_OWNER}/vf6/pull/${Date.now() % 10000}` });
  const sent = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: `Task ${task.key}: more`, body: "For the claimant." });
  assert.equal(sent.sent.recipient, child, "routed to the claimant's own inbox");
  await sleep(1300); // past the lease, no signal of any kind
  await hub.faults(); // any sweep
  assert.ok((await inboxOf(hub, OWNER_CLOUD)).includes(sent.sent.id), "back in the parent's inbox");
});

test("DEFECT 7: assigning a closed or backlog task to a cloud device fires nothing", { skip }, async () => {
  const { hub } = await memoryHub();
  const { updateTask } = await loadModule("src/cloud.ts");
  const api = fakeRoutinesApi();
  try {
    for (const state of ["dropped", "backlog"]) {
      const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: `Closed ${state}`, brief: "x", state });
      const out = await updateTask(cloudEnv, hub, OWNER, MEMBERS, task.key, { assignee: OWNER_CLOUD, note: "please do it" });
      assert.equal(api.fires.length, 0, `${state}: no session fired`);
      if (state === "backlog") assert.match(out.cloud?.note ?? "", /backlog: no session will see this/);
    }
  } finally {
    api.restore();
  }
});

test("DEFECT 8: a re-review note on an epic converted from a reviewed task fires no reviewer", { skip }, async () => {
  const { hub } = await memoryHub();
  const { task, send, review } = await openedPr(hub, { state: "ready" });
  assert.equal(await hub.reviewFired(review, "session_vf8first00001", "https://claude.ai/code/session_vf8first00001"), true);
  await send("synchronize", "sha-new-head");
  await hub.taskUpdate(OWNER, MEMBERS, task.key, { state: "review" });
  assert.equal((await hub.taskUpdate(OWNER, MEMBERS, task.key, { kind: "epic" })).task.kind, "epic");
  const out = await hub.taskUpdate(OWNER, MEMBERS, task.key, { note: "ready for re-review" }, undefined, { autoReview: true });
  assert.equal(out.review, undefined, "never a session for an epic");
});

test("DEFECT 9: a negated re-review note does not match", { skip }, async () => {
  const { RE_REVIEW_NOTE } = await loadModule("src/hub/github.ts");
  for (const no of ["Not yet ready for re-review.", "Never ready for re-review", "It isn't ready for re-review", "They aren't yet ready for rereview", "not ready for re-review"]) {
    assert.equal(RE_REVIEW_NOTE.test(no), false, no);
  }
  for (const yes of ["ready for re-review", "Fixed the points. Ready for re-review.", "ready for rereview now"]) assert.equal(RE_REVIEW_NOTE.test(yes), true, yes);
});

test("DEFECT 10: in a thread with two households' flagged fires, `task: new` is owned by the sender's person", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const m = await hub.send(OWNER, MEMBERS, { to: OTHER, subject: "shared", body: "Merge the branch." });
  for (const requester of [OWNER, OTHER]) {
    const id = await hub.intendFire({ member: `${requester}-cloud`, requester, message_id: m.id, thread_id: m.thread_id, task_key: null });
    sql.exec("UPDATE cloud_fires SET work_thread = 1 WHERE id = ?", id);
  }
  // bob's fire is the newest; alice attaches.
  const out = await hub.sendRouted(OWNER, MEMBERS, { thread_id: m.thread_id, body: "task: new" }, { people: [OWNER, OTHER], forceNew: false, onlineMs: 4000 });
  const key = /Attached (T-\d+)/.exec(out.message.body)?.[1];
  assert.ok(key, out.message.body);
  assert.equal((await hub.findTask(key)).owner, OWNER, "owned by the sender's person");
  assert.equal(sql.exec(`SELECT task_key FROM cloud_fires WHERE requester = '${OWNER}'`).one().task_key, key);
  assert.equal(sql.exec(`SELECT task_key FROM cloud_fires WHERE requester = '${OTHER}'`).one().task_key, null);
});

test("DEFECT 11: a fired session that reports only in its attached task's thread is not died_without_reply", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const { sent, child } = await firedAndCheckedIn(hub, "Merge the fix branch.");
  sql.exec("UPDATE cloud_fires SET work_thread = 1 WHERE thread_id = ?", sent.thread_id);
  const out = await hub.sendRouted(OWNER, MEMBERS, { thread_id: sent.thread_id, body: "task: new" }, { people: [OWNER], forceNew: false, onlineMs: 4000 });
  const key = /Attached (T-\d+)/.exec(out.message.body)[1];
  const task = await hub.findTask(key);
  assert.notEqual(task.thread_id, sent.thread_id, "the task has its own thread");
  await hub.taskDone(child, MEMBERS, key, { summary: "Merged.", verdict: "progress" });
  await sleep(1300);
  const f = await hub.faults();
  assert.ok(!f.fires.some((x) => x.child === child && x.fault === "died_without_reply"), JSON.stringify(f.fires));
});

test("DEFECT 12: a claim restored after the alarm lapsed re-arms it, so a second silence is swept", { skip }, async () => {
  const { hub, alarmAt, fireAlarm } = await memoryHub();
  const s = "cse_rearm00000000012";
  const child = await as(hub, s);
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "Re-arm", brief: "x", repo: `vf12-${Date.now()}`, state: "ready" });
  await hub.taskUpdate(child, MEMBERS, task.key, { state: "claim" });
  await sleep(1300);
  await fireAlarm(); // releases the claim as an orphan; nothing open is left, so no new alarm
  assert.ok((await hub.findTask(task.key)).orphaned_at, "orphaned");
  assert.equal(alarmAt(), null, "the alarm lapsed");
  await as(hub, s); // back within two leases: the claim is restored
  assert.equal((await hub.findTask(task.key)).claim_session, child, "restored");
  assert.notEqual(alarmAt(), null, "the restore re-armed the alarm");
  await sleep(1300);
  await fireAlarm();
  assert.ok((await hub.findTask(task.key)).orphaned_at, "orphaned again by the alarm alone");
});

test("DEFECT 13: a taskless session flagged died_without_reply that speaks again is cleared and not ended", { skip }, async () => {
  const { hub } = await memoryHub();
  const { child, session } = await firedAndCheckedIn(hub, "What does the backoff do?");
  await sleep(1300);
  assert.ok((await hub.faults()).fires.some((x) => x.child === child && x.fault === "died_without_reply"), "flagged first");
  await as(hub, session, "tool");
  assert.ok(!(await hub.faults()).fires.some((x) => x.child === child), "fault cleared");
  assert.ok(!(await hub.endedSessions(MEMBERS)).some((e) => e.child === child), "not in the ended list");
});

test("DEFECT 14: \" Offline\", any case, and an MCP batch count as going offline, as setStatus parses them", { skip }, async () => {
  const { goingOffline } = await loadModule("src/devices.ts");
  const req = (path, body) => new Request(`http://bridge.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(await goingOffline(req("/v1/status", { state: " Offline" })), true);
  assert.equal(await goingOffline(req("/v1/status", { state: "OFFLINE" })), true);
  assert.equal(await goingOffline(req("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge_status_set", arguments: { state: "Offline " } } })), true);
  assert.equal(await goingOffline(req("/mcp", [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge_inbox", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bridge_status_set", arguments: { state: "offline" } } },
  ])), true, "a batch with an offline post");
  assert.equal(await goingOffline(req("/v1/status", { state: "idle" })), false);
});

test("DEFECT 15: a session whose first contact is a process beat is not live for routing", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const child = await as(hub, "cse_processfirst0015", "process");
  assert.ok(sql.exec("SELECT seen_at FROM cloud_devices WHERE name = ?", child).one().seen_at > 0, "not the offline sentinel");
  const api = fakeRoutinesApi();
  try {
    const out = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: "anyone", body: "A question." });
    assert.ok(out.cloud?.url, `a session was fired: ${JSON.stringify(out.cloud)}`);
    assert.equal(api.fires.length, 1);
  } finally {
    api.restore();
  }
});

test("DEFECT 16: no claimed epic from one call; converting an orphaned task clears its orphan mark", { skip }, async () => {
  const { hub } = await memoryHub();
  const t = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "claim+epic", brief: "x", state: "ready" });
  await assert.rejects(hub.taskUpdate(OWNER, MEMBERS, t.key, { kind: "epic", state: "claim" }), /epic/);
  const after = await hub.findTask(t.key);
  assert.equal(after.kind, "task");
  assert.equal(after.claim_session, null);

  const s = "cse_orphanepic000016";
  const child = await as(hub, s);
  const o = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "orphan+epic", brief: "x", repo: `vf16-${Date.now()}`, state: "ready" });
  await hub.taskUpdate(child, MEMBERS, o.key, { state: "claim" });
  await hub.kill(OWNER, MEMBERS, child, "test");
  assert.ok((await hub.findTask(o.key)).orphaned_at);
  await hub.taskUpdate(OWNER, MEMBERS, o.key, { kind: "epic" });
  const epic = await hub.findTask(o.key);
  assert.equal(epic.kind, "epic");
  assert.equal(epic.orphaned_at, null);
  assert.equal(epic.orphaned_from, null);
  assert.ok(!(await hub.faults()).orphaned_tasks.some((x) => x.key === o.key));
});

test("DEFECT 17: reopening with the same branch repeated is refused while another open task holds it", { skip }, async () => {
  const { hub } = await memoryHub();
  const repo = `${GITHUB_OWNER}/vf17-${Date.now()}`;
  const done = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "closed", brief: "x", repo, branch: "claude/shared", state: "dropped", labels: [] });
  assert.equal(done.branch, "claude/shared", "a closed record keeps its branch");
  await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "open holder", brief: "x", repo, branch: "claude/shared", state: "ready" });
  await assert.rejects(hub.taskUpdate(OWNER, MEMBERS, done.key, { state: "ready", branch: "claude/shared" }), /already held by open task/);
  assert.equal((await hub.findTask(done.key)).state, "dropped");
});

test("DEFECT 18: moving an orphaned child to another epic while reassigning it leaves that epic ready", { skip }, async () => {
  const { hub } = await memoryHub();
  const a = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "epic A", brief: "x", kind: "epic" });
  const b = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "epic B", brief: "x", kind: "epic" });
  await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "B's other child", brief: "x", parent: b.key, state: "ready" });
  const child = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "orphan child", brief: "x", parent: a.key, state: "ready", repo: `vf18-${Date.now()}` });
  const s = await as(hub, "cse_reparent00000018");
  await hub.taskUpdate(s, MEMBERS, child.key, { state: "claim" });
  await hub.kill(OWNER, MEMBERS, s, "test");
  assert.equal((await hub.findTask(a.key)).state, "blocked", "the orphan blocks A");
  await hub.taskUpdate(OWNER, MEMBERS, child.key, { parent: b.key, assignee: OWNER });
  assert.equal((await hub.findTask(child.key)).orphaned_at, null);
  assert.equal((await hub.findTask(b.key)).state, "ready", "B is not blocked by a mark that is gone");
});

test("DEFECT 19: the report cap does not lock out the owner; others are told to start a new task", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const t = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "chatty", brief: "x", state: "ready" });
  for (let i = 0; i < 50; i++) sql.exec("INSERT INTO events (at, subject_kind, subject_id, actor, kind, data) VALUES (?, 'task', ?, 'x', 'report', '{}')", new Date().toISOString(), String(t.id));
  const s = await as(hub, "cse_reportcap0000019");
  await assert.rejects(hub.taskDone(s, MEMBERS, t.key, { summary: "again", verdict: "progress" }), (e) => /50 reports/.test(e.message) && !/ask the owner/.test(e.message));
  const owner = await hub.taskDone(OWNER, MEMBERS, t.key, { summary: "owner still reports", verdict: "progress" });
  assert.equal(owner.verdict, "progress");
});

test("DEFECT 21: a fired session that posted offline without a fault has a real ended_at, not 0", { skip }, async () => {
  const { hub } = await memoryHub();
  const { child } = await firedAndCheckedIn(hub, "What does the backoff do?");
  await hub.setStatus(child, { state: "offline", summary: "done" });
  const lane = (await hub.endedSessions(MEMBERS)).find((e) => e.child === child);
  assert.ok(lane, "listed as ended");
  assert.equal(lane.fault, null, "not faulted");
  assert.ok(lane.ended_at > Date.now() - 60_000, `a sane ended_at, got ${lane.ended_at}`);
});

// TEST-GAP 12 (claims.test "clears the fault" made no fire fault): a fired session's claim and its fire fault both come back.
test("a fired session back after an orphan release gets its claim and its died_without_reply fault cleared", { skip }, async () => {
  const { hub } = await memoryHub();
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "fired claim", brief: "x", repo: `tg12-${Date.now()}`, state: "ready" });
  const { child, session } = await firedAndCheckedIn(hub, `Task ${task.key}: go`);
  await hub.taskUpdate(child, MEMBERS, task.key, { state: "claim" });
  await sleep(1300);
  const f = await hub.faults();
  assert.ok(f.orphaned_tasks.some((t) => t.key === task.key), "orphaned");
  assert.ok(f.fires.some((x) => x.child === child && x.fault === "died_without_reply"), "and the fire faulted");
  await as(hub, session, "tool");
  const after = await hub.faults();
  assert.ok(!after.fires.some((x) => x.child === child), "the fire fault is cleared");
  assert.equal((await hub.findTask(task.key)).claim_session, child, "the claim is back");
});

// TEST-GAP 9: the ended list's branches the HTTP tests never reach.
test("ended: a silent un-faulted fire is listed; a replied one is not; a process-alive one is not; faults rank first past 50", { skip }, async () => {
  const { hub, sql } = await memoryHub({ GOONBRIDGE_CLAIM_LEASE_SECONDS: "2" });
  const silent = await firedAndCheckedIn(hub, "silent one");
  const replied = await firedAndCheckedIn(hub, "replies");
  await hub.send(replied.child, MEMBERS, { thread_id: replied.sent.thread_id, body: "Done." });
  const alive = await firedAndCheckedIn(hub, "process only");
  const until = Date.now() + 2300;
  while (Date.now() < until) { await as(hub, alive.session, "process"); await sleep(400); }
  // Not swept yet (no faults read): the silent fire is in the list by the silence branch, not by a fault.
  const lanes = await hub.endedSessions(MEMBERS);
  const silentLane = lanes.find((e) => e.child === silent.child);
  assert.ok(silentLane, "the silent un-faulted fire is ended");
  assert.equal(silentLane.fault, null, "listed by silence, not by a fault");
  assert.ok(!lanes.some((e) => e.child === replied.child), "a session that replied finished cleanly: not listed");
  assert.ok(!lanes.some((e) => e.child === alive.child), "a session whose process still beats is not ended");
  // 60 silent fires that never checked in, then one fault: the fault still ranks inside the 50.
  for (let i = 0; i < 60; i++) sql.exec(`INSERT INTO cloud_fires (member, requester, message_id, thread_id, session_id, session_key, url, fired_at, child) VALUES ('${OWNER_CLOUD}', '${OWNER}', 0, 0, ?, ?, '', ?, ?)`, `session_bulk${i}`, `bulk${i}`, Date.now(), silent.child);
  sql.exec("UPDATE cloud_fires SET fault = 'killed', fault_at = ? WHERE child = ? AND session_id = (SELECT session_id FROM cloud_fires WHERE child = ? ORDER BY id LIMIT 1)", Date.now(), silent.child, silent.child);
  const ranked = await hub.endedSessions(MEMBERS);
  assert.equal(ranked.length, 50, "capped at 50");
  assert.equal(ranked[0].fault, "killed", "a fault ranks first however many silent rows are newer");
});

test("DEFECT 22: a task assignment and a routed send for the same task at once start one session", { skip }, async () => {
  const { hub } = await memoryHub();
  const { cloudAfterTask, sendToCloud } = await loadModule("src/cloud.ts");
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "Race", brief: "Do the race.", repo: `vf22-${Date.now()}`, state: "ready", assignee: OWNER_CLOUD });
  const api = fakeRoutinesApi();
  try {
    // The send arrives while the assignment is between its Hub calls: any later RPC of the assignment waits for it.
    let raced = null;
    const racing = new Proxy(hub, { get: (t, k) => {
      const f = t[k];
      if (typeof f !== "function") return f;
      return async (...a) => {
        const out = await f(...a);
        raced ??= sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: `Task ${task.key}: also`, body: "And this." });
        await raced;
        return out;
      };
    } });
    const assigned = await cloudAfterTask(cloudEnv, racing, MEMBERS, task, task.thread_id, OWNER);
    const sent = await raced;
    assert.equal(api.fires.length, 1, `one session: ${JSON.stringify([assigned, sent.cloud])}`);
    // The brief waits for the session that fire starts, not for a sibling.
    const sibling = await as(hub, "cse_racesibling00022");
    assert.ok(!(await inboxOf(hub, sibling)).includes(task.thread_id), "the brief is not a sibling's to take");
  } finally {
    api.restore();
  }
});

// T-66 final round: defects from the second independent verification, each failing first.
test("FINAL 1: a sibling cannot mark done a message reserved for another session", { skip }, async () => {
  const { hub, sql } = await memoryHub();
  const { sent, child } = await firedAndCheckedIn(hub);
  const second = await hub.send(OWNER, MEMBERS, { thread_id: sent.thread_id, body: "For the fired session only." });
  sql.exec("UPDATE messages SET reserved_for = ? WHERE id = ?", child, second.id);
  const sibling = await as(hub, "cse_finalsibling00001");
  await assert.rejects(hub.done(sibling, MEMBERS, second.id), /reserved/);
  await assert.rejects(hub.done(OWNER_CLOUD, MEMBERS, second.id), /reserved/, "nor the plain parent");
  assert.ok((await inboxOf(hub, child)).includes(second.id), "still the child's");
  assert.equal((await hub.done(child, MEMBERS, second.id)).message_id, second.id, "the session it is reserved for may");
});

test("FINAL 2: a fire's started notice leaves an unrelated unread message to the parent unread", { skip }, async () => {
  const { hub } = await memoryHub();
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const earlier = await hub.send(OWNER, MEMBERS, { to: OWNER_CLOUD, subject: "two asks", body: "First ask, for whoever is around." });
  const api = fakeRoutinesApi();
  try {
    const out = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { thread_id: earlier.thread_id, body: "Second ask: start a session." }, true);
    assert.ok(out.cloud.url, JSON.stringify(out.cloud));
    const thread = await hub.thread(OWNER, MEMBERS, earlier.thread_id);
    assert.deepEqual(thread.find((m) => m.id === earlier.id).status, { [OWNER_CLOUD]: "unread" }, "the earlier ask is not acked");
    assert.deepEqual(thread.find((m) => m.id === out.sent.id).status, { [OWNER_CLOUD]: "done" }, "the fired message is done, by id");
    assert.equal(thread.at(-1).sender, "system", "the notice is the bridge's");
  } finally {
    api.restore();
  }
});

test("FINAL 3: the alarm stays armed while a message is reserved for a session, and hands it back when it dies", { skip }, async () => {
  const { hub, sql, alarmAt, fireAlarm } = await memoryHub();
  const { sent, child } = await firedAndCheckedIn(hub);
  await hub.send(child, MEMBERS, { thread_id: sent.thread_id, body: "Replied." }); // the fire is settled: no open fire
  const second = await hub.send(OWNER, MEMBERS, { thread_id: sent.thread_id, body: "One more." });
  sql.exec("UPDATE messages SET reserved_for = ? WHERE id = ?", child, second.id);
  await fireAlarm();
  assert.notEqual(alarmAt(), null, "still armed: a reserved message waits");
  await sleep(1300);
  await fireAlarm();
  assert.ok((await inboxOf(hub, OWNER_CLOUD)).includes(second.id), "handed back by the alarm alone");
});

test("FINAL 4: a reviewer whose recordFire failed is not fired again after the boot window", { skip }, async () => {
  const { hub } = await memoryHub();
  const { startReviewer } = await loadModule("src/github.ts");
  const { review, send } = await openedPr(hub);
  const api = fakeRoutinesApi();
  try {
    assert.equal((await startReviewer(routinesEnv, failing(hub, "recordFire"), MEMBERS, review)).ok, true);
    await sleep(1300);
    await hub.faults(); // a sweep past the boot window
    assert.equal((await send("ready_for_review")).review, undefined, "no second reviewer");
    assert.equal(api.fires.length, 1);
  } finally {
    api.restore();
  }
});

test("FINAL 6: a fired session that checked in but only polls does not get its task's messages directly", { skip }, async () => {
  const { hub } = await memoryHub();
  const { sendToCloud } = await loadModule("src/cloud.ts");
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "Poll only", brief: "x", repo: `f6-${Date.now()}`, state: "ready" });
  const api = fakeRoutinesApi();
  try {
    const first = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: `Task ${task.key}: go`, body: "Start." });
    assert.ok(first.cloud.url, JSON.stringify(first.cloud));
    const child = await as(hub, sessionOf(first.cloud.session_id), "poll");
    const second = await sendToCloud(cloudEnv, hub, OWNER, MEMBERS, { to: OWNER_CLOUD, subject: `Task ${task.key}: more`, body: "More." });
    assert.notEqual(second.sent.recipient, child, "not routed to a session that is not working");
    assert.equal(second.sent.recipient, OWNER_CLOUD);
    assert.equal(api.fires.length, 1, "and nothing fired");
  } finally {
    api.restore();
  }
});

test("FINAL 7: a claim whose session was seen exactly one lease ago is not released (the sweep agrees with liveness)", { skip }, async () => {
  const { liveness } = await loadModule("src/hub/claims.ts");
  const { hub, sql } = await memoryHub();
  const child = await as(hub, "cse_boundary00000007");
  const task = await hub.taskCreate(OWNER, MEMBERS, { owner: OWNER, title: "Boundary", brief: "x", repo: `f7-${Date.now()}`, state: "ready" });
  await hub.taskUpdate(child, MEMBERS, task.key, { state: "claim" });
  // Pin "now", so the sweep and the stamp are exactly one lease (1 s) apart.
  const realNow = Date.now;
  const now = realNow() + 5000;
  Date.now = () => now;
  try {
    sql.exec("UPDATE cloud_devices SET seen_at = ?1, call_at = ?1, tool_at = NULL, poll_at = NULL, process_at = NULL WHERE name = ?2", now - 1000, child);
    assert.equal(liveness(sql.exec("SELECT tool_at, call_at, poll_at, process_at, seen_at, killed_at FROM cloud_devices WHERE name = ?", child).one(), 1000, now), "working");
    await hub.faults();
    assert.equal((await hub.findTask(task.key)).claim_session, child, "not released at the boundary");
  } finally {
    Date.now = realNow;
  }
});

test("FINAL 8: an MCP batch of only bridge_inbox calls is a poll; a mixed batch is a call", { skip }, async () => {
  const { signalOf } = await loadModule("src/devices.ts");
  const req = (body) => new Request("http://bridge.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const call = (id, name) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
  assert.equal(await signalOf(req([call(1, "bridge_inbox"), call(2, "bridge_inbox")])), "poll");
  assert.equal(await signalOf(req([call(1, "bridge_inbox"), call(2, "bridge_send")])), "call");
  assert.equal(await signalOf(req(call(1, "bridge_inbox"))), "poll");
  assert.equal(await signalOf(req([])), "call");
});
