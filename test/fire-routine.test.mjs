import { CONTEXT_HEADER, OTHER, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// fire_routine starts a routine chosen by name (a fake routines API stands in), apart from the person -> cloud member map.
// Needs GOONBRIDGE_ROUTINES_URL and GOONBRIDGE_ROUTINE_BLANK_TRIGGER=trig_blank_test, _TOKEN and _ALLOW=alice (plus a
// BADTOKEN routine with a wrong token) in .dev.vars, and GOONBRIDGE_BOOT_SECONDS of a few seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base, ownerToken, ownerDeviceToken, ownerCloudToken, otherToken, rest, callTool, sleep, serverWindows, useFakeRoutines, devVars } from "./helpers.mjs";

const fake = useFakeRoutines();
const skip = (!fake || !devVars.GOONBRIDGE_ROUTINE_BLANK_TRIGGER) && "needs GOONBRIDGE_ROUTINES_URL and GOONBRIDGE_ROUTINE_BLANK_TRIGGER/_TOKEN/_ALLOW in .dev.vars";
const text = (r) => r.content[0].text;
const faults = async () => (await rest(ownerToken, "GET", "/v1/faults")).body;

test("fire_routine fires a named routine with the text as given, and returns the session link and id", { skip }, async () => {
  const before = fake.fires.length;
  const out = await callTool(ownerToken, "fire_routine", { routine: "Blank", text: "Research X and report back." });
  assert.match(text(out), /^Routine "blank" started: https:\/\/claude\.ai\/code\/session_fake\d+ \(session session_fake\d+\)$/);
  assert.equal(fake.fires.length, before + 1);
  assert.equal(fake.fires.at(-1).trigger, "trig_blank_test");
  assert.equal(fake.fires.at(-1).text, "Research X and report back.", "nothing is added to the text");
});

test("a device of an allowed person may fire; others, unknown names, empty text and bad tokens are refused", { skip }, async () => {
  const before = fake.fires.length;
  assert.match(text(await callTool(ownerDeviceToken, "fire_routine", { routine: "blank", text: "from a device" })), /started/);
  const notAllowed = await callTool(otherToken, "fire_routine", { routine: "blank", text: "no" });
  assert.equal(notAllowed.isError, true);
  assert.match(text(notAllowed), new RegExp(String.raw`${escapeRegex(OTHER)} may not fire routine "blank"`, ""));
  const unknown = await callTool(ownerToken, "fire_routine", { routine: "nope", text: "x" });
  assert.match(text(unknown), /unknown routine "nope"; routines: .*blank/);
  assert.ok(!text(unknown).includes("rt_"), "no token in the answer");
  assert.match(text(await callTool(ownerToken, "fire_routine", { routine: "blank", text: "  " })), /text is required/);
  const bad = await callTool(ownerToken, "fire_routine", { routine: "badtoken", text: "x" });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /could not fire routine "badtoken": bad trigger or token/);
  assert.equal(fake.fires.length, before + 1, "only the allowed fire went out (the bad token never reached a session)");
});

test("REST returns the session id and url; with a thread_id the link and id are posted in that thread", { skip }, async () => {
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, subject: "fire note", body: "hello" })).body;
  const viaTool = await callTool(ownerToken, "fire_routine", { routine: "blank", text: "with thread", thread_id: sent.thread_id });
  const sessionId = text(viaTool).match(/session_fake\d+/)[0];
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body;
  assert.match(thread.at(-1).body, new RegExp(`^started routine "blank": https://claude\\.ai/code/${sessionId} \\(session ${sessionId}\\)`));
  const viaRest = await rest(ownerToken, "POST", "/v1/routines/fire", { routine: "blank", text: "rest" });
  assert.equal(viaRest.status, 200);
  assert.match(viaRest.body.session_id, /^session_fake\d+$/);
  assert.equal(viaRest.body.url, `https://claude.ai/code/${viaRest.body.session_id}`);
  assert.equal(viaRest.body.routine, "blank");
  assert.match(viaRest.body.message, new RegExp(viaRest.body.session_id));
});

test("the fire is recorded: a named session that never boots is flagged never_started", { skip }, async () => {
  const boot = (await serverWindows()).boot_seconds ?? 3;
  assert.ok(boot <= 10, "set GOONBRIDGE_BOOT_SECONDS to a few seconds for tests");
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OTHER, subject: "named orphan", body: "hello" })).body;
  const out = await callTool(ownerToken, "fire_routine", { routine: "blank", text: "never boots", thread_id: sent.thread_id });
  const sessionId = text(out).match(/session_fake\d+/)[0];
  await sleep((boot + 2) * 1000);
  assert.ok((await faults()).fires.some((f) => f.session_id === sessionId && f.fault === "never_started"), "recordFire made the unbooted session visible to the orphan tracker");
});

test("a named fire with no thread that boots is not flagged as dying without a reply", { skip }, async () => {
  const sessionId = text(await callTool(ownerToken, "fire_routine", { routine: "blank", text: "no thread" })).match(/session_fake\d+/)[0];
  const res = await fetch(new URL("/v1/me", base), { headers: { Authorization: `Bearer ${ownerCloudToken}`, [SESSION_HEADER]: sessionId.replace(/^session_/, "cse_"), [CONTEXT_HEADER]: REPO } });
  assert.equal(res.status, 200);
  const w = await serverWindows();
  await sleep((Math.max(w.claim_lease_seconds, w.boot_seconds, w.online_seconds) + 2) * 1000);
  assert.ok(!(await faults()).fires.some((f) => f.session_id === sessionId), "booted, no thread to reply in: no fault");
});
