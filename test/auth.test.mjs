import { OTHER, OTHER_CLOUD, OTHER_DEVICE, OUTSIDER, OWNER, OWNER_CLOUD, OWNER_DEVICE, OWNER_SECOND_DEVICE } from "./harness/roles.mjs";
// Tokens, identity and the member list.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base, ownerToken, otherToken, outsiderToken, ownerDeviceToken, rest, testDevice,
} from "./helpers.mjs";

test("rejects missing and wrong tokens", async () => {
  assert.equal((await fetch(new URL("/v1/me", base))).status, 401);
  assert.equal((await rest("x".repeat(48), "GET", "/v1/me")).status, 401);
  assert.equal((await fetch(new URL("/mcp", base), { method: "POST", body: "{}" })).status, 401);
});

test("identity comes from the token, three members", async () => {
  assert.equal((await rest(ownerToken, "GET", "/v1/me")).body.member, OWNER);
  assert.equal((await rest(otherToken, "GET", "/v1/me")).body.member, OTHER);
  const me = (await rest(outsiderToken, "GET", "/v1/me")).body;
  assert.equal(me.member, OUTSIDER);
  assert.deepEqual(me.members, [OUTSIDER, OWNER, OTHER].sort());
});

test("devices are members under their person", async () => {
  const me = (await rest(ownerDeviceToken, "GET", "/v1/me")).body;
  assert.equal(me.member, OWNER_DEVICE);
  assert.equal(me.person, OWNER);
  assert.deepEqual(me.members, [OUTSIDER, OWNER, OTHER].sort(), "people stay the members list");
  const devices = Object.fromEntries(Object.entries(me.devices).map(([p, ds]) => [p, ds.filter((d) => !testDevice(d))]));
  assert.deepEqual(devices, { [OWNER]: [OWNER_DEVICE, OWNER_CLOUD, OWNER_SECOND_DEVICE].sort(), [OTHER]: [OTHER_CLOUD, OTHER_DEVICE] });
  assert.equal((await rest(ownerToken, "GET", "/v1/me")).body.person, null);
});
