import { OTHER, OWNER_SECOND_DEVICE, PRODUCT, escapeRegex } from "./harness/roles.mjs";
// The admin pages through the live Worker: the /docs sign-in, routing, the admin gate and the form guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { base, ownerToken, otherToken, ownerSecondDeviceToken, rest } from "./helpers.mjs";

const page = (path, token, init = {}) => fetch(new URL(path, base), { redirect: "manual", ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });

test("/docs/status: signed-in admins get the setup state as JSON; others are refused", async () => {
  assert.equal((await page("/docs/status")).status, 401, "no sign-in, no status");
  assert.equal((await page("/docs/status", otherToken)).status, 403, "a member who is not an admin");
  const res = await page("/docs/status", ownerToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["access", "deployment", "devices_registered", "last_contract_check", "members", "version"]);
  assert.equal(typeof body.version.engine, "string");
  assert.ok(body.members >= 2);
  assert.equal((await page("/docs/status", ownerToken, { method: "POST" })).status, 405, "read-only");
});

test("/docs/settings: admin page with device permissions; a change is guarded, applied and read back by the device", async () => {
  assert.equal((await page("/docs/settings", otherToken)).status, 403);
  const res = await page("/docs/settings", ownerToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(String.raw`<h1>${escapeRegex(PRODUCT)} settings<\/h1>`, ""));
  assert.ok(html.includes(OWNER_SECOND_DEVICE) && html.includes("may_edit_tasks"));
  const post = (fields, headers = {}) => page("/docs/settings", ownerToken, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
  const grant = { action: "permission", device: OWNER_SECOND_DEVICE, permission: "may_run_full", person: OTHER, value: "on" };
  assert.equal((await post(grant, { Origin: "https://evil.example" })).status, 403, "cross-site post refused");
  assert.equal((await page("/docs/settings", otherToken, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(grant) })).status, 403, "not an admin");
  assert.equal((await post(grant)).status, 303);
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/me")).body.trusted, [OTHER], "the device reads the change (responder full mode)");
  assert.equal((await post({ ...grant, value: "off" })).status, 303);
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/me")).body.trusted, []);
  assert.equal((await post({ ...grant, permission: "may_fly" })).status, 400, "only the fixed toggles");
});
