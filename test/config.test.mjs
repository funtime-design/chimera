import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModule } from './hub-memory.mjs';
const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
import { presentDeployments, brandingPattern } from './harness/baselines.mjs';
// Every deployment folder in this checkout: the public tree ships only the example; a fork adds its own.
const deploymentPaths = presentDeployments().map(id => `deployments/${id}/bridge.config.json`);
const neutralPath = 'test/fixtures/neutral/bridge.config.json';

test('strict config validation locks identity and rejects inline secrets, unknown fields and insecure origins', async () => {
  const { validateConfig } = await loadModule('src/config/schema.ts');
  for (const path of deploymentPaths) { const config = read(path); assert.deepEqual(validateConfig(config), config, path); }
  const good = read('deployments/example/bridge.config.json');
  for (const [change, message] of [
    [c => delete c.identity, /identity.*required/],
    [c => delete c.identity.hubKey, /identity.hubKey.*required/],
    [c => c.identity.hubKey = 'other', /identity.hubKey.*main/],
    [c => c.auth.staticTokensSecret = 'inline-value', /staticTokensSecret.*object/],
    [c => c.auth.staticTokensSecret = { env: 'BAD-NAME' }, /env.*pattern/],
    [c => c.deployment.surprise = true, /deployment.surprise.*unknown/],
    [c => c.deployment.origin = 'http://example.com', /origin.*HTTPS/],
  ]) {
    const c = structuredClone(good); change(c);
    assert.throws(() => validateConfig(c), message);
  }
});

test('resolver preserves legacy env precedence, supports neutral aliases and resolves references only at runtime', async () => {
  const { resolveConfig, runtimeEnv } = await loadModule('src/config/resolve.ts');
  const config = read(neutralPath);
  assert.equal(resolveConfig({}, config).deployment.productName, 'chimera');
  const env = { CHIMERA_GITHUB_OWNER: 'alias', GOONBRIDGE_GITHUB_OWNER: 'legacy', CHIMERA_CLAIM_SECONDS: '44', GOONBRIDGE_CLAIM_SECONDS: '55', TEST_TOKENS: JSON.stringify({ ['x'.repeat(24)]: 'alice' }), TEST_MEMBERS: JSON.stringify({ ['alice' + '@example.com']: 'alice' }) };
  const before = JSON.stringify(config);
  const c = resolveConfig(env, config);
  assert.equal(c.github.owner, 'legacy');
  assert.equal(c.timing.claimSeconds, 55);
  const out = runtimeEnv(env, config);
  assert.equal(out.GOONBRIDGE_TOKENS, env.TEST_TOKENS);
  assert.equal(out.GOONBRIDGE_MEMBERS, env.TEST_MEMBERS);
  assert.equal(JSON.stringify(config), before);
  assert.equal(resolveConfig({ CHIMERA_GITHUB_OWNER: 'alias' }, config).github.owner, 'alias');
  assert.equal(resolveConfig({ GOONBRIDGE_CLAIM_SECONDS: 'bad' }, config).timing.claimSeconds, 900);
});

test('validated neutral fixture renders every rules surface without deployment branding', async () => {
  const { resolveConfig } = await loadModule('src/config/resolve.ts');
  const { deploymentText } = await loadModule('src/deployment.ts');
  const r = await loadModule('src/rules.ts');
  const { renderCases } = await import('./rules-cases.mjs');
  const c = deploymentText(resolveConfig({}, read(neutralPath)));
  assert.doesNotMatch(JSON.stringify(renderCases(r, c)), brandingPattern());
});

test('deployment configs contain references only; public fixture contains no email or token-like value', () => {
  for (const path of [...deploymentPaths, neutralPath, 'config/bridge.config.schema.json']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /(?:gh[pousr]_|github_pat_|sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN .*PRIVATE KEY/);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    const scan = (value, key = '') => {
      if (Array.isArray(value)) return value.forEach(v => scan(v));
      if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => scan(v, k));
      if (typeof value !== 'string' || ['accountId', 'oauthKvId', 'commit'].includes(key)) return;
      assert.doesNotMatch(value, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|^[A-Fa-f0-9]{24,}$|^[A-Za-z0-9+/]{40,}={0,2}$/, `token-like value in ${path} (${key})`);
    };
    scan(JSON.parse(text));
  }
});

test('all six timings, access fields, GitHub and routines reach legacy consumers through the adapter', async () => {
  const { resolveConfig, runtimeEnv } = await loadModule('src/config/resolve.ts');
  const config = read(neutralPath);
  config.access = { clientId: 'example-client', clientSecret: { env: 'TEST_ACCESS_SECRET' }, authorizationUrl: 'https://example.com/authorize', tokenUrl: 'https://example.com/token', jwksUrl: 'https://example.com/jwks', pages: { issuer: 'https://example.com', audience: 'example-audience' } };
  config.github.webhookSecret = { env: 'TEST_WEBHOOK_SECRET' };
  config.cloud = { routines: { alice: { trigger: { env: 'TEST_TRIGGER' }, token: { env: 'TEST_ROUTINE_TOKEN' } } }, namedRoutines: { review: { trigger: { env: 'TEST_TRIGGER' }, token: { env: 'TEST_ROUTINE_TOKEN' }, allow: ['alice'] } }, configBundle: { repo: 'example/config', commit: 'a'.repeat(40), pat: { env: 'TEST_CONFIG_PAT' } } };
  const env = { TEST_ACCESS_SECRET: 'synthetic-access', TEST_WEBHOOK_SECRET: 'synthetic-webhook', TEST_TRIGGER: 'synthetic-trigger', TEST_ROUTINE_TOKEN: 'synthetic-token', TEST_CONFIG_PAT: 'synthetic-pat' };
  const out = runtimeEnv(env, config);
  assert.equal(out.ACCESS_CLIENT_SECRET, env.TEST_ACCESS_SECRET);
  assert.equal(out.ACCESS_CLIENT_ID, 'example-client');
  assert.equal(out.ACCESS_AUTHORIZATION_URL, config.access.authorizationUrl);
  assert.equal(out.ACCESS_TOKEN_URL, config.access.tokenUrl);
  assert.equal(out.ACCESS_JWKS_URL, config.access.jwksUrl);
  assert.equal(out.ACCESS_PAGES_ISSUER, config.access.pages.issuer);
  assert.equal(out.ACCESS_PAGES_AUD, config.access.pages.audience);
  assert.equal(out.GOONBRIDGE_GITHUB_WEBHOOK_SECRET, env.TEST_WEBHOOK_SECRET);
  assert.equal(out.GITHUB_CONFIG_PAT, env.TEST_CONFIG_PAT);
  assert.equal(out.GITHUB_CONFIG_REPO, 'example/config');
  assert.equal(resolveConfig(env, config).cloud.configRef, 'a'.repeat(40));
  assert.equal(out.GOONBRIDGE_ROUTINE_REVIEW_TRIGGER, env.TEST_TRIGGER);
  assert.equal(out.GOONBRIDGE_ROUTINE_REVIEW_TOKEN, env.TEST_ROUTINE_TOKEN);
  assert.equal(out.GOONBRIDGE_ROUTINE_REVIEW_ALLOW, 'alice');
  assert.deepEqual(JSON.parse(out.GOONBRIDGE_ROUTINES), { alice: { trigger: env.TEST_TRIGGER, token: env.TEST_ROUTINE_TOKEN } });
  const overridden = runtimeEnv({ ...env, GOONBRIDGE_ROUTINES: '{}', GOONBRIDGE_ROUTINE_REVIEW_TOKEN: '', ACCESS_CLIENT_SECRET: '', GITHUB_CONFIG_PAT: '' }, config);
  assert.equal(overridden.GOONBRIDGE_ROUTINES, '{}');
  assert.equal(overridden.GOONBRIDGE_ROUTINE_REVIEW_TOKEN, '');
  assert.equal(overridden.ACCESS_CLIENT_SECRET, '');
  assert.equal(overridden.GITHUB_CONFIG_PAT, '');
  for (const [key, suffix] of Object.entries({ claimSeconds: 'CLAIM_SECONDS', claimLeaseSeconds: 'CLAIM_LEASE_SECONDS', bootSeconds: 'BOOT_SECONDS', onlineSeconds: 'ONLINE_SECONDS', statusExpirySeconds: 'STATUS_EXPIRY_SECONDS', deploySeconds: 'DEPLOY_SECONDS' })) {
    assert.equal(out[`GOONBRIDGE_${suffix}`], String(config.timing[key]));
    assert.equal(runtimeEnv({ [`CHIMERA_${suffix}`]: '71', [`GOONBRIDGE_${suffix}`]: '72' }, config)[`GOONBRIDGE_${suffix}`], '72');
  }
  assert.equal(resolveConfig({ GOONBRIDGE_AUTO_REVIEW: ' OFF ' }, config).github.autoReview, false);
  assert.equal(resolveConfig({ GOONBRIDGE_AUTO_REVIEW: '' }, config).github.autoReview, true);
});

test('named routine parser accepts configured prefixes and legacy field overrides', async () => {
  const { parseNamedRoutines } = await loadModule('src/routines.ts');
  const parsed = parseNamedRoutines({ CHIMERA_ROUTINE_TEST_TRIGGER: ' example-trigger ', CHIMERA_ROUTINE_TEST_TOKEN: ' example-token ', CHIMERA_ROUTINE_TEST_ALLOW: ' alice, BOB ', GOONBRIDGE_ROUTINE_TEST_TOKEN: ' legacy-token ' });
  assert.deepEqual(parsed.get('test'), { trigger: 'example-trigger', token: 'legacy-token', allow: ['alice', 'bob'] });
});

test('configured branch prefix and labels change prose while legacy goonbridge output stays frozen', async () => {
  const { resolveConfig } = await loadModule('src/config/resolve.ts');
  const { deploymentText } = await loadModule('src/deployment.ts');
  const r = await loadModule('src/rules.ts');
  const fixture = read(neutralPath);
  fixture.labels = { ciRed: 'checks-failed', branchGone: 'branch-removed', deployFailed: 'release-failed', reReview: 'review-again', revert: 'rollback', exempt: ['support', 'maintenance'] };
  const c = deploymentText(resolveConfig({}, fixture));
  const guide = r.buildGuideRules(c);
  assert.match(guide.standingInstructions, /agent\/<slug>/);
  assert.match(r.buildRevertBrief({ person: 'alice', how: 'revert', repo: 'example', list: 'one' }, c), /agent\/revert-<slug>/);
  assert.match(guide.taskRules, /checks-failed/);
  assert.match(guide.taskRules, /`support` or `maintenance`/);
  assert.match(guide.manualRevert, /`rollback`-labelled/);
});

test('cloud-name helper preserves routing, authorization and trust distinctions, including malformed edge names', async () => {
  const { cloudParentOf, cloudMember, isCloud, isCloudParent, CLOUD_PARENT_LIKE } = await loadModule('src/config/names.ts');
  for (const name of ['alice', 'alice-cloud', 'alice-cloud-child', 'alice-laptop', 'alice-laptop-cloud', '-cloud', 'alice-cloudy-cloud-child', 'alice-cloudy', 'a-cloud-cloud', 'a-cloud_child']) {
    assert.equal(cloudParentOf(name), name.endsWith('-cloud') ? name.slice(0, -6) : null, name);
    assert.equal(isCloud(name), /^[^-]+-cloud(-|$)/.test(name), name);
    assert.equal(isCloud(name, true), /-cloud(-|$)/.test(name), name);
    assert.equal(isCloudParent(name), /^[^-]+-cloud$/.test(name), name);
  }
  assert.equal(cloudMember('alice'), 'alice-cloud');
  assert.equal(CLOUD_PARENT_LIKE, '%-cloud');
});

test('client projection is nonsecret and safely quoted for shell scripts', async () => {
  const { clientConfig, clientScript } = await loadModule('src/config/client.ts');
  const config = read(neutralPath);
  config.deployment.displayName = "Alice's bridge";
  config.deployment.productName = "Alice's bridge";
  const client = clientConfig(config);
  assert.equal(client.approver, 'alice');
  assert.equal(client.token_env, 'CHIMERA_TOKEN');
  assert.equal(client.launchd_label, config.clients.launchdLabel);
  assert.doesNotMatch(JSON.stringify(client), /staticTokens|memberEmails|accountId|configPat/);
  const { execFileSync } = await import('node:child_process');
  const script = clientScript("bridge_defaults='{}' # supplied by the Worker\nprintf '%s' \"$bridge_defaults\"", config);
  assert.deepEqual(JSON.parse(execFileSync('sh', ['-c', script], { encoding: 'utf8' })), client);
});

test('validation rejects nested unknown fields, each secret-bearing inline value and invalid membership without echoing private values', async () => {
  const { validateConfig } = await loadModule('src/config/schema.ts');
  const good = read(neutralPath);
  for (const mutate of [
    c => c.auth.staticTokensSecret = { env: 'TEST_TOKENS', value: 'private-sentinel' },
    c => c.access = { clientSecret: 'private-sentinel' },
    c => c.github.webhookSecret = 'private-sentinel',
    c => c.cloud = { routines: { alice: { trigger: { env: 'TEST_TRIGGER' }, token: 'private-sentinel' } } },
    c => c.cloud = { namedRoutines: { review: { trigger: 'private-sentinel', token: { env: 'TEST_TOKEN' } } } },
    c => c.cloud = { configBundle: { repo: 'example/config', commit: 'a'.repeat(40), pat: 'private-sentinel' } },
    c => c.cloud = { configBundle: { repo: 'example/config', commit: 'main', pat: { env: 'TEST_PAT' } } },
    c => c.members.push({ name: 'nobody-device', kind: 'device', person: 'nobody' }),
    c => c.members.push({ name: 'alice', kind: 'person' }),
    c => c.cloudflare.typo = true,
    c => c.timing.claimSeconds = 0,
    c => c.deployment.origin = 'https://private-sentinel@example.com',
    c => c.deployment.origin = 'https://example.com/path',
  ]) {
    const config = structuredClone(good); mutate(config);
    assert.throws(() => validateConfig(config), err => !err.message.includes('private-sentinel'));
  }
});

test('resource bindings, key main, env membership and timing defaults remain compatible', async () => {
  const { runtimeEnv, bundledConfig } = await loadModule('src/config/resolve.ts');
  const { hubOf, rosterOf, memberForEmail } = await loadModule('src/env.ts');
  const settings = await loadModule('src/hub/settings.ts');
  const stub = {};
  const env = { HUB: { idFromName: key => { assert.equal(key, 'main'); return key; }, get: () => stub }, OAUTH_KV: {}, CHIMERA_TOKENS: JSON.stringify({ ['x'.repeat(24)]: 'alice' }), GOONBRIDGE_MEMBERS: JSON.stringify({ ['person' + '@example.com']: 'bob' }) };
  const out = runtimeEnv(env);
  assert.equal(out.HUB, env.HUB);
  assert.equal(out.OAUTH_KV, env.OAUTH_KV);
  assert.equal(env.GOONBRIDGE_TOKENS, undefined);
  assert.equal(hubOf(out), stub);
  // Env grants entry on top of the bundled deployment's configured members.
  assert.deepEqual(rosterOf(out), [...new Set([...bundledConfig.members.map(m => m.name), 'alice', 'bob'])].sort());
  assert.equal(memberForEmail('PERSON' + '@example.com', out), 'bob');
  assert.equal(settings.claimSeconds(undefined), 900);
  assert.equal(settings.claimSeconds(null), 900);
  assert.equal(settings.claimSeconds({}), 900);
  assert.equal(settings.claimLeaseSeconds({ CHIMERA_CLAIM_LEASE_SECONDS: '73' }), 73);
});

test('reserved cloud labels and warm-session SQL keep their existing behavior', async () => {
  const { validDeviceLabel } = await import('../src/hub/registered.ts');
  for (const label of ['cloud', 'cloud-child', 'cloudy', 'mac-cloud', 'laptop', 'cloud-child-cloud']) {
    assert.equal(validDeviceLabel(label), /^[a-z0-9][a-z0-9-]{0,23}$/.test(label) && !/^cloud(-|$)/.test(label));
  }
  const { memoryHub } = await import('./hub-memory.mjs');
  const { hub, sql } = await memoryHub();
  try {
    const members = ['alice', 'alice-cloud', 'alice-laptop'];
    const cloud = (await hub.identify('alice-cloud', 'config-cloud', 'example', members, 4000, false, 'call')).member;
    const local = (await hub.identify('alice-laptop', 'config-local', 'example', members, 4000, false, 'call')).member;
    const roster = [...members, cloud, local];
    for (const session of [cloud, local]) {
      const first = await hub.taskCreate('alice', roster, { owner: 'alice', title: 'Anchor', brief: 'example', repo: 'one', state: 'ready' });
      const second = await hub.taskCreate('alice', roster, { owner: 'alice', title: 'Unrelated', brief: 'example', repo: 'two', state: 'ready' });
      await hub.taskUpdate(session, roster, first.key, { state: 'claim' });
      const claim = () => hub.taskUpdate(session, roster, second.key, { state: 'claim' });
      if (session === cloud) await assert.rejects(claim, /different or unset repo/);
      else await claim();
    }
  } finally { sql.db.close(); }
});
