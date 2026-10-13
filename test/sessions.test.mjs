import { CONTEXT_HEADER, OTHER, OWNER, OWNER_CLOUD, OWNER_DEVICE, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Sessions: a lane per Claude Code session, posted by the session-report hook after every turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base, ownerToken, otherToken, rest, callTool, drain } from "./helpers.mjs";

const runHook = (event, input, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [new URL("../bin/session-report.mjs", import.meta.url).pathname], {
    env: { ...process.env, GOONBRIDGE_URL: base, GOONBRIDGE_PERSON_TOKEN: ownerToken, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code, out }));
  p.stdin.end(JSON.stringify({ hook_event_name: event, ...input }));
});

test("a session posts lines, the board lists it newest first, and the log keeps the last 20", async () => {
  const id = `test-${Date.now()}`;
  const first = (await rest(ownerToken, "POST", "/v1/sessions", { session: id, title: `DevOps/${REPO}`, cwd: `/x/${REPO}`, line: "started the split" })).body;
  assert.equal(first.member, OWNER);
  assert.equal(first.last_line, "started the split");
  for (let i = 1; i <= 25; i++) await rest(ownerToken, "POST", "/v1/sessions", { session: id, line: `turn ${i}` });
  const list = (await rest(otherToken, "GET", "/v1/sessions")).body;
  const mine = list.find((s) => s.session === id);
  assert.ok(mine, `${OTHER} sees ${OWNER}'s session on the board`);
  assert.equal(mine.last_line, "turn 25");
  assert.equal(mine.title, `DevOps/${REPO}`, "title survives line-only posts");
  assert.equal(list[0].session, id, "newest first");
  const log = (await rest(otherToken, "GET", `/v1/sessions/${OWNER}/${id}`)).body;
  assert.equal(log.lines.length, 20);
  assert.equal(log.lines[0].line, "turn 6");
  assert.equal(log.lines.at(-1).line, "turn 25");
  assert.equal((await rest(ownerToken, "POST", "/v1/sessions", { session: "bad id with spaces", line: "x" })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/sessions", { session: id, line: "x".repeat(301) })).status, 400);
  const text = (await callTool(otherToken, "bridge_sessions", { member: OWNER })).content[0].text;
  assert.match(text, new RegExp(`${OWNER} · ${id} · DevOps/${escapeRegex(REPO)} · .*\\n  turn 25`));
  const logText = (await callTool(otherToken, "bridge_session_log", { member: OWNER, session: id })).content[0].text;
  assert.match(logText, /turn 20\n.*turn 21/);
  assert.match((await callTool(otherToken, "bridge_session_log", { member: OWNER, session: "nope" })).content[0].text, /not found/);
});


test("a heartbeating cloud session shows live on the board, and drops once silent past the lease", async () => {
  const { ownerCloudToken, sleep } = await import("./helpers.mjs");
  const s = `cse_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  const as = (method, path) => fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${ownerCloudToken}`, [SESSION_HEADER]: s, [CONTEXT_HEADER]: REPO } }).then((r) => r.json());
  const lease = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  assert.ok(lease <= 10000, "set GOONBRIDGE_CLAIM_LEASE_SECONDS to a few seconds for tests");
  const name = (await as("GET", "/v1/me")).member;
  const live = async () => (await rest(ownerToken, "GET", "/v1/sessions")).body.some((r) => r.member === name && r.session === s);
  // The heartbeat hook endpoint alone must put the session on the board, and keep it there.
  await as("POST", "/v1/heartbeat");
  assert.ok(await live(), "heartbeating session is live");
  await sleep(lease / 2 + 300);
  await as("POST", "/v1/heartbeat");
  await sleep(lease / 2 + 300);
  assert.ok(await live(), "still live: the second heartbeat landed inside the lease");
  // Silent past the lease: not live.
  await sleep(lease + 500);
  assert.ok(!(await live()), "silent past the lease drops off");
});

test("a session that makes bridge calls and posts hook lines is one lane, not two", async () => {
  const { ownerCloudToken } = await import("./helpers.mjs");
  const s = `cse_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  const as = () => fetch(new URL("/v1/me", base), { headers: { Authorization: `Bearer ${ownerCloudToken}`, [SESSION_HEADER]: s, [CONTEXT_HEADER]: REPO } }).then((r) => r.json());
  const lanes = async () => (await rest(ownerToken, "GET", "/v1/sessions")).body.filter((r) => r.session === s);
  await as();
  assert.equal((await lanes()).length, 1, "a bridge call alone makes a lane");
  await rest(ownerToken, "POST", "/v1/sessions", { session: s, line: "turn done" });
  await as();
  const after = await lanes();
  assert.equal(after.length, 1, "the hook's lane replaces the touched one");
  assert.equal(after[0].last_line, "turn done");
});

// T-57: member names a person, a device or a child. A person covers each of their devices and those devices' children.
test("bridge_sessions member resolves a person to their devices' children, a device to its children, a child to itself", async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const s = `cse_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  const headers = { Authorization: `Bearer ${ownerDeviceToken}`, "Content-Type": "application/json", [SESSION_HEADER]: s, [CONTEXT_HEADER]: REPO };
  const child = (await fetch(new URL("/v1/me", base), { headers }).then((r) => r.json())).member;
  assert.match(child, new RegExp(String.raw`^${escapeRegex(OWNER_DEVICE)}-[a-z0-9]+-${REPO}$`, ""));
  const has = async (member) => (await rest(otherToken, "GET", `/v1/sessions?member=${member}`)).body.some((r) => r.session === s);
  assert.ok(await has(OWNER), "person: a child of one of their devices");
  assert.ok(await has(OWNER_DEVICE), "device: its own child");
  assert.ok(await has(child), "child: itself");
  assert.ok(!(await has(OTHER)), "another person: not listed");
  assert.ok(!(await has(OWNER_CLOUD)), "another device of the same person: not listed");
  assert.match((await callTool(otherToken, "bridge_sessions", { member: OWNER })).content[0].text, new RegExp(s));
  await fetch(new URL("/v1/status", base), { method: "POST", headers, body: JSON.stringify({ state: "offline" }) });
});

// T-57: a session that died stays discoverable, so its log can still be read.
test("include ended lists a fired session that died without replying, with its child, session id and fault", async () => {
  const { ownerCloudToken, sleep, useFakeRoutines } = await import("./helpers.mjs");
  const fakeRoutines = useFakeRoutines();
  if (!fakeRoutines) return;
  const lease = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  await drain(ownerToken); await drain(ownerCloudToken);
  const made = (await callTool(ownerToken, "bridge_send", { to: OWNER_CLOUD, subject: "Die quietly", body: "T-57 ended-lanes test.", new_session: true })).content[0].text;
  const sessionId = made.match(/session_fake\d+/)[0];
  const header = sessionId.replace(/^session_/, "cse_");
  const child = (await fetch(new URL("/v1/me", base), { headers: { Authorization: `Bearer ${ownerCloudToken}`, [SESSION_HEADER]: header, [CONTEXT_HEADER]: REPO } }).then((r) => r.json())).member;
  await rest(ownerToken, "POST", "/v1/sessions", { session: header, line: "about to go quiet" });
  const until = Date.now() + lease * 4;
  while (Date.now() < until && !(await rest(ownerToken, "GET", "/v1/faults")).body.fires.some((f) => f.session_id === sessionId && f.fault === "died_without_reply")) await sleep(300);
  const plain = (await callTool(ownerToken, "bridge_sessions", { member: OWNER })).content[0].text;
  // A live lane is listed under the id the session sends (cse_...), so that is the form that must be absent.
  assert.ok(!plain.includes(header) && !plain.includes(sessionId) && !plain.includes("died_without_reply"), `the default output is unchanged: live sessions only: ${plain}`);
  const text = (await callTool(ownerToken, "bridge_sessions", { member: OWNER, include: "ended" })).content[0].text;
  const line = text.split("\n").find((l) => l.includes(sessionId));
  assert.ok(line, `ended list names the fire: ${text}`);
  assert.ok(line.includes(child) && line.includes("died_without_reply"), line);
  const [, logMember, logSession] = line.match(/bridge_session_log member=(\S+) session=(\S+)/) ?? [];
  assert.equal(logSession, header, "names the log to read");
  const log = (await callTool(ownerToken, "bridge_session_log", { member: logMember, session: logSession })).content[0].text;
  assert.match(log, /about to go quiet/);
  await drain(ownerToken); await drain(ownerCloudToken);
});
