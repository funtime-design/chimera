// pnpm secrets:mint: one master credential mints the rest of deployments/<id>/secrets.json.
//
//   pnpm secrets:mint -- --deployment <id> [--dry-run] [--yes] [--rotate-all] [--access-token]
//
// The master credential is the "minter": a Cloudflare account API token whose only permission is "API Tokens: Edit".
// It is read from CHIMERA_TOKEN_MINTER or asked masked on a terminal, and never stored. From it:
//   - generated here (32 random bytes, base64url): one static token per member, the GitHub webhook secret;
//     contractToken is set to the first admin's member name;
//   - minted through the Cloudflare API: CLOUDFLARE_API_TOKEN, "Workers Editor" scoped to this Worker (account scope
//     if the API refuses that), 90-day expiry, named github-actions-<worker>-deploy;
//   - with --access-token, or when the file already holds one: CLOUDFLARE_ACCESS_TOKEN, "Access: Apps and Policies
//     Edit" + "Access: Organizations, Identity Providers, and Groups Edit" on this account, 90 days, named
//     chimera-<worker>-access, for access:provision and members:sync. It never reaches the Worker. If Cloudflare
//     refuses it, mint says so and carries on: access:provision then says how to add it;
//   - asked (masked) or read from an env var of the same name: values issued elsewhere (account ID, Access secret,
//     email map, routines, config PAT), only those this config uses or the file already has. Enter, or an unset env
//     var, skips one; nothing is written for it.
// The order a person sees: a one-line plan ("Will mint: ..., generate: ..., ask for: ..."), the minter prompt, then
// "minted CLOUDFLARE_API_TOKEN (90 days)", the generated key names, and only then the values issued elsewhere, each
// with its one-line "where this comes from". Env values are checked before anything is minted.
// A re-run rotates everything it generates or mints (y/N on a terminal, --yes otherwise) and keeps values issued
// elsewhere unless --rotate-all. --dry-run prints the plan and mints and writes nothing. No value is ever printed:
// every line goes through the redactor. Exit 0 done, 2 waiting for --yes, 1 error.
import { randomBytes } from 'node:crypto';
import { cli, isMain, loadDeployment, projectRoot, requirePrivateSecrets, validation } from './deployment.mjs';
import { selectedDeploymentId } from './selected-deployment.mjs';
import { getKey, hasValue, hideSecrets, makeRedactor, parseField, readSecrets, secretFields, setKey, terminalAsk, writeSecrets } from './secrets-common.mjs';
import { pushSecrets } from './secrets-push.mjs';

const GENERATED = ['GOONBRIDGE_TOKENS', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCESS_TOKEN', 'contractToken', 'GOONBRIDGE_GITHUB_WEBHOOK_SECRET'];
const ROTATED = ['GOONBRIDGE_TOKENS', 'CLOUDFLARE_API_TOKEN', 'GOONBRIDGE_GITHUB_WEBHOOK_SECRET'];
export const randomSecret = () => randomBytes(32).toString('base64url');

// The Cloudflare API with the minter. Errors carry the HTTP status, never a response body.
function minterApi(fetchImpl, minter) {
  return async (method, p, body) => {
    let res;
    try {
      res = await fetchImpl(`https://api.cloudflare.com/client/v4${p}`, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${minter}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Cloudflare API request failed (network; details not shown)'); }
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, ok: res.ok && data?.success === true, result: data?.result };
  };
}
async function permissionGroups(api, accountId) {
  const groups = await api('GET', `/accounts/${accountId}/tokens/permission_groups?per_page=500`);
  if (!groups.ok) {
    if (groups.status === 401 || groups.status === 403) throw new Error(`Cloudflare refused the minter token (HTTP ${groups.status}): it must be an account API token with only "API Tokens: Edit", for this account`);
    throw new Error(`cannot list Cloudflare permission groups (HTTP ${groups.status})`);
  }
  return groups;
}

// Mint a Workers Editor token for one Worker.
export async function mintDeployToken({ fetchImpl = fetch, minter, accountId, worker, now = Date.now() }) {
  const api = minterApi(fetchImpl, minter);
  const groups = await permissionGroups(api, accountId);
  const editor = groups.result?.find(g => g.name === 'Workers Editor') ?? groups.result?.find(g => g.name === 'Workers Scripts Write');
  if (!editor) throw new Error('no "Workers Editor" permission group found in this account');
  const expires = new Date(now + 90 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const name = `github-actions-${worker}-deploy`;
  const policy = resources => ({ name, expires_on: expires, policies: [{ effect: 'allow', permission_groups: [{ id: editor.id }], resources }] });
  let made = await api('POST', `/accounts/${accountId}/tokens`, policy({ [`com.cloudflare.api.account.${accountId}`]: { [`com.cloudflare.edge.worker.script.${worker}`]: '*' } }));
  let scope = `Worker ${worker} only`;
  if (!made.ok) {
    made = await api('POST', `/accounts/${accountId}/tokens`, policy({ [`com.cloudflare.api.account.${accountId}`]: '*' }));
    scope = 'whole account (the API refused the per-Worker scope)';
  }
  if (!made.ok || typeof made.result?.value !== 'string') throw new Error(`Cloudflare refused to mint the deploy token (HTTP ${made.status})`);
  return { value: made.result.value, name, scope, expires };
}

// The dashboard says "Edit", the API's permission group names say "Write"; either is accepted.
export const ACCESS_PERMISSIONS = ['Access: Apps and Policies', 'Access: Organizations, Identity Providers, and Groups'];
// Mint the Access token (account scope: Access apps, policies and groups are account resources).
export async function mintAccessToken({ fetchImpl = fetch, minter, accountId, worker, now = Date.now() }) {
  const api = minterApi(fetchImpl, minter);
  const groups = await permissionGroups(api, accountId);
  const ids = ACCESS_PERMISSIONS.map(base => groups.result?.find(g => g.name === `${base} Write` || g.name === `${base} Edit`)?.id);
  if (ids.some(id => !id)) throw new Error('the Access permission groups were not found in this account');
  const expires = new Date(now + 90 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const name = `chimera-${worker}-access`;
  const made = await api('POST', `/accounts/${accountId}/tokens`, { name, expires_on: expires,
    policies: [{ effect: 'allow', permission_groups: ids.map(id => ({ id })), resources: { [`com.cloudflare.api.account.${accountId}`]: '*' } }] });
  if (!made.ok || typeof made.result?.value !== 'string') throw new Error(`Cloudflare refused to mint it (HTTP ${made.status})`);
  return { value: made.result.value, name, expires };
}

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (['--dry-run', '--yes', '--rotate-all', '--access-token'].includes(a)) o[a.slice(2)] = true;
    else throw new Error('unsupported option; use --deployment <id>, --dry-run, --yes, --rotate-all, --access-token');
  }
  return o;
}

export async function mintSecrets({
  root = projectRoot, argv = [], env = process.env, isTTY = !!(process.stdin.isTTY && process.stderr.isTTY), ask, fetchImpl = fetch,
  out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`), offerPush = true, now = Date.now(),
} = {}) {
  const { hide, redact } = makeRedactor();
  const say = line => out(redact(line)), warn = line => err(redact(line));
  const prompt = ask ?? (isTTY ? terminalAsk : null);
  try {
    const opts = parseArgs(argv);
    const deployment = opts.deployment ?? selectedDeploymentId(env);
    const { config } = await loadDeployment({ root, deployment });
    const file = await requirePrivateSecrets(root, deployment, { allowMissing: true });
    const existing = await readSecrets(file);
    hideSecrets(hide, existing);

    const members = [...new Set([...config.members.map(m => m.name), ...(config.admins ?? [])])];
    if (!members.length) throw new Error('bridge.config.json lists no members to make tokens for');
    const contract = (config.admins ?? [])[0] ?? config.members.find(m => m.kind === 'person')?.name ?? members[0];
    const fields = await secretFields(config);
    for (const name of ['CHIMERA_TOKEN_MINTER', ...fields.map(f => f.env)]) hide(env[name]);
    const rotating = !!existing && ROTATED.some(k => hasValue(existing, k));
    const keep = f => !!existing && hasValue(existing, f.key) && !opts['rotate-all'];
    const given = f => typeof env[f.env] === 'string' && env[f.env] !== '';
    // Ask only for what this config uses or the file already has; an env var is accepted for any key.
    const askFor = f => !!prompt && (f.needed || getKey(existing, f.key) !== undefined);
    const external = fields.filter(f => !GENERATED.includes(f.key));
    const wantAccess = !!opts['access-token'] || getKey(existing, 'CLOUDFLARE_ACCESS_TOKEN') !== undefined;

    const plan = [
      ['GOONBRIDGE_TOKENS', `generated (${members.length} member${members.length === 1 ? '' : 's'})`],
      ...external.filter(f => f.key === 'cloudflare.accountId').map(f => [f.key, keep(f) ? 'kept' : given(f) ? `env ${f.env}` : prompt ? 'prompted' : 'missing']),
      ['CLOUDFLARE_API_TOKEN', 'minted'],
      ...(wantAccess ? [['CLOUDFLARE_ACCESS_TOKEN', 'minted']] : []),
      ['contractToken', `generated (${contract})`],
      ['GOONBRIDGE_GITHUB_WEBHOOK_SECRET', 'generated'],
      ...external.filter(f => f.key !== 'cloudflare.accountId').map(f => [f.key, keep(f) ? 'kept' : given(f) ? `env ${f.env}` : askFor(f) ? 'prompted (Enter skips)' : f.needed ? 'skipped (this config uses it)' : 'skipped']),
    ];
    if (opts['dry-run']) {
      say(`secrets:mint plan for deployments/${deployment}/secrets.json (dry run: nothing minted or written)${rotating ? '; existing generated values would be rotated' : ''}:`);
      for (const [key, source] of plan) say(`  ${key}: ${source}`);
      return 0;
    }
    // The order a person sees: what will happen, the minter, the minted and generated names, then values issued elsewhere.
    const toAsk = external.filter(f => f.key !== 'cloudflare.accountId' && !keep(f) && !given(f) && askFor(f));
    say(`Will mint: CLOUDFLARE_API_TOKEN${wantAccess ? ', CLOUDFLARE_ACCESS_TOKEN' : ''} (90 days); generate: GOONBRIDGE_TOKENS (${members.join(', ')}), GOONBRIDGE_GITHUB_WEBHOOK_SECRET; ask for: ${toAsk.length ? `${toAsk.map(f => f.key).join(', ')} (Enter skips)` : 'nothing else'}.`);
    if (rotating && !opts.yes) {
      const what = 'secrets.json already holds generated values. Rotate them (every member gets a new token and a new deploy token is minted)';
      if (!prompt) { say(`${what}? Re-run with --yes to rotate; nothing changed.`); return 2; }
      if (!/^y(es)?$/i.test(await prompt(`${what}? [y/N] `, { mask: false }))) { say('Nothing changed.'); return 0; }
    }

    // Values from env are checked first, so a bad one fails before anything is minted.
    const next = structuredClone(existing ?? {});
    const report = [];
    const fromEnv = new Map();
    for (const f of external) {
      if (keep(f) || !given(f)) continue;
      try { fromEnv.set(f.key, await parseField(f, env[f.env], next)); } catch (e) { throw new Error(`${f.env}: ${e.message}`); }
      hide(fromEnv.get(f.key));
    }
    const askOne = async f => {
      say(`${f.key}: ${f.description}${f.needed ? ' (this deployment uses it)' : ''}`);
      for (;;) {
        const text = await prompt(`  ${f.key} (Enter skips): `, { mask: f.secret });
        if (!text) return undefined;
        hide(text);
        try { return await parseField(f, text, next); } catch (e) { warn(`  ${e.message}; try again`); }
      }
    };

    // 1. The minter.
    if (!env.CHIMERA_TOKEN_MINTER && prompt) say('The minter is your master token: a Cloudflare account API token with only "API Tokens: Edit". It is used once to mint the deploy token and is never stored.');
    const minter = env.CHIMERA_TOKEN_MINTER || (prompt ? await prompt('Minter token (Cloudflare account token with only "API Tokens: Edit"): ', { mask: true }) : '');
    if (!minter) throw new Error('no minter token: set CHIMERA_TOKEN_MINTER or run in a terminal. It is an account API token with only "API Tokens: Edit".');
    hide(minter);
    // The account the deploy token belongs to: kept, from env, or asked now (it is needed to mint).
    const account = external.find(f => f.key === 'cloudflare.accountId');
    if (!keep(account)) {
      const value = fromEnv.get(account.key) ?? (prompt ? await askOne(account) : undefined);
      if (value === undefined) throw new Error('CLOUDFLARE_ACCOUNT_ID: the Cloudflare account ID is needed to mint (set it, or run in a terminal)');
      setKey(next, account.key, value);
      hide(value);
      report.push([account.key, fromEnv.has(account.key) ? 'set from env' : 'prompted']);
    } else report.push([account.key, 'kept']);

    // 2. The deploy token.
    const accountId = getKey(next, 'cloudflare.accountId');
    const minted = await mintDeployToken({ fetchImpl, minter, accountId, worker: config.cloudflare.workerName, now });
    hide(minted.value);
    next.CLOUDFLARE_API_TOKEN = minted.value;
    say('minted CLOUDFLARE_API_TOKEN (90 days)');
    let access = null;
    if (wantAccess) {
      try {
        access = await mintAccessToken({ fetchImpl, minter, accountId, worker: config.cloudflare.workerName, now });
        hide(access.value);
        next.CLOUDFLARE_ACCESS_TOKEN = access.value;
        say('minted CLOUDFLARE_ACCESS_TOKEN (90 days)');
      } catch (e) {
        warn(`could not mint CLOUDFLARE_ACCESS_TOKEN: ${e.message}. access:provision will say how to add one; everything else goes on.`);
      }
    }

    // 3. Generated here.
    const tokens = Object.fromEntries(members.map(m => [m, randomSecret()]));
    hide(tokens);
    next.GOONBRIDGE_TOKENS = tokens;
    for (const m of members) say(`generated GOONBRIDGE_TOKENS.${m}`);
    next.GOONBRIDGE_GITHUB_WEBHOOK_SECRET = randomSecret();
    hide(next.GOONBRIDGE_GITHUB_WEBHOOK_SECRET);
    say('generated GOONBRIDGE_GITHUB_WEBHOOK_SECRET');
    next.contractToken = contract;
    const save = async () => { try { await writeSecrets(file, next); } catch { throw new Error(`could not write secrets.json; the deploy token ${minted.name} exists in Cloudflare, revoke it there`); } };
    await save();

    // 4. Values issued elsewhere, only the ones this config uses (or the file already has).
    for (const f of external) {
      if (f.key === 'cloudflare.accountId') continue;
      if (keep(f)) { report.push([f.key, 'kept']); continue; }
      const value = fromEnv.has(f.key) ? fromEnv.get(f.key) : askFor(f) ? await askOne(f) : undefined;
      setKey(next, f.key, value);
      hide(value);
      report.push([f.key, value === undefined ? 'skipped' : fromEnv.has(f.key) ? 'set from env' : 'prompted']);
    }
    await save();

    say(`Wrote deployments/${deployment}/secrets.json (mode 0600, ignored by git). Values are not shown; they are in that file.`);
    for (const [key, source] of [...plan.filter(([k]) => GENERATED.includes(k) && (k !== 'CLOUDFLARE_ACCESS_TOKEN' || access)), ...report]) say(`  ${key}: ${source}`);
    say(`Minted ${minted.name}: Workers Editor, ${minted.scope}, expires ${minted.expires}.`);
    say('Record its expiry so someone is warned before it lapses, for example:');
    say(`  az keyvault secret set-attributes --vault-name <vault> --name CLOUDFLARE_API_TOKEN --expires ${minted.expires}`);
    if (access) {
      say(`Minted ${access.name}: Access apps, policies and groups, whole account, expires ${access.expires}.`);
      say(`  az keyvault secret set-attributes --vault-name <vault> --name CLOUDFLARE_ACCESS_TOKEN --expires ${access.expires}`);
    }
    if (rotating) say(`Rotated: the previous deploy token still exists in Cloudflare; revoke it (API Tokens, name ${minted.name}${access ? `, and the old ${access.name}` : ''}). Every member needs their new token after secrets:push and a deploy.`);
    try { (await validation()).validateSecrets(next, config); } catch (e) { say(`Note: secrets:push will refuse until this is fixed: ${e.message}`); }
    if (offerPush && prompt && /^y(es)?$/i.test(await prompt('Run secrets:push --dry-run now? [y/N] ', { mask: false }))) {
      await pushSecrets({ root, deployment, dryRun: true, log: line => say(`  ${line}`) });
    }
    return 0;
  } catch (error) {
    warn(`secrets:mint: ${error.message}`);
    return 1;
  }
}

if (isMain(import.meta.url)) await cli(async () => { process.exitCode = await mintSecrets({ argv: process.argv.slice(2) }); });
