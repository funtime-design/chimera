import { OTHER, OTHER_DEVICE, OWNER, OWNER_CLOUD, OWNER_DEVICE } from "./harness/roles.mjs";
// Registered devices: the name rules, imported straight from the Hub module (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validDeviceLabel, deviceNameError } from "../src/hub/registered.ts";

test("device labels: lowercase, digits, dashes, 1-24 chars, never cloud", () => {
  for (const ok of ["air", "mini", "studio-2", "a"]) assert.equal(validDeviceLabel(ok), true, ok);
  for (const bad of ["", "Air", "a".repeat(25), "-x", "x_y", "cloud", "cloud-x7k"]) assert.equal(validDeviceLabel(bad), false, bad);
});

test("deviceNameError explains every refusal", () => {
  const roster = [OWNER, OTHER, OWNER_DEVICE, OTHER_DEVICE, OWNER_CLOUD];
  assert.equal(deviceNameError(`${OWNER}-studio`, OWNER, roster, []), null);
  assert.match(deviceNameError(`${OTHER}-studio`, OWNER, roster, []), /not your device/);
  assert.match(deviceNameError(OWNER_DEVICE, OWNER, roster, []), /already/);
  assert.match(deviceNameError(`${OWNER}-x7k`, OWNER, roster, [`${OWNER}-x7k`]), /already/);
  assert.match(deviceNameError(OWNER_CLOUD, OWNER, roster, []), /already/);
  assert.match(deviceNameError(`${OWNER}-Cloud`, OWNER, roster, []), /label/);
  assert.match(deviceNameError(OWNER, OWNER, roster, []), /label/);
});
