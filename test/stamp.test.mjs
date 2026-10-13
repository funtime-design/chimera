import { GITHUB_OWNER, OWNER } from "./harness/roles.mjs";
// Admin stamp: POST /v1/tasks/:id/stamp (and the task_stamp tool) backfills merged_sha on a done task so `revert` can find it.
// Needs GOONBRIDGE_DEPLOY_SECONDS=3 in .dev.vars (the not_seen sweep must not touch a stamped task).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ownerToken, otherToken, ownerDeviceToken, ownerCloudToken, callTool, rest, sleep } from "./helpers.mjs";

const SHA = "925a42072eae4f43b3ef5ea3cb483585ebd0626b";
const doneTask = async (fields = {}) => {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Stamp me", brief: "Merged but unrecorded.", repo: `${GITHUB_OWNER}/stamp${randomUUID().slice(0, 6)}`, state: "done", ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
const stamp = (who, key, body) => rest(who, "POST", `/v1/tasks/${key}/stamp`, body);

test("stamp: a done task with no merged_sha gets one (deploy live), and revert then resolves it", async () => {
  const t = await doneTask({ pr_url: `https://github.com/${GITHUB_OWNER}/x/pull/${Math.floor(Math.random() * 1e6)}` });
  assert.equal((await rest(ownerToken, "POST", "/v1/revert", { target: t.key })).status, 400, "revert fails before the stamp");

  const res = await stamp(ownerToken, t.key, { merged_sha: SHA.toUpperCase(), deploy_state: "live" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.stamped, true);
  assert.equal(res.body.task.merged_sha, SHA, "normalized to lower case");
  assert.equal(res.body.task.deploy_state, "live");
  assert.ok(res.body.task.deployed_at);
  assert.equal(res.body.task.state, "done");
  assert.equal(res.body.task.pr_url, t.pr_url);

  const rev = await rest(ownerToken, "POST", "/v1/revert", { target: t.key, reason: "bad" });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.match((await get(rev.body.key)).brief, new RegExp(SHA));
  const events = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.events;
  assert.ok(events.some((e) => e.kind === "stamped"));
  assert.ok(!events.some((e) => e.kind === "merged"), "no merge event is fabricated");

  // No deploy watch: well past GOONBRIDGE_DEPLOY_SECONDS it is still live and unflagged.
  await sleep(5000);
  const after = await get(t.key);
  assert.equal(after.deploy_state, "live");
  assert.ok(!after.labels.includes("deploy-failed"));
});

test("stamp without deploy_state records the merge and starts no deploy watch", async () => {
  const t = await doneTask();
  const res = await stamp(ownerToken, t.key, { merged_sha: SHA });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.merged_sha, SHA);
  assert.equal(res.body.task.deploy_state, null);
  await sleep(5000);
  const after = await get(t.key);
  assert.equal(after.deploy_state, null);
  assert.ok(!after.labels.includes("deploy-failed"));
  assert.equal((await rest(ownerToken, "POST", "/v1/revert", { target: t.key })).status, 200);
});

test("stamp is owner-gated: not another person, not a cloud session; the owner's own device may", async () => {
  const t = await doneTask();
  for (const who of [otherToken, ownerCloudToken]) {
    const res = await stamp(who, t.key, { merged_sha: SHA, deploy_state: "live" });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /can stamp|cloud/);
  }
  assert.equal((await get(t.key)).merged_sha, null, "refused calls changed nothing");
  const mcp = await callTool(ownerCloudToken, "task_stamp", { key: t.key, merged_sha: SHA });
  assert.equal(mcp.isError, true);
  assert.equal((await get(t.key)).merged_sha, null);
  assert.equal((await stamp(ownerDeviceToken, t.key, { merged_sha: SHA })).status, 200);
});

test("stamp is idempotent: same SHA is a no-op, a different one is refused, bad input and open tasks are rejected", async () => {
  const t = await doneTask();
  const first = await stamp(ownerToken, t.key, { merged_sha: SHA, deploy_state: "live" });
  const again = await stamp(ownerToken, t.key, { merged_sha: SHA, deploy_state: "live" });
  assert.equal(again.status, 200);
  assert.equal(again.body.stamped, false);
  assert.deepEqual(again.body.changed, []);
  assert.equal(again.body.task.version, first.body.task.version, "no-op does not bump the version");
  assert.equal(again.body.task.merged_at, first.body.task.merged_at);

  const other = await stamp(ownerToken, t.key, { merged_sha: "1".repeat(40) });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /already has merged_sha/);
  assert.equal((await get(t.key)).merged_sha, SHA);

  const fresh = await doneTask();
  for (const bad of [{ merged_sha: "abc123" }, { merged_sha: "z".repeat(40) }, { merged_sha: SHA, deploy_state: "pending" }, { merged_sha: SHA, deploy_state: "not_seen" }, {}]) {
    assert.equal((await stamp(ownerToken, fresh.key, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await get(fresh.key)).merged_sha, null);
  const open = await doneTask({ state: "review" });
  const res = await stamp(ownerToken, open.key, { merged_sha: SHA });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /only a done task/);
  assert.equal((await stamp(ownerToken, "T-99999999", { merged_sha: SHA })).status, 400);
});

test("task_stamp tool stamps for the owner", async () => {
  const t = await doneTask();
  const out = await callTool(ownerToken, "task_stamp", { key: t.key, merged_sha: SHA, deploy_state: "live" });
  assert.ok(!out.isError, JSON.stringify(out));
  assert.match(out.content[0].text, /Stamped/);
  assert.equal((await get(t.key)).deploy_state, "live");
});
