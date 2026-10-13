import { OTHER, OTHER_DEVICE, OTHER_EMAIL, OUTSIDER, OWNER, OWNER_CLOUD, OWNER_EMAIL, PRODUCT, REPO, escapeRegex } from "./harness/roles.mjs";
// OAuth for claude.ai connectors. A fake OIDC provider stands in for Cloudflare Access; its URLs come from .dev.vars.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base, ownerToken, outsiderToken, ownerCloudToken, callTool, useFakeAccess, signInThroughAccess, oauthToken, rest,
} from "./helpers.mjs";

const fakeAccess = useFakeAccess();

test("OAuth discovery: resource and authorization server metadata, 401 points at them", async () => {
  const challenge = await fetch(new URL("/mcp", base), { method: "POST", body: "{}" });
  assert.equal(challenge.status, 401);
  const resourceMetadataUrl = challenge.headers.get("WWW-Authenticate").match(/resource_metadata="([^"]+)"/)[1];
  assert.equal(resourceMetadataUrl, new URL("/.well-known/oauth-protected-resource/mcp", base).href);
  const resource = await (await fetch(resourceMetadataUrl)).json();
  assert.equal(resource.resource, new URL("/mcp", base).href);
  const as = await (await fetch(new URL("/.well-known/oauth-authorization-server", resource.authorization_servers[0]))).json();
  assert.equal(as.authorization_endpoint, new URL("/authorize", base).href);
  assert.ok(as.registration_endpoint, "dynamic client registration is on");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true, "CIMD needs the global_fetch_strictly_public flag");
});

test("static bearer tokens still work on /mcp next to OAuth", async () => {
  assert.match((await callTool(outsiderToken, "bridge_members")).content[0].text, new RegExp(String.raw`You are "${escapeRegex(OUTSIDER)}"`, ""));
  const wrong = await fetch(new URL("/mcp", base), { method: "POST", headers: { Authorization: `Bearer ${"y".repeat(40)}` }, body: "{}" });
  assert.equal(wrong.status, 401);
});

test("OAuth sign-in through Cloudflare Access gives an MCP token for the member", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const token = await oauthToken(await signInThroughAccess(OTHER_EMAIL));
  const members = await callTool(token, "bridge_members");
  assert.match(members.content[0].text, new RegExp(String.raw`You are "${escapeRegex(OTHER)}"`, ""));
});

test("OAuth sign-in can connect as one of the person's devices", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const token = await oauthToken(await signInThroughAccess(OWNER_EMAIL, { connectAs: OWNER_CLOUD }));
  assert.match((await callTool(token, "bridge_members")).content[0].text, new RegExp(String.raw`You are "${escapeRegex(OWNER_CLOUD)}"`, ""));
  const summary = `oauth device ${Date.now()}`;
  assert.match((await callTool(token, "bridge_status_set", { state: "working", repo: REPO, summary })).content[0].text, new RegExp(String.raw`Status for ${escapeRegex(OWNER_CLOUD)}: working`, ""));
  const line = (await callTool(ownerToken, "bridge_status")).content[0].text.split("\n").find((l) => l.startsWith(`${OWNER_CLOUD} `));
  assert.match(line, new RegExp(summary));
  await callTool(ownerCloudToken, "bridge_status_set", { state: "idle" });
});

test("OAuth sign-in falls back to the person for another person's device or no pick", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const other = await oauthToken(await signInThroughAccess(OWNER_EMAIL, { connectAs: OTHER_DEVICE }));
  assert.match((await callTool(other, "bridge_members")).content[0].text, new RegExp(String.raw`You are "${escapeRegex(OWNER)}"`, ""));
  const unknown = await oauthToken(await signInThroughAccess(OWNER_EMAIL, { connectAs: `${OWNER}-nope` }));
  assert.match((await callTool(unknown, "bridge_members")).content[0].text, new RegExp(String.raw`You are "${escapeRegex(OWNER)}"`, ""));
  const none = await oauthToken(await signInThroughAccess(OWNER_EMAIL));
  assert.match((await callTool(none, "bridge_members")).content[0].text, new RegExp(String.raw`You are "${escapeRegex(OWNER)}"`, ""));
});

test("OAuth sign-in refuses an email that is not a member", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const { done } = await signInThroughAccess("stranger@example.com");
  assert.equal(done.status, 403);
  assert.equal(done.headers.get("Location"), null);
  assert.match(await done.text(), new RegExp(String.raw`not a ${escapeRegex(PRODUCT)} member`, ""));
});

test("OAuth sign-in refuses an ID token with a bad signature", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const { done } = await signInThroughAccess(OTHER_EMAIL, { badSignature: true });
  assert.equal(done.status, 403);
  assert.equal(done.headers.get("Location"), null);
});

test("callback without the browser's state cookie is refused", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const res = await fetch(new URL("/callback?code=x&state=forged", base), { redirect: "manual" });
  assert.equal(res.status, 400);
});

test("REST accepts an OAuth token for the member it was issued to", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const token = await oauthToken(await signInThroughAccess(OWNER_EMAIL, { connectAs: OWNER_CLOUD }));
  const me = await rest(token, "GET", "/v1/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.member, OWNER_CLOUD);
  assert.equal(me.body.person, OWNER);
  const status = await rest(token, "POST", "/v1/status", { state: "idle", summary: "oauth rest" });
  assert.equal(status.status, 200);
});

test("REST still refuses a token that is neither static nor OAuth", async () => {
  const res = await rest("z".repeat(48), "GET", "/v1/me");
  assert.equal(res.status, 401);
});
