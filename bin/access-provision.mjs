// pnpm access:provision: create (or find) the Cloudflare Access sign-in for a deployment, through the Cloudflare API.
// pnpm members:sync: the same tool with --sync, which only brings the Access group's email list in line with the members.
//
//   pnpm access:provision -- --deployment <id> [--dry-run] [--existing] [--sync]
//   pnpm run members:sync -- --deployment <id> [--dry-run]
//
// People sign in to the bridge with an email code: the bridge's /authorize sends the browser to a Cloudflare Access for
// SaaS (OIDC) app, Access emails a one-time code, and the callback maps the verified email to a member through the
// GOONBRIDGE_MEMBERS map. This tool builds that app, idempotently:
//   1. Access must be turned on for the account (GET /access/organizations gives the team domain). If it is not, it
//      prints the one-time dashboard step and exits 2.
//   2. The One-time PIN login method exists (created when missing).
//   3. The Access group "<displayName> members" includes exactly the emails in the member map (created, or synced:
//      added and removed). Only member NAMES are printed, never an email.
//   4. The reusable Access policy "<displayName> members" allows that group.
//   5. The SaaS OIDC app "<displayName> sign-in" with the redirect URL <origin>/callback and that policy.
//   6. bridge.config.json gets access.clientId, authorizationUrl, tokenUrl and jwksUrl (not secret); secrets.json gets
//      ACCESS_CLIENT_SECRET (mode 0600) when the app is new: the API returns the secret only on create.
// --existing uses the app whose client id is in bridge.config.json (access.clientId) and only writes its URLs.
// --sync does only step 1 and 3, and also runs without secrets.json (in CI) from the env vars CLOUDFLARE_ACCOUNT_ID,
// CLOUDFLARE_ACCESS_TOKEN and GOONBRIDGE_MEMBERS.
// The API token is CLOUDFLARE_ACCESS_TOKEN (env, else secrets.json), minted by secrets:mint with "Access: Apps and
// Policies Edit" and "Access: Organizations, Identity Providers, and Groups Edit". The deploy token cannot do this.
// --dry-run reads but creates, changes and writes nothing. Exit 0 done, 2 waiting for a person, 1 error. No secret value
// (token, account ID, client secret) and no email is ever printed; errors carry an HTTP status, never a response body.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cli, deploymentDir, isMain, loadDeployment, projectRoot, requirePrivateSecrets } from './deployment.mjs';
import { selectedDeploymentId } from './selected-deployment.mjs';
import { hasValue, hideSecrets, makeRedactor, readSecrets, writeSecrets } from './secrets-common.mjs';

export const ZERO_TRUST_URL = 'https://one.dash.cloudflare.com/';
const SHOW = '--- show this ---', SHOW_END = '--- end ---';
export const groupName = config => `${config.deployment.displayName} members`;
export const appName = config => `${config.deployment.displayName} sign-in`;
export const callbackUrl = config => `${config.deployment.origin}/callback`;
// Access for SaaS serves every OIDC endpoint under its issuer (src/oauth.ts reads the issuer back from tokenUrl).
export function oidcUrls(authDomain, clientId) {
  const issuer = `https://${authDomain}/cdn-cgi/access/sso/oidc/${clientId}`;
  return { authorizationUrl: `${issuer}/authorization`, tokenUrl: `${issuer}/token`, jwksUrl: `${issuer}/jwks` };
}

class Waiting extends Error {}

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (['--dry-run', '--existing', '--sync'].includes(a)) o[a.slice(2)] = true;
    else throw new Error('unsupported option; use --deployment <id>, --dry-run, --existing, --sync');
  }
  if (o.existing && o.sync) throw new Error('--existing and --sync do not go together');
  return o;
}

// One Cloudflare API client. A failure says which call and the HTTP status, never the body (it can echo the token).
function accessApi({ fetchImpl, token, accountId }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access`;
  const call = async (method, p, body) => {
    let res;
    try {
      res = await fetchImpl(`${base}${p}`, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error(`Cloudflare API request failed (${method} ${p.split('?')[0]}; network, details not shown)`); }
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, ok: res.ok && data?.success === true, result: data?.result, info: data?.result_info };
  };
  const must = async (method, p, body) => {
    const r = await call(method, p, body);
    if (r.ok) return r.result;
    if (r.status === 401 || r.status === 403) throw new Error(`Cloudflare refused CLOUDFLARE_ACCESS_TOKEN for ${method} ${p.split('?')[0]} (HTTP ${r.status}): it needs "Access: Apps and Policies Edit" and "Access: Organizations, Identity Providers, and Groups Edit" on this account`);
    throw new Error(`Cloudflare Access API refused ${method} ${p.split('?')[0]} (HTTP ${r.status})`);
  };
  const list = async p => {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const r = await call('GET', `${p}?per_page=100&page=${page}`);
      if (!r.ok) return must('GET', p);
      all.push(...(r.result ?? []));
      if (!r.info?.total_pages || page >= r.info.total_pages) break;
    }
    return all;
  };
  return { call, must, list };
}

const emailsOf = group => (group?.include ?? []).map(r => r.email?.email?.toLowerCase()).filter(Boolean);

export async function provisionAccess({
  root = projectRoot, argv = [], env = process.env, fetchImpl = fetch,
  out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`),
} = {}) {
  const { hide, redact } = makeRedactor();
  const say = line => out(redact(line)), warn = line => err(redact(line));
  let emails = [];
  const hideEmails = () => { for (const e of emails) hide(e); };
  try {
    const opts = parseArgs(argv);
    const deployment = opts.deployment ?? selectedDeploymentId(env);
    const tool = opts.sync ? 'members:sync' : 'access:provision';
    const rerun = opts.sync ? `pnpm run members:sync -- --deployment ${deployment}` : `pnpm access:provision -- --deployment ${deployment}${opts.existing ? ' --existing' : ''}`;
    const { config } = await loadDeployment({ root, deployment });
    const file = await requirePrivateSecrets(root, deployment, { allowMissing: opts.sync });
    const secrets = await readSecrets(file);
    if (!secrets && !opts.sync) throw new Error(`deployments/${deployment}/secrets.json is missing: run pnpm run setup or pnpm secrets:mint first`);
    hideSecrets(hide, secrets);
    for (const key of ['CLOUDFLARE_ACCESS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOONBRIDGE_MEMBERS', 'ACCESS_CLIENT_SECRET']) hide(env[key]);

    const token = env.CLOUDFLARE_ACCESS_TOKEN || (hasValue(secrets, 'CLOUDFLARE_ACCESS_TOKEN') ? secrets.CLOUDFLARE_ACCESS_TOKEN : '');
    const accountId = env.CLOUDFLARE_ACCOUNT_ID || secrets?.cloudflare?.accountId || '';
    let members = secrets?.GOONBRIDGE_MEMBERS;
    if (!members && env.GOONBRIDGE_MEMBERS) {
      try { members = JSON.parse(env.GOONBRIDGE_MEMBERS); } catch { throw new Error('GOONBRIDGE_MEMBERS is not valid JSON (contents not shown)'); }
    }
    members = Object.fromEntries(Object.entries(members ?? {}).map(([e, n]) => [String(e).toLowerCase(), n]));
    emails = Object.keys(members);
    hideEmails();
    if (!/^[a-fA-F0-9]{32}$/.test(accountId)) throw new Error('no Cloudflare account ID: secrets.json cloudflare.accountId, or CLOUDFLARE_ACCOUNT_ID');
    if (!token) {
      say([SHOW,
        `${tool}: waiting for an API token that can manage Cloudflare Access (CLOUDFLARE_ACCESS_TOKEN).`,
        `  Next: run pnpm secrets:mint -- --deployment ${deployment} in your own terminal; it mints this token next to the deploy token.`,
        '  Or create it yourself at https://dash.cloudflare.com/profile/api-tokens with "Access: Apps and Policies Edit" and',
        '  "Access: Organizations, Identity Providers, and Groups Edit", and enter it with',
        `  pnpm secrets:fill -- --deployment ${deployment} --only CLOUDFLARE_ACCESS_TOKEN`,
        `  Then: ${rerun}`, SHOW_END].join('\n'));
      return 2;
    }
    const api = accessApi({ fetchImpl, token, accountId });
    const dry = opts['dry-run'];
    const would = dry ? 'would ' : '';

    // 1. Access turned on? The organization holds the team domain every OIDC URL lives under.
    const org = await api.call('GET', '/organizations');
    if (org.status === 401 || org.status === 403) await api.must('GET', '/organizations');
    const authDomain = org.ok && typeof org.result?.auth_domain === 'string' && org.result.auth_domain ? org.result.auth_domain : null;
    if (!authDomain) {
      say([SHOW,
        'Cloudflare Access is not turned on for this Cloudflare account yet. This is a one-time step in the dashboard:',
        `  1. Open ${ZERO_TRUST_URL} and pick this account.`,
        '  2. Choose a team name (it becomes <team>.cloudflareaccess.com) and the Free plan (up to 50 people; no charge).',
        `  3. Then run: ${rerun}`, SHOW_END].join('\n'));
      return 2;
    }
    say(`${tool}${dry ? ' (dry run: nothing is created, changed or written)' : ''}: Cloudflare Access is on (team ${authDomain}).`);

    // --existing: the person made the app; find it by client id, write its URLs, change nothing in Cloudflare.
    if (opts.existing) {
      const clientId = config.access?.clientId;
      if (!clientId) throw new Error('--existing needs access.clientId in bridge.config.json (the client id of your Access for SaaS app)');
      const app = (await api.list('/apps')).find(a => a.saas_app?.client_id === clientId);
      if (!app) throw new Error(`no Access for SaaS app with client id ${clientId} in this account (Zero Trust > Access controls > Applications)`);
      if (!(app.saas_app.redirect_uris ?? []).includes(callbackUrl(config))) say(`  note: add ${callbackUrl(config)} to the app's Redirect URLs (Zero Trust > Access controls > Applications > ${app.name} > Configure), or sign-in fails`);
      await writeConfig({ root, deployment, config, authDomain, clientId, dry, say });
      say('  Who may sign in is decided by this app\'s own policies in the dashboard; add each person\'s email there.');
      return await secretState({ secrets, deployment, appLabel: app.name, rerun, say });
    }

    // 2. A login method: the One-time PIN emails the code.
    if (!opts.sync) {
      const idps = await api.list('/identity_providers');
      if (idps.some(i => i.type === 'onetimepin')) say('  login method: One-time PIN (email code) is on');
      else {
        if (!dry) await api.must('POST', '/identity_providers', { name: 'One-time PIN', type: 'onetimepin', config: {} });
        say(`  login method: ${would}turn on One-time PIN (email code)`);
      }
    }

    // 3. The group: exactly the member emails. Rules that are not single emails are kept as they are.
    const name = groupName(config);
    const nameOf = email => members[email] ?? 'someone';
    let group = (await api.list('/groups')).find(g => g.name === name);
    if (!group) {
      if (!emails.length) throw new Error('no member emails: secrets.json GOONBRIDGE_MEMBERS is empty');
      const body = { name, include: emails.map(email => ({ email: { email } })) };
      group = dry ? { id: '(new group)', ...body } : await api.must('POST', '/groups', body);
      say(`  group "${name}": ${would}create with ${emails.map(nameOf).join(', ')}`);
    } else {
      const have = emailsOf(group);
      const add = emails.filter(e => !have.includes(e)), remove = have.filter(e => !emails.includes(e));
      if (!add.length && !remove.length) say(`  group "${name}": already lists every member (${emails.map(nameOf).join(', ')})`);
      else {
        if (!emails.length) throw new Error('no member emails: refusing to empty the Access group');
        const others = (group.include ?? []).filter(r => !r.email?.email);
        const body = { name, include: [...others, ...emails.map(email => ({ email: { email } }))], ...(group.exclude ? { exclude: group.exclude } : {}), ...(group.require ? { require: group.require } : {}) };
        if (!dry) await api.must('PUT', `/groups/${encodeURIComponent(group.id)}`, body);
        const parts = [...(add.length ? [`${would}add ${add.map(nameOf).join(', ')}`] : []), ...(remove.length ? [`${would}remove ${remove.length} email${remove.length === 1 ? '' : 's'} no longer in the member list`] : [])];
        say(`  group "${name}": ${parts.join('; ')}`);
      }
    }
    if (opts.sync) return 0;

    // 4. The reusable policy that allows the group.
    let policy = (await api.list('/policies')).find(p => p.name === name);
    if (policy) say(`  policy "${name}": already there`);
    else {
      const body = { name, decision: 'allow', include: [{ group: { id: group.id } }] };
      policy = dry ? { id: '(new policy)', ...body } : await api.must('POST', '/policies', body);
      say(`  policy "${name}": ${would}create (allow the group)`);
    }

    // 5. The SaaS OIDC app. Its client secret comes back only from this create.
    const label = appName(config);
    let app = (await api.list('/apps')).find(a => a.name === label && a.type === 'saas');
    let created = null;
    if (app) {
      say(`  app "${label}": already there`);
      if (!(app.saas_app?.redirect_uris ?? []).includes(callbackUrl(config))) say(`  note: the app's Redirect URLs lack ${callbackUrl(config)}; add it in Zero Trust > Access controls > Applications > ${label} > Configure`);
      if (!(app.policies ?? []).some(p => (p?.id ?? p) === policy.id)) say(`  note: attach the policy "${name}" to the app in the same place, or nobody can sign in`);
    } else {
      const body = { name: label, type: 'saas', policies: [policy.id], allowed_idps: [],
        saas_app: { auth_type: 'oidc', redirect_uris: [callbackUrl(config)], grant_type: ['authorization_code'], scopes: ['openid', 'email', 'profile'] } };
      if (!dry) {
        app = await api.must('POST', '/apps', body);
        if (typeof app?.saas_app?.client_id !== 'string') throw new Error('Cloudflare created the app but returned no client id; open it in the dashboard');
        if (typeof app.saas_app.client_secret === 'string') { created = app.saas_app.client_secret; hide(created); }
      }
      say(`  app "${label}": ${would}create (OIDC, redirect ${callbackUrl(config)})`);
    }
    if (dry) {
      say(`  bridge.config.json: ${would}set access.clientId and the sign-in URLs; secrets.json: ${would}set ACCESS_CLIENT_SECRET when the app is new`);
      return 0;
    }

    // 6. The non-secret settings into the config, the secret into secrets.json.
    await writeConfig({ root, deployment, config, authDomain, clientId: app.saas_app.client_id, dry, say });
    if (created) {
      secrets.ACCESS_CLIENT_SECRET = created;
      try { await writeSecrets(file, secrets); } catch { throw new Error(`could not write secrets.json; the app "${label}" exists, regenerate its client secret in the dashboard and enter it with pnpm secrets:fill`); }
      say(`  secrets.json: set ACCESS_CLIENT_SECRET (mode 0600, value not shown)`);
      return 0;
    }
    return await secretState({ secrets, deployment, appLabel: label, rerun, say });
  } catch (error) {
    hideEmails();
    warn(`access:provision: ${error.message}`);
    return 1;
  }
}

async function writeConfig({ root, deployment, config, authDomain, clientId, dry, say }) {
  const file = path.join(deploymentDir(root, deployment), 'bridge.config.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const access = { ...(raw.access ?? {}), clientId, clientSecret: raw.access?.clientSecret ?? { env: 'ACCESS_CLIENT_SECRET' }, ...oidcUrls(authDomain, clientId) };
  if (JSON.stringify(raw.access) === JSON.stringify(access)) { say('  bridge.config.json: access settings already set'); return; }
  if (dry) { say('  bridge.config.json: would set access.clientId and the sign-in URLs'); return; }
  raw.access = access;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  say(`  bridge.config.json: set access.clientId and the sign-in URLs (commit it; nothing in it is secret)`);
  void config;
}

// The app exists but its secret is not in secrets.json: Cloudflare will not show it again, so it must be regenerated.
async function secretState({ secrets, deployment, appLabel, rerun, say }) {
  if (hasValue(secrets, 'ACCESS_CLIENT_SECRET')) { say('  secrets.json: ACCESS_CLIENT_SECRET is set'); return 0; }
  say([SHOW,
    `The app "${appLabel}" exists, but its client secret is not in secrets.json, and Cloudflare shows a secret only once.`,
    `  1. Open ${ZERO_TRUST_URL} > Access controls > Applications > ${appLabel} > Configure.`,
    '  2. Under the OIDC settings, regenerate the Client secret and copy it.',
    `  3. Run pnpm secrets:fill -- --deployment ${deployment} --only ACCESS_CLIENT_SECRET in your own terminal and paste it (typing stays hidden).`,
    `  4. Then: ${rerun}`, SHOW_END].join('\n'));
  return 2;
}

if (isMain(import.meta.url)) await cli(async () => { process.exitCode = await provisionAccess({ argv: process.argv.slice(2) }); });
