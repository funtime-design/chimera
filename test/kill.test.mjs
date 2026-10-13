import { CONTEXT_HEADER, OWNER, OWNER_CLOUD, OWNER_DEVICE, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Kill revokes the claim, tombstones the session and evicts it on its next check-in. It never terminates a process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, otherToken, ownerCloudToken, rest, callTool, drain, useFakeRoutines } from "./helpers.mjs";

const fakeRoutines = useFakeRoutines();

const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
async function as(session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const getTask = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
const listed = async (needle) => (await callTool(ownerToken, "bridge_sessions", {})).content[0].text.includes(needle);
async function claimed(session) {
  const name = (await as(session, "GET", "/v1/me")).body.member;
  await as(session, "POST", "/v1/sessions", { session, line: "working" });
  const key = (await rest(ownerToken, "POST", "/v1/tasks", { title: "Kill target", brief: "Held by a session that will be killed.", owner: OWNER, repo: REPO })).body.key;
  assert.equal((await as(session, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);
  return { name, key };
}
const cleanup = async (...keys) => {
  for (const k of keys) await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
};

test("kill by session id ends the claim, tombstones the session and leaves a note", async () => {
  const s = newSession();
  const { name, key } = await claimed(s);
  assert.ok(await listed(s));
  const out = await rest(ownerToken, "POST", "/v1/kill", { session: s, reason: "runaway" });
  assert.equal(out.status, 200);
  assert.equal(out.body.killed, true);
  assert.equal(out.body.name, name);
  assert.equal(out.body.killed_by, OWNER);
  assert.ok(out.body.killed_at);
  assert.deepEqual(out.body.released, [key]);
  assert.match(out.body.message, /not force-terminated/);
  // The claim is freed now, not after the lease.
  const t = await getTask(key);
  assert.equal(t.state, "ready");
  assert.equal(t.claim_session, null);
  // The thread keeps a record.
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${out.body.thread_id}`)).body;
  assert.ok(thread.some((m) => m.body.includes(`session ${name}`) && m.body.includes(`killed by ${OWNER}`) && m.body.includes("runaway")));
  await cleanup(key);
});

test("kill by bridge name works the same", async () => {
  const s = newSession();
  const { name, key } = await claimed(s);
  const out = await callTool(ownerToken, "kill", { session: name });
  assert.ok(!out.isError, out.content[0].text);
  assert.match(out.content[0].text, new RegExp(`Killed session ${name}`));
  assert.equal((await getTask(key)).claim_session, null);
  assert.equal((await as(s, "GET", "/v1/inbox")).status, 410);
  await cleanup(key);
});

test("only the owner can kill a session", async () => {
  const s = newSession();
  const { key } = await claimed(s);
  const denied = await rest(otherToken, "POST", "/v1/kill", { session: s });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, new RegExp(String.raw`only ${escapeRegex(OWNER)} can kill ${escapeRegex(OWNER)}'s sessions`, ""));
  assert.equal((await getTask(key)).claim_session !== null, true, "the claim survives a refused kill");
  assert.equal((await as(s, "GET", "/v1/inbox")).status, 200, "the session was not tombstoned");
  await rest(ownerToken, "POST", "/v1/kill", { session: s });
  await cleanup(key);
});

test("the claim slot is free right after a kill: a forced new session fires without waiting out the lease", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  const s = newSession();
  const { key } = await claimed(s);
  await rest(ownerToken, "POST", "/v1/kill", { session: s });
  const before = fakeRoutines.fires.length;
  const sent = await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: `Task ${key}: Kill target`, body: "Pick this up again." });
  assert.match(sent.content[0].text, /Cloud session started/);
  assert.equal(fakeRoutines.fires.length, before + 1, "not swallowed by the dead session");
  const t = await getTask(key);
  assert.equal(t.claim_session, null);
  await cleanup(key);
});

test("a killed session no longer shows in bridge_sessions", async () => {
  const s = newSession();
  const { key } = await claimed(s);
  assert.ok(await listed(s));
  await rest(ownerToken, "POST", "/v1/kill", { session: s });
  assert.ok(!(await listed(s)));
  assert.ok(!(await rest(ownerToken, "GET", `/v1/sessions?member=${OWNER_CLOUD}`)).body.some((r) => r.session === s));
  await cleanup(key);
});

test("the next check-in of a killed session is told to stop, on every path", async () => {
  const s = newSession();
  const { key } = await claimed(s);
  await rest(ownerToken, "POST", "/v1/kill", { session: s });
  // REST inbox poll and heartbeat: 410 Gone with the order.
  for (const [method, path] of [["GET", "/v1/inbox"], ["POST", "/v1/heartbeat"], ["GET", "/v1/me"]]) {
    const r = await as(s, method, path);
    assert.equal(r.status, 410, path);
    assert.equal(r.body.evicted, true);
    assert.match(r.body.error, /You have been killed.*Stop now/);
  }
  // A session line posted under the session id (the per-turn hook, as the person) is refused too, and does not revive it.
  const line = await rest(ownerToken, "POST", "/v1/sessions", { session: s, line: "still here" });
  assert.equal(line.status, 410);
  assert.match(line.body.error, /You have been killed/);
  assert.ok(!(await listed(s)));
  // MCP tool call.
  const res = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", [SESSION_HEADER]: s },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge_inbox", arguments: {} } }),
  });
  const rpc = await res.json();
  assert.equal(rpc.result.isError, true);
  assert.match(rpc.result.content[0].text, /You have been killed.*Stop now/);
  assert.equal((await getTask(key)).claim_session, null, "a refused check-in does not re-stamp a claim");
  await cleanup(key);
});

test("killing an unknown or already-killed session is a no-op, not an error", async () => {
  const unknown = await rest(ownerToken, "POST", "/v1/kill", { session: "cse_doesnotexist0000" });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.killed, false);
  assert.match(unknown.body.message, /nothing to kill/);
  const s = newSession();
  const { key } = await claimed(s);
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: s })).body.killed, true);
  const again = await rest(ownerToken, "POST", "/v1/kill", { session: s });
  assert.equal(again.status, 200);
  assert.equal(again.body.killed, false);
  assert.match(again.body.message, new RegExp(String.raw`already killed by ${escapeRegex(OWNER)}`, ""));
  const tool = await callTool(ownerToken, "kill", { session: s });
  assert.ok(!tool.isError);
  await cleanup(key);
});

// A fired session registers on the board only at its first check-in, seconds after the fire. Kill must reach it before that.
async function fired() {
  const out = await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "Kill before register", body: "Start a session.", new_session: true });
  assert.equal(out.status, 200);
  const sessionId = out.body.cloud?.session_id;
  assert.match(sessionId ?? "", /^session_/, `no session id in ${JSON.stringify(out.body)}`);
  // The id the session itself sends is cse_<same key>.
  return { sessionId, header: sessionId.replace(/^session_/, "cse_"), thread_id: out.body.thread_id };
}

test("a started session that has not registered yet can be killed, and is pre-tombstoned", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  const f = await fired();
  assert.ok(!(await listed(f.header)), "not on the board yet");
  // Killable by the id the routines API returned, before any check-in.
  const out = await rest(ownerToken, "POST", "/v1/kill", { session: f.sessionId, reason: "smoke" });
  assert.equal(out.status, 200);
  assert.equal(out.body.killed, true, out.body.message);
  assert.equal(out.body.killed_by, OWNER);
  assert.equal(out.body.name, null);
  assert.match(out.body.message, /ahead of its first check-in/);
  assert.equal(out.body.thread_id, f.thread_id, "the note lands in the fire's thread");
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${out.body.thread_id}`)).body;
  assert.ok(thread.some((m) => m.body.includes(`killed by ${OWNER}`) && m.body.includes("smoke") && m.body.includes("had not checked in yet")));
  // Its first check-in, under the cse_ id, is refused on every path and does not register it.
  for (const [method, path] of [["GET", "/v1/me"], ["GET", "/v1/inbox"], ["POST", "/v1/heartbeat"]]) {
    const r = await as(f.header, method, path);
    assert.equal(r.status, 410, path);
    assert.equal(r.body.evicted, true);
    assert.match(r.body.error, /You have been killed.*Stop now/);
  }
  assert.equal((await rest(ownerToken, "POST", "/v1/sessions", { session: f.header, line: "hello" })).status, 410);
  assert.ok(!(await listed(f.header)), "never made it onto the board");
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("the pre-tombstone can be addressed by the cse_ id too, and a second kill is the already-killed no-op", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  const f = await fired();
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: f.header })).body.killed, true);
  const again = await rest(ownerToken, "POST", "/v1/kill", { session: f.sessionId });
  assert.equal(again.status, 200);
  assert.equal(again.body.killed, false);
  assert.match(again.body.message, new RegExp(String.raw`already killed by ${escapeRegex(OWNER)}`, ""));
  // The tombstone is permanent: even after it "registers" attempts, it stays refused and a kill stays a no-op.
  assert.equal((await as(f.header, "GET", "/v1/inbox")).status, 410);
  const third = await callTool(ownerToken, "kill", { session: f.header });
  assert.ok(!third.isError);
  assert.match(third.content[0].text, /already killed/);
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a kill settles the session's fire, so the sweep does not later flag it never_started", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  const f = await fired();
  await rest(ownerToken, "POST", "/v1/kill", { session: f.sessionId });
  const faults = (await rest(ownerToken, "GET", "/v1/faults")).body;
  assert.ok(!faults.fires.some((x) => x.session_id === f.sessionId && x.fault === "never_started"), "the kill settled the fire");
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a never-started bogus id is still a clean no-op, distinct from a started-then-killed one", async () => {
  const id = randomBytes(8).toString("hex");
  for (const bogus of [`cse_never${id}`, `session_never${randomBytes(8).toString("hex")}`, "x"]) {
    const out = await rest(ownerToken, "POST", "/v1/kill", { session: bogus });
    assert.equal(out.status, 200, bogus);
    assert.equal(out.body.killed, false);
    assert.match(out.body.message, /nothing to kill/);
    assert.doesNotMatch(out.body.message, /already killed/);
    // And nothing was tombstoned: a check-in under that id is not evicted.
    if (bogus.startsWith("cse_")) assert.equal((await as(bogus, "GET", "/v1/me")).status, 200);
  }
});

test("only the owner can pre-tombstone a started session", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  const f = await fired();
  const denied = await rest(otherToken, "POST", "/v1/kill", { session: f.sessionId });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, new RegExp(String.raw`only ${escapeRegex(OWNER)} can kill ${escapeRegex(OWNER)}'s sessions`, ""));
  assert.equal((await as(f.header, "GET", "/v1/me")).status, 200, "not tombstoned by a refused kill");
  await rest(ownerToken, "POST", "/v1/kill", { session: f.sessionId });
  await drain(ownerToken); await drain(ownerCloudToken);
});

// T-57: kill shares the sessions resolver. A child of a Mac (alice-laptop) is killed by its name or session; a person or
// device name is not a session and kills nothing.
test("kill resolves a Mac child by name and by session id; a person or device name kills nothing", async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const mac = async (session) => (await fetch(new URL("/v1/me", base), { headers: { Authorization: `Bearer ${ownerDeviceToken}`, [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO } }).then((r) => r.json())).member;
  const a = newSession(), b = newSession();
  const nameA = await mac(a);
  await mac(b);
  const denied = await rest(otherToken, "POST", "/v1/kill", { session: nameA });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, new RegExp(String.raw`only ${escapeRegex(OWNER)} can kill ${escapeRegex(OWNER)}'s sessions`, ""), "another person cannot kill a Mac child");
  for (const who of [OWNER, OWNER_DEVICE]) {
    const out = (await rest(ownerToken, "POST", "/v1/kill", { session: who })).body;
    assert.equal(out.killed, false, `${who}: ${out.message}`);
  }
  const byName = (await rest(ownerToken, "POST", "/v1/kill", { session: nameA })).body;
  assert.equal(byName.killed, true, byName.message);
  assert.equal(byName.session, a);
  const bySession = (await rest(ownerToken, "POST", "/v1/kill", { session: b })).body;
  assert.equal(bySession.killed, true, bySession.message);
  assert.ok(bySession.name.startsWith(`${OWNER_DEVICE}-`));
  await drain(ownerToken);
});
