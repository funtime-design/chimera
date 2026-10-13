import { CONTEXT_HEADER, GITHUB_OWNER, OWNER, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Epics (T-53, F6 phase 1): a task of kind epic groups child tasks (parent = the epic's key). An epic is never claimed;
// its state follows its children. A PR naming several children of one epic moves all of them.
// Needs GOONBRIDGE_GITHUB_WEBHOOK_SECRET=test-webhook-secret in .dev.vars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { devVars,  base, ownerToken, ownerCloudToken, otherToken, rest, callTool, drain  } from "./helpers.mjs";

const repoName = `epic${Date.now()}`;
const SHA = "abc123def4567890abc123def4567890abc12345";
const sign = (raw) => `sha256=${createHmac("sha256", (devVars.GOONBRIDGE_GITHUB_WEBHOOK_SECRET ?? "test-webhook-secret")).update(raw).digest("hex")}`;
async function hook(payload) {
  const text = JSON.stringify(payload);
  const res = await fetch(new URL("/v1/github/webhook", base), {
    method: "POST", body: text,
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": randomUUID(), "X-Hub-Signature-256": sign(text) },
  });
  return { status: res.status, body: await res.json() };
}
let n = 900;
function pr({ branch = `claude/epic-${randomUUID().slice(0, 8)}`, action = "opened", title, merged = false, number } = {}) {
  number ??= ++n;
  return {
    action, repository: { full_name: `${GITHUB_OWNER}/${repoName}`, default_branch: "main", owner: { login: GITHUB_OWNER } },
    pull_request: {
      number, title, draft: false, merged, html_url: `https://github.com/${GITHUB_OWNER}/${repoName}/pull/${number}`,
      merge_commit_sha: merged ? SHA : null, merged_by: merged ? { login: OWNER } : null, head: { ref: branch }, base: { ref: "main" },
    },
  };
}
async function make(fields) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, brief: "Part of an epic.", title: "Epic test", repo: `${GITHUB_OWNER}/${repoName}`, ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
const patch = (token, key, body) => rest(token, "PATCH", `/v1/tasks/${key}`, body);

test("an epic takes children by parent, cannot be claimed, and only the owner sets a parent", async () => {
  const epic = await make({ title: "The epic", kind: "epic" });
  assert.equal(epic.kind, "epic");
  assert.equal(epic.state, "backlog");
  const a = await make({ title: "child A", parent: epic.key.toLowerCase().replace("-", ""), state: "ready" });
  assert.equal(a.parent, epic.key, "the parent key is normalized");
  assert.equal(a.kind, "task");
  assert.equal((await get(epic.key)).task.state, "ready", "an open child makes the epic ready");

  const claim = await patch(ownerToken, epic.key, { state: "claim" });
  assert.equal(claim.status, 400);
  assert.match(claim.body.error, /is an epic.*claim a child/);
  const move = await patch(ownerToken, epic.key, { state: "in_progress" });
  assert.equal(move.status, 400);
  assert.match(move.body.error, /follows its children/);

  assert.match((await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "x", brief: "y", parent: a.key })).body.error, /not an epic/);
  assert.match((await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "x", brief: "y", parent: "T-99999999" })).body.error, /not found/);
  assert.match((await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "x", brief: "y", kind: "saga" })).body.error, /kind/);
  assert.match((await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "x", brief: "y", kind: "epic", parent: epic.key })).body.error, /an epic cannot have a parent/);

  const b = await make({ title: "child B", state: "ready" });
  const denied = await patch(otherToken, b.key, { parent: epic.key, expected_version: b.version });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, new RegExp(String.raw`only ${escapeRegex(OWNER)} .*sets the parent`, ""));
  const ok = await patch(ownerToken, b.key, { parent: epic.key });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.task.parent, epic.key);
  assert.equal((await patch(ownerToken, b.key, { parent: null })).body.task.parent, null, "a parent can be cleared");

  // An existing task becomes an epic (the conversion of a label set): owner only, and only while nobody holds it.
  const plain = await make({ title: "becomes an epic" });
  assert.match((await patch(otherToken, plain.key, { kind: "epic", expected_version: plain.version })).body.error, new RegExp(String.raw`only ${escapeRegex(OWNER)} .*sets the kind`, ""));
  assert.equal((await patch(ownerToken, plain.key, { kind: "epic" })).body.task.kind, "epic");
  assert.equal((await patch(ownerToken, b.key, { parent: plain.key })).status, 200);
  assert.match((await patch(ownerToken, plain.key, { kind: "task" })).body.error, /has children/);
  await drain(otherToken);
});

test("epic state is derived: ready while any child is open, blocked if one is, review when all are up, done when all are done", async () => {
  const epic = await make({ title: "Derived", kind: "epic" });
  const a = await make({ title: "A", parent: epic.key, state: "ready", labels: ["no-pr"] });
  const b = await make({ title: "B", parent: epic.key, state: "ready", labels: ["no-pr"] });
  const state = async () => (await get(epic.key)).task.state;
  assert.equal(await state(), "ready");
  assert.equal((await patch(ownerToken, a.key, { state: "blocked" })).status, 200);
  assert.equal(await state(), "blocked");
  assert.equal((await patch(ownerToken, a.key, { state: "review" })).status, 200);
  assert.equal(await state(), "ready", "B is still open");
  assert.equal((await patch(ownerToken, b.key, { state: "review" })).status, 200);
  assert.equal(await state(), "review");
  assert.equal((await patch(ownerToken, a.key, { state: "done" })).status, 200);
  assert.equal(await state(), "review", "done + review is still review");
  assert.equal((await patch(ownerToken, b.key, { state: "done" })).status, 200);
  const done = (await get(epic.key)).task;
  assert.equal(done.state, "done");
  assert.equal(done.closed_by, "system");
  // A reopened child reopens the epic; a dropped child stops counting.
  assert.equal((await patch(ownerToken, b.key, { state: "ready" })).status, 200);
  const reopened = (await get(epic.key)).task;
  assert.equal(reopened.state, "ready");
  assert.equal(reopened.closed_at, null);
  assert.equal((await patch(ownerToken, b.key, { state: "dropped" })).status, 200);
  assert.equal(await state(), "done");
  // The owner may still drop the epic itself.
  assert.equal((await patch(ownerToken, epic.key, { state: "dropped" })).status, 200);
});

test("task_list groups children under their epic with a rollup line; task_get on an epic lists its children", async () => {
  const epic = await make({ title: "Listed epic", kind: "epic" });
  const a = await make({ title: "listed A", parent: epic.key, state: "ready", labels: ["no-pr"] });
  const b = await make({ title: "listed B", parent: epic.key, state: "in_progress", labels: ["ci-red"] });
  const c = await make({ title: "listed C", parent: epic.key, state: "ready", labels: ["no-pr"] });
  assert.equal((await patch(ownerToken, c.key, { state: "done" })).status, 200);
  const loose = await make({ title: "listed loose", state: "ready" });

  const rows = (await rest(ownerToken, "GET", `/v1/tasks?repo=${GITHUB_OWNER}/${repoName}`)).body;
  const e = rows.find((t) => t.key === epic.key);
  assert.deepEqual({ total: e.rollup.total, done: e.rollup.done, ci_red: e.rollup.ci_red, blocked: e.rollup.blocked, orphaned: e.rollup.orphaned }, { total: 3, done: 1, ci_red: 1, blocked: 0, orphaned: 0 });

  const text = (await callTool(ownerToken, "task_list", { repo: `${GITHUB_OWNER}/${repoName}` })).content[0].text;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(`${epic.key} · `));
  assert.ok(at >= 0, text);
  assert.match(lines[at], /epic/);
  assert.match(lines[at + 1], /1\/3 done.*1 ci-red/);
  const kids = lines.slice(at + 2, at + 4);
  assert.ok(kids.join("\n").includes(b.key) && kids.join("\n").includes(a.key), text);
  assert.ok(kids.every((l) => l.startsWith("      ")), "children are indented under the epic");
  assert.ok(!kids.some((l) => l.includes(loose.key)));
  assert.equal(lines.filter((l) => l.includes(`${a.key} · `)).length, 1, "a child is listed once");

  const got = await get(epic.key);
  assert.deepEqual(got.children.map((t) => t.key).sort(), [a.key, b.key, c.key].sort());
  const shown = (await callTool(ownerToken, "task_get", { key: epic.key })).content[0].text;
  assert.match(shown, /Children \(3, 1\/3 done/);
  assert.ok(shown.includes(a.key) && shown.includes(c.key));
});

test("a PR naming several children of one epic moves them all: review on open, done on merge, one note each", async () => {
  const epic = await make({ title: "Multi", kind: "epic" });
  const a = await make({ title: "multi A", parent: epic.key, state: "in_progress" });
  const b = await make({ title: "multi B", parent: epic.key, state: "in_progress" });
  const p = pr({ title: `${a.key} ${b.key}: one PR for both` });
  const opened = await hook(p);
  assert.equal(opened.body.outcome, "review", JSON.stringify(opened.body));
  assert.deepEqual([...opened.body.tasks].sort(), [a.key, b.key].sort());
  for (const t of [a, b]) {
    const now = (await get(t.key)).task;
    assert.equal(now.state, "review");
    assert.equal(now.pr_url, p.pull_request.html_url, "siblings may share a PR");
  }
  assert.equal((await get(epic.key)).task.state, "review");
  const merged = await hook({ ...p, action: "closed", pull_request: { ...p.pull_request, merged: true, merge_commit_sha: SHA, merged_by: { login: OWNER } } });
  assert.equal(merged.body.outcome, "done", JSON.stringify(merged.body));
  for (const t of [a, b]) {
    const now = await get(t.key);
    assert.equal(now.task.state, "done");
    assert.equal(now.task.merged_sha, SHA);
    const thread = (await rest(ownerToken, "GET", `/v1/threads/${t.thread_id}`)).body;
    assert.equal(thread.filter((m) => /merged to main/.test(m.body)).length, 1);
  }
  assert.equal((await get(epic.key)).task.state, "done");
});

test("a PR naming the epic itself moves its open children; two unrelated keys move nothing", async () => {
  const epic = await make({ title: "By epic key", kind: "epic" });
  const a = await make({ title: "ek A", parent: epic.key, state: "in_progress" });
  const b = await make({ title: "ek B", parent: epic.key, state: "ready" });
  const opened = await hook(pr({ title: `${epic.key}: the whole epic` }));
  assert.deepEqual([...opened.body.tasks].sort(), [a.key, b.key].sort());
  assert.equal((await get(a.key)).task.state, "review");
  assert.equal((await get(epic.key)).task.state, "review");

  const x = await make({ title: "unrelated X", state: "in_progress" });
  const y = await make({ title: "unrelated Y", state: "in_progress" });
  const res = await hook(pr({ title: `${x.key} and ${y.key}`, merged: true, action: "closed" }));
  assert.notEqual(res.body.outcome, "done");
  for (const t of [x, y]) assert.equal((await get(t.key)).task.state, "in_progress");
});

test("an orphaned child blocks its epic until someone claims it again", async () => {
  const epic = await make({ title: "Orphan epic", kind: "epic", repo: REPO });
  const child = await make({ title: "orphan child", parent: epic.key, state: "ready", repo: REPO });
  const session = `cse_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const as = (method, path, body) => fetch(new URL(path, base), {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
  });
  await as("GET", "/v1/me");
  assert.equal((await as("PATCH", `/v1/tasks/${child.key}`, { state: "claim" })).status, 200);
  assert.equal((await get(epic.key)).task.state, "ready");
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session })).status, 200);
  assert.ok((await get(child.key)).task.orphaned_at, "kill releases with the orphan mark");
  const blocked = await get(epic.key);
  assert.equal(blocked.task.state, "blocked");
  assert.equal(blocked.rollup.orphaned, 1);
  assert.equal((await patch(ownerToken, child.key, { state: "claim" })).status, 200);
  assert.equal((await get(epic.key)).task.state, "ready", "a new claim ends the orphan mark");
  await patch(ownerToken, child.key, { state: "dropped" });
  await patch(ownerToken, epic.key, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("siblings sharing a PR cannot be split under different parents, nor one taken out of its epic", async () => {
  const one = await make({ title: "split one", kind: "epic" });
  const two = await make({ title: "split two", kind: "epic" });
  const url = `https://github.com/${GITHUB_OWNER}/${repoName}/pull/${++n}`;
  const a = await make({ title: "split A", parent: one.key, state: "in_progress", pr_url: url });
  const b = await make({ title: "split B", parent: one.key, state: "in_progress", pr_url: url });
  const moved = await patch(ownerToken, b.key, { parent: two.key });
  assert.equal(moved.status, 400);
  assert.match(moved.body.error, /already held by open task/);
  const cleared = await patch(ownerToken, b.key, { parent: null });
  assert.equal(cleared.status, 400);
  assert.match(cleared.body.error, /already held by open task/);
  assert.equal((await get(b.key)).task.parent, one.key);
  assert.equal((await get(a.key)).task.parent, one.key);
});

// DEFECT 16 (T-66 verification): each epic check looked at the old kind, so one call could make a claimed epic; and an
// orphaned task turned epic kept its orphan mark for good.
test("one call cannot make a claimed epic, and converting an orphaned task clears its orphan mark", async () => {
  const t = await make({ title: "claim and convert", state: "ready" });
  const both = await patch(ownerToken, t.key, { kind: "epic", state: "claim" });
  assert.equal(both.status, 400, JSON.stringify(both.body));
  assert.match(both.body.error, /epic/);
  const after = (await get(t.key)).task;
  assert.equal(after.kind, "task");
  assert.equal(after.claim_session, null);

  const o = await make({ title: "orphan then epic", state: "ready", repo: REPO });
  const session = `cse_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const as = (method, path, body) => fetch(new URL(path, base), {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
  });
  assert.equal((await as("PATCH", `/v1/tasks/${o.key}`, { state: "claim" })).status, 200);
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session })).status, 200);
  assert.ok((await get(o.key)).task.orphaned_at, "orphaned by the kill");
  assert.equal((await patch(ownerToken, o.key, { kind: "epic" })).status, 200);
  const epic = (await get(o.key)).task;
  assert.equal(epic.kind, "epic");
  assert.equal(epic.orphaned_at, null, "an epic is never orphaned");
  assert.ok(!(await rest(ownerToken, "GET", "/v1/faults")).body.orphaned_tasks.some((x) => x.key === o.key), "not listed as an orphaned task");
  await drain(ownerToken); await drain(ownerCloudToken);
});

// DEFECT 8 (T-66 verification): never fire a session for an epic, even one converted from a task that was in review.
test("a ready-for-re-review note on an epic converted from a reviewed task starts no reviewer", async () => {
  const branch = `claude/epic-rr-${randomUUID().slice(0, 8)}`;
  const t = await make({ title: "reviewed then epic", state: "in_progress", branch });
  await hook(pr({ branch, action: "opened" }));
  assert.equal((await get(t.key)).task.state, "review");
  assert.equal((await patch(ownerToken, t.key, { kind: "epic" })).status, 200);
  const noted = await patch(ownerToken, t.key, { note: "ready for re-review" });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.equal(noted.body.reviewer, undefined, "no reviewer for an epic");
});

test("cleanup: drop what this file made", async () => {
  const rows = (await rest(ownerToken, "GET", `/v1/tasks?repo=${GITHUB_OWNER}/${repoName}`)).body;
  for (const t of rows.filter((x) => x.kind !== "epic")) assert.equal((await patch(ownerToken, t.key, { state: "dropped" })).status, 200, t.key);
  for (const t of rows.filter((x) => x.kind === "epic")) {
    const now = (await get(t.key)).task;
    if (now.state !== "dropped") assert.equal((await patch(ownerToken, t.key, { state: "dropped" })).status, 200, t.key);
  }
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/tasks?repo=${GITHUB_OWNER}/${repoName}`)).body.map((t) => `${t.key} ${t.state}`), []);
  await drain(ownerToken);
});
