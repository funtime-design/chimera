// pnpm access:provision / members:sync (bin/access-provision.mjs), offline: the Cloudflare Access API is an in-memory
// fake behind an injected fetch. The no-print contract: no token, account ID, client secret or email is printed, on
// success or on any failure path; only member NAMES appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { provisionAccess } from '../bin/access-provision.mjs';
import { configFrom, secretsFrom } from '../bin/setup.mjs';
import { engineTemplate, identityOf } from '../bin/deployment.mjs';
import { accessFake } from './access-fake.mjs';

const hex = n => randomBytes(n).toString('hex');
const SECRET = { token: `cf_access_${hex(16)}`, account: hex(16), client: `client_secret_${hex(16)}`, deploy: `cf_deploy_${hex(16)}`, alice: `tok_alice_${hex(16)}`, bob: `tok_bob_${hex(16)}` };
const EMAIL = { alice: 'alice@example.test', bob: 'bob@example.test', carol: 'carol@example.test' };
const TEAM = 'acme-team.cloudflareaccess.com';
const answers = (extra = {}) => ({ deployment: 'acme', displayName: 'Acme', origin: 'https://bridge.example.test', accountId: SECRET.account, workerName: 'acme-bridge',
  admins: [{ name: 'alice', email: EMAIL.alice }], members: [{ name: 'bob', email: EMAIL.bob }], access: 'provision', ...extra });

async function sandbox(t, { a = answers(), secrets = true, token = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'chimera-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n');
  const dir = path.join(root, 'deployments/acme');
  await mkdir(dir, { recursive: true });
  const config = await configFrom(a);
  await writeFile(path.join(dir, 'bridge.config.json'), `${JSON.stringify({ $schema: '../../config/bridge.config.schema.json', ...config }, null, 2)}\n`);
  await writeFile(path.join(dir, 'deployment.lock.json'), JSON.stringify(identityOf(config, await engineTemplate())));
  if (secrets) {
    const s = { ...secretsFrom(a), GOONBRIDGE_TOKENS: { alice: SECRET.alice, bob: SECRET.bob }, CLOUDFLARE_API_TOKEN: SECRET.deploy, ...(token ? { CLOUDFLARE_ACCESS_TOKEN: SECRET.token } : {}) };
    await writeFile(path.join(dir, 'secrets.json'), JSON.stringify(s), { mode: 0o600 });
  }
  return root;
}

const cloudflare = (opts = {}) => accessFake({ token: SECRET.token, account: SECRET.account, clientSecret: SECRET.client, teamDomain: TEAM, leak: [EMAIL.alice], ...opts });

async function run(root, argv, options = {}) {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
  try {
    const code = await provisionAccess({ root, argv: ['--deployment', 'acme', ...argv], env: {}, fetchImpl: cloudflare().fetchImpl,
      out: l => lines.push(l), err: l => lines.push(l), ...options });
    return { code, text: lines.join('\n') };
  } finally { Object.assign(console, original); }
}
const read = async (root, rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));
const writes = calls => calls.filter(c => c.method !== 'GET');
function noLeak(text, where) {
  for (const [name, value] of Object.entries(SECRET)) assert.ok(!text.includes(value), `${where}: ${name} printed`);
  for (const email of Object.values(EMAIL)) assert.ok(!text.includes(email), `${where}: an email printed`);
}

test('create fresh: One-time PIN, the members group, an allow policy and the OIDC app; config gets the URLs, secrets.json the client secret', async t => {
  const root = await sandbox(t);
  const cf = cloudflare();
  const r = await run(root, [], { fetchImpl: cf.fetchImpl });
  assert.equal(r.code, 0, r.text);
  noLeak(r.text, 'create');
  const [idp] = cf.state.idps, [group] = cf.state.groups, [policy] = cf.state.policies, [app] = cf.state.apps;
  assert.equal(idp.type, 'onetimepin');
  assert.equal(group.name, 'Acme members');
  assert.deepEqual(group.include, [{ email: { email: EMAIL.alice } }, { email: { email: EMAIL.bob } }]);
  assert.deepEqual({ name: policy.name, decision: policy.decision, include: policy.include }, { name: 'Acme members', decision: 'allow', include: [{ group: { id: group.id } }] });
  assert.equal(app.name, 'Acme sign-in');
  assert.equal(app.type, 'saas');
  assert.equal(app.saas_app.auth_type, 'oidc');
  assert.deepEqual(app.saas_app.redirect_uris, ['https://bridge.example.test/callback'], 'the callback path src/oauth.ts uses');
  assert.deepEqual(app.policies, [{ id: policy.id }]);
  const access = (await read(root, 'deployments/acme/bridge.config.json')).access;
  const issuer = `https://${TEAM}/cdn-cgi/access/sso/oidc/${app.saas_app.client_id}`;
  assert.deepEqual(access, { clientId: app.saas_app.client_id, clientSecret: { env: 'ACCESS_CLIENT_SECRET' }, authorizationUrl: `${issuer}/authorization`, tokenUrl: `${issuer}/token`, jwksUrl: `${issuer}/jwks` });
  const secrets = await read(root, 'deployments/acme/secrets.json');
  assert.equal(secrets.ACCESS_CLIENT_SECRET, SECRET.client);
  assert.equal((await stat(path.join(root, 'deployments/acme/secrets.json'))).mode & 0o777, 0o600);
  assert.match(r.text, /create with alice, bob/);
  assert.match(r.text, /ACCESS_CLIENT_SECRET/);
});

test('find existing: a second run creates nothing, keeps the config and the secret, and exits 0', async t => {
  const root = await sandbox(t);
  const cf = cloudflare();
  await run(root, [], { fetchImpl: cf.fetchImpl });
  const config = await readFile(path.join(root, 'deployments/acme/bridge.config.json'), 'utf8');
  const again = cloudflare({ state: cf.state });
  const r = await run(root, [], { fetchImpl: again.fetchImpl });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(writes(again.calls), [], 'nothing created or changed');
  assert.equal(await readFile(path.join(root, 'deployments/acme/bridge.config.json'), 'utf8'), config);
  assert.equal((await read(root, 'deployments/acme/secrets.json')).ACCESS_CLIENT_SECRET, SECRET.client);
  assert.match(r.text, /already lists every member/);
  assert.match(r.text, /app "Acme sign-in": already there/);
  noLeak(r.text, 'existing');
});

test('an existing app whose secret is missing: says how to regenerate it in the dashboard, exit 2', async t => {
  const root = await sandbox(t);
  const cf = cloudflare();
  await run(root, [], { fetchImpl: cf.fetchImpl });
  const s = await read(root, 'deployments/acme/secrets.json');
  delete s.ACCESS_CLIENT_SECRET;
  await writeFile(path.join(root, 'deployments/acme/secrets.json'), JSON.stringify(s));
  const r = await run(root, [], { fetchImpl: cloudflare({ state: cf.state }).fetchImpl });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /regenerate the Client secret/);
  assert.match(r.text, /pnpm secrets:fill -- --deployment acme --only ACCESS_CLIENT_SECRET/);
  assert.match(r.text, /^--- show this ---$/m);
  noLeak(r.text, 'missing secret');
});

test('member sync adds and removes emails and prints names only', async t => {
  const root = await sandbox(t);
  const cf = cloudflare();
  await run(root, [], { fetchImpl: cf.fetchImpl });
  // A rule that is not a single email (an email domain) is the owner's; sync keeps it.
  cf.state.groups[0].include.push({ email_domain: { domain: 'partner.test' } });
  const s = await read(root, 'deployments/acme/secrets.json');
  s.GOONBRIDGE_MEMBERS = { [EMAIL.alice]: 'alice', [EMAIL.carol]: 'carol' };
  await writeFile(path.join(root, 'deployments/acme/secrets.json'), JSON.stringify(s));
  const sync = cloudflare({ state: cf.state });
  const r = await run(root, ['--sync'], { fetchImpl: sync.fetchImpl });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(writes(sync.calls).map(c => c.method), ['PUT'], 'one group update, nothing else');
  assert.deepEqual(cf.state.groups[0].include, [{ email_domain: { domain: 'partner.test' } }, { email: { email: EMAIL.alice } }, { email: { email: EMAIL.carol } }]);
  assert.match(r.text, /add carol/);
  assert.match(r.text, /remove 1 email no longer in the member list/);
  assert.doesNotMatch(r.text, /\bbob\b/);
  noLeak(r.text, 'sync');
  const quiet = await run(root, ['--sync'], { fetchImpl: cloudflare({ state: cf.state }).fetchImpl });
  assert.match(quiet.text, /already lists every member \(alice, carol\)/);
});

test('members:sync in CI: no secrets.json, everything from env', async t => {
  const root = await sandbox(t, { secrets: false });
  const cf = cloudflare();
  const env = { CLOUDFLARE_ACCESS_TOKEN: SECRET.token, CLOUDFLARE_ACCOUNT_ID: SECRET.account, GOONBRIDGE_MEMBERS: JSON.stringify({ [EMAIL.alice]: 'alice' }) };
  const r = await run(root, ['--sync'], { fetchImpl: cf.fetchImpl, env });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(cf.state.groups[0].include, [{ email: { email: EMAIL.alice } }]);
  assert.deepEqual(cf.state.apps, [], 'sync never makes the app');
  noLeak(r.text, 'ci sync');
});

test('Access not turned on: prints the one-time dashboard step and exits 2, creating nothing', async t => {
  const root = await sandbox(t);
  const cf = cloudflare({ enabled: false });
  const r = await run(root, [], { fetchImpl: cf.fetchImpl });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /https:\/\/one\.dash\.cloudflare\.com\//);
  assert.match(r.text, /pnpm access:provision -- --deployment acme/);
  assert.deepEqual(writes(cf.calls), []);
  noLeak(r.text, 'disabled');
});

test('--dry-run reads but creates and writes nothing', async t => {
  const root = await sandbox(t);
  const before = { config: await readFile(path.join(root, 'deployments/acme/bridge.config.json'), 'utf8'), secrets: await readFile(path.join(root, 'deployments/acme/secrets.json'), 'utf8') };
  const cf = cloudflare();
  const r = await run(root, ['--dry-run'], { fetchImpl: cf.fetchImpl });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(writes(cf.calls), []);
  assert.equal(await readFile(path.join(root, 'deployments/acme/bridge.config.json'), 'utf8'), before.config);
  assert.equal(await readFile(path.join(root, 'deployments/acme/secrets.json'), 'utf8'), before.secrets);
  assert.match(r.text, /would create/);
  noLeak(r.text, 'dry run');
});

test('--existing finds the app by the client id in the config and writes only its URLs', async t => {
  const root = await sandbox(t, { a: answers({ access: 'existing', accessClientId: 'cid-mine' }) });
  const cf = cloudflare();
  cf.state.apps.push({ id: 'app-x', name: 'My app', type: 'saas', saas_app: { client_id: 'cid-mine', redirect_uris: ['https://bridge.example.test/callback'] } });
  const s = await read(root, 'deployments/acme/secrets.json');
  s.ACCESS_CLIENT_SECRET = SECRET.client;
  await writeFile(path.join(root, 'deployments/acme/secrets.json'), JSON.stringify(s));
  const r = await run(root, ['--existing'], { fetchImpl: cf.fetchImpl });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(writes(cf.calls), [], 'nothing created in Cloudflare');
  const access = (await read(root, 'deployments/acme/bridge.config.json')).access;
  assert.equal(access.clientId, 'cid-mine');
  assert.equal(access.tokenUrl, `https://${TEAM}/cdn-cgi/access/sso/oidc/cid-mine/token`);
  noLeak(r.text, 'existing app');
});

test('no secret or email is printed on any failure path', async t => {
  const cases = [
    ['forbidden', { fail: 'forbidden' }, /refused CLOUDFLARE_ACCESS_TOKEN.*HTTP 403/],
    ['network', { fail: 'throw' }, /network, details not shown/],
    ['app create', { fail: 'app' }, /refused POST \/apps \(HTTP 500\)/],
  ];
  for (const [label, opts, message] of cases) {
    const root = await sandbox(t);
    const r = await run(root, [], { fetchImpl: cloudflare(opts).fetchImpl });
    assert.equal(r.code, 1, `${label}: ${r.text}`);
    assert.match(r.text, message, label);
    noLeak(r.text, label);
  }
  // A failing group update during sync.
  const root = await sandbox(t);
  const cf = cloudflare();
  await run(root, [], { fetchImpl: cf.fetchImpl });
  const s = await read(root, 'deployments/acme/secrets.json');
  s.GOONBRIDGE_MEMBERS = { [EMAIL.carol]: 'carol' };
  await writeFile(path.join(root, 'deployments/acme/secrets.json'), JSON.stringify(s));
  const put = await run(root, ['--sync'], { fetchImpl: cloudflare({ state: cf.state, fail: 'put' }).fetchImpl });
  assert.equal(put.code, 1, put.text);
  noLeak(put.text, 'group update');
  // No token at all: a waiting step that says where the token comes from.
  const none = await sandbox(t, { token: false });
  const r = await run(none, []);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /pnpm secrets:mint -- --deployment acme/);
  noLeak(r.text, 'no token');
  // Bad GOONBRIDGE_MEMBERS JSON in CI.
  const ci = await sandbox(t, { secrets: false });
  const bad = await run(ci, ['--sync'], { env: { CLOUDFLARE_ACCESS_TOKEN: SECRET.token, CLOUDFLARE_ACCOUNT_ID: SECRET.account, GOONBRIDGE_MEMBERS: `{${EMAIL.alice}` } });
  assert.equal(bad.code, 1);
  noLeak(bad.text, 'bad members json');
});

test('the deploy workflow runs members:sync only when CLOUDFLARE_ACCESS_TOKEN is set', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /HAS_ACCESS_TOKEN: \$\{\{ secrets\.CLOUDFLARE_ACCESS_TOKEN != '' \}\}/);
  const step = workflow.slice(workflow.indexOf('- name: Sync the Access members group'));
  assert.match(step, /if: env\.HAS_ACCESS_TOKEN == 'true'/);
  assert.match(step, /run: pnpm run members:sync -- --deployment "\$DEPLOYMENT"/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['members:sync'], 'node bin/access-provision.mjs --sync');
  assert.equal(pkg.scripts['access:provision'], 'node bin/access-provision.mjs');
});
