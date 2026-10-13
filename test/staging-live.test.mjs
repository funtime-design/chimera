// The staging smoke (bin/staging-smoke.mjs) against the real engine: proves its parsing matches the live tool replies.
import { test } from "node:test";
import { base, ownerToken } from "./helpers.mjs";
import { OTHER } from "./harness/roles.mjs";
import { stagingSmoke } from "../bin/staging-smoke.mjs";

test("staging smoke passes against a live Worker: status, send and thread, task create, get and drop", async () => {
  const origin = "https://staging.invalid";
  const id = (await (await fetch(new URL("/docs/status", base), { headers: { Authorization: `Bearer ${ownerToken}` } })).json()).deployment;
  // The smoke insists on HTTPS; point its requests at the local Worker.
  const fetchImpl = (url, init) => fetch(new URL(String(url).slice(origin.length), base), { ...init, redirect: "manual" });
  await stagingSmoke({ origin, token: ownerToken, expectedDeployment: id, peer: OTHER, fetchImpl, log: () => {} });
});
