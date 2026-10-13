import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFixture, rolesFor, ownerRoles, workerConfig, cleanEnvironment, NEUTRAL_ROLES } from './harness/fixture.mjs';
import { brandingPattern, brandingWords } from './harness/baselines.mjs';
const branding = brandingPattern();
import { buildEngine } from './harness/build.mjs';

test('neutral fixture has eight distinct roles, fresh synthetic credentials and all integrations', () => {
  const a = makeFixture(), b = makeFixture();
  assert.deepEqual(Object.values(a.roles), ['alice', 'bob', 'outsider', 'alice-laptop', 'alice-mini', 'alice-cloud', 'bob-mac', 'bob-cloud']);
  assert.equal(new Set(a.tokens).size, 8);
  assert.ok(a.tokens.every(t => !b.tokens.includes(t)));
  assert.deepEqual(Object.values(JSON.parse(a.vars.GOONBRIDGE_TOKENS)), Object.values(a.roles));
  assert.equal(a.vars.GOONBRIDGE_ROUTINE_BLANK_ALLOW, a.roles.OWNER);
  assert.ok(a.vars.GITHUB_CONFIG_PAT && a.vars.GOONBRIDGE_GITHUB_WEBHOOK_SECRET);
  assert.doesNotMatch(JSON.stringify(a.config), branding);
  assert.ok(Object.values(a.config.timing).every(n => n > 0 && n <= 8));
  assert.equal(a.config.members.length, 8);
});

test('legacy roles remain exact and neutral mode is explicit', () => {
  // Owner mode keeps the bundled deployment's exact private role names; without them it falls back to the neutral names.
  assert.deepEqual(Object.values(rolesFor(false)), ownerRoles() ?? NEUTRAL_ROLES);
  assert.equal(rolesFor(true).OWNER, 'alice');
});

test('Worker config is local, fresh and preserves storage identity', () => {
  const c = workerConfig('engine.js', makeFixture().vars);
  assert.deepEqual(c.durable_objects.bindings, [{ name: 'HUB', class_name: 'Hub' }]);
  assert.deepEqual(c.migrations, [{ tag: 'v1', new_sqlite_classes: ['Hub'] }]);
  assert.deepEqual(c.kv_namespaces, [{ binding: 'OAUTH_KV' }]);
  assert.equal(c.account_id, undefined);
  assert.equal(c.routes, undefined);
  assert.equal(c.dev.port, 0);
  assert.equal(c.dev.inspector_port, 0);
});

test('neutral children cannot inherit owner credentials or private configuration', () => {
  const env = cleanEnvironment({ PATH: 'tools', HOME: 'home', GOONBRIDGE_TOKENS: 'private', CHIMERA_TOKEN: 'private', ACCESS_CLIENT_SECRET: 'private', GITHUB_CONFIG_PAT: 'private', CLOUDFLARE_API_TOKEN: 'private', BRIDGE_CONFIG: 'private', NODE_OPTIONS: 'private' });
  assert.equal(env.PATH, 'tools');
  assert.ok(!Object.values(env).includes('private'));
  assert.equal(env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, 'false');
});

test('the actual engine bundles against the neutral config without private build inputs', async () => {
  const built = await buildEngine(makeFixture().config);
  assert.match(built, /alice-laptop/);
  assert.doesNotMatch(built, /account_id\s*[:=]/, 'account binding is not bundled');
  assert.match(built, /class.*|Hub/);
});


test('neutral served guide and unauthenticated page contain no deployment branding', async () => {
  const { loadSurfaces } = await import('./rules-surfaces.mjs');
  const { setupGuide, pagesEndpoint } = await loadSurfaces(makeFixture().config);
  assert.doesNotMatch(setupGuide('https://example.test'), branding);
  const page = await pagesEndpoint(new Request('https://example.test/docs'), { HUB: { idFromName: () => 'main', get: () => ({ registeredDevices: async () => [] }) } });
  assert.equal(page.status, 401);
  assert.doesNotMatch(await page.text(), branding);
});

test('Wrangler control connections are limited to loopback and local pipes', async () => {
  const { localConnection } = await import('./harness/offline.cjs');
  for (const args of [[{ host: '127.0.0.1', port: 0 }], [{ host: '::1', port: 0 }], [0, 'localhost'], [{ path: 'local.sock' }]]) assert.equal(localConnection(args), true);
  for (const args of [[{ host: 'registry.npmjs.org', port: 443 }], [443, 'api.cloudflare.com'], [{ host: '192.168.1.1', port: 80 }]]) assert.equal(localConnection(args), false);
});

test('command cleanup terminates a process group and reports command failures', async () => {
  const { command } = await import('./harness/process.mjs');
  const failed = command(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  assert.equal((await failed.exited).code, 7);
  await failed.stop();
  const live = command(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => live.child.stdout.once('data', resolve));
  await live.stop();
  assert.throws(() => process.kill(live.child.pid, 0), { code: 'ESRCH' });
});

test('agent output guard rejects branded prose instead of normalizing it away', async () => {
  const { assertNeutralOutput } = await import('./harness/output.mjs');
  assert.equal(assertNeutralOutput('chimera: alice-laptop replied to bob'), 'chimera: alice-laptop replied to bob');
  for (const value of ['goonbridge', 'GOONBRIDGE_TOKEN', ...brandingWords().flatMap(w => [w, `https://${w}`, `${w}-cloud`])]) assert.throws(() => assertNeutralOutput(value), /deployment branding/);
});

test('the installed Wrangler executable resolves through its exported package metadata', async () => {
  const { wranglerCli } = await import('./harness/worker.mjs');
  assert.match(readFileSync(wranglerCli(), 'utf8'), /runWrangler/);
});

test('readiness uses Wrangler IPC and rejects missing, remote or unassigned ports', async () => {
  const { readyUrl } = await import('./harness/worker.mjs');
  assert.equal(readyUrl(JSON.stringify({ event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 12345 })), 'http://127.0.0.1:12345');
  for (const event of [null, 'bad json', { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 0 }, { event: 'DEV_SERVER_READY', ip: 'example.com', port: 443 }]) assert.equal(readyUrl(event), null);
});
