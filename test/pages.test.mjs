import { servedScript } from "./harness/client.mjs";
import { ACTIVE_CONFIG, OTHER, OTHER_DEVICE, OTHER_EMAIL, OWNER_CLOUD, OWNER_DEVICE, OWNER_EMAIL, PRODUCT, escapeRegex } from "./harness/roles.mjs";
// Redirects, the pages under /docs, the served scripts and the Cloudflare Access browser sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  base, ownerToken, otherToken, outsiderToken, ownerDeviceToken, ownerSecondDeviceToken, ownerCloudToken, otherDeviceToken, otherCloudToken, rest, mcp, callTool, devVars,
  useFakeAccess, signInThroughAccess, oauthToken,
} from "./helpers.mjs";

const fakeAccess = useFakeAccess();

test("the old page paths redirect under /docs", async () => {
  const origin = new URL(base).origin;
  const go = async (path) => { const r = await fetch(new URL(path, base), { redirect: "manual" }); return [r.status, r.headers.get("Location")]; };
  assert.deepEqual(await go("/"), [302, `${origin}/docs`]);
  assert.deepEqual(await go("/setup.md"), [308, `${origin}/docs/setup.md`]);
  assert.deepEqual(await go("/tasks?state=all"), [308, `${origin}/docs/tasks?state=all`]);
});

test("the pages under /docs need a member: no token, no page", async () => {
  for (const path of ["/docs", "/docs/", "/docs/setup.md", "/docs/tasks"]) {
    const res = await fetch(new URL(path, base));
    assert.equal(res.status, 401, path);
    const text = await res.text();
    assert.ok(!text.includes(OWNER_DEVICE) && !text.includes("bridge_send") && !text.includes("Key Vault"), `${path} leaks nothing`);
  }
  assert.equal((await fetch(new URL("/docs/nothing", base), { headers: { Authorization: `Bearer ${otherToken}` } })).status, 404);
});

test("setup guide with a token, connector without", async () => {
  const guide = await fetch(new URL("/docs/setup.md", base), { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(guide.status, 200);
  const text = await guide.text();
  assert.match(text, new RegExp(String.raw`# ${escapeRegex(PRODUCT)}: setup for agents`, ""));
  assert.ok(text.includes(`${new URL(base).origin}/mcp`), "guide uses this bridge's own URL");
  assert.ok(!text.includes("{{BASE_URL}}"));
  const connector = await fetch(new URL("/goonbridge-mcp.mjs", base));
  assert.equal(connector.status, 200);
  const connectorText = await connector.text();
  assert.match(connectorText, /GOONBRIDGE_TOKEN/);
  const alias = await fetch(new URL(ACTIVE_CONFIG.compatibility.assetNames.connector, base));
  assert.equal(alias.status, 200);
  assert.equal(await alias.text(), connectorText);
});

test("the cloud setup script is served without a token, as the repo file", async () => {
  const res = await fetch(new URL("/cloud-setup.sh", base));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, servedScript("cloud-setup.sh"));
  assert.match(text, /^#!\/bin\/sh/);
  assert.ok(!/ops_|Bearer [0-9a-f]{20}/.test(text), "no secrets in the served script");
});

test("the front page shows every tool and every member, with online flags and no secrets", async () => {
  await rest(otherDeviceToken, "POST", "/v1/status", { state: "idle" });
  const res = await fetch(new URL("/docs", base), { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^text\/html/);
  const html = await res.text();
  assert.match(html, new RegExp(String.raw`<h1>${escapeRegex(PRODUCT)}<\/h1>`, ""));
  assert.ok(!/<script/i.test(html));
  const tools = (await mcp(ownerToken, "tools/list")).result.tools.map((t) => t.name);
  for (const name of tools) assert.ok(html.includes(`<code>${name}</code>`), `front page names ${name}`);
  const me = (await rest(ownerToken, "GET", "/v1/me")).body;
  for (const name of [...me.members, ...Object.values(me.devices).flat()]) assert.ok(html.includes(name), `front page lists ${name}`);
  assert.match(html, new RegExp(String.raw`${escapeRegex(OTHER_DEVICE)} <small>online<\/small>`, ""));
  for (const token of [ownerToken, otherToken, outsiderToken, ownerDeviceToken, ownerSecondDeviceToken, ownerCloudToken, otherDeviceToken, otherCloudToken]) assert.ok(!html.includes(token), "no tokens");
  assert.ok(!html.includes("@"), "no emails");
  assert.match(html, new RegExp(String.raw`${escapeRegex(PRODUCT)} \d+\.\d+\.\d+`, ""), "version line");
  assert.ok(html.includes('href="/docs/setup.md"') && html.includes('href="/docs/tasks"') && html.includes('href="/docs/devices"'));
  assert.ok(html.includes(`claude mcp add --scope user --transport http ${PRODUCT} ${new URL(base).origin}/mcp`), "start here shows the connect command");
});

test("a browser behind Cloudflare Access reaches /docs and /docs/tasks as the signed-in person", async () => {
  if (!fakeAccess) return;
  const withJwt = (path, jwt, viaCookie = false) => fetch(new URL(path, base), { headers: viaCookie ? { Cookie: `CF_Authorization=${jwt}` } : { "Cf-Access-Jwt-Assertion": jwt } });
  const members = JSON.parse(devVars.GOONBRIDGE_MEMBERS);
  const timEmail = Object.keys(members).find((email) => members[email] === OTHER);
  assert.ok(timEmail, `.dev.vars maps an email to ${OTHER}`);
  const page = await withJwt("/docs", fakeAccess.accessJwt(timEmail));
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(String.raw`<h1>${escapeRegex(PRODUCT)}<\/h1>`, ""));
  assert.equal((await withJwt("/docs/setup.md", fakeAccess.accessJwt(timEmail), true)).status, 200, "the CF_Authorization cookie works too");
  const made = await callTool(ownerToken, "task_create", { title: "seen from the browser", brief: "Open /docs/tasks and look.", owner: OTHER });
  const key = made.content[0].text.match(/^Created (T-\d+) /)[1];
  const tasks = await withJwt("/docs/tasks", fakeAccess.accessJwt(timEmail));
  assert.equal(tasks.status, 200);
  assert.ok((await tasks.text()).includes(key), "the tasks page lists the task");
  await callTool(ownerToken, "task_update", { key, state: "dropped" });
  assert.equal((await withJwt("/docs", fakeAccess.accessJwt(timEmail, { badSignature: true }))).status, 401, "bad signature");
  assert.equal((await withJwt("/docs", fakeAccess.accessJwt(timEmail, { aud: "another-app" }))).status, 401, "another app's audience");
  assert.equal((await withJwt("/docs", fakeAccess.accessJwt(timEmail, { expired: true }))).status, 401, "expired");
  assert.equal((await withJwt("/docs", fakeAccess.accessJwt("stranger@example.com"))).status, 401, "a sign-in that is not a member");
});

test("/docs/devices lists my household with grants and lets me revoke one, never another person's", { skip: !fakeAccess && "no ACCESS_* in .dev.vars" }, async () => {
  const mine = await oauthToken(await signInThroughAccess(OWNER_EMAIL, { connectAs: OWNER_CLOUD }));
  const theirs = await oauthToken(await signInThroughAccess(OTHER_EMAIL));
  const page = await fetch(new URL("/docs/devices", base), { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(String.raw`${escapeRegex(OWNER_CLOUD)}`, ""));
  assert.doesNotMatch(html, new RegExp(String.raw`${escapeRegex(OTHER_DEVICE)}`, ""), "other households are not shown");
  // Grants are listed newest first per member, and earlier runs leave older alice-cloud grants behind: take the newest.
  const [, grantId, userId] = html.match(new RegExp(String.raw`name="grant_id" value="([^"]+)"><input type="hidden" name="user_id" value="(${escapeRegex(OWNER_CLOUD)})"`, ""));
  const post = (body, headers = {}) => fetch(new URL("/docs/devices", base), { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  assert.equal((await post({ action: "revoke", grant_id: "x", user_id: OTHER })).status, 403);
  assert.equal((await post({ action: "forget", name: OTHER_DEVICE })).status, 403, "never another person's device");
  assert.equal((await post({ action: "revoke", grant_id: grantId, user_id: userId }, { Origin: "https://evil.example" })).status, 403, "a cross-site form post is refused");
  assert.match((await callTool(theirs, "bridge_members")).content[0].text, new RegExp(String.raw`You are "${escapeRegex(OTHER)}"`, ""), `${OTHER}'s grant untouched`);
  const ok = await post({ action: "revoke", grant_id: grantId, user_id: userId });
  assert.equal(ok.status, 303);
  assert.equal(new URL(ok.headers.get("Location"), base).pathname, "/docs/devices");
  const after = await fetch(new URL("/mcp", base), { method: "POST", headers: { Authorization: `Bearer ${mine}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(after.status, 401, "revoked grant's token no longer works");
  assert.ok(!(await (await fetch(new URL("/docs/devices", base), { headers: { Authorization: `Bearer ${ownerToken}` } })).text()).includes(grantId), "the revoked grant is gone from the page");
});
