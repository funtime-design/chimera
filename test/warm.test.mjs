import { CONTEXT_HEADER, OWNER, REPO, SESSION_HEADER } from "./harness/roles.mjs";
// Warm-session claims: a cloud session may add tasks the bridge judges related to its anchor (first claim), inside caps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, ownerCloudToken, rest, drain } from "./helpers.mjs";

const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
async function as(session, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const make = async (extra = {}) =>
  (await rest(ownerToken, "POST", "/v1/tasks", { title: "Warm claim", brief: "A task for the warm-claim tests.", owner: OWNER, repo: REPO, labels: ["warm-test"], state: "ready", ...extra })).body.key;
const claim = (s, key) => as(s, "PATCH", `/v1/tasks/${key}`, { state: "claim" });
const cleanup = async (...keys) => {
  for (const k of keys) await rest(ownerToken, "PATCH", `/v1/tasks/${k}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
};

test("a session may claim a task with the same owner, repo and a shared label, and each claim is logged", async () => {
  const s = newSession();
  const [a, b] = [await make(), await make()];
  assert.equal((await claim(s, a)).status, 200);
  assert.equal((await claim(s, b)).status, 200);
  const t = (await rest(ownerToken, "GET", `/v1/tasks/${b}`)).body.task;
  assert.equal(t.state, "claimed");
  // Logged: each task's record has its claim event and a claim row naming this session.
  const name = (await as(s, "GET", "/v1/me")).body.member;
  for (const k of [a, b]) {
    const got = (await rest(ownerToken, "GET", `/v1/tasks/${k}`)).body;
    assert.ok(got.events.some((e) => e.kind === "claimed" && e.by === name), `${k} has a claimed event by ${name}`);
    assert.equal(got.claims[0]?.session, name, `${k} has a claim row for ${name}`);
  }
  await cleanup(a, b);
});

test("the bridge refuses unrelated tasks: other repo, no shared label", async () => {
  const s = newSession();
  const a = await make();
  const otherRepo = await make({ repo: "cloud-session-config" });
  const otherArea = await make({ labels: ["unrelated"] });
  assert.equal((await claim(s, a)).status, 200);
  const r1 = await claim(s, otherRepo);
  assert.notEqual(r1.status, 200);
  assert.match(JSON.stringify(r1.body), /not related/);
  assert.notEqual((await claim(s, otherArea)).status, 200);
  await cleanup(a, otherRepo, otherArea);
});

test("a session holds at most two working claims; a second session cannot take a held task", async () => {
  const s = newSession();
  const [a, b, c] = [await make(), await make(), await make()];
  assert.equal((await claim(s, a)).status, 200);
  assert.equal((await claim(s, b)).status, 200);
  assert.notEqual((await claim(s, c)).status, 200);
  const other = newSession();
  const d = await make();
  assert.equal((await claim(other, d)).status, 200); // its own anchor
  // With the real version, so the version check passes and the held-task/warm guard is what refuses.
  const version = (await rest(ownerToken, "GET", `/v1/tasks/${a}`)).body.task.version;
  const stolen = await as(other, "PATCH", `/v1/tasks/${a}`, { state: "claim", expected_version: version });
  assert.notEqual(stolen.status, 200);
  assert.doesNotMatch(JSON.stringify(stolen.body), /is at version/, "not refused for the version");
  assert.equal((await rest(ownerToken, "GET", `/v1/tasks/${a}`)).body.task.claim_session, (await as(s, "GET", "/v1/me")).body.member, "still held by the first session");
  await cleanup(a, b, c, d);
});
