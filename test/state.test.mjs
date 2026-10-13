import { CONTEXT_HEADER, GITHUB_OWNER, OTHER_DEVICE, OWNER, OWNER_CLOUD, OWNER_DEVICE, OWNER_SECOND_DEVICE, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// The task state machine (src/hub/state.ts): who may move a task where. done comes from a merge, or from the owner on a
// task that never has a PR; task_done only reports; every claim goes through the claim path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { base, ownerToken, ownerDeviceToken, ownerCloudToken, otherDeviceToken, rest, mcp, callTool, drain } from "./helpers.mjs";

const repo = `state-${Date.now()}`;
const made = [];
async function make(fields = {}) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "State task", brief: "A task for the state tests.", repo, ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  made.push(res.body.key);
  return res.body;
}
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
const patch = (token, key, body) => rest(token, "PATCH", `/v1/tasks/${key}`, body);
const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
async function as(token, session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: "state" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("a move that is not in the table is refused with a clear error", async () => {
  const t = await make({ state: "backlog" });
  const res = await patch(otherDeviceToken, t.key, { state: "in_progress" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, new RegExp(`${t.key} cannot go from backlog to in_progress`));
  assert.match(res.body.error, /Claim it first \(task_update state claim\), then report/);
  assert.equal((await get(t.key)).state, "backlog");
});

test("task_done reports: with a PR it moves to review, never to done, and the owner is told", async () => {
  await drain(ownerToken);
  const t = await make({ state: "ready" });
  assert.equal((await patch(otherDeviceToken, t.key, { state: "claim" })).status, 200);
  const url = `https://github.com/${GITHUB_OWNER}/${repo}/pull/1`;
  const text = (await callTool(otherDeviceToken, "task_done", { key: t.key, summary: "Pushed abc123.", pr_url: url })).content[0].text;
  assert.match(text, /state review/);
  assert.match(text, /done when its PR merges/);
  const after = await get(t.key);
  assert.equal(after.state, "review");
  assert.equal(after.closed_at, null);
  const notice = (await rest(ownerToken, "GET", "/v1/inbox")).body.find((m) => m.thread_id === t.thread_id);
  assert.match(notice.body, new RegExp(String.raw`reported finished by ${escapeRegex(OTHER_DEVICE)}: Pushed abc123\.`, ""));
  // Again from review: it stays in review and records the summary.
  const again = await rest(otherDeviceToken, "POST", `/v1/tasks/${t.key}/done`, { summary: "One more fix pushed." });
  assert.equal(again.status, 200);
  assert.equal(again.body.task.state, "review");
  await drain(ownerToken);
});

test("task_done without a PR lets the holder's claim go, so its later exit is no orphan fault", async () => {
  await drain(ownerToken);
  const s = newSession();
  const t = await make({ state: "ready" });
  assert.equal((await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${t.key}`, { state: "claim" })).status, 200);
  const res = await as(ownerCloudToken, s, "POST", `/v1/tasks/${t.key}/done`, { summary: "Answered the question." });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.task.state, "ready");
  assert.equal(res.body.task.claim_session, null);
  const claims = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.claims;
  assert.equal(claims[0].end_reason, "reported");
  await as(ownerCloudToken, s, "POST", "/v1/status", { state: "offline", summary: "test over" });
  const inbox = (await rest(ownerToken, "GET", "/v1/inbox")).body;
  assert.ok(!inbox.some((m) => /FAULT orphaned/.test(m.body) && m.body.includes(t.key)), "no orphan fault after a report");
  await drain(ownerToken);
});

test("a cloud parent cannot hold a claim, created or updated", async () => {
  const t = await make({ state: "ready" });
  const upd = await patch(ownerToken, t.key, { state: "claimed", assignee: OWNER_CLOUD });
  assert.equal(upd.status, 400);
  assert.match(upd.body.error, new RegExp(String.raw`assign it \(state ready, assignee ${escapeRegex(OWNER_CLOUD)}\) and the bridge fires a session; a claim belongs to a session`, ""));
  const created = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "x", brief: "y", repo, state: "claimed", assignee: OWNER_CLOUD });
  assert.equal(created.status, 400);
  assert.match(created.body.error, /a claim belongs to a session/);
  assert.equal((await rest(ownerCloudToken, "PATCH", `/v1/tasks/${t.key}`, { state: "claim" })).status, 400, "the parent claiming for itself too");
});

test("only the owner sets done by hand, and only on an exempt-labelled task", async () => {
  const plain = await make({ state: "ready" });
  const refused = await patch(ownerToken, plain.key, { state: "done" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /done comes from the merge/);
  const audit = await make({ state: "ready", labels: ["audit"] });
  assert.equal((await patch(ownerCloudToken, audit.key, { state: "done" })).status, 400, "a cloud device is not the owner");
  const done = await patch(ownerDeviceToken, audit.key, { state: "done", note: "Audit read, nothing to fix." });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.state, "done");
  // A closed task is not claimed back; the owner reopens it.
  const claim = await patch(otherDeviceToken, audit.key, { state: "claim" });
  assert.equal(claim.status, 400);
  assert.match(claim.body.error, /closed task is not claimed/);
  assert.equal((await patch(otherDeviceToken, audit.key, { state: "ready" })).status, 400, "only the owner reopens");
  assert.equal((await patch(ownerToken, audit.key, { state: "ready" })).status, 200);
});

test("claimed is only reached by a claim: an explicit assignee is claimed for, a null one is refused", async () => {
  const t = await make({ state: "ready" });
  const nobody = await patch(ownerToken, t.key, { state: "claimed", assignee: null });
  assert.equal(nobody.status, 400);
  const handed = await patch(ownerToken, t.key, { state: "claimed", assignee: OWNER_DEVICE });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.task.assignee, OWNER_DEVICE);
  assert.equal(handed.body.task.claim_session, OWNER_DEVICE, "the claim is stamped");
  const created = await make({ state: "claimed", assignee: OWNER_SECOND_DEVICE });
  assert.equal(created.claim_session, OWNER_SECOND_DEVICE);
});

test("create with state claim goes through the warm check", async () => {
  const s = newSession();
  const anchor = await make({ state: "ready", labels: ["anchor-only"] });
  assert.equal((await as(ownerCloudToken, s, "PATCH", `/v1/tasks/${anchor.key}`, { state: "claim" })).status, 200);
  const res = await as(ownerCloudToken, s, "POST", "/v1/tasks", { owner: OWNER, title: "unrelated", brief: "x", repo: "elsewhere", state: "claim" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not related/);
  await as(ownerCloudToken, s, "POST", "/v1/status", { state: "offline", summary: "test over" });
});

test("warm caps apply to cloud sessions only: a Mac session claims unrelated tasks", async () => {
  const s = newSession();
  const a = await make({ state: "ready", labels: ["one"] });
  const b = await make({ state: "ready", labels: ["two"], repo: "other-repo" });
  assert.equal((await as(ownerDeviceToken, s, "PATCH", `/v1/tasks/${a.key}`, { state: "claim" })).status, 200);
  const second = await as(ownerDeviceToken, s, "PATCH", `/v1/tasks/${b.key}`, { state: "claim" });
  assert.equal(second.status, 200, JSON.stringify(second.body));
});

// task_done reports; the merge closes. No agent-facing text may say otherwise.
const SAYS_DONE = /finish(es)? (it )?with task_done|task_done (finishes|closes)|sets it done|Finish a task/i;
test("no prompt, tool description or guide tells an agent that task_done closes a task", async () => {
  // The pattern itself catches each way of saying it.
  for (const said of ["task_done closes the task", "Finish it with task_done.", "task_done finishes the task", "that sets it done", "Finish a task by calling task_done"]) {
    assert.match(said, SAYS_DONE, said);
  }
  assert.doesNotMatch("task_done reports finished work; the merge closes the task", SAYS_DONE);
  for (const file of ["../src/rules.ts", "../src/routines.ts", "../src/tools.ts", "../src/home.ts", "../docs/agent-setup.md"]) {
    assert.ok(!SAYS_DONE.test(readFileSync(new URL(file, import.meta.url), "utf8")), `${file} says task_done closes a task`);
  }
  const tools = (await mcp(ownerToken, "tools/list", {})).result.tools;
  for (const t of tools) assert.doesNotMatch(t.description, SAYS_DONE, t.name);
  assert.match(tools.find((t) => t.name === "task_done").description, /merge/);
  assert.doesNotMatch((await callTool(ownerToken, "bridge_help")).content[0].text, SAYS_DONE);
});

test("cleanup", async () => {
  for (const k of made) await patch(ownerToken, k, { state: "dropped" });
  for (const t of [ownerToken, ownerDeviceToken, ownerCloudToken, otherDeviceToken]) await drain(t);
});
