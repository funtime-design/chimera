import { CONTEXT_HEADER, OTHER, OTHER_DEVICE, OWNER, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Optimistic concurrency on tasks: every write bumps version, labels change by add/remove, and anyone editing a task
// they do not hold passes expected_version (the owner of an unclaimed task need not).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, ownerCloudToken, ownerSecondDeviceToken, otherToken, otherDeviceToken, rest, callTool, drain } from "./helpers.mjs";

const repo = `versions-${Date.now()}`;
const made = [];
async function make(fields = {}) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Version task", brief: "A task for the version tests.", repo, state: "ready", ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  made.push(res.body.key);
  return res.body;
}
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
const patch = (token, key, body) => rest(token, "PATCH", `/v1/tasks/${key}`, body);
const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
async function as(session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: "versions" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("an edit by someone who does not hold the task needs expected_version; the owner of an unclaimed task does not", async () => {
  const t = await make();
  // A session of the owner's household (outside it, priority is not editable at all: test/permissions.test.mjs).
  const s = newSession();
  const blind = await as(s, "PATCH", `/v1/tasks/${t.key}`, { priority: 1 });
  assert.equal(blind.status, 400);
  assert.match(blind.body.error, /expected_version/);
  assert.equal((await as(s, "PATCH", `/v1/tasks/${t.key}`, { priority: 1, expected_version: t.version })).status, 200);
  await as(s, "POST", "/v1/status", { state: "offline", summary: "test over" });
  assert.equal((await patch(ownerToken, t.key, { priority: 2 })).status, 200, "owner, unclaimed");
  // Claims and notes stay version-free.
  assert.equal((await patch(otherDeviceToken, t.key, { state: "claim", note: "mine" })).status, 200);
  assert.equal((await patch(otherDeviceToken, t.key, { branch: `claude/${repo}` })).status, 200, "the claimant edits freely");
  const owner = await patch(ownerToken, t.key, { priority: 4 });
  assert.equal(owner.status, 400, "the owner of a claimed task passes a version too");
  const now = await get(t.key);
  assert.equal((await patch(ownerToken, t.key, { priority: 4, expected_version: now.version })).status, 200);
});

test("labels: a full replace needs expected_version; add and remove do not, and a session cannot remove a system label", async () => {
  const t = await make({ labels: ["ci-red", "keep"] });
  assert.equal((await patch(otherDeviceToken, t.key, { state: "claim" })).status, 200);
  const stale = await patch(otherDeviceToken, t.key, { labels: ["mine"] });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /expected_version/);
  const added = await patch(otherDeviceToken, t.key, { add_labels: ["extra"], remove_labels: ["keep"] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.task.labels, ["ci-red", "extra"], "ci-red survives an add/remove");
  const strip = await patch(otherDeviceToken, t.key, { remove_labels: ["ci-red"] });
  assert.equal(strip.status, 400);
  assert.match(strip.body.error, /ci-red/);
  // A session of the owner's household that does not hold the task adds and removes without a version too; protected
  // labels stay protected.
  const s = newSession();
  const other = await as(s, "PATCH", `/v1/tasks/${t.key}`, { add_labels: [`seen-by-${OTHER}`] });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.ok(other.body.task.labels.includes("ci-red"));
  assert.equal((await as(s, "PATCH", `/v1/tasks/${t.key}`, { remove_labels: [`seen-by-${OTHER}`] })).status, 200);
  assert.equal((await as(s, "PATCH", `/v1/tasks/${t.key}`, { remove_labels: ["ci-red"] })).status, 400);
  await as(s, "POST", "/v1/status", { state: "offline", summary: "test over" });
  const viaTool = await callTool(otherDeviceToken, "task_update", { key: t.key, add_labels: ["tool"] });
  assert.ok(!viaTool.isError, viaTool.content[0].text);
  assert.ok((await get(t.key)).labels.includes("tool"));
  const v = (await get(t.key)).version;
  const replaced = await patch(otherDeviceToken, t.key, { labels: ["ci-red", "only"], expected_version: v });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.body.task.labels, ["ci-red", "only"]);
  assert.equal((await patch(ownerToken, t.key, { remove_labels: ["ci-red"], expected_version: v + 1 })).status, 200, "the owner may clear it");
});

test("a release (session offline) and a kill bump the version", async () => {
  const a = await make();
  const s1 = newSession();
  assert.equal((await as(s1, "PATCH", `/v1/tasks/${a.key}`, { state: "claim" })).status, 200);
  let before = (await get(a.key)).version;
  await as(s1, "POST", "/v1/status", { state: "offline", summary: "test over" });
  let after = await get(a.key);
  assert.equal(after.state, "ready");
  assert.ok(after.version > before, "release bumps version");

  const b = await make();
  const s2 = newSession();
  assert.equal((await as(s2, "PATCH", `/v1/tasks/${b.key}`, { state: "claim" })).status, 200);
  assert.equal((await as(s2, "PATCH", `/v1/tasks/${b.key}`, { state: "blocked", note: "waiting" })).status, 200);
  before = (await get(b.key)).version;
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: s2 })).status, 200);
  after = await get(b.key);
  assert.equal(after.claim_session, null);
  assert.ok(after.version > before, "kill bumps version");
});

test("taking over a blocked claim needs expected_version", async () => {
  const t = await make();
  assert.equal((await patch(otherDeviceToken, t.key, { state: "claim" })).status, 200);
  assert.equal((await patch(otherDeviceToken, t.key, { state: "blocked", note: "stuck" })).status, 200);
  const grab = await patch(ownerSecondDeviceToken, t.key, { state: "claim" });
  assert.equal(grab.status, 400);
  assert.match(grab.body.error, new RegExp(String.raw`already blocked by ${escapeRegex(OTHER_DEVICE)}`, ""));
});

test("cleanup", async () => {
  for (const k of made) await patch(ownerToken, k, { state: "dropped" });
  for (const t of [ownerToken, ownerCloudToken, otherDeviceToken]) await drain(t);
});
