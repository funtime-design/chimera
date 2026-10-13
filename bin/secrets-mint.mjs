// pnpm secrets:mint: one master credential mints the rest of deployments/<id>/secrets.json.
//
//   pnpm secrets:mint -- --deployment <id> [--dry-run] [--yes] [--rotate-all]
//
// The master credential is the "minter": a Cloudflare account API token whose only permission is "API Tokens: Edit".
// It is read from CHIMERA_TOKEN_MINTER or asked masked on a terminal, and never stored. From it:
//   - generated here (32 random bytes, base64url): one static token per member, the GitHub webhook secret;
//     contractToken is set to the first admin's member name;
//   - minted through the Cloudflare API: CLOUDFLARE_API_TOKEN, "Workers Editor" scoped to this Worker (account scope
//     if the API refuses that), 90-day expiry, named github-actions-<worker>-deploy;
//   - asked (masked) or read from an env var of the same name: values issued elsewhere (account ID, Access secret,
//     email map, routines, config PAT). Enter, or an unset env var, skips one; nothing is written for it.
// A re-run rotates everything it generates or mints (y/N on a terminal, --yes otherwise) and keeps values issued
// elsewhere unless --rotate-all. --dry-run prints the plan and mints and writes nothing. No value is ever printed:
// every line goes through the redactor. Exit 0 done, 2 waiting for --yes, 1 error.
import { randomBytes } from 'node:crypto';
import { cli, isMain, loadDeployment, projectRoot, requirePrivateSecrets, validation } from './deployment.mjs';
import { selectedDeploymentId } from './selected-deployment.mjs';
import { getKey, hasValue, hideSecrets, makeRedactor, parseField, readSecrets, secretFields, setKey, terminalAsk, writeSecrets } from './secrets-common.mjs';
import { pushSecrets } from './secrets-push.mjs';

const GENERATED = ['GOONBRIDGE_TOKENS', 'CLOUDFLARE_API_TOKEN', 'contractToken', 'GOONBRIDGE_GITHUB_WEBHOOK_SECRET'];
const ROTATED = ['GOONBRIDGE_TOKENS', 'CLOUDFLARE_API_TOKEN', 'GOONBRIDGE_GITHUB_WEBHOOK_SECRET'];
export const randomSecret = () => randomBytes(32).toString('base64url');

// Mint a Workers Editor token for one Worker. Errors carry the HTTP status, never a response body.
export async function mintDeployToken({ fetchImpl = fetch, minter, accountId, worker, now = Date.now() }) {
  const api = async (method, p, body) => {
    let res;
    try {
      res = await fetchImpl(`https://api.cloudflare.com/client/v4${p}`, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${minter}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Cloudflare API request failed (network; details not shown)'); }
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, ok: res.ok && data?.success === true, result: data?.result };
  };
  const groups = await api('GET', `/accounts/${accountId}/tokens/permission_groups?per_page=500`);
  if (!groups.ok) {
    if (groups.status === 401 || groups.status === 403) throw new Error(`Cloudflare refused the minter token (HTTP ${groups.status}): it must be an account API token with only "API Tokens: Edit", for this account`);
    throw new Error(`cannot list Cloudflare permission groups (HTTP ${groups.status})`);
  }
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

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (['--dry-run', '--yes', '--rotate-all'].includes(a)) o[a.slice(2)] = true;
    else throw new Error('unsupported option; use --deployment <id>, --dry-run, --yes, --rotate-all');
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

    const plan = [
      ['GOONBRIDGE_TOKENS', `generated (${members.length} member${members.length === 1 ? '' : 's'})`],
      ...external.filter(f => f.key === 'cloudflare.accountId').map(f => [f.key, keep(f) ? 'kept' : given(f) ? `env ${f.env}` : prompt ? 'prompted' : 'missing']),
      ['CLOUDFLARE_API_TOKEN', 'minted'],
      ['contractToken', `generated (${contract})`],
      ['GOONBRIDGE_GITHUB_WEBHOOK_SECRET', 'generated'],
      ...external.filter(f => f.key !== 'cloudflare.accountId').map(f => [f.key, keep(f) ? 'kept' : given(f) ? `env ${f.env}` : askFor(f) ? 'prompted (Enter skips)' : f.needed ? 'skipped (this config uses it)' : 'skipped']),
    ];
    if (opts['dry-run']) {
      say(`secrets:mint plan for deployments/${deployment}/secrets.json (dry run: nothing minted or written)${rotating ? '; existing generated values would be rotated' : ''}:`);
      for (const [key, source] of plan) say(`  ${key}: ${source}`);
      return 0;
    }
    if (rotating && !opts.yes) {
      const what = 'secrets.json already holds generated values. Rotate them (every member gets a new token and a new deploy token is minted)';
      if (!prompt) { say(`${what}? Re-run with --yes to rotate; nothing changed.`); return 2; }
      if (!/^y(es)?$/i.test(await prompt(`${what}? [y/N] `, { mask: false }))) { say('Nothing changed.'); return 0; }
    }

    // Values issued elsewhere first, so a bad one fails before anything is minted.
    const next = structuredClone(existing ?? {});
    const report = [];
    for (const f of external) {
      if (keep(f)) { report.push([f.key, 'kept']); continue; }
      let value;
      if (given(f)) {
        try { value = await parseField(f, env[f.env], next); } catch (e) { throw new Error(`${f.env}: ${e.message}`); }
      } else if (askFor(f) || (prompt && f.key === 'cloudflare.accountId')) {
        say(`${f.key}: ${f.description}${f.needed ? ' (this deployment uses it)' : ''}`);
        for (;;) {
          const text = await prompt(`  ${f.key} (Enter skips): `, { mask: f.secret });
          if (!text) break;
          hide(text);
          try { value = await parseField(f, text, next); break; } catch (e) { warn(`  ${e.message}; try again`); }
        }
      }
      if (value === undefined && f.key === 'cloudflare.accountId') throw new Error('CLOUDFLARE_ACCOUNT_ID: the Cloudflare account ID is needed to mint (set it, or run in a terminal)');
      setKey(next, f.key, value);
      hide(value);
      report.push([f.key, value === undefined ? 'skipped' : given(f) ? 'set from env' : 'prompted']);
    }

    const minter = env.CHIMERA_TOKEN_MINTER || (prompt ? await prompt('Minter token (Cloudflare account token with only "API Tokens: Edit"): ', { mask: true }) : '');
    if (!minter) throw new Error('no minter token: set CHIMERA_TOKEN_MINTER or run in a terminal. It is an account API token with only "API Tokens: Edit".');
    hide(minter);
    const accountId = getKey(next, 'cloudflare.accountId');
    const minted = await mintDeployToken({ fetchImpl, minter, accountId, worker: config.cloudflare.workerName, now });
    hide(minted.value);

    const tokens = Object.fromEntries(members.map(m => [m, randomSecret()]));
    hide(tokens);
    next.GOONBRIDGE_TOKENS = tokens;
    next.GOONBRIDGE_GITHUB_WEBHOOK_SECRET = randomSecret();
    hide(next.GOONBRIDGE_GITHUB_WEBHOOK_SECRET);
    next.CLOUDFLARE_API_TOKEN = minted.value;
    next.contractToken = contract;
    try { await writeSecrets(file, next); } catch { throw new Error(`could not write secrets.json; the deploy token ${minted.name} exists in Cloudflare, revoke it there`); }

    say(`Wrote deployments/${deployment}/secrets.json (mode 0600, ignored by git). Values are not shown; they are in that file.`);
    for (const [key, source] of [...plan.filter(([k]) => GENERATED.includes(k)), ...report]) say(`  ${key}: ${source}`);
    say(`Minted ${minted.name}: Workers Editor, ${minted.scope}, expires ${minted.expires}.`);
    say('Record its expiry so someone is warned before it lapses, for example:');
    say(`  az keyvault secret set-attributes --vault-name <vault> --name CLOUDFLARE_API_TOKEN --expires ${minted.expires}`);
    if (rotating) say(`Rotated: the previous deploy token still exists in Cloudflare; revoke it (API Tokens, name ${minted.name}). Every member needs their new token after secrets:push and a deploy.`);
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
