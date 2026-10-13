// bin/setup-detect.mjs: what setup can find out before asking anything, and the step-0 prerequisites checklist.
// Every command and the Cloudflare API are stubbed; the wrangler OAuth token is used for the zone lookup and never printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detect, formatPrereqs, prereqs, publicView, mergeAnswers } from '../bin/setup-detect.mjs';

const hex = n => randomBytes(n).toString('hex');
const ACCOUNT = hex(16), TOKEN = `oauth_${hex(16)}`;

// One stubbed machine. Keys are "command arg arg"; a missing key is a command that is not installed (exit 127).
function machine({ loggedIn = true, accounts = [{ id: ACCOUNT, name: 'Alice Account' }], gh = true, pnpm = true, git = true, zones = ['example.test'], subdomain = 'alice-sub' } = {}) {
  const commands = {
    'npx wrangler whoami --json': loggedIn ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'alice@example.test', accounts }) }
      : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: 'You are not authenticated. Please run `wrangler login`.' },
    'npx wrangler auth token --json': loggedIn ? { code: 0, stdout: JSON.stringify({ type: 'oauth', token: TOKEN }) } : { code: 1, stdout: '' },
    ...(gh ? { 'gh auth status': { code: 0, stdout: 'github.com\n  ✓ Logged in to github.com account alicegh (keyring)\n' } } : {}),
    ...(pnpm ? { 'pnpm --version': { code: 0, stdout: '10.4.1\n' } } : {}),
    ...(git ? { 'git config user.email': { code: 0, stdout: 'alice@example.test\n' }, 'git config user.name': { code: 0, stdout: 'Alice Smith\n' } } : {}),
  };
  const calls = [];
  const run = async (cmd, args) => { const key = [cmd, ...args].join(' '); calls.push(key); return commands[key] ?? { code: 127, stdout: '', stderr: '' }; };
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, auth: new Headers(init.headers).get('Authorization') });
    if (new Headers(init.headers).get('Authorization') !== `Bearer ${TOKEN}`) return Response.json({ success: false }, { status: 403 });
    const u = new URL(url);
    if (u.pathname === '/client/v4/zones') return Response.json({ success: true, result: (zones ?? []).map(name => ({ name, account: { id: ACCOUNT } })) });
    if (u.pathname === `/client/v4/accounts/${ACCOUNT}/workers/subdomain`) return Response.json({ success: true, result: { subdomain } });
    return Response.json({ success: false }, { status: 404 });
  };
  return { run, fetchImpl, calls, requests };
}
async function root(t, deployments = ['example']) {
  const dir = await mkdtemp(path.join(tmpdir(), 'chimera-detect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const d of deployments) await mkdir(path.join(dir, 'deployments', d), { recursive: true });
  return dir;
}

test('logged in: account, zones, git admin and defaults are detected; the token is used but never shown', async t => {
  const m = machine();
  const dir = await root(t, ['example', 'staging']);
  await mkdir(path.join(dir, '.chimera-setup'));
  await writeFile(path.join(dir, '.chimera-setup/old.json'), '{}');
  const r = await detect({ root: dir, run: m.run, fetchImpl: m.fetchImpl, env: {}, nodeVersion: '22.18.0' });
  assert.equal(r.fields.accountId.source, 'detected');
  assert.equal(r.fields.accountId.value, ACCOUNT);
  assert.equal(r.tools.wrangler.value.loggedIn, true);
  assert.equal(r.tools.gh.value.loggedIn, true);
  assert.deepEqual(r.fields.zones.value, ['example.test']);
  assert.equal(r.fields.zones.source, 'detected');
  assert.deepEqual(r.fields.origin.choices, ['https://bridge.example.test', 'workers.dev']);
  assert.equal(r.fields.origin.source, 'needs-answer');
  assert.equal(r.fields.deployment.value, 'alice');
  assert.equal(r.fields.deployment.source, 'default');
  assert.deepEqual(r.fields.admins.value, [{ name: 'alice', email: 'alice@example.test' }]);
  assert.equal(r.fields.admins.source, 'detected');
  assert.equal(r.fields.access.source, 'needs-answer');
  assert.deepEqual(r.fields.existingDeployments.value, ['example', 'staging']);
  assert.deepEqual(r.fields.setupInProgress.value, ['old']);
  assert.equal(r.fields.githubActions.value, true);
  for (const f of Object.values({ ...r.fields, ...r.tools })) {
    assert.ok(['detected', 'default', 'needs-answer'].includes(f.source), JSON.stringify(f));
    assert.equal(typeof f.howToGet, 'string');
    assert.ok(f.howToGet.length > 10);
  }
  assert.ok(m.requests.every(q => q.auth === `Bearer ${TOKEN}`), 'zones read with the wrangler token');
  const printed = JSON.stringify(publicView(r));
  assert.ok(!printed.includes(TOKEN), 'token never in the printed view');
  assert.ok(!printed.includes(ACCOUNT), 'account ID masked in the printed view');
  assert.match(printed, /Alice Account/);
  assert.ok(prereqs(r).every(p => p.status === 'ok' || !p.required));
});

test('logged out: the account is a needs-answer with the exact next step, zones unknown, prereqs stop at wrangler', async t => {
  const m = machine({ loggedIn: false });
  const r = await detect({ root: await root(t), run: m.run, fetchImpl: m.fetchImpl, env: {}, nodeVersion: '22.18.0' });
  assert.equal(r.tools.wrangler.value.loggedIn, false);
  assert.match(r.tools.wrangler.howToGet, /npx wrangler login/);
  assert.equal(r.fields.accountId.source, 'needs-answer');
  assert.match(r.fields.accountId.howToGet, /npx wrangler login/);
  assert.equal(r.fields.zones.source, 'needs-answer');
  assert.equal(r.fields.zones.value, null);
  assert.equal(m.requests.length, 0, 'no API call without a token');
  const text = formatPrereqs(prereqs(r));
  assert.match(text, /✓ Node/);
  assert.match(text, /✓ pnpm/);
  assert.match(text, /✗ wrangler/);
  assert.match(text, /Next: .*npx wrangler login/);
  assert.match(text, /[Rr]un again when done/);
});

test('no zones: workers.dev is the default address and the domain line is optional', async t => {
  const m = machine({ zones: [] });
  const r = await detect({ root: await root(t), run: m.run, fetchImpl: m.fetchImpl, env: {}, nodeVersion: '24.1.0' });
  assert.deepEqual(r.fields.zones.value, []);
  assert.equal(r.fields.zones.source, 'detected');
  assert.deepEqual(r.fields.origin.choices, ['workers.dev']);
  assert.equal(r.fields.origin.value, 'workers.dev');
  assert.equal(r.fields.origin.source, 'default');
  assert.equal(r.workersSubdomain, 'alice-sub');
  const domain = prereqs(r).find(p => p.key === 'domain');
  assert.equal(domain.required, false);
  assert.notEqual(domain.status, 'missing');
  const text = formatPrereqs(prereqs(r));
  assert.match(text, /All set/);
  assert.doesNotMatch(text, /✗/);
});

test('prereqs: all ok lists every line with a tick and starts the questions', async t => {
  const m = machine();
  const r = await detect({ root: await root(t), run: m.run, fetchImpl: m.fetchImpl, env: {}, nodeVersion: '22.18.0' });
  const list = prereqs(r);
  assert.deepEqual(list.map(p => p.key), ['node', 'pnpm', 'cloudflare', 'wrangler', 'gh', 'domain', 'passwords']);
  const text = formatPrereqs(list);
  for (const line of ['✓ Node', '✓ pnpm', '✓ A Cloudflare account', '✓ wrangler', '✓ GitHub', '✓ A domain']) assert.ok(text.includes(line), line);
  assert.match(text, /it runs the bridge/);
  assert.match(text, /password manager/);
  assert.match(text, /All set/);
});

test('prereqs: old or missing node stops first with the download link, and the whole list is still shown', async t => {
  for (const nodeVersion of ['18.19.0', null]) {
    const m = machine({ gh: false });
    const r = await detect({ root: await root(t), run: m.run, fetchImpl: m.fetchImpl, env: {}, nodeVersion });
    const text = formatPrereqs(prereqs(r));
    assert.match(text, /✗ Node/);
    assert.match(text, /Next: .*nodejs\.org.*brew install node/);
    assert.match(text, /✓ pnpm/, 'the rest of the list still shows');
    assert.match(text, /optional/i, 'gh not logged in is optional');
    assert.match(text, /gh auth login/);
    assert.doesNotMatch(text, /All set/);
  }
});

test('mergeAnswers: the answers file wins, detect fills the rest, workers.dev resolves, missing fields are listed', async t => {
  const m = machine();
  const r = await detect({ root: await root(t), run: m.run, fetchImpl: m.fetchImpl, env: {}, nodeVersion: '22.18.0' });
  const partial = mergeAnswers({ displayName: 'Team bridge' }, r);
  assert.deepEqual(partial.missing, ['access', 'origin']);
  assert.equal(partial.answers.displayName, 'Team bridge');
  assert.equal(partial.answers.accountId, ACCOUNT);
  assert.equal(partial.answers.workerName, 'alice-bridge');
  const full = mergeAnswers({ deployment: 'team', origin: 'workers.dev', access: false }, r);
  assert.deepEqual(full.missing, []);
  assert.equal(full.answers.origin, 'https://team-bridge.alice-sub.workers.dev');
  assert.equal(full.answers.workerName, 'team-bridge');
  assert.equal(full.answers.displayName, "Alice's bridge");
  assert.deepEqual(full.answers.members, []);
  const out = await detect({ root: await root(t), run: machine({ loggedIn: false }).run, fetchImpl: m.fetchImpl, env: {}, nodeVersion: '22.18.0' });
  assert.deepEqual(mergeAnswers({ origin: 'https://bridge.example.test', access: true }, out).missing, ['accountId']);
});
