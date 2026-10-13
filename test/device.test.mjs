import { PRODUCT, OTHER, OTHER_DEVICE, OWNER, OWNER_DEVICE, OWNER_EMAIL, escapeRegex } from "./harness/roles.mjs";
// Device-code sign-in: a headless daemon starts it and polls, a person approves on any browser, the daemon swaps the
// code for an OAuth grant as its device. Drives the same fake Cloudflare Access as oauth.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, rest, callTool, useFakeAccess, approveAuthorize, s256, cookieJar } from "./helpers.mjs";

const fakeAccess = useFakeAccess();
const skip = !fakeAccess && "no ACCESS_* in .dev.vars";
const postJson = (path, body) => fetch(new URL(path, base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function daemonStart(device) {
  const reg = await postJson("/oauth/register", { client_name: `${PRODUCT} responder`, redirect_uris: [new URL("/device/callback", base).href], token_endpoint_auth_method: "none" });
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const start = await postJson("/device/start", { client_id, code_challenge: s256(verifier), device });
  return { client_id, verifier, status: start.status, body: await start.json() };
}

// The phone side: submit the code on /device, go through consent (preselected) and the fake Access sign-in.
async function phoneApproves(email, userCode, opts) {
  const jar = cookieJar();
  const form = jar.take(await fetch(new URL("/device", base), { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: userCode }) }));
  assert.equal(form.status, 302);
  const authorize = new URL(form.headers.get("Location"));
  assert.equal(authorize.pathname, "/authorize");
  return approveAuthorize(authorize, email, jar, opts);
}

test("device flow: start, approve on the phone, poll, exchange, act as the new device", { skip }, async () => {
  const device = `${OWNER}-t${randomBytes(2).toString("hex")}`;
  const d = await daemonStart(device);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.match(d.body.user_code, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
  assert.equal(d.body.verification_uri, new URL("/device", base).href);
  assert.equal(d.body.verification_uri_complete, new URL(`/device?code=${d.body.user_code}`, base).href);
  assert.equal(d.body.expires_in, 600);
  assert.equal(d.body.interval, 5);
  const page = await fetch(d.body.verification_uri_complete);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`value="${d.body.user_code}"`), "the code is filled in");

  const pending = await postJson("/device/token", { device_code: d.body.device_code });
  assert.equal(pending.status, 400);
  assert.equal((await pending.json()).error, "authorization_pending");
  const done = await phoneApproves(OWNER_EMAIL, d.body.user_code);
  const text = await done.text();
  assert.equal(done.status, 200, text);
  assert.match(text, new RegExp(`Signed in as ${device}`));

  const ready = await postJson("/device/token", { device_code: d.body.device_code });
  assert.equal(ready.status, 200);
  const { code, redirect_uri } = await ready.json();
  assert.ok(code);
  assert.equal(redirect_uri, new URL("/device/callback", base).href);
  const tok = await (await fetch(new URL("/oauth/token", base), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri, client_id: d.client_id, code_verifier: d.verifier }) })).json();
  assert.ok(tok.access_token && tok.refresh_token, JSON.stringify(tok));
  assert.match((await callTool(tok.access_token, "bridge_members")).content[0].text, new RegExp(`You are "${device}"`));
  assert.equal((await rest(tok.access_token, "GET", "/v1/me")).body.person, OWNER);
  assert.ok((await rest(ownerToken, "GET", "/v1/me")).body.devices[OWNER].includes(device), "registered device is on the roster");

  const again = await postJson("/device/token", { device_code: d.body.device_code });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, "expired_token", "single use");
  const reused = await fetch(new URL("/device", base), { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: d.body.user_code }) });
  assert.equal(reused.status, 404, "the user code is gone with it");

  // /docs/devices offers Forget for a registered device; forgetting it drops it from the roster and cuts its grant off.
  const page2 = await (await fetch(new URL("/docs/devices", base), { headers: { Authorization: `Bearer ${ownerToken}` } })).text();
  assert.ok(page2.includes(`name="name" value="${device}"`), "a Forget button for the registered device");
  assert.ok(!page2.includes(`name="name" value="${OWNER_DEVICE}"`), "no Forget for a static-token device");
  const forgot = await fetch(new URL("/docs/devices", base), { method: "POST", redirect: "manual",
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "forget", name: device }) });
  assert.equal(forgot.status, 303);
  assert.ok(!(await rest(ownerToken, "GET", "/v1/me")).body.members.includes(device), "forgotten device is off the roster");
  assert.equal((await rest(tok.access_token, "GET", "/v1/me")).status, 401, "and its grant no longer works");
});

test("device flow refuses another person's device name and a bad client", { skip }, async () => {
  const d = await daemonStart(`${OTHER}-rogue`);
  assert.equal(d.status, 200, "the name is only judged once we know who signed in");
  const done = await phoneApproves(OWNER_EMAIL, d.body.user_code);
  assert.equal(done.status, 403);
  assert.match(await done.text(), /not your device/);
  assert.ok(!(await rest(ownerToken, "GET", "/v1/me")).body.members.includes(`${OTHER}-rogue`), "nothing registered");
  assert.equal((await (await postJson("/device/token", { device_code: d.body.device_code })).json()).error, "authorization_pending");

  // A roster device of another person: the device flow refuses rather than granting the person under a device's name.
  const other = await daemonStart(OTHER_DEVICE);
  assert.equal((await phoneApproves(OWNER_EMAIL, other.body.user_code)).status, 403);

  // Picking another radio on the consent page than the device the daemon asked for is refused too.
  const own = await daemonStart(`${OWNER}-t${randomBytes(2).toString("hex")}`);
  assert.equal((await phoneApproves(OWNER_EMAIL, own.body.user_code, { connectAs: OWNER_DEVICE })).status, 403);

  const bad = await postJson("/device/start", { client_id: "nope", code_challenge: "x", device: `${OWNER}-z` });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);
  const reg = await postJson("/oauth/register", { client_name: "elsewhere", redirect_uris: ["http://localhost:9/cb"], token_endpoint_auth_method: "none" });
  const wrongRedirect = await postJson("/device/start", { client_id: (await reg.json()).client_id, code_challenge: "x", device: `${OWNER}-z` });
  assert.equal(wrongRedirect.status, 400, "the client must have registered /device/callback");
  const badName = await daemonStart(`${OWNER} Mac`);
  assert.equal(badName.status, 400);
  const unknown = await fetch(new URL("/device", base), { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: "ZZZZ-ZZZZ" }) });
  assert.equal(unknown.status, 404);
  assert.equal((await (await postJson("/device/token", { device_code: "nope" })).json()).error, "expired_token");
});

test("a plain client cannot offer to register a device through a member= link", { skip }, async () => {
  // Finding from the 2026-10-10 review: a stranger's client could send a link whose pre-checked "Register new device"
  // would land them a device under the victim's name. Registration is offered only when the redirect is /device/callback.
  const reg = await fetch(new URL("/oauth/register", base), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Plain", redirect_uris: ["http://localhost:9/cb"], token_endpoint_auth_method: "none" }) });
  const { client_id } = await reg.json();
  const auth = new URL("/authorize", base);
  for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: "http://localhost:9/cb", state: "s", code_challenge: s256("v".repeat(43)),
    code_challenge_method: "S256", resource: new URL("/mcp", base).href, member: `${OWNER}-phish` })) auth.searchParams.set(k, v);
  const html = await (await fetch(auth, { redirect: "manual" })).text();
  assert.doesNotMatch(html, /Register new device/);
  assert.doesNotMatch(html, new RegExp(String.raw`${escapeRegex(OWNER)}-phish`, ""));
});
