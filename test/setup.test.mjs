// pnpm run setup (bin/setup.mjs), offline: answers from a file or a stubbed terminal, wrangler/gh/pnpm and fetch stubbed.
// The no-print contract: no injected secret value (tokens, deploy token, Access secret, account ID) appears in stdout,
// stderr, the state file or an error, on success or on any failure path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup } from '../bin/setup.mjs';
import { detect } from '../bin/setup-detect.mjs';

const hex = n => randomBytes(n).toString('hex');
const SECRET = {
  alice: `tok_alice_${hex(16)}`, bob: `tok_bob_${hex(16)}`, deploy: `cf_deploy_${hex(16)}`, access: `access_secret_${hex(12)}`,
  account: hex(16), accessApi: `cf_access_api_${hex(12)}`,
};
const EMAIL = { alice: 'alice@example.test', bob: 'bob@example.test' };
const answers = (extra = {}) => ({ deployment: 'acme', displayName: 'Acme bridge', origin: 'https://bridge.example.test', accountId: SECRET.account, workerName: 'acme-bridge',
  admins: [{ name: 'alice', email: EMAIL.alice }], members: [{ name: 'bob', email: EMAIL.bob }], access: false, ...extra });

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'chimera-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n.generated/\n.chimera-setup/\n');
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  return root;
}
const version = { engine: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, schema: 2, build: 'b1' };
// A live bridge, in process: answers the contract endpoints for the contract token only.
function bridge({ fail } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const req = new Request(url, init); seen.push(req);
    if (fail === 'throw') throw new Error(`network down ${SECRET.alice}`);
    if (fail === 'status') return new Response(`denied ${SECRET.alice}`, { status: 401 });
    if (req.headers.get('Authorization') !== `Bearer ${SECRET.alice}`) return new Response('no', { status: 401 });
    const p = new URL(url).pathname;
    if (p === '/v1/me') return Response.json({ member: 'alice' });
    if (p === '/v1/version') return Response.json({ worker: version, hub: version });
    if (p === '/v1/faults') return Response.json({ errors: [], work_threads: [] });
    if (p === '/v1/contract-check') return Response.json({ recorded: true });
    if (p === '/mcp') return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'task_report' }, { name: 'bridge_faults' }] } });
    return new Response('?', { status: 404 });
  };
  return { fetchImpl, seen };
}
// Detection on a stubbed machine: wrangler logged in to one account (SECRET.account), gh logged in, given zones.
const DETECT_TOKEN = `oauth_${hex(16)}`;
function detector({ loggedIn = true, zones = ['example.test'], git = false, gh = true, nodeVersion = '22.18.0' } = {}) {
  const commands = {
    'npx wrangler whoami --json': loggedIn ? { code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: SECRET.account, name: 'Acme Account' }] }) } : { code: 1, stdout: '{"loggedIn":false}' },
    'npx wrangler auth token --json': { code: loggedIn ? 0 : 1, stdout: loggedIn ? JSON.stringify({ type: 'oauth', token: DETECT_TOKEN }) : '' },
    'pnpm --version': { code: 0, stdout: '10.4.1' },
    ...(gh ? { 'gh auth status': { code: 0, stdout: 'Logged in to github.com account acmegh' } } : {}),
    ...(git ? { 'git config user.email': { code: 0, stdout: EMAIL.alice }, 'git config user.name': { code: 0, stdout: 'Alice' } } : {}),
  };
  const run = async (cmd, args) => commands[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '', stderr: '' };
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/client/v4/zones') return Response.json({ success: true, result: zones.map(name => ({ name })) });
    if (u.pathname.endsWith('/workers/subdomain')) return Response.json({ success: true, result: { subdomain: 'acme-sub' } });
    return Response.json({ success: false }, { status: 404 });
  };
  return ({ answers }) => detect({ root: tmpdir(), run, fetchImpl, env: {}, nodeVersion, answers });
}
// Runs setup once; returns exit code and everything it printed (console included, for stray prints).
async function runSetup(root, argv, options = {}) {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
  try {
    const code = await setup({ root, argv, isTTY: false, run: async () => {}, fetchImpl: bridge().fetchImpl, env: {}, detector: detector(), out: l => lines.push(l), err: l => lines.push(l), ...options });
    return { code, text: lines.join('\n') };
  } finally { Object.assign(console, original); }
}
const read = async (root, rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));
const exists = async p => access(p).then(() => true, () => false);
async function answersFile(root, a = answers()) {
  const file = path.join(root, 'answers.json');
  await writeFile(file, JSON.stringify(a));
  return file;
}
async function fillSecrets(root, extra = {}) {
  const file = path.join(root, 'deployments/acme/secrets.json');
  const s = JSON.parse(await readFile(file, 'utf8'));
  s.GOONBRIDGE_TOKENS = { alice: SECRET.alice, bob: SECRET.bob };
  s.CLOUDFLARE_API_TOKEN = SECRET.deploy;
  if ('ACCESS_CLIENT_SECRET' in s) s.ACCESS_CLIENT_SECRET = SECRET.access;
  await writeFile(file, JSON.stringify({ ...s, ...extra }));
}
function noSecrets(text, where) {
  for (const [name, value] of Object.entries(SECRET)) assert.ok(!text.includes(value), `${where}: ${name} must never be printed`);
}
async function stateClean(root) {
  const text = await readFile(path.join(root, '.chimera-setup/acme.json'), 'utf8');
  noSecrets(text, 'state file');
  for (const email of Object.values(EMAIL)) assert.ok(!text.includes(email), 'no emails in the state file');
  return JSON.parse(text);
}

test('setup --answers writes config, lock and secrets, pauses for secrets, then resumes through push, deploy and contract check', async t => {
  const root = await sandbox(t);
  let all = '';
  const first = await runSetup(root, ['--answers', await answersFile(root)]);
  all += first.text;
  assert.equal(first.code, 2, first.text);
  const config = await read(root, 'deployments/acme/bridge.config.json');
  assert.equal(config.deployment.id, 'acme');
  assert.deepEqual(config.admins, ['alice']);
  assert.deepEqual(config.hooks.approvers, ['alice']);
  assert.deepEqual(config.members, [{ name: 'alice', kind: 'person' }, { name: 'bob', kind: 'person' }]);
  assert.equal(config.access, undefined, 'no Access block without Access');
  assert.ok(!JSON.stringify(config).includes(SECRET.account) && !JSON.stringify(config).includes('@'), 'no account ID or email in committed config');
  assert.equal((await read(root, 'deployments/acme/deployment.lock.json')).workerName, 'acme-bridge');
  const secrets = await read(root, 'deployments/acme/secrets.json');
  assert.deepEqual(secrets.GOONBRIDGE_MEMBERS, { [EMAIL.alice]: 'alice', [EMAIL.bob]: 'bob' }, 'emails only in secrets.json');
  assert.equal(secrets.cloudflare.accountId, SECRET.account);
  assert.equal(secrets.contractToken, 'alice');
  assert.match(first.text, /GOONBRIDGE_TOKENS\.alice/);
  assert.match(first.text, /CLOUDFLARE_API_TOKEN/);
  assert.match(first.text, /secrets:mint -- --deployment acme/);
  assert.match(first.text, /secrets:fill -- --deployment acme/);
  for (const email of Object.values(EMAIL)) assert.ok(!first.text.includes(email), 'no emails printed without Access');
  let state = await stateClean(root);
  assert.equal(state.steps.config.status, 'done');
  assert.equal(state.steps.secrets.status, 'todo');

  await fillSecrets(root);
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, env: options?.env, input: options?.input }); };
  const unconfirmed = await runSetup(root, ['--deployment', 'acme', '--resume'], { run });
  all += unconfirmed.text;
  assert.equal(unconfirmed.code, 2, unconfirmed.text);
  assert.match(unconfirmed.text, /Would set GOONBRIDGE_TOKENS/);
  assert.match(unconfirmed.text, /--resume --yes/);
  assert.equal(calls.length, 0, 'nothing pushed without confirmation');
  assert.ok(await exists(path.join(root, '.generated/wrangler.acme.jsonc')));

  const live = bridge();
  const done = await runSetup(root, ['--deployment', 'acme', '--resume', '--yes'], { run, fetchImpl: live.fetchImpl });
  all += done.text;
  assert.equal(done.code, 0, done.text);
  assert.ok(calls.some(c => c.command === 'npx' && c.args.join(' ') === 'wrangler secret put GOONBRIDGE_TOKENS --name acme-bridge'));
  assert.ok(calls.some(c => c.command === 'gh' && c.args.join(' ') === 'secret set CLOUDFLARE_API_TOKEN' && c.input === SECRET.deploy), 'values go on stdin');
  const deploy = calls.find(c => c.command === 'pnpm');
  assert.deepEqual(deploy.args, ['exec', 'wrangler', 'deploy', '-c', '.generated/wrangler.acme.jsonc']);
  assert.equal(deploy.env.CLOUDFLARE_API_TOKEN, SECRET.deploy);
  assert.ok(calls.every(c => !c.args.some(a => Object.values(SECRET).some(v => a.includes(v)))), 'no secret in argv');
  assert.deepEqual(live.seen.map(r => new URL(r.url).pathname), ['/v1/me', '/v1/version', '/v1/faults', '/mcp', '/v1/contract-check']);
  state = await stateClean(root);
  for (const step of ['config', 'secrets', 'validate', 'wrangler', 'push', 'deploy', 'contract']) assert.equal(state.steps[step].status, 'done', step);
  assert.equal(state.steps.access, undefined, 'no Access step without Access');

  calls.length = 0;
  const again = await runSetup(root, ['--deployment', 'acme']);
  all += again.text;
  assert.equal(again.code, 0);
  assert.match(again.text, /Setup status for acme/);
  assert.equal(calls.length, 0, 'idempotent: nothing runs again');
  noSecrets(all, 'output');
});

test('person names are checked: no dash, never reused, and nothing is written', async t => {
  const root = await sandbox(t);
  for (const [a, pattern] of [
    [answers({ members: [{ name: 'bob-smith', email: EMAIL.bob }] }), /no dash \("bob-smith" has a dash\)/],
    [answers({ members: [{ name: 'alice', email: EMAIL.bob }] }), /"alice" is used twice/],
    [answers({ admins: [] }), /admins: at least one person/],
    [answers({ accountId: 'nope' }), /accountId/],
  ]) {
    const r = await runSetup(root, ['--answers', await answersFile(root, a)]);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, pattern);
    noSecrets(r.text, 'validation error');
  }
  assert.ok(!await exists(path.join(root, 'deployments/acme')), 'no files written for bad answers');
  const noTty = await runSetup(root, []);
  assert.equal(noTty.code, 2, noTty.text);
  assert.match(noTty.text, /needs-answer\): access, admins, origin$/m);
});

test('on a terminal it asks, re-asking for a dashed or reused name', async t => {
  const root = await sandbox(t);
  const replies = ['acme', 'Acme bridge', '1', '', 'alice', EMAIL.alice, 'bob-smith', 'alice', 'bob', EMAIL.bob, 'n'];
  const asked = [];
  const prompt = async q => { asked.push(q); return replies.shift() ?? ''; };
  const r = await runSetup(root, [], { isTTY: true, prompt });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /no dashes or other characters in person names: bob-smith/);
  assert.match(r.text, /each person name is used once: alice/);
  const config = await read(root, 'deployments/acme/bridge.config.json');
  assert.equal(config.cloudflare.workerName, 'acme-bridge', 'default Worker name');
  assert.equal(config.deployment.origin, 'https://bridge.example.test', 'the detected domain, picked by number');
  assert.equal((await read(root, 'deployments/acme/secrets.json')).cloudflare.accountId, SECRET.account, 'account ID detected, never asked');
  assert.ok(!asked.some(q => /account ID/i.test(q)), 'no account ID question when wrangler knows it');
  assert.deepEqual(config.members.map(m => m.name), ['alice', 'bob']);
  noSecrets(r.text, 'terminal run');
});

test('no secret is printed on any failure path: push, deploy, contract, Access API, corrupt secrets', async t => {
  const leaky = async () => { throw new Error(`boom ${SECRET.deploy} ${SECRET.alice}`); };
  const cases = [
    ['push', { run: async (c, args) => { if (c !== 'pnpm') await leaky(); } }, /failed setting/],
    ['deploy', { run: async c => { if (c === 'pnpm') await leaky(); } }, /wrangler deploy failed/],
    ['contract (network)', { fetchImpl: bridge({ fail: 'throw' }).fetchImpl }, /contract request failed/],
    ['contract (refused)', { fetchImpl: bridge({ fail: 'status' }).fetchImpl }, /contract HTTP failure/],
  ];
  for (const [name, options, pattern] of cases) {
    const root = await sandbox(t);
    await runSetup(root, ['--answers', await answersFile(root)]);
    await fillSecrets(root);
    const r = await runSetup(root, ['--deployment', 'acme', '--resume', '--yes'], options);
    assert.equal(r.code, 1, `${name}: ${r.text}`);
    assert.match(r.text, pattern, name);
    noSecrets(r.text, name);
    const state = await stateClean(root);
    assert.ok(Object.values(state.steps).some(s => s.status === 'todo'), `${name}: the failed step stays todo`);
  }
  // Access API failure (its body echoes the token and account).
  const root = await sandbox(t);
  await runSetup(root, ['--answers', await answersFile(root, answers({ access: { enabled: true, groupId: 'grp1' } }))]);
  await fillSecrets(root);
  const api = async (url, init) => new URL(url).hostname === 'api.cloudflare.com' ? new Response(`bad ${SECRET.accessApi} ${SECRET.account}`, { status: 403 }) : bridge().fetchImpl(url, init);
  const r = await runSetup(root, ['--deployment', 'acme', '--resume', '--yes'], { fetchImpl: api, env: { CLOUDFLARE_ACCESS_TOKEN: SECRET.accessApi } });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /Access API refused/);
  noSecrets(r.text, 'Access API failure');
  // A corrupt secrets file holding a secret.
  const corrupt = await sandbox(t);
  await runSetup(corrupt, ['--answers', await answersFile(corrupt)]);
  await writeFile(path.join(corrupt, 'deployments/acme/secrets.json'), `{"CLOUDFLARE_API_TOKEN": "${SECRET.deploy}"`);
  const bad = await runSetup(corrupt, ['--deployment', 'acme', '--resume', '--yes']);
  assert.equal(bad.code, 1);
  noSecrets(bad.text, 'corrupt secrets');
  // A secrets file that validates badly (an unknown member), values still never echoed.
  await writeFile(path.join(corrupt, 'deployments/acme/secrets.json'), JSON.stringify({ GOONBRIDGE_TOKENS: { mallory: SECRET.alice }, cloudflare: { accountId: SECRET.account }, CLOUDFLARE_API_TOKEN: SECRET.deploy, contractToken: 'mallory' }));
  const invalid = await runSetup(corrupt, ['--deployment', 'acme', '--resume', '--yes']);
  assert.equal(invalid.code, 1, invalid.text);
  noSecrets(invalid.text, 'invalid secrets');
});

test('Cloudflare Access: prints the manual step per person, or adds the emails through the API when a token is present', async t => {
  const root = await sandbox(t);
  await runSetup(root, ['--answers', await answersFile(root, answers({ access: true }))]);
  assert.ok((await read(root, 'deployments/acme/bridge.config.json')).access, 'Access config block');
  assert.ok('ACCESS_CLIENT_SECRET' in await read(root, 'deployments/acme/secrets.json'));
  await fillSecrets(root);
  const manual = await runSetup(root, ['--deployment', 'acme', '--resume', '--yes']);
  assert.equal(manual.code, 0, manual.text);
  for (const email of Object.values(EMAIL)) assert.match(manual.text, new RegExp(`add ${email} to the Access group`));
  assert.equal((await stateClean(root)).steps.access.status, 'manual');
  noSecrets(manual.text, 'manual Access');

  const viaApi = await sandbox(t);
  await runSetup(viaApi, ['--answers', await answersFile(viaApi, answers({ access: { enabled: true, groupId: 'grp1' } }))]);
  await fillSecrets(viaApi);
  const puts = [];
  const api = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'api.cloudflare.com') return bridge().fetchImpl(url, init);
    assert.equal(u.pathname, `/client/v4/accounts/${SECRET.account}/access/groups/grp1`);
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${SECRET.accessApi}`);
    if (init.method === 'GET') return Response.json({ success: true, result: { name: 'Team List', include: [{ email: { email: EMAIL.alice } }] } });
    puts.push(JSON.parse(init.body));
    return Response.json({ success: true, result: {} });
  };
  const r = await runSetup(viaApi, ['--deployment', 'acme', '--resume', '--yes'], { fetchImpl: api, env: { CLOUDFLARE_ACCESS_TOKEN: SECRET.accessApi } });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(puts, [{ name: 'Team List', include: [{ email: { email: EMAIL.alice } }, { email: { email: EMAIL.bob } }] }], 'only the missing email is added');
  assert.equal((await stateClean(viaApi)).steps.access.status, 'done');
  noSecrets(r.text, 'Access API');
});

test('with a minter token, setup fills the new secrets.json through secrets:mint and goes on without printing a value', async t => {
  const root = await sandbox(t);
  const minter = `minter_${hex(16)}`, minted = `minted_${hex(16)}`;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (init.headers?.Authorization !== `Bearer ${minter}`) return Response.json({ success: false }, { status: 403 });
    if (url.includes('/permission_groups')) return Response.json({ success: true, result: [{ id: 'pg', name: 'Workers Editor' }] });
    return Response.json({ success: true, result: { value: minted } });
  };
  const r = await runSetup(root, ['--answers', await answersFile(root)], { env: { CHIMERA_TOKEN_MINTER: minter }, fetchImpl });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /waiting for confirmation/, 'stops at the push confirmation, past the secrets step');
  const secrets = await read(root, 'deployments/acme/secrets.json');
  assert.equal(secrets.CLOUDFLARE_API_TOKEN, minted);
  for (const v of Object.values(secrets.GOONBRIDGE_TOKENS)) assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(secrets.GOONBRIDGE_MEMBERS, { [EMAIL.alice]: 'alice', [EMAIL.bob]: 'bob' }, 'emails from the answers are kept');
  assert.equal(secrets.cloudflare.accountId, SECRET.account);
  for (const v of [minter, minted, ...Object.values(secrets.GOONBRIDGE_TOKENS), secrets.GOONBRIDGE_GITHUB_WEBHOOK_SECRET]) assert.ok(!r.text.includes(v), 'no value printed');
  noSecrets(r.text, 'mint in setup');
  assert.equal((await stateClean(root)).steps.secrets.status, 'done');
});

test('step 0 and detection: partial answers exit 2 listing exactly the missing fields, and nothing is written', async t => {
  const root = await sandbox(t);
  const r = await runSetup(root, ['--answers', await answersFile(root, { deployment: 'acme', admins: [{ name: 'alice', email: EMAIL.alice }] })]);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /Step 0: checking what you have/);
  assert.match(r.text, /needs-answer\): access, origin$/m);
  assert.match(r.text, /- origin: .*workers\.dev/);
  assert.match(r.text, /- access: .*Cloudflare Access/);
  assert.ok(!await exists(path.join(root, 'deployments/acme')), 'nothing written while answers are missing');
  noSecrets(r.text, 'needs-answer');
  assert.ok(!r.text.includes(DETECT_TOKEN), 'detect token never printed');
});

test('step 0 stops on the first missing prerequisite with its fix, before any question', async t => {
  const root = await sandbox(t);
  const asked = [];
  const r = await runSetup(root, [], { isTTY: true, prompt: async q => { asked.push(q); return ''; }, detector: detector({ loggedIn: false }) });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /✗ wrangler logged in/);
  assert.match(r.text, /Next: run `npx wrangler login`/);
  assert.match(r.text, /Run again when done/);
  assert.deepEqual(asked, [], 'no question before the prerequisites pass');
  const only = await runSetup(root, ['--prereqs'], { detector: detector({ nodeVersion: '20.1.0' }) });
  assert.equal(only.code, 2);
  assert.match(only.text, /✗ Node/);
  const fine = await runSetup(root, ['--prereqs']);
  assert.equal(fine.code, 0, fine.text);
  assert.match(fine.text, /All set/);
});

test('--detect prints JSON with the account masked; detection fills a workers.dev origin; no gh skips GitHub secrets', async t => {
  const root = await sandbox(t);
  const d = await runSetup(root, ['--detect']);
  assert.equal(d.code, 0);
  const report = JSON.parse(d.text);
  assert.equal(report.fields.accountId.source, 'detected');
  assert.ok(!d.text.includes(SECRET.account) && !d.text.includes(DETECT_TOKEN), 'no account ID or token in --detect');

  const r = await runSetup(root, ['--answers', await answersFile(root, { deployment: 'acme', displayName: 'Acme', admins: [{ name: 'alice', email: EMAIL.alice }], origin: 'workers.dev', access: false })],
    { detector: detector({ zones: [], gh: false }) });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /Step 1 of 7: writing the bridge settings/);
  assert.match(r.text, /Result: done/);
  assert.match(r.text, /Step 2 of 7: creating the secrets file/);
  assert.match(r.text, /secrets:mint -- --deployment acme in your own terminal/);
  const config = await read(root, 'deployments/acme/bridge.config.json');
  assert.equal(config.deployment.origin, 'https://acme-bridge.acme-sub.workers.dev');
  assert.equal(config.cloudflare.workersDev, true);
  assert.equal((await read(root, 'deployments/acme/secrets.json')).cloudflare.accountId, SECRET.account);
  await fillSecrets(root, { GOONBRIDGE_TOKENS: { alice: SECRET.alice } });
  const calls = [];
  const resumed = await runSetup(root, ['--deployment', 'acme', '--resume', '--yes'], { run: async (c, args) => { calls.push(c); } });
  assert.match(resumed.text, /^Where setup stands for acme:\n  \[done\] writing the bridge settings/m);
  assert.match(resumed.text, /\[todo\] creating the secrets file/);
  assert.match(resumed.text, /GitHub Actions secrets are skipped/);
  assert.equal(resumed.code, 0, resumed.text);
  assert.ok(calls.includes('npx') && !calls.includes('gh'), 'Worker secrets pushed, no gh call without gh');
  noSecrets(d.text + r.text + resumed.text, 'detect flow');
});

test('--prereqs wraps the whole checklist in show markers, every line included, even when all pass', async t => {
  const root = await sandbox(t);
  const fine = await runSetup(root, ['--prereqs']);
  assert.equal(fine.code, 0, fine.text);
  const lines = fine.text.split('\n');
  const start = lines.indexOf('--- show this ---'), end = lines.indexOf('--- end ---');
  assert.ok(start >= 0 && end > start, `show markers around the checklist:\n${fine.text}`);
  const block = lines.slice(start + 1, end);
  assert.match(block[0], /Step 0: checking what you have/);
  assert.ok(block.filter(l => /^\s+✓ /.test(l)).length >= 3, 'every passing line is in the block, with its tick');
  assert.match(block.at(-1), /All set/);
  const failing = await runSetup(root, ['--prereqs'], { detector: detector({ loggedIn: false }) });
  assert.equal(failing.code, 2);
  assert.match(failing.text, /--- show this ---\n[\s\S]*✗ wrangler logged in[\s\S]*Next: [\s\S]*\n--- end ---/);
});

test('a token pause shows the waiting line and the exact commands inside show markers', async t => {
  const root = await sandbox(t);
  const r = await runSetup(root, ['--answers', await answersFile(root, { deployment: 'acme', displayName: 'Acme', admins: [{ name: 'alice', email: EMAIL.alice }], origin: 'workers.dev', access: false })]);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /--- show this ---\n\s*Result: waiting for the tokens[\s\S]*pnpm secrets:mint -- --deployment acme[\s\S]*https:\/\/dash\.cloudflare\.com\/profile\/api-tokens[\s\S]*--resume\n--- end ---/);
});
