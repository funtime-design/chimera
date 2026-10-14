// pnpm secrets:mint (bin/secrets-mint.mjs), offline: the Cloudflare API is an injected fetch, input comes from env or a
// stubbed prompt. The no-print contract: no minter, minted, generated or externally-issued value appears in anything
// printed, on success or on any failure path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintSecrets } from '../bin/secrets-mint.mjs';
import { configFrom, secretsFrom } from '../bin/setup.mjs';
import { engineTemplate, identityOf } from '../bin/deployment.mjs';
import { pushSecrets } from '../bin/secrets-push.mjs';

const hex = n => randomBytes(n).toString('hex');
const SECRET = { minter: `minter_${hex(16)}`, minted: `minted_${hex(16)}`, account: hex(16), access: `access_${hex(12)}`, pat: `pat_${hex(12)}` };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const answers = (extra = {}) => ({ deployment: 'acme', displayName: 'Acme', origin: 'https://bridge.example.test', accountId: SECRET.account, workerName: 'acme-bridge',
  admins: [{ name: 'alice', email: 'alice@example.test' }], members: [{ name: 'bob', email: 'bob@example.test' }], access: false, ...extra });

async function sandbox(t, a = answers()) {
  const root = await mkdtemp(path.join(tmpdir(), 'chimera-mint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n');
  const dir = path.join(root, 'deployments/acme');
  await mkdir(dir, { recursive: true });
  const config = await configFrom(a);
  await writeFile(path.join(dir, 'bridge.config.json'), JSON.stringify(config));
  await writeFile(path.join(dir, 'deployment.lock.json'), JSON.stringify(identityOf(config, await engineTemplate())));
  return root;
}
// Fake Cloudflare API. Echoes the presented credential in error bodies so a leak would show.
function cloudflare({ refuseWorkerScope = false, fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', auth: init.headers?.Authorization, body: init.body && JSON.parse(init.body) });
    if (fail === 'throw') throw new Error(`network down ${SECRET.minter}`);
    if (init.headers?.Authorization !== `Bearer ${SECRET.minter}` || fail === 'rejected') return Response.json({ success: false, errors: [{ message: `bad token ${init.headers?.Authorization}` }] }, { status: 403 });
    const p = new URL(url).pathname;
    if (p === `/client/v4/accounts/${SECRET.account}/tokens/permission_groups`) {
      if (fail === 'groups') return Response.json({ success: false, errors: [{ message: `oops ${SECRET.minter}` }] }, { status: 500 });
      return Response.json({ success: true, result: [{ id: 'pg-other', name: 'Zone Read' }, { id: 'pg-editor', name: 'Workers Editor' }] });
    }
    if (p === `/client/v4/accounts/${SECRET.account}/tokens` && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const scoped = JSON.stringify(body.policies[0].resources).includes('worker.script');
      if (fail === 'mint' || (scoped && refuseWorkerScope)) return Response.json({ success: false, errors: [{ message: 'nope' }] }, { status: 400 });
      return Response.json({ success: true, result: { id: 'tok1', value: SECRET.minted } });
    }
    return Response.json({ success: false }, { status: 404 });
  };
  return { fetchImpl, calls };
}
async function run(root, argv, options = {}) {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '));
  try {
    const code = await mintSecrets({ root, argv: ['--deployment', 'acme', ...argv], isTTY: false, fetchImpl: cloudflare().fetchImpl,
      env: { CHIMERA_TOKEN_MINTER: SECRET.minter, CLOUDFLARE_ACCOUNT_ID: SECRET.account }, out: l => lines.push(l), err: l => lines.push(l), ...options });
    return { code, text: lines.join('\n') };
  } finally { Object.assign(console, original); }
}
const file = root => path.join(root, 'deployments/acme/secrets.json');
const read = async root => JSON.parse(await readFile(file(root), 'utf8'));
const exists = p => access(p).then(() => true, () => false);
function noLeak(text, where, extra = []) {
  for (const [name, value] of Object.entries(SECRET)) if (name !== 'account' || !where.includes('allow-account')) assert.ok(!text.includes(value), `${where}: ${name} printed`);
  for (const value of extra) assert.ok(!text.includes(value), `${where}: generated value printed`);
}
const generatedValues = s => [...Object.values(s.GOONBRIDGE_TOKENS ?? {}), s.GOONBRIDGE_GITHUB_WEBHOOK_SECRET, s.CLOUDFLARE_API_TOKEN].filter(Boolean);

test('mints the deploy token, generates member tokens and writes a 0600 secrets.json without printing a value', async t => {
  const root = await sandbox(t);
  const cf = cloudflare();
  const before = Date.now();
  const emails = { 'alice@example.test': 'alice', 'bob@example.test': 'bob' };
  const { code, text } = await run(root, [], { fetchImpl: cf.fetchImpl,
    env: { CHIMERA_TOKEN_MINTER: SECRET.minter, CLOUDFLARE_ACCOUNT_ID: SECRET.account, GOONBRIDGE_MEMBERS: JSON.stringify(emails) } });
  assert.equal(code, 0, text);
  const s = await read(root);
  assert.deepEqual(s.GOONBRIDGE_MEMBERS, emails, 'a JSON external from env');
  assert.deepEqual(Object.keys(s.GOONBRIDGE_TOKENS).sort(), ['alice', 'bob'], 'one token per member');
  for (const v of Object.values(s.GOONBRIDGE_TOKENS)) assert.match(v, TOKEN, '32 random bytes, base64url');
  assert.equal(new Set(Object.values(s.GOONBRIDGE_TOKENS)).size, 2, 'tokens are unique');
  assert.match(s.GOONBRIDGE_GITHUB_WEBHOOK_SECRET, TOKEN);
  assert.equal(s.contractToken, 'alice', 'first admin');
  assert.equal(s.CLOUDFLARE_API_TOKEN, SECRET.minted);
  assert.equal(s.cloudflare.accountId, SECRET.account);
  assert.equal((await stat(file(root))).mode & 0o777, 0o600);
  for (const key of ['ACCESS_CLIENT_SECRET', 'GOONBRIDGE_ROUTINES', 'GITHUB_CONFIG_PAT']) assert.ok(!(key in s), `${key} skipped, nothing written`);
  // The token request: Workers Editor, scoped to this Worker, 90 days, named after the Worker.
  const post = cf.calls.find(c => c.method === 'POST');
  assert.equal(post.auth, `Bearer ${SECRET.minter}`);
  assert.equal(post.body.name, 'github-actions-acme-bridge-deploy');
  assert.deepEqual(post.body.policies[0].permission_groups, [{ id: 'pg-editor' }]);
  assert.deepEqual(post.body.policies[0].resources, { [`com.cloudflare.api.account.${SECRET.account}`]: { 'com.cloudflare.edge.worker.script.acme-bridge': '*' } });
  const days = (Date.parse(post.body.expires_on) - before) / 86400000;
  assert.ok(days > 89.9 && days < 90.1, 'expires in 90 days');
  assert.match(text, new RegExp(`az keyvault secret set-attributes --vault-name <vault> --name CLOUDFLARE_API_TOKEN --expires ${post.body.expires_on}`));
  assert.match(text, /GOONBRIDGE_TOKENS.*generated/);
  assert.match(text, /CLOUDFLARE_API_TOKEN.*minted/);
  assert.match(text, /ACCESS_CLIENT_SECRET.*skipped/);
  noLeak(text, 'success', generatedValues(s));
  // secrets:push accepts a file without the optional keys.
  const pushed = [];
  await pushSecrets({ root, deployment: 'acme', dryRun: true, log: l => pushed.push(l) });
  assert.ok(pushed.some(l => /BRIDGE_CONTRACT_TOKEN/.test(l)));
});

test('falls back to an account-scoped token when the per-Worker scope is refused', async t => {
  const root = await sandbox(t);
  const cf = cloudflare({ refuseWorkerScope: true });
  const { code, text } = await run(root, [], { fetchImpl: cf.fetchImpl });
  assert.equal(code, 0, text);
  const posts = cf.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body.policies[0].resources, { [`com.cloudflare.api.account.${SECRET.account}`]: '*' });
  assert.match(text, /whole account/);
});

test('externally-issued values come from env when given, are skipped otherwise, and the config decides what is required', async t => {
  const root = await sandbox(t, answers({ access: true }));
  const { code, text } = await run(root, [], { env: { CHIMERA_TOKEN_MINTER: SECRET.minter, CLOUDFLARE_ACCOUNT_ID: SECRET.account, ACCESS_CLIENT_SECRET: SECRET.access } });
  assert.equal(code, 0, text);
  const s = await read(root);
  assert.equal(s.ACCESS_CLIENT_SECRET, SECRET.access);
  assert.ok(!('GITHUB_CONFIG_PAT' in s));
  noLeak(text, 'externals', generatedValues(s));

  const root2 = await sandbox(t, answers({ access: true }));
  const second = await run(root2, []);
  assert.equal(second.code, 0, 'skipping a required external still writes the rest');
  assert.match(second.text, /ACCESS_CLIENT_SECRET.*skipped/);
  assert.match(second.text, /secrets:push will refuse/);
  noLeak(second.text, 'required skipped', generatedValues(await read(root2)));
});

test('--dry-run prints the plan, needs no minter, calls nothing and writes nothing', async t => {
  const root = await sandbox(t);
  const cf = cloudflare();
  const { code, text } = await run(root, ['--dry-run'], { fetchImpl: cf.fetchImpl, env: { CLOUDFLARE_ACCOUNT_ID: SECRET.account } });
  assert.equal(code, 0, text);
  assert.equal(cf.calls.length, 0);
  assert.equal(await exists(file(root)), false);
  for (const line of [/GOONBRIDGE_TOKENS.*generated/, /CLOUDFLARE_API_TOKEN.*minted/, /cloudflare\.accountId.*env/, /contractToken.*generated/, /GITHUB_CONFIG_PAT.*skipped/]) assert.match(text, line);
  noLeak(text, 'dry run');
});

test('a re-run rotates generated values only with --yes, keeps external values unless --rotate-all', async t => {
  const root = await sandbox(t, answers({ access: true }));
  const env = { CHIMERA_TOKEN_MINTER: SECRET.minter, CLOUDFLARE_ACCOUNT_ID: SECRET.account, ACCESS_CLIENT_SECRET: SECRET.access };
  assert.equal((await run(root, [], { env })).code, 0);
  const first = await read(root), firstText = await readFile(file(root), 'utf8');

  const refused = await run(root, [], { env });
  assert.equal(refused.code, 2, 'waits for --yes');
  assert.match(refused.text, /--yes/);
  assert.equal(await readFile(file(root), 'utf8'), firstText, 'unchanged without --yes');

  const newer = `access_${hex(12)}`;
  const rotated = await run(root, ['--yes'], { env: { ...env, ACCESS_CLIENT_SECRET: newer } });
  assert.equal(rotated.code, 0, rotated.text);
  const second = await read(root);
  for (const m of ['alice', 'bob']) assert.notEqual(second.GOONBRIDGE_TOKENS[m], first.GOONBRIDGE_TOKENS[m], 'member tokens rotated');
  assert.notEqual(second.GOONBRIDGE_GITHUB_WEBHOOK_SECRET, first.GOONBRIDGE_GITHUB_WEBHOOK_SECRET);
  assert.equal(second.ACCESS_CLIENT_SECRET, SECRET.access, 'external value kept');
  assert.match(rotated.text, /ACCESS_CLIENT_SECRET.*kept/);
  assert.match(rotated.text, /revoke/i, 'reminds to revoke the previous deploy token');
  noLeak(rotated.text, 'rotate', [...generatedValues(first), ...generatedValues(second), newer]);

  const all = await run(root, ['--yes', '--rotate-all'], { env: { ...env, ACCESS_CLIENT_SECRET: newer } });
  assert.equal(all.code, 0, all.text);
  assert.equal((await read(root)).ACCESS_CLIENT_SECRET, newer, '--rotate-all replaces external values');
  noLeak(all.text, 'rotate-all', [newer]);
});

test('placeholders from pnpm run setup are filled without asking to rotate; emails and account ID are kept', async t => {
  const root = await sandbox(t);
  await writeFile(file(root), JSON.stringify({ $schema: '../../config/secrets.schema.json', GOONBRIDGE_TOKENS: { alice: 'REPLACE_ME_random_24_plus_characters', bob: 'REPLACE_ME_random_24_plus_characters' },
    GOONBRIDGE_MEMBERS: { 'alice@example.test': 'alice', 'bob@example.test': 'bob' }, cloudflare: { accountId: SECRET.account }, CLOUDFLARE_API_TOKEN: 'REPLACE_ME_cloudflare_deploy_token', contractToken: 'alice' }));
  const { code, text } = await run(root, [], { env: { CHIMERA_TOKEN_MINTER: SECRET.minter } });
  assert.equal(code, 0, text);
  const s = await read(root);
  assert.match(s.GOONBRIDGE_TOKENS.alice, TOKEN);
  assert.deepEqual(s.GOONBRIDGE_MEMBERS, { 'alice@example.test': 'alice', 'bob@example.test': 'bob' });
  assert.equal(s.cloudflare.accountId, SECRET.account);
  assert.ok(!text.includes('alice@example.test'));
});

test('on a terminal every value is asked masked, a bad value is asked again, and Enter skips an external', async t => {
  const root = await sandbox(t, answers({ access: true }));
  const asked = [];
  const replies = { 'cloudflare.accountId': ['not-hex', SECRET.account], ACCESS_CLIENT_SECRET: [''], minter: [SECRET.minter] };
  const ask = async (prompt, { mask = false } = {}) => {
    asked.push({ prompt, mask });
    const key = Object.keys(replies).find(k => prompt.includes(k)) ?? (/minter/i.test(prompt) ? 'minter' : null);
    if (key) return replies[key].shift() ?? '';
    return /\[y\/N\]/.test(prompt) ? 'n' : '';
  };
  const { code, text } = await run(root, [], { isTTY: true, ask, env: {} });
  assert.equal(code, 0, text);
  for (const a of asked.filter(a => /accountId|ACCESS_CLIENT_SECRET|minter/i.test(a.prompt))) assert.equal(a.mask, true, `${a.prompt} must be masked`);
  assert.equal(asked.filter(a => a.prompt.includes('cloudflare.accountId')).length, 2, 'asked again after a bad value');
  assert.match(text, /32 hex/);
  const s = await read(root);
  assert.ok(!('ACCESS_CLIENT_SECRET' in s), 'Enter skips');
  noLeak(text, 'tty', generatedValues(s));
});

test('refuses a tracked or unignored secrets.json before calling Cloudflare', async t => {
  const root = await sandbox(t);
  await writeFile(file(root), '{}');
  execFileSync('git', ['add', '-f', 'deployments/acme/secrets.json'], { cwd: root });
  const cf = cloudflare();
  const tracked = await run(root, [], { fetchImpl: cf.fetchImpl });
  assert.equal(tracked.code, 1);
  assert.match(tracked.text, /tracked/);
  execFileSync('git', ['rm', '--cached', '-q', '-f', 'deployments/acme/secrets.json'], { cwd: root });
  await rm(file(root));
  await writeFile(path.join(root, '.gitignore'), '');
  const unignored = await run(root, [], { fetchImpl: cf.fetchImpl });
  assert.equal(unignored.code, 1);
  assert.match(unignored.text, /gitignored/);
  assert.equal(cf.calls.length, 0);
  assert.equal(await exists(file(root)), false);
  noLeak(tracked.text + unignored.text, 'refusal');
});

test('no value is printed on any failure path, and nothing is written', async t => {
  const cases = [
    ['minter rejected', { fetchImpl: cloudflare({ fail: 'rejected' }).fetchImpl }, /minter/],
    ['wrong minter', { env: { CHIMERA_TOKEN_MINTER: `wrong_${hex(8)}`, CLOUDFLARE_ACCOUNT_ID: SECRET.account } }, /minter/],
    ['network error', { fetchImpl: cloudflare({ fail: 'throw' }).fetchImpl }, /request failed/],
    ['permission groups error', { fetchImpl: cloudflare({ fail: 'groups' }).fetchImpl }, /permission groups/],
    ['mint refused', { fetchImpl: cloudflare({ fail: 'mint' }).fetchImpl }, /refused/],
    ['no minter', { env: { CLOUDFLARE_ACCOUNT_ID: SECRET.account } }, /CHIMERA_TOKEN_MINTER/],
    ['bad account id', { env: { CHIMERA_TOKEN_MINTER: SECRET.minter, CLOUDFLARE_ACCOUNT_ID: `${SECRET.access}zz` } }, /CLOUDFLARE_ACCOUNT_ID/],
    ['bad external JSON', { env: { CHIMERA_TOKEN_MINTER: SECRET.minter, CLOUDFLARE_ACCOUNT_ID: SECRET.account, GOONBRIDGE_ROUTINES: `{"x": "${SECRET.pat}` } }, /GOONBRIDGE_ROUTINES.*JSON/],
  ];
  for (const [name, options, why] of cases) {
    const root = await sandbox(t);
    const { code, text } = await run(root, [], options);
    assert.notEqual(code, 0, name);
    assert.match(text, why, name);
    noLeak(text, name);
    assert.equal(await exists(file(root)), false, `${name}: nothing written`);
  }
  const root = await sandbox(t);
  await writeFile(path.join(root, 'deployments/acme/bridge.config.json'), `{ "broken": "${SECRET.pat}`);
  const bad = await run(root, []);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /invalid/);
  noLeak(bad.text, 'bad config');
});

// A real run asked for ACCESS_CLIENT_SECRET before anything else. The order is: a short plan, the minter (masked, with
// one line saying what it is), the minted deploy token, the generated names, and only then the values issued elsewhere.
async function ordered(t, a) {
  const root = await sandbox(t, a);
  await writeFile(file(root), JSON.stringify(secretsFrom(a)));
  const events = [];
  const ask = async (prompt, { mask = false } = {}) => {
    events.push(`ASK${mask ? '*' : ''} ${prompt.trim()}`);
    return /minter/i.test(prompt) ? SECRET.minter : '';
  };
  const { code, text } = await run(root, [], { isTTY: true, ask, env: {}, out: l => events.push(l), err: l => events.push(l) });
  return { code, text: events.join('\n'), events, root };
}
const at = (events, re) => { const i = events.findIndex(e => re.test(e)); assert.ok(i >= 0, `missing ${re}:\n${events.join('\n')}`); return i; };

test('on a terminal: plan, then the minter, then minted and generated names, and only then external values', async t => {
  const { code, events, text, root } = await ordered(t, answers({ access: true }));
  assert.equal(code, 0, text);
  const plan = at(events, /^Will mint: CLOUDFLARE_API_TOKEN.*generate: GOONBRIDGE_TOKENS.*GOONBRIDGE_GITHUB_WEBHOOK_SECRET.*ask for: ACCESS_CLIENT_SECRET/);
  const what = at(events, /^The minter is/);
  const minter = at(events, /^ASK\* Minter token/);
  const minted = at(events, /^minted CLOUDFLARE_API_TOKEN \(90 days\)$/);
  const alice = at(events, /^generated GOONBRIDGE_TOKENS\.alice$/), bob = at(events, /^generated GOONBRIDGE_TOKENS\.bob$/);
  const hook = at(events, /^generated GOONBRIDGE_GITHUB_WEBHOOK_SECRET$/);
  const where = at(events, /^ACCESS_CLIENT_SECRET: .*\S/);
  const external = at(events, /^ASK\* ACCESS_CLIENT_SECRET/);
  assert.equal(events.findIndex(e => e.startsWith('ASK')), minter, 'the minter is the first prompt');
  for (const [a, b, why] of [[plan, what, 'plan first'], [what, minter, 'what the minter is, then its prompt'], [minter, minted, 'minter before minting'],
    [minted, alice, 'minted before generated'], [alice, bob, 'members in order'], [bob, hook, 'webhook after members'], [hook, where, 'generated before externals'], [where, external, 'where it comes from, then the prompt']]) assert.ok(a < b, why);
  assert.match(events[external], /Enter skips/);
  noLeak(text, 'ordered', generatedValues(await read(root)));
});

test('Access off: secrets:mint never mentions or asks for ACCESS_CLIENT_SECRET', async t => {
  const { code, events, text } = await ordered(t, answers({ access: false }));
  assert.equal(code, 0, text);
  assert.ok(!events.some(e => /^ASK.*ACCESS_CLIENT_SECRET/.test(e)), 'no Access prompt');
  assert.doesNotMatch(events[at(events, /^Will mint:/)], /ACCESS_CLIENT_SECRET/);
  assert.doesNotMatch(text, /ACCESS_CLIENT_SECRET.*this deployment uses it/);
});
