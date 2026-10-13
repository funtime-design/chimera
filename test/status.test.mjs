import { OTHER, OTHER_CLOUD, OTHER_DEVICE, OUTSIDER, OWNER, OWNER_CLOUD, OWNER_DEVICE, OWNER_SECOND_DEVICE, escapeRegex } from "./harness/roles.mjs";
// The status board: online flags, posted status and working claims that expire.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownerToken, otherToken, ownerDeviceToken, ownerSecondDeviceToken, ownerCloudToken, otherDeviceToken, otherCloudToken, rest, callTool, sleep, serverWindows, withoutTestDevices,
} from "./helpers.mjs";

test("bridge_members groups devices under people and marks the online ones", async () => {
  // A child stays addressable (a member) for the claim lease, not just the online window (Hub.identify), so wait out both.
  const w = await serverWindows();
  await sleep(Math.max(w.online_seconds, w.claim_lease_seconds) * 1000 + 1000);
  await rest(ownerDeviceToken, "GET", "/v1/inbox?peek=1");
  await rest(otherDeviceToken, "POST", "/v1/status", { state: "idle" });
  const text = withoutTestDevices((await callTool(otherToken, "bridge_members")).content[0].text);
  assert.match(text, new RegExp(String.raw`You are "${escapeRegex(OTHER)}"`, ""));
  const devices = [OWNER_DEVICE, OWNER_CLOUD, OWNER_SECOND_DEVICE].sort().map(name => `${name} (${name === OWNER_DEVICE ? "online" : "offline"})`).join(", ");
  assert.ok(text.split("\n").includes(`- ${OWNER}: devices ${devices}`), text);
  assert.match(text, new RegExp(String.raw`^- ${escapeRegex(OTHER)}: devices ${escapeRegex(OTHER_CLOUD)} \(offline\), ${escapeRegex(OTHER_DEVICE)} \(online\)$`, "m"));
  assert.match(text, new RegExp(String.raw`^- ${escapeRegex(OUTSIDER)}$`, "m"));
});

test("status set and get, with age and online", async () => {
  const set = await rest(ownerSecondDeviceToken, "POST", "/v1/status", { state: "Working", repo: "example-repo", branch: "fix/x", summary: "retry backoff" });
  assert.equal(set.status, 200);
  assert.equal(set.body.state, "working");
  const board = (await rest(otherToken, "GET", "/v1/status")).body;
  const mini = board.find((e) => e.member === OWNER_SECOND_DEVICE);
  assert.equal(mini.person, OWNER);
  assert.equal(mini.online, true);
  assert.equal(mini.state, "working");
  assert.equal(mini.expired, false);
  assert.equal(mini.repo, "example-repo");
  assert.equal(mini.branch, "fix/x");
  assert.equal(mini.summary, "retry backoff");
  assert.ok(mini.age_seconds >= 0 && mini.age_seconds < 5);
  assert.ok(board.some((e) => e.member === OTHER_CLOUD), "every member is listed, posted or not");

  const tool = (await callTool(ownerCloudToken, "bridge_status_set", { state: "working", repo: "example-web", summary: "R2 upload" })).content[0].text;
  assert.match(tool, new RegExp(String.raw`Status for ${escapeRegex(OWNER_CLOUD)}: working in example-web`, ""));
  const shown = (await callTool(otherToken, "bridge_status")).content[0].text;
  assert.match(shown, new RegExp(String.raw`^${escapeRegex(OWNER_SECOND_DEVICE)} · online · working · \d+s ago · example-repo @ fix\/x · retry backoff$`, "m"));
  assert.match(shown, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)} · online · working · \d+s ago · example-web · R2 upload$`, "m"));

  assert.equal((await rest(ownerSecondDeviceToken, "POST", "/v1/status", { repo: "x" })).status, 400, "state is required");
  assert.equal((await rest(ownerSecondDeviceToken, "POST", "/v1/status", { state: "idle", summary: "x".repeat(501) })).status, 400);
  assert.equal((await callTool(ownerSecondDeviceToken, "bridge_status_set", {})).isError, true);
  await rest(ownerCloudToken, "POST", "/v1/status", { state: "idle" });
});

test("polling the inbox records last-seen without changing the posted status", async () => {
  await rest(otherCloudToken, "POST", "/v1/status", { state: "idle", summary: "posted once" });
  await sleep((await serverWindows()).online_seconds * 1000 + 1000);
  let entry = (await rest(ownerToken, "GET", "/v1/status")).body.find((e) => e.member === OTHER_CLOUD);
  assert.equal(entry.online, false);
  await rest(otherCloudToken, "GET", "/v1/inbox?peek=1");
  entry = (await rest(ownerToken, "GET", "/v1/status")).body.find((e) => e.member === OTHER_CLOUD);
  assert.equal(entry.online, true);
  assert.ok(entry.seen_seconds_ago < 3);
  assert.equal(entry.summary, "posted once");
  assert.ok(entry.age_seconds >= (await serverWindows()).online_seconds, "a poll is not a status post");
});

test("a working claim outlives the online window and reads idle once it expires", async () => {
  const { online_seconds, status_expiry_seconds } = await serverWindows();
  assert.ok(online_seconds < status_expiry_seconds && status_expiry_seconds <= 15, "set short GOONBRIDGE_ONLINE_SECONDS / GOONBRIDGE_STATUS_EXPIRY_SECONDS for tests");
  await rest(ownerCloudToken, "POST", "/v1/status", { state: "working", repo: "example-repo", branch: "feat/y", summary: "cloud task" });
  await sleep(online_seconds * 1000 + 1000);
  let entry = (await rest(otherToken, "GET", "/v1/status")).body.find((e) => e.member === OWNER_CLOUD);
  assert.equal(entry.online, false);
  assert.equal(entry.state, "working", "the claim stands after the session goes quiet");
  assert.equal(entry.expired, false);
  assert.match((await callTool(otherToken, "bridge_status")).content[0].text, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)} · offline · working · \d+s ago · example-repo @ feat\/y · cloud task$`, "m"));

  await sleep((status_expiry_seconds - online_seconds) * 1000 + 1000);
  entry = (await rest(otherToken, "GET", "/v1/status")).body.find((e) => e.member === OWNER_CLOUD);
  assert.equal(entry.state, "idle");
  assert.equal(entry.expired, true);
  assert.equal(entry.repo, "example-repo", "what the claim said is kept for context");
  assert.match((await callTool(otherToken, "bridge_status")).content[0].text, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)} · offline · idle \(claim expired; posted \d+s ago · example-repo @ feat\/y · cloud task\)$`, "m"));
});
