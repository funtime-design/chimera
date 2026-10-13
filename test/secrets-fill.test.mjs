// pnpm secrets:fill (bin/secrets-fill.mjs): enter values a person already holds. Run as a child process with --from-env,
// so the real CLI path is exercised. No injected value may appear in stdout or stderr on success or any failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFrom } from '../bin/setup.mjs';
import { engineTemplate, identityOf } from '../bin/deployment.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hex = n => randomBytes(n).toString('hex');
const V = { alice: `tok_alice_${hex(16)}`, bob: `tok_bob_${hex(16)}`, deploy: `cf_${hex(16)}`, account: hex(16) };
const answers = { deployment: 'acme', displayName: 'Acme', origin: 'https://bridge.example.test', accountId: V.account, workerName: 'acme-bridge',
  admins: [{ name: 'alice', email: 'alice@example.test' }], members: [{ name: 'bob', email: 'bob@example.test' }], access: false };

// A throwaway copy of the engine's tools in its own git repo, so the CLI's projectRoot is the sandbox.
async function sandbox(t) {
  // realpath: the CLI's isMain compares against the resolved path (/var vs /private/var on macOS).
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'chimera-fill-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\nnode_modules\n');
  for (const dir of ['bin', 'src', 'config', 'deployments/example']) await cp(path.join(repo, dir), path.join(root, dir), { recursive: true });
  await cp(path.join(repo, 'package.json'), path.join(root, 'package.json'));
  await symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  const config = await configFrom(answers);
  await mkdir(path.join(root, 'deployments/acme'), { recursive: true });
  await writeFile(path.join(root, 'deployments/acme/bridge.config.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'deployments/acme/deployment.lock.json'), JSON.stringify(identityOf(config, await engineTemplate())));
  return root;
}
const fill = (root, env, args = []) => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin/secrets-fill.mjs'), '--deployment', 'acme', '--from-env', ...args],
    { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });
  return { code: r.status, text: `${r.stdout}\n${r.stderr}` };
};
const file = root => path.join(root, 'deployments/acme/secrets.json');
const exists = p => access(p).then(() => true, () => false);
const good = () => ({ GOONBRIDGE_TOKENS: JSON.stringify({ alice: V.alice, bob: V.bob }), CLOUDFLARE_ACCOUNT_ID: V.account, CLOUDFLARE_API_TOKEN: V.deploy, contractToken: 'alice' });
function noLeak(text, where, extra = []) {
  for (const value of [...Object.values(V), ...extra]) assert.ok(!text.includes(value), `${where}: a value was printed`);
}

test('--from-env writes a 0600 secrets.json and prints key names only', async t => {
  const root = await sandbox(t);
  const { code, text } = fill(root, good());
  assert.equal(code, 0, text);
  const s = JSON.parse(await readFile(file(root), 'utf8'));
  assert.deepEqual(s.GOONBRIDGE_TOKENS, { alice: V.alice, bob: V.bob });
  assert.equal(s.cloudflare.accountId, V.account);
  assert.equal(s.CLOUDFLARE_API_TOKEN, V.deploy);
  assert.equal(s.contractToken, 'alice');
  assert.equal((await stat(file(root))).mode & 0o777, 0o600);
  assert.match(text, /set: .*GOONBRIDGE_TOKENS/);
  assert.match(text, /Cloudflare dashboard/, 'explains where a value comes from');
  noLeak(text, 'success');
});

test('values already in secrets.json are kept when the env does not give them; --only limits the keys', async t => {
  const root = await sandbox(t);
  assert.equal(fill(root, good()).code, 0);
  const newer = `cf_${hex(16)}`;
  const { code, text } = fill(root, { CLOUDFLARE_API_TOKEN: newer }, ['--only', 'CLOUDFLARE_API_TOKEN']);
  assert.equal(code, 0, text);
  const s = JSON.parse(await readFile(file(root), 'utf8'));
  assert.equal(s.CLOUDFLARE_API_TOKEN, newer);
  assert.deepEqual(s.GOONBRIDGE_TOKENS, { alice: V.alice, bob: V.bob });
  assert.match(text, /skipped: .*GOONBRIDGE_TOKENS/);
  const kept = fill(root, {});
  assert.equal(kept.code, 0, kept.text);
  assert.match(kept.text, /kept: .*CLOUDFLARE_API_TOKEN/);
  noLeak(text + kept.text, 'keep', [newer]);
});

test('a bad value fails with a clear message, writes nothing, and is never echoed', async t => {
  const cases = [
    ['invalid JSON', { GOONBRIDGE_TOKENS: `{"alice": "${V.alice}` }, /GOONBRIDGE_TOKENS.*JSON/],
    ['short token', { GOONBRIDGE_TOKENS: JSON.stringify({ alice: 'short', bob: V.bob }) }, /24/],
    ['bad account', { CLOUDFLARE_ACCOUNT_ID: `${V.deploy}` }, /CLOUDFLARE_ACCOUNT_ID/],
    ['token as contractToken', { contractToken: V.alice }, /member NAME/],
    ['empty deploy token', { CLOUDFLARE_API_TOKEN: ' ' }, /CLOUDFLARE_API_TOKEN/],
  ];
  for (const [name, bad, why] of cases) {
    const root = await sandbox(t);
    const { code, text } = fill(root, { ...good(), ...bad });
    assert.notEqual(code, 0, name);
    assert.match(text, why, name);
    noLeak(text, name);
    assert.equal(await exists(file(root)), false, `${name}: nothing written`);
  }
});

test('refuses a tracked or unignored secrets.json', async t => {
  const root = await sandbox(t);
  await writeFile(file(root), '{}');
  execFileSync('git', ['add', '-f', 'deployments/acme/secrets.json'], { cwd: root });
  const tracked = fill(root, good());
  assert.equal(tracked.code, 1);
  assert.match(tracked.text, /tracked/);
  execFileSync('git', ['rm', '--cached', '-q', '-f', 'deployments/acme/secrets.json'], { cwd: root });
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
  const unignored = fill(root, good());
  assert.equal(unignored.code, 1);
  assert.match(unignored.text, /gitignored/);
  assert.equal(await readFile(file(root), 'utf8'), '{}');
  noLeak(tracked.text + unignored.text, 'refusal');
});
