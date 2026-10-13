import { OTHER, OTHER_CLOUD, OTHER_DEVICE, OWNER, OWNER_CLOUD, OWNER_DEVICE, ACTIVE_CONFIG } from "./harness/roles.mjs";
// Admin pages (/docs/status, /docs/settings) and the per-device permission toggles behind them, against the real Hub on an
// in-memory SQLite. The live routes (Access guard, routing) are covered in settings-live.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, memoryHub, memorySql, noSqlite } from "./hub-memory.mjs";

const MEMBERS = [OWNER, OWNER_DEVICE, OWNER_CLOUD, OTHER, OTHER_DEVICE, OTHER_CLOUD];
const ADMINS = ACTIVE_CONFIG.admins;
const tokenOf = (name) => `${name}-token-`.padEnd(32, "x");

async function setup() {
  const { hub, sql } = await memoryHub();
  const grants = [{ id: "g1", userId: OTHER_DEVICE, clientId: "c1", createdAt: 1_760_000_000 }];
  const revoked = [];
  const env = {
    HUB: { idFromName: () => "main", get: () => hub },
    GOONBRIDGE_TOKENS: JSON.stringify(Object.fromEntries(MEMBERS.map((m) => [tokenOf(m), m]))),
    OAUTH_PROVIDER: {
      listUserGrants: async (userId) => ({ items: grants.filter((g) => g.userId === userId) }),
      lookupClient: async (id) => ({ clientName: id === "c1" ? "Claude" : id }),
      revokeGrant: async (id, userId) => { revoked.push([id, userId]); },
    },
  };
  return { hub, sql, env, revoked, settings: await loadModule("src/settings.ts") };
}
const form = (fields, headers = {}) => new Request("https://bridge.example.test/docs/settings", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://bridge.example.test", ...headers }, body: new URLSearchParams(fields),
});
const get = (path) => new Request(`https://bridge.example.test${path}`);
const eventsOf = (sql, device) => sql.exec("SELECT actor, kind, data FROM events WHERE subject_kind = 'device' AND subject_id = ? ORDER BY id", device).toArray()
  .map((e) => ({ ...e, data: JSON.parse(e.data) }));

test("/docs/status is admin-only JSON with what the Worker can see, and no secrets", { skip: noSqlite }, async () => {
  const { env, hub, settings } = await setup();
  assert.deepEqual(ADMINS, [OWNER], "fixture: the owner is the one admin");
  assert.equal((await settings.statusPage(env, OTHER)).status, 403, "a member who is not an admin");
  assert.equal((await settings.statusPage(env, OTHER_DEVICE)).status, 403);
  await hub.registerDevice(OWNER, `${OWNER}-studio`, MEMBERS);
  const res = await settings.statusPage(env, OWNER_DEVICE);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assert.equal(body.deployment, ACTIVE_CONFIG.deployment.id);
  assert.equal(typeof body.version.engine, "string");
  assert.equal(body.members, 2, "people, not devices");
  assert.equal(body.devices_registered, 1);
  assert.equal(body.last_contract_check, null);
  assert.equal(typeof body.access, "boolean");
  await hub.recordContractCheck(OWNER, "0.1.0");
  const after = await (await settings.statusPage(env, OWNER)).json();
  assert.match(after.last_contract_check, /^\d{4}-\d\d-\d\dT/);
  assert.ok(!JSON.stringify(after).includes("-token-"), "no tokens");
});

test("/docs/settings: admin-only page lists devices per person, permissions and agents; bridge values are read-only", { skip: noSqlite }, async () => {
  const { env, settings } = await setup();
  assert.equal((await settings.settingsPage(get("/docs/settings"), env, OTHER)).status, 403);
  assert.equal((await settings.settingsPage(get("/docs/settings"), env, OWNER_CLOUD)).status, 403, "a cloud session never opens settings");
  const res = await settings.settingsPage(get("/docs/settings"), env, OWNER);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy"), /default-src 'none'.*form-action 'self'/);
  const html = await res.text();
  assert.ok(!/<script/i.test(html), "no script");
  for (const name of [OWNER_DEVICE, OTHER_DEVICE]) assert.ok(html.includes(name), `lists ${name}`);
  for (const p of ["may_run_full", "may_edit_tasks", "may_act_as_person"]) assert.ok(html.includes(p), `toggle ${p}`);
  assert.match(html, /Claude/, "connected agents by client name");
  assert.ok(html.includes(`deployments/${ACTIVE_CONFIG.deployment.id}/bridge.config.json`), "says where bridge values are edited");
  assert.ok(!/name="(admins|members|origin|displayName)"/.test(html), "no form field edits bridge values or roles");
  assert.ok(!html.includes("-token-"), "no tokens");
});

test("settings posts: cross-site refused, non-admins refused, each permission change is an event", { skip: noSqlite }, async () => {
  const { env, sql, hub, settings } = await setup();
  const post = (member, fields, headers) => settings.settingsAction(form(fields, headers), env, member);
  const change = { action: "permission", device: OTHER_DEVICE, permission: "may_edit_tasks", value: "off" };
  assert.equal((await post(OWNER, change, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(OWNER, change, { Origin: "", "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post(OTHER, change)).status, 403, "not an admin");
  const ok = await post(OWNER, change);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("Location"), "/docs/settings");
  assert.deepEqual(eventsOf(sql, OTHER_DEVICE), [{ actor: OWNER, kind: "permission", data: { permission: "may_edit_tasks", person: null, value: "off" } }]);
  await post(OWNER, change);
  assert.equal(eventsOf(sql, OTHER_DEVICE).length, 1, "no change, no event");
  await post(OWNER, { action: "permission", device: OTHER_DEVICE, permission: "may_run_full", person: OWNER, value: "on" });
  assert.deepEqual(await hub.trustedOn(OTHER_DEVICE), [OWNER], "may_run_full is T-41 trust");
  assert.equal(eventsOf(sql, OTHER_DEVICE).at(-1).data.permission, "may_run_full");
  await assert.rejects(hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER_CLOUD, "may_act_as_person", "on"), /cloud/);
  await assert.rejects(hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER_DEVICE, "may_fly", "on"), /may_run_full, may_edit_tasks, may_act_as_person/);
  await assert.rejects(hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER, "may_edit_tasks", "off"), /not a device/);
  await hub.registerDevice(OTHER, `${OTHER}-studio`, MEMBERS);
  assert.equal((await post(OWNER, { action: "forget", name: `${OTHER}-studio` })).status, 303);
  assert.ok(!(await hub.registeredDevices()).some((d) => d.name === `${OTHER}-studio`), "an admin forgets any registered device");
  assert.equal((await post(OWNER, { action: "forget", name: OTHER_DEVICE })).status, 400, "a token device is not forgotten here");
});

test("toggles are enforced: may_edit_tasks restricts or expands task edits, may_act_as_person drops the owner role", { skip: noSqlite }, async () => {
  const { hub } = await setup();
  const made = await hub.taskCreate(OWNER, MEMBERS, { title: "Toggle task", brief: "For the permission toggles.", owner: OWNER, state: "ready" });
  await hub.taskUpdate(OWNER_DEVICE, MEMBERS, made.key, { title: "renamed by my device" });
  await hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER_DEVICE, "may_edit_tasks", "off");
  await assert.rejects(hub.taskUpdate(OWNER_DEVICE, MEMBERS, made.key, { title: "again" }), /may_edit_tasks/);
  await hub.taskUpdate(OWNER_DEVICE, MEMBERS, made.key, { note: "a note is still fine" });
  await hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER_DEVICE, "may_edit_tasks", "default");
  await hub.taskUpdate(OWNER_DEVICE, MEMBERS, made.key, { title: "back to normal" });
  // A cloud session never edits title or brief by default; may_edit_tasks on expands that.
  await assert.rejects(hub.taskUpdate(OWNER_CLOUD, MEMBERS, made.key, { title: "cloud rename", expected_version: (await hub.taskGet(made.key)).task.version }), /cloud session never changes the title/);
  await hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER_CLOUD, "may_edit_tasks", "on");
  const version = (await hub.taskGet(made.key)).task.version;
  await hub.taskUpdate(OWNER_CLOUD, MEMBERS, made.key, { title: "cloud rename", expected_version: version });
  // may_act_as_person off: the device no longer counts as its person (no owner moves, no trust changes).
  await hub.setPermission(OWNER, MEMBERS, ADMINS, OWNER_DEVICE, "may_act_as_person", "off");
  await assert.rejects(hub.taskUpdate(OWNER_DEVICE, MEMBERS, made.key, { state: "dropped" }), /cannot go from ready to dropped/);
  await assert.rejects(hub.setTrust(OWNER_DEVICE, MEMBERS, OWNER_DEVICE, OTHER, "full"), /may_act_as_person/);
  await hub.taskUpdate(OWNER, MEMBERS, made.key, { state: "dropped" });
});

test("old device_trust rows move into device_permissions once, and trust reads them", { skip: noSqlite }, async () => {
  const trust = await loadModule("src/hub/trust.ts");
  const events = await loadModule("src/hub/events.ts");
  const sql = memorySql();
  events.initEvents(sql);
  sql.exec("CREATE TABLE device_trust (device TEXT NOT NULL, person TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY (device, person))");
  sql.exec("INSERT INTO device_trust VALUES (?, ?, ?, ?)", OWNER_DEVICE, OTHER, OWNER, 5);
  trust.initTrust(sql);
  trust.initTrust(sql);
  assert.deepEqual(trust.trustedOn(sql, OWNER_DEVICE), [OTHER]);
  assert.deepEqual(trust.trustRows(sql, [OWNER_DEVICE]), [{ device: OWNER_DEVICE, person: OTHER, granted_by: OWNER, granted_at: 5 }]);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'device_trust'").toArray()[0].n, 0, "old table renamed, not re-copied");
});
