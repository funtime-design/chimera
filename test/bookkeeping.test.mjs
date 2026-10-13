import { GITHUB_OWNER, OWNER, OWNER_CLOUD } from "./harness/roles.mjs";
// Bookkeeping holes from the 2026-10-11 audit (T-70): branch uniqueness on a repo-only update, deploys from other
// environments, a deploy that arrives before its merge, and a threadless routine fire that kept the alarm alive forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { buildSync } from "esbuild";
import { devVars,  base, ownerToken, rest, drain  } from "./helpers.mjs";

const repoName = `keep${Date.now()}`;
const made = [];
async function make(fields) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, brief: "Do it.", title: "Bookkeeping task", repo: `${GITHUB_OWNER}/${repoName}`, ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  made.push(res.body.key);
  return res.body;
}
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
const repository = () => ({ full_name: `${GITHUB_OWNER}/${repoName}`, default_branch: "main", owner: { login: GITHUB_OWNER } });
async function hook(payload, event) {
  const text = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": randomUUID(),
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", (devVars.GOONBRIDGE_GITHUB_WEBHOOK_SECRET ?? "test-webhook-secret")).update(text).digest("hex")}`,
  };
  const res = await fetch(new URL("/v1/github/webhook", base), { method: "POST", headers, body: text });
  return { status: res.status, body: await res.json() };
}
let n = 900;
const merged = (branch, sha) => ({
  action: "closed", repository: repository(),
  pull_request: { number: ++n, title: "A change", draft: false, html_url: `https://github.com/${GITHUB_OWNER}/${repoName}/pull/${n}`, merged: true, merge_commit_sha: sha, merged_by: { login: OWNER }, head: { ref: branch }, base: { ref: "main" } },
});
const deployment = (sha, environment, state = "success") => ({ repository: repository(), deployment: { sha, environment }, deployment_status: { state, target_url: "https://example.test" } });

test("a repo-only update cannot give two open tasks the same repo and branch", async () => {
  const branch = `claude/shared-${randomUUID().slice(0, 8)}`;
  await make({ branch, state: "ready" });
  const other = await make({ branch, state: "ready", repo: `${GITHUB_OWNER}/somewhere-else` });
  const res = await rest(ownerToken, "PATCH", `/v1/tasks/${other.key}`, { repo: `${GITHUB_OWNER}/${repoName}` });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already held by open task/);
});

test("only a production deployment marks a merge live (GOONBRIDGE_DEPLOY_ENVIRONMENT, default production)", async () => {
  const sha = randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
  const branch = `claude/env-${randomUUID().slice(0, 8)}`;
  const t = await make({ branch, state: "review" });
  await hook(merged(branch, sha), "pull_request");
  assert.equal((await get(t.key)).deploy_state, "pending");
  const preview = await hook(deployment(sha, "preview"), "deployment_status");
  assert.equal(preview.body.ignored, true);
  assert.equal((await get(t.key)).deploy_state, "pending", "a preview deploy says nothing about production");
  assert.equal((await hook(deployment(sha, "Production"), "deployment_status")).body.outcome, "live");
});

test("a deploy that reports before its merge is held and applied when the merge arrives", async () => {
  const sha = randomUUID().replace(/-/g, "").padEnd(40, "1").slice(0, 40);
  const branch = `claude/early-${randomUUID().slice(0, 8)}`;
  const t = await make({ branch, state: "review" });
  const early = await hook(deployment(sha, "production"), "deployment_status");
  assert.equal(early.status, 200);
  await hook(merged(branch, sha), "pull_request");
  const after = await get(t.key);
  assert.equal(after.state, "done");
  assert.equal(after.deploy_state, "live", "the early deploy counted");
});

// openWork() decides whether the Hub alarm keeps running. Run the real module against an in-memory SQLite.
const { outputFiles } = buildSync({ entryPoints: [new URL("../src/hub/faults.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const faults = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const sqlite = process.getBuiltinModule?.("node:sqlite");
function memorySql() {
  const db = new sqlite.DatabaseSync(":memory:");
  const cursor = (rows) => ({ toArray: () => rows, one: () => rows[0] });
  return { exec: (q, ...p) => (p.length === 0 && /;\s*\S/.test(q.trim()) ? (db.exec(q), cursor([])) : cursor(db.prepare(q).all(...p))) };
}

test("a threadless routine fire stops counting as open work once its session boots", { skip: !sqlite && "node:sqlite is not available" }, () => {
  const sql = memorySql();
  sql.exec("CREATE TABLE tasks (key TEXT, thread_id INTEGER, claim_session TEXT, state TEXT, deploy_state TEXT); CREATE TABLE cloud_devices (name TEXT, parent TEXT, session TEXT, seen_at INTEGER); CREATE TABLE messages (id INTEGER, thread_id INTEGER, sender TEXT, recipient TEXT, reserved_for TEXT); CREATE TABLE deliveries (message_id INTEGER, member TEXT, done_at TEXT); CREATE TABLE review_fires (session_id TEXT);");
  faults.initFaults(sql);
  faults.recordFire(sql, { member: OWNER_CLOUD, requester: OWNER, message_id: 0, thread_id: 0, task_key: null, session_id: "session_0123456789abcdef", url: "https://example.test/s" });
  assert.equal(faults.openWork(sql), true, "waiting for the session to boot");
  faults.linkSession(sql, OWNER_CLOUD, "cse_0123456789abcdef", `${OWNER_CLOUD}-x7k-test`);
  assert.equal(faults.openWork(sql), false, "booted: nothing left to judge, the alarm may stop");
});

test("cleanup", async () => {
  for (const k of made) assert.equal((await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" })).status, 200, k);
  await drain(ownerToken);
});
