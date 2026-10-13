import { OTHER, OTHER_DEVICE, OWNER, OWNER_CLOUD, OWNER_DEVICE, OWNER_SECOND_DEVICE, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Device trust (T-41): a device's owner grants another person full mode on that one device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base, ownerToken, otherToken, ownerDeviceToken, ownerSecondDeviceToken, ownerCloudToken, otherDeviceToken, rest, callTool } from "./helpers.mjs";

const asCloud = async (method, path, body) => {
  const res = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: `cse_${randomBytes(6).toString("hex")}` }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("the owner grants and revokes full mode on their device; the device reads it from /v1/me", async () => {
  const set = await rest(ownerToken, "POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "full" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body, { device: OWNER_SECOND_DEVICE, person: OTHER, mode: "full", changed: true });
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/me")).body.trusted, [OTHER]);
  assert.deepEqual((await rest(ownerDeviceToken, "GET", "/v1/me")).body.trusted, [], "trust is per device");
  assert.deepEqual((await rest(ownerToken, "GET", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`)).body, { device: OWNER_SECOND_DEVICE, trusted: [OTHER] });
  assert.equal((await rest(ownerToken, "POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "full" })).body.changed, false, "idempotent");
  const text = (await callTool(ownerDeviceToken, "bridge_trust", { device: OWNER_SECOND_DEVICE, person: OTHER, mode: "read" })).content[0].text;
  assert.match(text, new RegExp(String.raw`Trust on ${escapeRegex(OWNER_SECOND_DEVICE)}: ${escapeRegex(OTHER)} read \(revoked\)`, ""));
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/me")).body.trusted, []);
});

test("only the owner, as themselves or their own non-cloud device, may set trust; people and cloud devices cannot be trusted targets", async () => {
  for (const [token, why] of [[otherToken, "another person"], [otherDeviceToken, "another person's device"]]) {
    const r = await rest(token, "POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "full" });
    assert.equal(r.status, 400, why);
    assert.match(r.body.error, new RegExp(String.raw`only ${escapeRegex(OWNER)}`, ""));
  }
  const cloud = await asCloud("POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "full" });
  assert.equal(cloud.status, 400);
  assert.match(cloud.body.error, /cloud session/);
  for (const [device, person, re] of [[OWNER_CLOUD, OTHER, /cloud/], [OWNER, OTHER, /not a device/], [OWNER_SECOND_DEVICE, OTHER_DEVICE, /not a person/], [OWNER_SECOND_DEVICE, OWNER, /owner/], [OWNER_SECOND_DEVICE, "nobody", /unknown/]]) {
    const r = await rest(ownerToken, "POST", `/v1/devices/${device}/trust`, { person, mode: "full" });
    assert.equal(r.status, 400, `${device} ${person}`);
    assert.match(r.body.error, re, `${device} ${person}: ${r.body.error}`);
  }
  assert.deepEqual((await rest(ownerSecondDeviceToken, "GET", "/v1/me")).body.trusted, [], "nothing leaked through");
});

test("/docs/devices shows the trust line for the owner", async () => {
  await rest(ownerToken, "POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "full" });
  const html = await (await fetch(new URL("/docs/devices", base), { headers: { Authorization: `Bearer ${ownerToken}` } })).text();
  assert.match(html, new RegExp(String.raw`${escapeRegex(OWNER_SECOND_DEVICE)}[\s\S]*full mode for[\s\S]*${escapeRegex(OTHER)}`, ""));
  await rest(ownerToken, "POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "read" });
});

test("a Mac session's child name is not a device: trust goes on the device itself", async () => {
  const res = await fetch(new URL("/v1/me", base), { headers: { Authorization: `Bearer ${ownerDeviceToken}`, [SESSION_HEADER]: `mac_${randomBytes(6).toString("hex")}` } });
  const child = (await res.json()).member;
  assert.match(child, new RegExp(String.raw`^${escapeRegex(OWNER_DEVICE)}-`, ""));
  const r = await rest(ownerToken, "POST", `/v1/devices/${child}/trust`, { person: OTHER, mode: "full" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, new RegExp(String.raw`session of ${escapeRegex(OWNER_DEVICE)}`, ""));
  const bad = await rest(ownerToken, "POST", `/v1/devices/${OWNER_SECOND_DEVICE}/trust`, { person: OTHER, mode: "write" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /mode must be/);
});
