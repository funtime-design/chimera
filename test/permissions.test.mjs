import { CONTEXT_HEADER, GITHUB_OWNER, OTHER, OTHER_DEVICE, OWNER, OWNER_DEVICE, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Who may change what on a task (T-60, src/hub/permissions.ts), on top of the state machine (state.ts). alice's household
// is alice and their devices; bob and bob-mac are outside it (bob-mac acts as a trust-admitted second person).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, ownerDeviceToken, ownerCloudToken, otherToken, otherDeviceToken, otherCloudToken, rest, drain } from "./helpers.mjs";

const repo = `perm-${Date.now()}`;
const made = [];
async function make(fields = {}) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Perm task", brief: "A task for the permission tests.", repo, ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  made.push(res.body.key);
  return res.body;
}
const patch = (token, key, body) => rest(token, "PATCH", `/v1/tasks/${key}`, body);
const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
async function as(token, session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: "perm" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
function refused(res, pattern) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, pattern);
}

test("outside the household: editing title, brief, priority, owner or labels is refused, naming who may", async () => {
  const t = await make({ state: "ready" });
  for (const body of [{ brief: "rewritten" }, { title: "renamed" }, { priority: 1 }, { owner: OTHER }, { add_labels: ["x"] }, { assignee: OTHER_DEVICE }]) {
    refused(await patch(otherDeviceToken, t.key, { ...body, expected_version: t.version }), new RegExp(String.raw`outside ${escapeRegex(OWNER)}'s household.*${escapeRegex(OWNER)}'s household may`, ""));
  }
  refused(await patch(otherDeviceToken, t.key, { state: "dropped" }), /cannot go from ready to dropped.*allowed: owner/);
  assert.equal((await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.task.version, t.version, "nothing changed");
});

test("outside the household: a note is allowed, and a claim only on a ready, unassigned task", async () => {
  const backlog = await make({ state: "backlog" });
  refused(await patch(otherDeviceToken, backlog.key, { state: "claim" }), new RegExp(String.raw`only a ready task that is unassigned.*${escapeRegex(OWNER)}'s household`, ""));
  const held = await make({ state: "ready", assignee: OWNER_DEVICE });
  refused(await patch(otherDeviceToken, held.key, { state: "claim", expected_version: held.version }), /only a ready task that is unassigned/);
  const t = await make({ state: "ready" });
  assert.equal((await patch(otherToken, t.key, { note: "Looks related to the sync work." })).status, 200);
  const claimed = await patch(otherDeviceToken, t.key, { state: "claim" });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.assignee, OTHER_DEVICE);
});

test("a claimant outside the household sets state, branch, pr_url and labels, not the brief or the priority", async () => {
  const t = await make({ state: "ready", labels: ["keep"] });
  assert.equal((await patch(otherDeviceToken, t.key, { state: "claim" })).status, 200);
  const work = await patch(otherDeviceToken, t.key, { state: "in_progress", branch: `claude/${repo}`, pr_url: `https://github.com/${GITHUB_OWNER}/${repo}/pull/9`, add_labels: ["wip"], note: "Started." });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  assert.deepEqual(work.body.task.labels, ["keep", "wip"]);
  refused(await patch(otherDeviceToken, t.key, { brief: "my own scope" }), new RegExp(String.raw`${escapeRegex(OTHER_DEVICE)} holds the claim on .*branch, pr_url, labels and notes.*brief is for ${escapeRegex(OWNER)}'s household`, ""));
  refused(await patch(otherDeviceToken, t.key, { priority: 1, expected_version: work.body.task.version }), /holds the claim/);
  assert.equal((await patch(otherDeviceToken, t.key, { state: "review" })).status, 200);
});

test("a cloud session of the owner's household edits, but never title, brief, owner, drop or done", async () => {
  const s = newSession();
  const t = await make({ state: "ready", labels: ["audit"] });
  const edit = await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { priority: 1, add_labels: ["x"], assignee: OWNER_DEVICE, expected_version: t.version });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const v = edit.body.task.version;
  refused(await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { brief: "new scope", expected_version: v }), new RegExp(String.raw`cloud session never changes the title or brief.*propose it in a note.*${escapeRegex(OWNER)}`, ""));
  refused(await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { owner: OTHER, expected_version: v }), new RegExp(String.raw`only ${escapeRegex(OWNER)} .*changes the owner`, ""));
  const same = await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { owner: OWNER_DEVICE, note: "same owner, by device name", expected_version: v });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  refused(await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { assignee: OTHER_DEVICE, expected_version: v }), new RegExp(String.raw`assignee stays in ${escapeRegex(OWNER)}'s household`, ""));
  refused(await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { state: "done" }), /allowed: github, owner/);
  refused(await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { state: "dropped" }), /allowed: owner/);
  await as(ownerCloudToken, s, "POST", "/v1/status", { state: "offline", summary: "test over" });
});

test("the owner's device may do anything on the owner's tasks", async () => {
  const t = await make({ state: "ready", labels: ["audit"] });
  const res = await patch(ownerDeviceToken, t.key, { title: "Renamed", brief: "New brief.", priority: 1, labels: ["audit", "y"], assignee: OTHER_DEVICE, expected_version: t.version });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await patch(ownerDeviceToken, t.key, { state: "done", note: "closed by hand" })).status, 200);
});

test("a task thread is readable by the owner's household and the assignee's, not by anyone else", async () => {
  const t = await make({ state: "ready" });
  assert.equal((await rest(ownerCloudToken, "GET", `/v1/threads/${t.thread_id}`)).status, 200);
  assert.equal((await rest(otherDeviceToken, "GET", `/v1/threads/${t.thread_id}`)).status, 400, `${OTHER_DEVICE} is not on it`);
  assert.equal((await rest(otherCloudToken, "GET", `/v1/threads/${t.thread_id}`)).status, 400);
  assert.equal((await patch(ownerToken, t.key, { assignee: OTHER_DEVICE })).status, 200);
  assert.equal((await rest(otherDeviceToken, "GET", `/v1/threads/${t.thread_id}`)).status, 200, "the assignee reads it");
  assert.equal((await rest(otherCloudToken, "GET", `/v1/threads/${t.thread_id}`)).status, 200, "and so does the assignee's household");
});

test("cleanup", async () => {
  for (const k of made) await patch(ownerToken, k, { state: "dropped" });
  for (const t of [ownerToken, otherToken, ownerDeviceToken, ownerCloudToken, otherDeviceToken]) await drain(t);
});
