import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadModule } from './hub-memory.mjs';
import { baselineDeployments, baselineUrl, presentDeployments, skipUnless, brandingPattern } from './harness/baselines.mjs';

const read = async p => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), 'utf8'));
const config = () => read('deployments/example/bridge.config.json');
const secrets = () => read('deployments/example/secrets.example.json');
const api = () => import('../bin/deployment.mjs');

async function repo(t) {
  const base = path.resolve('.chimera-test'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'stage4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(path.join(root, 'deployments/example'), { recursive: true });
  for (const file of ['bridge.config.json', 'deployment.lock.json']) await writeFile(path.join(root, 'deployments/example', file), JSON.stringify(await read(`deployments/example/${file}`)));
  await writeFile(path.join(root, 'deployments/example/secrets.json'), JSON.stringify(await secrets()));
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n.generated/\n');
  return root;
}

test('secrets schema validates allowed keys, pairs and every configured SecretRef without leaking values', async () => {
  const { validateSecrets, runtimeSecrets } = await loadModule('src/config/secrets-schema.ts');
  const c = await config(), s = await secrets();
  validateSecrets(s, c);
  const runtime = runtimeSecrets(s, c);
  assert.equal(JSON.parse(runtime.GOONBRIDGE_TOKENS)[s.GOONBRIDGE_TOKENS.alice], 'alice');
  assert.equal(runtime.CHIMERA_TOKENS, runtime.GOONBRIDGE_TOKENS);
  assert.equal(runtime.EXAMPLE_ALICE_TRIGGER, s.GOONBRIDGE_ROUTINES.alice.trigger);
  for (const change of [
    s => { s.surprise = 'sensitive-sentinel'; },
    s => { delete s.ACCESS_CLIENT_SECRET; },
    s => { delete s.GOONBRIDGE_ROUTINE_REVIEW_TOKEN; },
    s => { s.GOONBRIDGE_TOKENS.alice = 'short'; },
    s => { s.GOONBRIDGE_MEMBERS = { 'sensitive-sentinel': 'alice' }; },
    s => { s.cloudflare.accountId = 'sensitive-sentinel'; },
  ]) {
    const bad = structuredClone(s); change(bad);
    assert.throws(() => validateSecrets(bad, c), e => !e.message.includes('sensitive-sentinel'));
  }
  const bad = structuredClone(c); bad.access.clientSecret.env = 'UNSATISFIABLE';
  // Configured aliases of known slots are supported, arbitrary unprovided routine refs are not.
  bad.cloud.routines.bob = { trigger: { env: 'MISSING_TRIGGER' }, token: { env: 'MISSING_TOKEN' } };
  assert.throws(() => validateSecrets(s, bad), /reference|member/);
});

test('secrets push refuses missing, unignored and tracked files before external commands', async t => {
  const { pushSecrets } = await import('../bin/secrets-push.mjs');
  const root = await repo(t), file = path.join(root, 'deployments/example/secrets.json');
  const run = () => assert.fail('external command called');
  await writeFile(path.join(root, '.gitignore'), '');
  await assert.rejects(pushSecrets({ root, deployment: 'example', run }), /ignored/);
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n');
  execFileSync('git', ['add', '-f', 'deployments/example/secrets.json'], { cwd: root });
  await assert.rejects(pushSecrets({ root, deployment: 'example', run }), /tracked/);
  execFileSync('git', ['rm', '--cached', '-f', 'deployments/example/secrets.json'], { cwd: root });
  await rm(file);
  await assert.rejects(pushSecrets({ root, deployment: 'example', run }), /missing/);
});

test('dry run prints only names/actions; real run injects wrangler and gh stdin, never secret argv', async t => {
  const { pushSecrets } = await import('../bin/secrets-push.mjs');
  const root = await repo(t), lines = [], calls = [];
  const run = async (command, args, options) => calls.push({ command, args, ...options });
  await pushSecrets({ root, deployment: 'example', dryRun: true, run, log: line => lines.push(line) });
  assert.equal(calls.length, 0);
  assert.match(lines.join('\n'), /GOONBRIDGE_TOKENS/);
  assert.match(lines.join('\n'), /CLOUDFLARE_ACCOUNT_ID/);
  await pushSecrets({ root, deployment: 'example', run, log: line => lines.push(line) });
  const s = await secrets();
  assert.deepEqual(calls.filter(c => c.command === 'gh').map(c => c.args), [['secret', 'set', 'BRIDGE_CONTRACT_TOKEN'], ['secret', 'set', 'CLOUDFLARE_ACCOUNT_ID'], ['secret', 'set', 'CLOUDFLARE_API_TOKEN']]);
  assert.equal(calls.find(c => c.args.includes('BRIDGE_CONTRACT_TOKEN')).input, s.GOONBRIDGE_TOKENS[s.contractToken]);
  const tokenCall = calls.find(c => c.args.includes('GOONBRIDGE_TOKENS'));
  assert.deepEqual(tokenCall.args, ['wrangler', 'secret', 'put', 'GOONBRIDGE_TOKENS', '--name', 'example-bridge']);
  assert.equal(tokenCall.env.CLOUDFLARE_ACCOUNT_ID, s.cloudflare.accountId);
  assert.equal(tokenCall.env.CLOUDFLARE_API_TOKEN, s.CLOUDFLARE_API_TOKEN);
  assert.equal(JSON.parse(tokenCall.input)[s.GOONBRIDGE_TOKENS.alice], 'alice');
  assert.equal(calls.find(c => c.args.includes('CLOUDFLARE_API_TOKEN')).input, s.CLOUDFLARE_API_TOKEN);
  assert.doesNotMatch(JSON.stringify(lines) + JSON.stringify(calls.map(c => c.args)), /FAKE_|alice@example.com/);
  await assert.rejects(pushSecrets({ root, deployment: 'example', run: async () => { throw new Error('sensitive-sentinel'); }, log: () => {} }), e => !e.message.includes('sensitive-sentinel'));
});

// Owner-mode baseline: each deployment folder with a frozen private Wrangler capture (.private/fixtures/<id>/wrangler.json).
const wranglerBaselines = baselineDeployments('wrangler.json');
test('deployment generator matches its deployed baseline except env account ID, deterministically', { skip: skipUnless(wranglerBaselines, 'wrangler.json') }, async () => {
  const { generateWrangler } = await import('../bin/gen-wrangler.mjs');
  const { loadDeployment } = await api();
  for (const id of wranglerBaselines) {
    const input = await loadDeployment({ deployment: id });
    const accountId = '0'.repeat(32);
    const result = generateWrangler({ ...input, accountId });
    // Frozen from the deployed engine; account ID omitted so a fresh public history can run this test.
    const baseline = JSON.parse(await readFile(baselineUrl(id, 'wrangler.json'), 'utf8'));
    baseline.account_id = accountId;
    assert.deepEqual(result, baseline);
    assert.equal(JSON.stringify(result), JSON.stringify(generateWrangler({ ...input, accountId })));
    assert.throws(() => generateWrangler({ ...input, accountId: undefined }), /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(input.config.deployment.id, id);
    assert.equal(input.config.cloudflare.accountId, undefined);
  }
});

test('identity lock refuses every changed identity and accepts an explicitly updated lock', async () => {
  const { identityOf, validateLock, loadDeployment } = await api();
  for (const id of presentDeployments()) await loadDeployment({ deployment: id });
  const input = await loadDeployment({ deployment: 'example' });
  for (const mutate of [
    c => c.cloudflare.workerName = 'different', c => c.deployment.origin = 'https://different.example.com',
    c => c.identity.hubClass = 'Other', c => c.identity.hubBinding = 'OTHER', c => c.identity.hubKey = 'other',
    c => c.cloudflare.oauthKvId = '1'.repeat(32),
  ]) {
    const c = structuredClone(input.config); mutate(c);
    assert.throws(() => validateLock(c, input.lock, input.template), /lock/);
  }
  for (const mutate of [t => t.migrations.push({ tag: 'v2', new_classes: [] }), t => t.kv_namespaces[0].binding = 'OTHER', t => t.migrations[0].new_sqlite_classes = ['Other']]) {
    const template = structuredClone(input.template); mutate(template);
    assert.throws(() => validateLock(input.config, input.lock, template), /lock/);
  }
  const changed = structuredClone(input.config); changed.cloudflare.workerName = 'example';
  assert.doesNotThrow(() => validateLock(changed, identityOf(changed, input.template), input.template));
  await assert.rejects(api().then(({ loadDeployment }) => loadDeployment({ deployment: '../escape' })), /deployment/);
});

test('committed configurations reject account IDs and email maps', async () => {
  const { validateConfig } = await loadModule('src/config/schema.ts');
  const c = await config();
  assert.throws(() => validateConfig({ ...c, cloudflare: { ...c.cloudflare, accountId: '0'.repeat(32) } }), /unknown/);
  assert.throws(() => validateConfig({ ...c, auth: { ...c.auth, memberEmails: { 'alice@example.com': 'alice' } } }), /memberEmails/);
});

test('generator selects the deployment import and refuses drift before writing either output', async t => {
  const { writeWrangler } = await import('../bin/gen-wrangler.mjs');
  const root = await repo(t);
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  const options = { root, deployment: 'example', accountId: '0'.repeat(32) };
  await writeWrangler(options);
  const wrangler = await readFile(path.join(root, '.generated/wrangler.example.jsonc'), 'utf8');
  const selected = await readFile(path.join(root, 'src/config/deployment.ts'), 'utf8');
  assert.match(selected, /deployments\/example\/bridge.config.json/);
  assert.equal(JSON.parse(wrangler).name, 'example-bridge');
  await writeWrangler(options);
  assert.equal(await readFile(path.join(root, '.generated/wrangler.example.jsonc'), 'utf8'), wrangler);
  const c = await config(); c.deployment.origin = 'https://changed.example.com';
  await writeFile(path.join(root, 'deployments/example/bridge.config.json'), JSON.stringify(c));
  await assert.rejects(writeWrangler(options), /lock/);
  assert.equal(await readFile(path.join(root, '.generated/wrangler.example.jsonc'), 'utf8'), wrangler);
  assert.equal(await readFile(path.join(root, 'src/config/deployment.ts'), 'utf8'), selected);
});

// Owner-mode baseline: every deployment with a private deployed baseline keeps SecretRefs the example secrets file
// satisfies. The example's own refs are covered above.
test('owner SecretRefs are all satisfiable and secret diagnostics redact object keys', { skip: skipUnless(wranglerBaselines, 'wrangler.json') }, async () => {
  const { validateSecrets, runtimeSecrets } = await loadModule('src/config/secrets-schema.ts');
  for (const id of wranglerBaselines) {
    const c = await read(`deployments/${id}/bridge.config.json`), s = await secrets();
    validateSecrets(s, c);
    const runtime = runtimeSecrets(s, c);
    assert.equal(runtime.ACCESS_CLIENT_SECRET, s.ACCESS_CLIENT_SECRET);
    assert.equal(runtime.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(runtime.CLOUDFLARE_ACCOUNT_ID, undefined);
    for (const bad of [{ ...s, ['private-sentinel@example.com']: 'x' }, { ...s, GOONBRIDGE_TOKENS: {} }, { ...s, GOONBRIDGE_TOKENS: { alice: s.GOONBRIDGE_TOKENS.alice, bob: s.GOONBRIDGE_TOKENS.alice } }]) {
      assert.throws(() => validateSecrets(bad, c), e => !e.message.includes('private-sentinel'));
    }
    const forbidden = structuredClone(c); forbidden.auth.staticTokensSecret.env = 'CLOUDFLARE_API_TOKEN';
    assert.throws(() => validateSecrets(s, forbidden), /deploy-only/);
  }
});

test('untrusted secret JSON and symlinks fail without leaking contents or running commands', async t => {
  const { pushSecrets } = await import('../bin/secrets-push.mjs');
  const { symlink } = await import('node:fs/promises');
  const root = await repo(t), file = path.join(root, 'deployments/example/secrets.json');
  const run = () => assert.fail('external command called');
  await writeFile(file, '{"private-sentinel": invalid}');
  await assert.rejects(pushSecrets({ root, deployment: 'example', run }), e => !e.message.includes('private-sentinel'));
  await rm(file);
  await writeFile(path.join(root, 'unguarded.json'), JSON.stringify(await secrets()));
  await symlink('../../unguarded.json', file);
  await assert.rejects(pushSecrets({ root, deployment: 'example', run }), /symlink/);
});

test('D1 contractToken names an existing member and is required before uploads', async () => {
  const { validateSecrets } = await loadModule('src/config/secrets-schema.ts');
  const c = await config(), s = await secrets();
  s.contractToken = 'alice'; assert.doesNotThrow(() => validateSecrets(s, c));
  for (const value of [undefined, 'unknown']) {
    const bad = { ...s, contractToken: value }; if (value === undefined) delete bad.contractToken;
    assert.throws(() => validateSecrets(bad, c), /contractToken|contract token/);
  }
});

test('R2 generation writes account ID only under ignored output and preserves local Wrangler', async t => {
  const { writeWrangler } = await import('../bin/gen-wrangler.mjs');
  const root = await repo(t);
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, 'wrangler.jsonc'), '{"local":true}\n');
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n.generated/\n');
  await writeWrangler({ root, deployment: 'example', accountId: '0'.repeat(32) });
  assert.equal(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'), '{"local":true}\n');
  const generated = JSON.parse(await readFile(path.join(root, '.generated/wrangler.example.jsonc'), 'utf8'));
  assert.equal(generated.account_id, '0'.repeat(32));
  assert.equal(path.resolve(root, '.generated', generated.main), path.join(root, 'src/index.ts'));
  assert.equal(execFileSync('git', ['check-ignore', '.generated/wrangler.example.jsonc'], { cwd: root, encoding: 'utf8' }).trim(), '.generated/wrangler.example.jsonc');
  execFileSync('git', ['add', '-f', '.generated/wrangler.example.jsonc'], { cwd: root });
  await assert.rejects(writeWrangler({ root, deployment: 'example', accountId: '0'.repeat(32) }), /untracked/);
  execFileSync('git', ['rm', '--cached', '-f', '.generated/wrangler.example.jsonc'], { cwd: root });
  const mcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.chimera.url, 'https://example.com/mcp');
  const settings = await readFile(path.join(root, '.claude/settings.json'), 'utf8');
  assert.match(settings, /https:\/\/example.com\/cloud-setup.sh/);
  assert.doesNotMatch(settings, brandingPattern());
  assert.doesNotMatch(settings, /approval.mjs/);
  await rm(path.join(root, '.generated/wrangler.example.jsonc'));
  await symlink('../wrangler.jsonc', path.join(root, '.generated/wrangler.example.jsonc'));
  await assert.rejects(writeWrangler({ root, deployment: 'example', accountId: '0'.repeat(32) }), /symlink/);
  assert.equal(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'), '{"local":true}\n');
  await rm(path.join(root, '.generated/wrangler.example.jsonc'));
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n');
  await assert.rejects(writeWrangler({ root, deployment: 'example', accountId: '0'.repeat(32) }), /ignored/);
});

test('bridge roles: admins and approvers are people without a dash; the old hooks.approver key is still read', async () => {
  const { validateConfig, approversOf, adminsOf } = await loadModule('src/config/schema.ts');
  const c = await config();
  assert.deepEqual(approversOf(validateConfig(c)), ['alice']);
  assert.deepEqual(adminsOf(validateConfig(c)), ['alice']);
  const old = structuredClone(c); delete old.hooks.approvers; old.hooks.approver = 'alice';
  assert.deepEqual(approversOf(validateConfig(old)), ['alice'], 'compatibility read of hooks.approver');
  const both = structuredClone(c); both.hooks.approver = 'alice';
  assert.throws(() => validateConfig(both), /approvers.*not both/);
  const none = structuredClone(c); delete none.hooks.approvers;
  assert.throws(() => validateConfig(none), /config\.hooks\.approvers: required/);
  const dashed = structuredClone(c); dashed.members.push({ name: 'bob-smith', kind: 'person' });
  assert.throws(() => validateConfig(dashed), /person names must not contain a dash/);
  const notPerson = structuredClone(c); notPerson.admins = ['bob'];
  assert.throws(() => validateConfig(notPerson), /config\.admins: .*person in members/);
  const device = structuredClone(c); device.hooks.approvers = ['alice-cloud'];
  assert.throws(() => validateConfig(device), /config\.hooks\.approvers|must match/);
  const noAdmins = structuredClone(c); delete noAdmins.admins;
  assert.deepEqual(adminsOf(validateConfig(noAdmins)), [], 'no admins: nobody opens the admin pages');
});
