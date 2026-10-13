import { CONTEXT_HEADER, OWNER, OWNER_CLOUD, OWNER_DEVICE, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// T-56: a task_update note for a cloud device goes through the same routing as bridge_send, and a bridge_send reply in a
// task's thread is a task event, so task_get and bridge_thread hold the same history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, ownerDeviceToken, ownerCloudToken, rest, callTool, drain, useFakeRoutines } from "./helpers.mjs";

const fakeRoutines = useFakeRoutines();
const skip = !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars";
const repo = `notes-${Date.now()}`;
const made = [];
// Made by alice-laptop: a device of the same person assigning to alice-cloud fires nothing, so the task starts unclaimed and quiet.
async function cloudTask(state) {
  const res = await rest(ownerDeviceToken, "POST", "/v1/tasks", { owner: OWNER, title: `Note routing ${state}`, brief: `BRIEF-${state}: do the thing.`, repo, assignee: OWNER_CLOUD, state });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.cloud, undefined, "nothing fired at creation");
  made.push(res.body.key);
  return res.body;
}
const asSession = (session) => (method, path, body) => fetch(new URL(path, base), {
  method, headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: "notes" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
const firesFor = (key) => fakeRoutines.fires.filter((f) => f.text.includes(`Bridge task ${key}:`)).length;

test("a note on a cloud-assigned task nobody holds fires one session with the brief and the note; a second note joins it", { skip }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const t = await cloudTask("ready");
  const out = (await callTool(ownerToken, "task_update", { key: t.key, note: "NOTE-ONE please start." })).content[0].text;
  assert.match(out, new RegExp(String.raw`Cloud session started for ${escapeRegex(OWNER_CLOUD)}`, ""), out);
  assert.equal(firesFor(t.key), 1);
  const fire = fakeRoutines.fires.at(-1);
  assert.match(fire.text, /BRIEF-ready: do the thing\./, "the task brief is in the payload");
  assert.match(fire.text, /NOTE-ONE please start\./, "and the note");
  // REST takes the same path; a second note while that session boots joins it.
  const again = (await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { note: "NOTE-TWO one more thing." })).body;
  assert.equal(again.cloud?.live, true, JSON.stringify(again));
  assert.equal(firesFor(t.key), 1, "deduped by the fire intent");
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a note on a task a cloud session holds reaches that session only", { skip }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const t = await cloudTask("ready");
  const claimant = asSession(newSession()), sibling = asSession(newSession());
  assert.equal((await claimant("PATCH", `/v1/tasks/${t.key}`, { state: "claim" })).status, 200);
  const name = (await claimant("GET", "/v1/me")).body.member;
  await sibling("GET", "/v1/me");
  // The claim made the child the assignee; a note from the owner goes to it, through the router.
  const before = fakeRoutines.fires.length;
  const out = (await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { note: "For the claimant only." })).body;
  assert.equal(out.posted_to, name, JSON.stringify(out));
  assert.equal(fakeRoutines.fires.length, before, "nothing fired");
  assert.ok(!(await sibling("GET", "/v1/inbox")).body.some((m) => m.id === out.message_id), "the sibling never sees it");
  assert.ok((await claimant("GET", "/v1/inbox")).body.some((m) => m.id === out.message_id), "the claimant does");
  await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { state: "dropped" });
  await claimant("POST", "/v1/status", { state: "offline" }); await sibling("POST", "/v1/status", { state: "offline" });
  await drain(ownerToken); await drain(ownerCloudToken);
});

test("a note on a backlog task for a cloud device says no session will see it, and fires nothing", { skip }, async () => {
  const t = await cloudTask("backlog");
  const before = fakeRoutines.fires.length;
  const out = (await callTool(ownerToken, "task_update", { key: t.key, note: "Thoughts for later." })).content[0].text;
  assert.match(out, new RegExp(`${t.key} is in backlog: no session will see this; set it ready and assign it to fire one`), out);
  assert.equal(fakeRoutines.fires.length, before);
  await drain(ownerCloudToken);
});

test("a note on a done task, or one that drops it in the same call, fires nothing and is a plain comment", { skip }, async () => {
  await drain(ownerCloudToken);
  const done = await cloudTask("ready");
  // Owner closes it by hand (exempt label), then thanks the session.
  assert.equal((await rest(ownerToken, "PATCH", `/v1/tasks/${done.key}`, { add_labels: ["no-pr"] })).status, 200);
  assert.equal((await rest(ownerToken, "PATCH", `/v1/tasks/${done.key}`, { state: "done" })).status, 200);
  const before = fakeRoutines.fires.length;
  const thanks = (await rest(ownerToken, "PATCH", `/v1/tasks/${done.key}`, { note: "merged, thanks" })).body;
  assert.equal(thanks.cloud, undefined, JSON.stringify(thanks));
  assert.equal(thanks.posted_to, OWNER_CLOUD, "posted to the target only");
  const dropped = await cloudTask("ready");
  const out = (await callTool(ownerToken, "task_update", { key: dropped.key, state: "dropped", note: "not needed after all" })).content[0].text;
  assert.doesNotMatch(out, /Cloud session started|no session will see/, out);
  assert.equal(fakeRoutines.fires.length, before, "no session fired for a closed task");
  await drain(ownerCloudToken);
});

test("a bridge_send reply in a task's thread is in task_get's events", async () => {
  const t = (await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Replies recorded", brief: "x", repo })).body;
  made.push(t.key);
  const sent = (await callTool(ownerDeviceToken, "bridge_send", { thread_id: t.thread_id, to: OWNER, body: "A reply in the thread." })).content[0].text;
  const id = Number(sent.match(/Sent message (\d+)/)[1]);
  const { events } = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body;
  const reply = events.find((e) => e.kind === "reply");
  assert.ok(reply, JSON.stringify(events));
  assert.equal(reply.by, OWNER_DEVICE);
  assert.equal(reply.data.message_id, id);
  assert.equal(reply.data.sender, OWNER_DEVICE);
  await drain(ownerToken);
});

test("cleanup", async () => {
  for (const key of made) await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
});
