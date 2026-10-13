import { CONTEXT_HEADER, OWNER, OWNER_CLOUD, OWNER_DEVICE, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Cloud child devices: a session sending Goonbridge-Session under a <person>-cloud token gets a name of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, ownerDeviceToken, ownerCloudToken, rest, drain, waitPastClaim } from "./helpers.mjs";

const newSession = () => `cse_${randomBytes(8).toString("hex")}`;

async function as(token, session, context, method, path, body) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [SESSION_HEADER]: session };
  if (context !== undefined) headers[CONTEXT_HEADER] = context;
  const res = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function mcpAs(token, session, context, name, args = {}) {
  const res = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: context },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()).result.content[0].text;
}

test("each cloud session gets its own child name, fixed for the session and never shared", async () => {
  const s1 = newSession();
  const s2 = newSession();
  const a = (await as(ownerCloudToken, s1, "Cloud Research_Trading", "GET", "/v1/me")).body;
  const b = (await as(ownerCloudToken, s2, "Cloud Research_Trading", "GET", "/v1/me")).body;
  assert.match(a.member, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-[a-z0-9]{3}-cloud-research-trading$`, ""));
  assert.match(b.member, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-[a-z0-9]{3}-cloud-research-trading$`, ""));
  assert.notEqual(a.member, b.member);
  assert.equal(a.person, OWNER);
  assert.equal((await as(ownerCloudToken, s1, "anything else", "GET", "/v1/me")).body.member, a.member, "the name is fixed at the session's first call");
  const seen = (await rest(ownerToken, "GET", "/v1/me")).body.devices[OWNER];
  assert.ok(seen.includes(a.member) && seen.includes(b.member), "children are devices of the person");
  // No context: just the random part.
  assert.match((await as(ownerCloudToken, newSession(), undefined, "GET", "/v1/me")).body.member, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-[a-z0-9]{3}$`, ""));
  // No session header, a bad one, or a token that is not a cloud device: unchanged.
  assert.equal((await rest(ownerCloudToken, "GET", "/v1/me")).body.member, OWNER_CLOUD);
  assert.equal((await as(ownerCloudToken, "", "x", "GET", "/v1/me")).body.member, OWNER_CLOUD);
  assert.equal((await as(ownerCloudToken, "bad session!", "x", "GET", "/v1/me")).body.member, OWNER_CLOUD);
  // A person (not a device) with a session id is unchanged: children hang off devices only.
  assert.equal((await as(ownerToken, newSession(), "x", "GET", "/v1/me")).body.member, OWNER);
});

test("children have their own status lines and threads, and share their parent's inbox", async () => {
  await waitPastClaim(); await drain(ownerToken); await drain(ownerCloudToken);
  const s1 = newSession();
  const s2 = newSession();
  const c1 = (await as(ownerCloudToken, s1, REPO, "GET", "/v1/me")).body.member;
  const c2 = (await as(ownerCloudToken, s2, REPO, "GET", "/v1/me")).body.member;
  // Status: one line each.
  await as(ownerCloudToken, s1, REPO, "POST", "/v1/status", { state: "working", summary: "one" });
  await as(ownerCloudToken, s2, REPO, "POST", "/v1/status", { state: "working", summary: "two" });
  const board = (await rest(ownerToken, "GET", "/v1/status")).body;
  assert.equal(board.find((e) => e.member === c1).summary, "one");
  assert.equal(board.find((e) => e.member === c2).summary, "two");
  assert.equal(board.find((e) => e.member === c1).person, OWNER);
  // A message to the parent goes to whichever child polls first, once.
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, body: "for any cloud session" })).body;
  const got1 = (await as(ownerCloudToken, s1, REPO, "GET", "/v1/inbox")).body;
  const got2 = (await as(ownerCloudToken, s2, REPO, "GET", "/v1/inbox")).body;
  assert.deepEqual(got1.map((m) => m.id), [sent.id]);
  assert.deepEqual(got2, [], "claimed by the first child");
  // The child replies under its own name; that finishes the parent's copy.
  const reply = (await as(ownerCloudToken, s1, REPO, "POST", "/v1/send", { thread_id: sent.thread_id, body: "on it" })).body;
  assert.equal(reply.sender, c1);
  assert.equal(reply.recipient, OWNER);
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body;
  assert.deepEqual(thread[0].status, { [OWNER_CLOUD]: "done" });
  await waitPastClaim();
  assert.deepEqual((await as(ownerCloudToken, s2, REPO, "GET", "/v1/inbox")).body, [], "done for every child");
  assert.deepEqual((await rest(ownerCloudToken, "GET", "/v1/inbox")).body, [], "and for the plain parent");
  // A message to a child by name reaches only that child.
  const direct = (await rest(ownerToken, "POST", "/v1/send", { to: c2, body: "just you" })).body;
  assert.deepEqual((await as(ownerCloudToken, s1, REPO, "GET", "/v1/inbox")).body, []);
  assert.deepEqual((await as(ownerCloudToken, s2, REPO, "GET", "/v1/inbox")).body.map((m) => m.id), [direct.id]);
  // Done on a parent message from a child works too.
  const second = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, body: "no reply needed" })).body;
  const got = (await as(ownerCloudToken, s2, REPO, "GET", "/v1/inbox")).body;
  assert.deepEqual(got.map((m) => m.id), [second.id]);
  assert.equal((await as(ownerCloudToken, s2, REPO, "POST", "/v1/done", { message_id: second.id })).status, 200);
  await as(ownerCloudToken, s2, REPO, "POST", "/v1/done", { message_id: direct.id });
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("over MCP a child acts under its own name", async () => {
  const s = newSession();
  const status = await mcpAs(ownerCloudToken, s, REPO, "bridge_status_set", { state: "working", summary: "mcp child" });
  assert.match(status, new RegExp(String.raw`^Status for ${escapeRegex(OWNER_CLOUD)}-[a-z0-9]{3}-${REPO}: working`, ""));
});

test("posting offline takes a child off the board at once; a sibling stays", async () => {
  const a = newSession(), b = newSession();
  const nameA = (await as(ownerCloudToken, a, "ctx", "POST", "/v1/status", { state: "working" })).body.member;
  const online = async () => new Set((await rest(ownerToken, "GET", "/v1/status")).body.filter((e) => e.online).map((e) => e.member));
  const nameB = (await as(ownerCloudToken, b, "ctx", "POST", "/v1/status", { state: "working" })).body.member;
  const both = await online();
  assert.ok(both.has(nameA) && both.has(nameB));
  await as(ownerCloudToken, a, "ctx", "POST", "/v1/status", { state: "offline" });
  const afterA = await online();
  assert.ok(!afterA.has(nameA), "the child that wound down is offline at once");
  assert.ok(afterA.has(nameB), "its sibling is untouched");
  await as(ownerCloudToken, b, "ctx", "POST", "/v1/status", { state: "offline" });
  const now = await online();
  assert.ok(!now.has(nameB));
  await drain(ownerCloudToken);
});

test("a Mac session sending a session id is a child of its device, and its claim is never auto-released", async () => {
  const s = newSession();
  const me = (await as(ownerDeviceToken, s, REPO, "GET", "/v1/me")).body;
  assert.match(me.member, new RegExp(String.raw`^${escapeRegex(OWNER_DEVICE)}-[a-z0-9]{3}-${REPO}$`, ""));
  assert.equal(me.person, OWNER);
  assert.equal((await as(ownerDeviceToken, s, REPO, "GET", "/v1/me")).body.member, me.member, "fixed for the session");
  assert.equal((await rest(ownerDeviceToken, "GET", "/v1/me")).body.member, OWNER_DEVICE, "no session id: the device itself");
  // A claim by the Mac child survives silence past the lease: only cloud children are released for no heartbeat.
  const lease = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  const made = await rest(ownerToken, "POST", "/v1/tasks", { title: "Mac child claim", brief: "Claimed from a Mac session.", owner: OWNER, repo: REPO });
  assert.equal((await as(ownerDeviceToken, s, REPO, "PATCH", `/v1/tasks/${made.body.key}`, { state: "claim" })).status, 200);
  await new Promise((r) => setTimeout(r, lease + 1500));
  const t = (await rest(ownerToken, "GET", `/v1/tasks/${made.body.key}`)).body.task;
  assert.equal(t.state, "claimed");
  assert.equal(t.claim_session, me.member);
  await rest(ownerToken, "PATCH", `/v1/tasks/${made.body.key}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerDeviceToken);
});

// A local Claude Code window cannot fill Goonbridge-Session, so /mcp hands out an Mcp-Session-Id on initialize and the
// client echoes it; that id names the child unless an explicit Goonbridge-Session is sent.
const validSession = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/;

async function mcpRaw(token, headers, body) {
  return fetch(new URL("/mcp", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

async function whoOverMcp(token, headers) {
  const res = await mcpRaw(token, headers, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge_members", arguments: {} } });
  return (await res.json()).result.content[0].text.match(/^You are "([^"]+)"/)[1];
}

async function mcpInit(token) {
  const res = await mcpRaw(token, {}, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.serverInfo.name !== undefined, true);
  return res.headers.get("Mcp-Session-Id");
}

test("an MCP session id from initialize names a local window's child; Goonbridge-Session wins; persons stay themselves", async () => {
  const id = await mcpInit(ownerDeviceToken);
  assert.match(id ?? "", validSession, "initialize hands out a valid Mcp-Session-Id");
  assert.notEqual(await mcpInit(ownerDeviceToken), id, "a fresh id per initialize");

  const child = await whoOverMcp(ownerDeviceToken, { "Mcp-Session-Id": id });
  assert.match(child, new RegExp(String.raw`^${escapeRegex(OWNER_DEVICE)}-[a-z0-9]{3}$`, ""), "a child with no context part");
  assert.equal(await whoOverMcp(ownerDeviceToken, { "Mcp-Session-Id": id }), child, "fixed for the session");

  assert.equal(await whoOverMcp(ownerDeviceToken, {}), OWNER_DEVICE, "no session headers: the device itself");

  const s = newSession(), other = await mcpInit(ownerDeviceToken);
  const both = await whoOverMcp(ownerDeviceToken, { "Mcp-Session-Id": other, [SESSION_HEADER]: s });
  assert.equal(await whoOverMcp(ownerDeviceToken, { [SESSION_HEADER]: s }), both, "Goonbridge-Session wins over Mcp-Session-Id");
  assert.notEqual(both, await whoOverMcp(ownerDeviceToken, { "Mcp-Session-Id": other }), "the MCP id alone is a different child");

  assert.equal(await whoOverMcp(ownerToken, { "Mcp-Session-Id": await mcpInit(ownerToken) }), OWNER, "a person token stays the person");
  await drain(ownerDeviceToken);
});
