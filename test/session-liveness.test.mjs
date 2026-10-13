import { CONTEXT_HEADER, OWNER, OWNER_CLOUD, REPO, SESSION_HEADER } from "./harness/roles.mjs";
// The per-turn hook posts a session line (POST /v1/sessions), often as the person rather than the cloud child. That line
// must count as the child's heartbeat: the claim it holds stays fresh and the board lists it live; silent past the lease
// (GOONBRIDGE_CLAIM_LEASE_SECONDS, a few seconds in .dev.vars) it drops off and its claim is released.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, ownerCloudToken, rest, callTool, drain, sleep } from "./helpers.mjs";

const as = async (session, method, path, body) => {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const listed = async (session) => (await callTool(ownerToken, "bridge_sessions", { member: OWNER_CLOUD })).content[0].text.includes(session);

test("session lines posted as the person keep a cloud child live, and it drops after the lease", async () => {
  const ms = (await rest(ownerToken, "GET", "/v1/me")).body.claim_lease_seconds * 1000;
  assert.ok(ms <= 10000, "set GOONBRIDGE_CLAIM_LEASE_SECONDS to a few seconds for tests");
  const session = `cse_${randomBytes(8).toString("hex")}`;
  const child = (await as(session, "GET", "/v1/me")).body.member;
  const key = (await rest(ownerToken, "POST", "/v1/tasks", { title: "Session liveness", brief: "Held by a session that only posts lines.", owner: OWNER, repo: REPO })).body.key;
  assert.equal((await as(session, "PATCH", `/v1/tasks/${key}`, { state: "claim" })).status, 200);

  // Heartbeat only through session lines, as the person, for longer than the lease.
  for (let i = 0; i < 4; i++) {
    assert.equal((await rest(ownerToken, "POST", "/v1/sessions", { session, line: `turn ${i}` })).status, 200);
    await sleep(ms / 2);
  }
  const live = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
  assert.equal(live.state, "claimed", "claim still held after more than the lease of lines");
  assert.equal(live.claim_session, child);
  assert.ok(await listed(session), "the board lists the heartbeating session");

  // Silence past the lease: not live, claim released.
  await sleep(ms + 1500);
  assert.ok(!(await listed(session)), "the board drops a session silent past the lease");
  const gone = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
  assert.equal(gone.state, "ready");
  assert.equal(gone.claim_session, null);

  await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await drain(ownerToken); await drain(ownerCloudToken);
});
