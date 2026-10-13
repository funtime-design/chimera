import { OTHER, OTHER_CLOUD, OTHER_DEVICE, OUTSIDER, OWNER, OWNER_DEVICE, OWNER_SECOND_DEVICE, escapeRegex } from "./harness/roles.mjs";
// Send, inbox, claim, done and threads, between people and between devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownerToken, otherToken, outsiderToken, ownerDeviceToken, ownerSecondDeviceToken, otherDeviceToken, otherCloudToken, rest, callTool, drain, waitPastClaim,
} from "./helpers.mjs";

test("a third member sends, receives and gets broadcasts", async () => {
  await drain(ownerToken); await drain(otherToken); await drain(outsiderToken);
  const sent = await rest(outsiderToken, "POST", "/v1/send", { to: OTHER, subject: `Nightly ${OUTSIDER}`, body: `3 resources ${OUTSIDER}ed in example-app beta.` });
  assert.equal(sent.status, 200);
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body[0].sender, OUTSIDER);
  await rest(otherToken, "POST", "/v1/send", { thread_id: sent.body.thread_id, body: "Thanks, looking." });
  assert.equal((await rest(outsiderToken, "GET", "/v1/inbox")).body[0].sender, OTHER);

  const all = await rest(ownerToken, "POST", "/v1/send", { to: "all", body: "beta freeze tonight" });
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.length, 1);
  assert.equal((await rest(outsiderToken, "GET", "/v1/inbox")).body.length, 1);
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${all.body.thread_id}`)).body;
  assert.deepEqual(thread[0].status, { [OUTSIDER]: "claimed", [OTHER]: "claimed" });
  await drain(otherToken); await drain(outsiderToken);
});

test(`${OWNER} asks ${OTHER} to finish work, ${OTHER} replies, ${OWNER} sees the reply (MCP both ways)`, async () => {
  await drain(ownerToken); await drain(otherToken);
  const sent = await callTool(ownerToken, "bridge_send", {
    to: OTHER,
    subject: "Finish CASA retry fix",
    body: "Out of credits. Branch fix/casa-retry at abc123 in example-repo. Left: wire backoff into SyncEngine, run --filter SyncTests, push.",
  });
  assert.match(sent.content[0].text, new RegExp(String.raw`Sent message \d+ to ${escapeRegex(OTHER)} in thread (\d+)`, ""));
  const threadId = Number(sent.content[0].text.match(/thread (\d+)/)[1]);

  const inbox = await callTool(otherToken, "bridge_inbox");
  assert.match(inbox.content[0].text, new RegExp(String.raw`from ${escapeRegex(OWNER)} to ${escapeRegex(OTHER)}`, ""));
  assert.match(inbox.content[0].text, /fix\/casa-retry/);
  assert.equal((await callTool(otherToken, "bridge_inbox")).content[0].text, "No unread messages.");

  await callTool(otherToken, "bridge_send", { thread_id: threadId, body: "Done. Pushed def456, SyncTests green." });
  const reply = await callTool(ownerToken, "bridge_inbox");
  assert.match(reply.content[0].text, new RegExp(String.raw`from ${escapeRegex(OTHER)} to ${escapeRegex(OWNER)}`, ""));
  assert.match(reply.content[0].text, /Subject: Finish CASA retry fix/);

  const thread = (await callTool(ownerToken, "bridge_thread", { thread_id: threadId })).content[0].text;
  assert.equal((thread.match(/^--- thread/gm) ?? []).length, 2);
  assert.match(thread, new RegExp(String.raw`from ${escapeRegex(OWNER)} to ${escapeRegex(OTHER)} · [^\n]* · ${escapeRegex(OTHER)}: done\n`, ""), `${OTHER}'s reply marked the request done`);
  assert.match(thread, new RegExp(String.raw`from ${escapeRegex(OTHER)} to ${escapeRegex(OWNER)} · [^\n]* · ${escapeRegex(OWNER)}: claimed\n`, ""));
  await drain(ownerToken);
});

test("a fetched message is claimed, comes back if not done, and stays gone once done", async () => {
  await drain(otherToken);
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "claim me" })).body;
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body[0].status, { [OTHER]: "unread" });
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.length, 1);
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.length, 0, "claimed messages are not handed out twice");
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body[0].status, { [OTHER]: "claimed" });

  await waitPastClaim();
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body[0].status, { [OTHER]: "unread" });
  const again = (await rest(otherToken, "GET", "/v1/inbox")).body;
  assert.deepEqual(again.map((m) => m.id).filter((id) => id === sent.id), [sent.id], "an expired claim makes the message visible again");

  const done = await callTool(otherToken, "bridge_done", { message_id: sent.id });
  assert.equal(done.content[0].text, `Message ${sent.id} marked done.`);
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body[0].status, { [OTHER]: "done" });
  await waitPastClaim();
  assert.ok(!(await rest(otherToken, "GET", "/v1/inbox")).body.some((m) => m.id === sent.id));
  await drain(otherToken);
});

test("a reply in the thread marks the messages it answers done", async () => {
  await drain(otherToken);
  const first = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "question one" })).body;
  const second = (await rest(ownerToken, "POST", "/v1/send", { thread_id: first.thread_id, body: "question two" })).body;
  const other = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "separate thread" })).body;
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.filter((m) => [first.id, second.id, other.id].includes(m.id)).length, 3);
  await callTool(otherToken, "bridge_send", { thread_id: first.thread_id, body: "both answered" });
  await waitPastClaim();
  const ours = new Set([first.id, second.id, other.id]);
  const back = (await rest(otherToken, "GET", "/v1/inbox")).body.map((m) => m.id).filter((id) => ours.has(id));
  assert.deepEqual(back, [other.id], "only the unanswered thread comes back");
  await drain(otherToken);
});

test("two clients of one member never get the same message while it is claimed", async () => {
  await drain(otherToken);
  await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "only one of you" });
  const [a, b] = await Promise.all([rest(otherToken, "GET", "/v1/inbox"), callTool(otherToken, "bridge_inbox")]);
  const handedOut = a.body.length + (b.content[0].text === "No unread messages." ? 0 : 1);
  assert.equal(handedOut, 1);
  await drain(otherToken);
});

test("done is refused for messages that are not yours", async () => {
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: `not for ${OUTSIDER}` })).body;
  assert.equal((await rest(outsiderToken, "POST", "/v1/done", { message_id: sent.id })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/done", { message_id: sent.id })).status, 400, "senders cannot mark their own message done");
  assert.equal((await rest(otherToken, "POST", "/v1/done", {})).status, 400);
  assert.equal((await callTool(otherToken, "bridge_done", {})).isError, true);
  await drain(otherToken);
});

test(`a person's devices share threads: ${OTHER_CLOUD} can answer what was sent to ${OTHER_DEVICE}`, async () => {
  await drain(otherDeviceToken); await drain(ownerToken);
  const asked = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER_DEVICE, subject: "household", body: `task for ${OTHER}'s side` })).body;
  const reply = await rest(otherCloudToken, "POST", "/v1/send", { thread_id: asked.thread_id, body: "done, from the cloud session" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.recipient, OWNER);
  const seen = (await rest(ownerSecondDeviceToken, "GET", `/v1/threads/${asked.thread_id}`)).body;
  assert.equal(seen.length, 2, `${OWNER}'s other device reads the thread too`);
  assert.equal((await rest(outsiderToken, "GET", `/v1/threads/${asked.thread_id}`)).status, 400, "an outsider still cannot");
});

test("a thread is capped at 20 messages", async () => {
  const first = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "loop 1" })).body;
  for (let i = 2; i <= 20; i++) {
    const res = await rest(i % 2 ? ownerToken : otherToken, "POST", "/v1/send", { thread_id: first.thread_id, body: `loop ${i}` });
    assert.equal(res.status, 200, `message ${i}`);
  }
  const refused = await rest(otherToken, "POST", "/v1/send", { thread_id: first.thread_id, body: "loop 21" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /reached 20 messages.*new thread.*owner/);
  const tool = await callTool(ownerToken, "bridge_send", { thread_id: first.thread_id, body: "thanks!" });
  assert.equal(tool.isError, true);
  await drain(ownerToken); await drain(otherToken);
});

test("inbox returns 50 at a time and says how many more are waiting", async () => {
  await drain(outsiderToken);
  for (let i = 1; i <= 53; i++) await rest(ownerToken, "POST", "/v1/send", { to: OUTSIDER, body: `bulk ${i}` });
  const peeked = await rest(outsiderToken, "GET", "/v1/inbox?peek=1");
  assert.equal(peeked.body.length, 50);
  assert.equal(peeked.more, 3);
  const first = (await callTool(outsiderToken, "bridge_inbox")).content[0].text;
  assert.match(first, /^50 unread message\(s\)/);
  assert.match(first, /3 more waiting, call bridge_inbox again\.$/);
  const second = (await callTool(outsiderToken, "bridge_inbox")).content[0].text;
  assert.match(second, /^3 unread message\(s\)/);
  assert.doesNotMatch(second, /more waiting/);
  await waitPastClaim();
  await drain(outsiderToken);
});

test(`${OTHER} can start a thread with ${OWNER} (REST)`, async () => {
  await drain(ownerToken);
  const sent = await rest(otherToken, "POST", "/v1/send", { to: OWNER, subject: "Fable review please", body: "Review PR 42 in example-app for RLS gaps." });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sender, OTHER);
  const inbox = await rest(ownerToken, "GET", "/v1/inbox");
  assert.equal(inbox.body.length, 1);
  assert.equal(inbox.body[0].subject, "Fable review please");
  await drain(ownerToken);
});

test("malformed JSON is a 400 with a message, not a 500", async () => {
  for (const path of ["/v1/send", "/v1/done"]) {
    for (const body of ["{not json", "[]", "null"]) {
      const res = await rest(ownerToken, "POST", path, body);
      assert.equal(res.status, 400, `${path} ${body}`);
      assert.match(res.body.error, /JSON/);
    }
  }
});

test("long-poll inbox wakes when a message arrives", async () => {
  await drain(otherToken);
  const started = Date.now();
  const waiting = rest(otherToken, "GET", "/v1/inbox?wait=10");
  await new Promise((r) => setTimeout(r, 500));
  await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "ping while you wait" });
  const got = await waiting;
  assert.equal(got.body.length, 1);
  assert.ok(Date.now() - started < 8000, "returned before the wait expired");
  await drain(otherToken);
});

test("peek leaves messages unread", async () => {
  await drain(otherToken);
  await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "peek me" });
  assert.equal((await rest(otherToken, "GET", "/v1/inbox?peek=1")).body.length, 1);
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.length, 1);
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.length, 0);
  await drain(otherToken);
});

test("broadcast to all reaches everyone but the sender", async () => {
  await drain(ownerToken); await drain(otherToken);
  await rest(ownerToken, "POST", "/v1/send", { to: "all", body: "heads up: deploying beta" });
  assert.equal((await rest(otherToken, "GET", "/v1/inbox")).body.length, 1);
  assert.equal((await rest(ownerToken, "GET", "/v1/inbox")).body.length, 0);
  await drain(otherToken); await drain(outsiderToken);
});

test("bad input is a clean error, not a crash", async () => {
  assert.equal((await rest(ownerToken, "POST", "/v1/send", { to: "nobody", body: "x" })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/send", { to: OTHER, body: "  " })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/send", { to: OWNER, body: "me" })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/send", { thread_id: 999999, body: "x" })).status, 400);
  const tool = await callTool(ownerToken, "bridge_send", { to: "nobody", body: "x" });
  assert.equal(tool.isError, true);
  assert.match(tool.content[0].text, /unknown member/);
});

test("a message to a person is not delivered to their devices, a message to a device goes only there", async () => {
  for (const t of [ownerToken, otherToken, outsiderToken, ownerDeviceToken, ownerSecondDeviceToken, otherDeviceToken]) await drain(t);
  const toPerson = (await rest(otherToken, "POST", "/v1/send", { to: OWNER, body: `for ${OWNER}'s phone` })).body;
  assert.deepEqual((await rest(ownerDeviceToken, "GET", "/v1/inbox")).body, []);
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/inbox")).body, []);
  assert.deepEqual((await rest(ownerToken, "GET", "/v1/inbox")).body.map((m) => m.id), [toPerson.id]);

  const toDevice = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_DEVICE, body: "what branch is example-repo on?" })).body;
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/inbox")).body, []);
  assert.deepEqual((await rest(ownerToken, "GET", "/v1/inbox")).body, []);
  assert.deepEqual((await rest(ownerDeviceToken, "GET", "/v1/inbox")).body.map((m) => m.id), [toDevice.id]);
  await rest(ownerDeviceToken, "POST", "/v1/send", { thread_id: toDevice.thread_id, body: "main" });
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/threads/${toDevice.thread_id}`)).body[0].status, { [OWNER_DEVICE]: "done" });

  const crossDevice = await rest(otherDeviceToken, "POST", "/v1/send", { to: OWNER_SECOND_DEVICE, body: "device to device" });
  assert.equal(crossDevice.status, 200);
  assert.equal((await rest(ownerSecondDeviceToken, "GET", "/v1/inbox")).body[0].sender, OTHER_DEVICE);

  const all = (await rest(outsiderToken, "POST", "/v1/send", { to: "all", body: "people only" })).body;
  assert.deepEqual((await rest(ownerDeviceToken, "GET", "/v1/inbox")).body, [], "devices do not get broadcasts");
  assert.equal((await rest(ownerDeviceToken, "POST", "/v1/done", { message_id: all.id })).status, 400);
  assert.deepEqual((await rest(outsiderToken, "GET", `/v1/threads/${all.thread_id}`)).body[0].status, { [OWNER]: "unread", [OTHER]: "unread" });
  for (const t of [ownerToken, otherToken, outsiderToken, ownerSecondDeviceToken]) await drain(t);
});
