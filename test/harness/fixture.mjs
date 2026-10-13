import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { baselineUrl, bundledDeploymentId } from './baselines.mjs';

export const NEUTRAL_ROLES = ['alice', 'bob', 'outsider', 'alice-laptop', 'alice-mini', 'alice-cloud', 'bob-mac', 'bob-cloud'];
// Owner mode uses the member names of the bundled deployment's private roles baseline (.private/fixtures/<id>/roles.json),
// the names its .dev.vars tokens map to; without one, the neutral names.
export function ownerRoles() {
  const file = baselineUrl(bundledDeploymentId(), 'roles.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
export function rolesFor(neutral) {
  const names = neutral ? NEUTRAL_ROLES : ownerRoles() ?? NEUTRAL_ROLES;
  return Object.fromEntries(['OWNER', 'OTHER', 'OUTSIDER', 'OWNER_DEVICE', 'OWNER_SECOND_DEVICE', 'OWNER_CLOUD', 'OTHER_DEVICE', 'OTHER_CLOUD'].map((k, i) => [k, names[i]]));
}

export function makeFixture() {
  const roles = rolesFor(true);
  const config = JSON.parse(readFileSync(new URL('../fixtures/neutral/bridge.config.json', import.meta.url), 'utf8'));
  config.members = Object.values(roles).map(name => name.includes('-') ? { name, kind: 'device', person: name.split('-')[0] } : { name, kind: name === roles.OUTSIDER ? 'service' : 'person' });
  config.timing = { claimSeconds: 3, claimLeaseSeconds: 8, bootSeconds: 3, onlineSeconds: 4, statusExpirySeconds: 8, deploySeconds: 3 };
  config.github.autoReview = true;
  config.cloud = { legacyConfigRepo: 'example/cloud-session-config', configPat: { env: 'GITHUB_CONFIG_PAT' } };
  config.hooks.branchPrefix = 'claude/';
  config.hooks.protectedBranches = ['main', 'master'];
  config.presentation = { exampleSecondDevice: roles.OWNER_SECOND_DEVICE, exampleRepo: 'example', examplePeer: roles.OTHER };
  const tokens = Object.values(roles).map(() => randomBytes(24).toString('hex'));
  const vars = {
    GOONBRIDGE_TOKENS: JSON.stringify(Object.fromEntries(tokens.map((t, i) => [t, Object.values(roles)[i]]))),
    GOONBRIDGE_MEMBERS: JSON.stringify({ 'alice@example.test': roles.OWNER, 'bob@example.test': roles.OTHER }),
    ACCESS_CLIENT_ID: 'engine-test', ACCESS_CLIENT_SECRET: randomBytes(24).toString('hex'), ACCESS_PAGES_AUD: 'engine-pages',
    GOONBRIDGE_ROUTINES: JSON.stringify({ [roles.OWNER]: { trigger: 'trig_local_test', token: 'rt_local_test_token' } }),
    GOONBRIDGE_ROUTINE_BLANK_TRIGGER: 'trig_blank_test', GOONBRIDGE_ROUTINE_BLANK_TOKEN: 'rt_local_test_token', GOONBRIDGE_ROUTINE_BLANK_ALLOW: roles.OWNER,
    GOONBRIDGE_ROUTINE_BADTOKEN_TRIGGER: 'trig_bad_test', GOONBRIDGE_ROUTINE_BADTOKEN_TOKEN: 'intentionally-wrong',
    GITHUB_CONFIG_REPO: config.cloud.legacyConfigRepo, GITHUB_CONFIG_PAT: randomBytes(24).toString('hex'),
    GOONBRIDGE_GITHUB_OWNER: config.github.owner, GOONBRIDGE_GITHUB_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    GOONBRIDGE_AUTO_REVIEW: 'on',
  };
  return { roles, config, tokens, vars };
}

export function workerConfig(main) {
  return {
    name: 'chimera-engine-test', main, compatibility_date: '2026-09-01',
    compatibility_flags: ['global_fetch_strictly_public'],
    durable_objects: { bindings: [{ name: 'HUB', class_name: 'Hub' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Hub'] }], kv_namespaces: [{ binding: 'OAUTH_KV' }],
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    dev: { ip: '127.0.0.1', port: 0, inspector_port: 0 },
    workers_dev: false, preview_urls: false, no_bundle: true, find_additional_modules: false,
  };
}

export function cleanEnvironment(input = process.env) {
  // An allow-list, so credentials added to an owner's shell in future cannot enter the fixture Worker.
  const keep = ['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM'];
  return { ...Object.fromEntries(keep.filter(k => input[k] !== undefined).map(k => [k, input[k]])),
    CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' };
}
