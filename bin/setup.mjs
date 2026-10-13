// pnpm run setup: stand up a deployment from a short questionnaire, then validate, generate, push secrets, deploy and
// check the live contract. Every step says what it will do, runs, verifies, and records done/todo in the ignored state
// file .chimera-setup/<id>.json, so --resume continues and a finished setup re-run only prints its status.
// (`pnpm setup` is pnpm's own command; use `pnpm run setup`.)
//
//   pnpm run setup [-- --deployment <id>] [--resume] [--answers <file.json>] [--yes]
//
// On a terminal it asks; anywhere else it reads --answers (the chimera-setup skill writes that file). Exit 0: done
// (a manual Cloudflare Access step may remain, printed). Exit 2: waiting for a person (fill secrets.json, or confirm
// with --yes). Exit 1: an error. Secret values (tokens, account ID, Access secret) are never printed: every line goes
// through redact(), and child command output is discarded (runCommand).
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { engineTemplate, identityOf, isMain, loadDeployment, projectRoot, readJson, requirePrivateSecrets, runCommand, validation } from './deployment.mjs';
import { writeWrangler } from './gen-wrangler.mjs';
import { pushSecrets } from './secrets-push.mjs';
import { checkAfterDeploy } from './contract-check.mjs';
import { buildResponder } from './build-responder.mjs';

export const STATE_DIR = '.chimera-setup';
const ID = /^[a-z0-9][a-z0-9_-]*$/;
// Person names: no dash (a dash separates a person from their device), never "all".
const PERSON = /^[a-z0-9][a-z0-9_]*$/;
const PLACEHOLDER = 'REPLACE_ME';

export class Pause extends Error {}

// What a person must answer; everything else is derived. Messages never echo an email or the account ID.
export function checkAnswers(a) {
  const errors = [];
  if (!a || typeof a !== 'object') return ['answers must be a JSON object'];
  if (!ID.test(a.deployment ?? '') || a.deployment === 'all' || a.deployment === 'example') errors.push('deployment: lowercase letters, digits, dash or underscore; not "all" or "example"');
  if (typeof a.displayName !== 'string' || !a.displayName.trim()) errors.push('displayName: required');
  let origin;
  try { origin = new URL(a.origin); } catch {}
  if (!origin || origin.protocol !== 'https:' || origin.origin !== a.origin) errors.push('origin: an HTTPS origin such as https://bridge.example.com (no path)');
  if (!/^[a-fA-F0-9]{32}$/.test(a.accountId ?? '')) errors.push('accountId: the 32-character Cloudflare account ID');
  if (!ID.test(a.workerName ?? '') || a.workerName === 'all') errors.push('workerName: lowercase letters, digits, dash or underscore');
  const people = [...(Array.isArray(a.admins) ? a.admins : []), ...(Array.isArray(a.members) ? a.members : [])];
  if (!Array.isArray(a.admins) || a.admins.length === 0) errors.push('admins: at least one person');
  if (a.members !== undefined && !Array.isArray(a.members)) errors.push('members: a list of people');
  const seen = new Set();
  people.forEach((p, i) => {
    const name = typeof p?.name === 'string' ? p.name : '';
    if (!PERSON.test(name) || name === 'all') errors.push(`person ${i + 1}: name must be lowercase letters, digits or underscore, with no dash${name.includes('-') ? ` ("${name}" has a dash)` : ''}`);
    else if (seen.has(name)) errors.push(`person "${name}" is used twice; every person name is used once`);
    seen.add(name);
    if (typeof p?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.push(`person ${PERSON.test(name) ? `"${name}"` : i + 1}: email must be an email address`);
  });
  if (a.access !== undefined && typeof a.access !== 'boolean' && !(a.access && typeof a.access === 'object' && typeof a.access.enabled === 'boolean')) errors.push('access: true, false or { "enabled": true, "groupId": "<Access group id>" }');
  return errors;
}
const accessOf = a => a?.access === true ? { enabled: true } : a?.access && typeof a.access === 'object' && a.access.enabled ? { enabled: true, groupId: a.access.groupId } : { enabled: false };

// The committed config: the example's engine defaults, this deployment's identity and people, no optional integrations.
export async function configFrom(a) {
  const example = await readJson(path.join(projectRoot, 'deployments/example/bridge.config.json'));
  const people = [...a.admins, ...(a.members ?? [])].map(p => p.name);
  const c = structuredClone(example);
  c.deployment = { id: a.deployment, displayName: a.displayName.trim(), origin: a.origin };
  c.cloudflare = { workerName: a.workerName, workersDev: false, previewUrls: false, observability: true };
  c.members = people.map(name => ({ name, kind: 'person' }));
  c.admins = a.admins.map(p => p.name);
  delete c.github; delete c.cloud; delete c.presentation;
  if (accessOf(a).enabled) c.access = { clientSecret: { env: 'ACCESS_CLIENT_SECRET' } }; else delete c.access;
  // Per-deployment client names, so one machine can later serve two bridges.
  c.clients = { connectorName: a.deployment, launchdLabel: `com.chimera.${a.deployment}-responder`, stateDirName: `.chimera-${a.deployment}` };
  c.hooks = { approvers: c.admins, protectedBranches: ['main'], enabled: [], externalSkills: [], branchPrefix: 'agent/' };
  return c;
}

export function secretsFrom(a) {
  const people = [...a.admins, ...(a.members ?? [])];
  return {
    $schema: '../../config/secrets.schema.json',
    GOONBRIDGE_TOKENS: Object.fromEntries(people.map(p => [p.name, `${PLACEHOLDER}_random_24_plus_characters`])),
    GOONBRIDGE_MEMBERS: Object.fromEntries(people.map(p => [p.email.toLowerCase(), p.name])),
    ...(accessOf(a).enabled ? { ACCESS_CLIENT_SECRET: `${PLACEHOLDER}_access_client_secret` } : {}),
    cloudflare: { accountId: a.accountId },
    CLOUDFLARE_API_TOKEN: `${PLACEHOLDER}_cloudflare_deploy_token`,
    contractToken: a.admins[0].name,
  };
}

// Key paths still holding a placeholder (names only, never values).
export function unfilled(value, at = '') {
  if (typeof value === 'string') return value.includes(PLACEHOLDER) || value.startsWith('FAKE_') ? [at] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => k === '$schema' ? [] : unfilled(v, at ? `${at}.${k}` : k));
}
// Every string in the secrets file except member names and the email map: what redact() hides.
function secretValues(s) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== '$schema' && key !== 'contractToken' && v.length >= 4) out.push(v); }
    else if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) if (k !== 'GOONBRIDGE_MEMBERS') walk(child, k);
  };
  walk(s);
  return out;
}

const STEPS = [
  ['config', 'Write bridge.config.json and deployment.lock.json'],
  ['secrets', 'Create secrets.json (ignored by git) and check every value is filled'],
  ['validate', 'Validate the config, the identity lock and the secrets (validate:deployment)'],
  ['wrangler', 'Generate the Wrangler config, client files and responder (gen:wrangler, build:responder)'],
  ['push', 'Push runtime secrets to the Worker and deploy credentials to GitHub Actions (secrets:push)'],
  ['deploy', 'Deploy the Worker (wrangler deploy)'],
  ['contract', 'Check the live contract (contract:check)'],
  ['access', 'Add each person to the Cloudflare Access group'],
];

export async function setup({
  root = projectRoot, argv = [], env = process.env, isTTY = !!(process.stdin.isTTY && process.stdout.isTTY),
  prompt, run = runCommand, fetchImpl = fetch, out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`),
} = {}) {
  const hidden = new Set();
  const redact = text => [...hidden].sort((x, y) => y.length - x.length).reduce((t, v) => t.split(v).join('[redacted]'), String(text));
  const say = line => out(redact(line));
  const warn = line => err(redact(line));
  let ask = prompt, rl;
  const question = async q => {
    if (!ask) { rl = createInterface({ input: process.stdin, output: process.stdout }); ask = text => rl.question(text); }
    return String(await ask(q)).trim();
  };
  try {
    const opts = parseArgs(argv);
    let answers = null;
    if (opts.answers) {
      try { answers = JSON.parse(await readFile(path.resolve(opts.answers), 'utf8')); } catch { throw new Error('--answers: file missing or not valid JSON (contents not shown)'); }
    }
    if (answers?.accountId) hidden.add(answers.accountId);
    const id = opts.deployment ?? answers?.deployment ?? (opts.resume ? await onlyState(root) : null);
    if (opts.deployment && answers && answers.deployment !== opts.deployment) throw new Error('--deployment and the answers file name different deployments');
    const stateFile = id && ID.test(id) ? path.join(root, STATE_DIR, `${id}.json`) : null;
    let state = stateFile ? await readState(stateFile) : null;
    if (opts.resume && !state) throw new Error(`nothing to resume${id ? ` for "${id}"` : ''}: run setup without --resume first`);
    const dir = id && ID.test(id) ? path.join(root, 'deployments', id) : null;
    const configured = dir && await exists(path.join(dir, 'bridge.config.json'));
    if (!state?.steps?.config && !configured && !answers) {
      if (!isTTY) throw new Error('not a terminal: pass --answers <file.json> (see .claude/skills/chimera-setup/SKILL.md)');
      answers = await questionnaire(question, id, say);
      hidden.add(answers.accountId);
    }
    if (answers) {
      const problems = checkAnswers(answers);
      if (problems.length) throw new Error(`answers need fixing:\n  - ${problems.join('\n  - ')}`);
    }
    const deployment = id ?? answers.deployment;
    const file = path.join(root, STATE_DIR, `${deployment}.json`);
    state ??= { deployment, access: answers ? accessOf(answers).enabled : null, steps: {} };
    if (answers) { state.access = accessOf(answers).enabled; if (accessOf(answers).groupId) state.accessGroup = String(accessOf(answers).groupId); }
    const save = async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(state, null, 2)}\n`); };
    const mark = async (step, status, note) => { state.steps[step] = { status, at: new Date().toISOString(), ...(note ? { note } : {}) }; await save(); };
    const confirm = async what => {
      if (opts.yes) return true;
      if (!isTTY) throw new Pause(`waiting for confirmation: re-run with --resume --yes to ${what}`);
      return /^y(es)?$/i.test(await question(`${what}? [y/N] `));
    };
    const ddir = path.join(root, 'deployments', deployment);
    let secrets = null;
    const loadSecrets = async () => {
      const f = await requirePrivateSecrets(root, deployment);
      const s = await readJson(f);
      for (const v of secretValues(s)) hidden.add(v);
      return s;
    };
    let paused = null;
    for (const [step, title] of STEPS) {
      if (step === 'access' && state.access === false) continue;
      const n = STEPS.findIndex(([s]) => s === step) + 1;
      if (state.steps[step]?.status === 'done') { say(`[${n}/${STEPS.length}] ${title}: done`); continue; }
      say(`[${n}/${STEPS.length}] ${title} ...`);
      try {
        if (step === 'config') {
          if (await exists(path.join(ddir, 'bridge.config.json'))) say('  deployments/' + deployment + '/bridge.config.json exists; keeping it');
          else {
            if (!answers) throw new Error('no answers to write the config from: pass --answers');
            const config = await configFrom(answers);
            const lock = identityOf(config, await engineTemplate());
            await mkdir(ddir, { recursive: true });
            await writeFile(path.join(ddir, 'bridge.config.json'), `${JSON.stringify({ $schema: '../../config/bridge.config.schema.json', ...config }, null, 2)}\n`);
            await writeFile(path.join(ddir, 'deployment.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
            say(`  wrote deployments/${deployment}/bridge.config.json and deployment.lock.json (commit both)`);
          }
          const { config } = await loadDeployment({ root, deployment });
          if (state.access === null) state.access = !!config.access;
          await mark(step, 'done');
        } else if (step === 'secrets') {
          const target = path.join(ddir, 'secrets.json');
          if (!await exists(target)) {
            if (!ignored(root, `deployments/${deployment}/secrets.json`)) throw new Error('secrets.json must be gitignored before it is written (deployments/*/secrets.json)');
            if (!answers) throw new Error('secrets.json is missing and there are no answers to create it from: pass --answers');
            await writeFile(target, `${JSON.stringify(secretsFrom(answers), null, 2)}\n`, { mode: 0o600 });
            say(`  created deployments/${deployment}/secrets.json (ignored by git; never commit it)`);
          }
          secrets = await loadSecrets();
          const todo = unfilled(secrets);
          if (todo.length) {
            await mark(step, 'todo', `fill: ${todo.join(', ')}`);
            say(`  fill these values in deployments/${deployment}/secrets.json, then run: pnpm run setup -- --deployment ${deployment} --resume`);
            for (const key of todo) say(`    - ${key}${/^GOONBRIDGE_TOKENS\./.test(key) ? ' (a random string of 24+ characters, e.g. openssl rand -hex 24)' : key === 'CLOUDFLARE_API_TOKEN' ? ' (Cloudflare API token that can deploy this Worker)' : ''}`);
            say('  pnpm secrets:mint will fill the tokens for you in a later release; it is not available yet.');
            paused = 'secrets'; break;
          }
          await mark(step, 'done');
        } else if (step === 'validate') {
          const { config } = await loadDeployment({ root, deployment });
          secrets ??= await loadSecrets();
          (await validation()).validateSecrets(secrets, config);
          await mark(step, 'done');
        } else if (step === 'wrangler') {
          secrets ??= await loadSecrets();
          await writeWrangler({ root, deployment, accountId: secrets.cloudflare.accountId });
          const { config } = await loadDeployment({ root, deployment });
          await mkdir(path.join(root, 'bin'), { recursive: true });
          await buildResponder({ config, root });
          if (!await exists(path.join(root, '.generated', `wrangler.${deployment}.jsonc`))) throw new Error('generated Wrangler config missing');
          await mark(step, 'done');
        } else if (step === 'push') {
          await pushSecrets({ root, deployment, dryRun: true, run, log: line => say(`  ${line}`) });
          if (!await confirm('push these secrets now')) { await mark(step, 'todo', 'not confirmed'); paused = step; break; }
          await pushSecrets({ root, deployment, run, log: line => say(`  ${line}`) });
          await mark(step, 'done');
        } else if (step === 'deploy') {
          secrets ??= await loadSecrets();
          const config = `.generated/wrangler.${deployment}.jsonc`;
          say(`  will run: pnpm exec wrangler deploy -c ${config}`);
          if (!await confirm('deploy now')) { await mark(step, 'todo', 'not confirmed'); paused = step; break; }
          await deploy(run, root, config, secrets, env, deployment);
          await mark(step, 'done');
        } else if (step === 'contract') {
          secrets ??= await loadSecrets();
          const { config } = await loadDeployment({ root, deployment });
          const pkg = await readJson(path.join(projectRoot, 'package.json'));
          await checkAfterDeploy({ origin: config.deployment.origin, token: secrets.GOONBRIDGE_TOKENS[secrets.contractToken], expectedEngine: pkg.version, fetchImpl,
            redeploy: () => deploy(run, root, `.generated/wrangler.${deployment}.jsonc`, secrets, env, deployment), log: line => say(`  ${line}`) });
          await mark(step, 'done');
        } else if (step === 'access') {
          secrets ??= await loadSecrets();
          const emails = Object.keys(secrets.GOONBRIDGE_MEMBERS ?? {});
          const group = state.accessGroup;
          const token = env.CLOUDFLARE_ACCESS_TOKEN;
          if (token) hidden.add(token);
          if (token && group && emails.length && await confirm(`add ${emails.length} email(s) to Access group ${group} through the Cloudflare API`)) {
            await addToAccessGroup(fetchImpl, secrets.cloudflare.accountId, group, token, emails);
            say(`  added ${emails.length} email(s) to the Access group`);
            await mark(step, 'done');
          } else {
            say('  Cloudflare Access guards this bridge: each person must also be in its Access group (Zero Trust > Access > Access groups):');
            for (const email of emails) say(`    - add ${email} to the Access group`);
            say('  With a Cloudflare API token that can edit Access groups in CLOUDFLARE_ACCESS_TOKEN and access.groupId in the answers, setup does it for you.');
            await mark(step, 'manual', 'add each email to the Access group');
          }
        }
        if (state.steps[step]?.status === 'done') say('  done');
      } catch (error) {
        if (error instanceof Pause) { await mark(step, 'todo', 'waiting for confirmation'); throw error; }
        await mark(step, 'todo', 'failed; see the message and re-run with --resume');
        throw error;
      }
    }
    say(status(state));
    if (paused) return 2;
    return 0;
  } catch (error) {
    if (error instanceof Pause) { say(error.message); return 2; }
    warn(`setup: ${error.message}`);
    return 1;
  } finally {
    rl?.close();
  }
}

function status(state) {
  const lines = STEPS.filter(([s]) => s !== 'access' || state.access !== false)
    .map(([s, title]) => `  ${(state.steps[s]?.status ?? 'todo').padEnd(6)} ${title}`);
  return `Setup status for ${state.deployment}:\n${lines.join('\n')}`;
}

async function deploy(run, root, config, secrets, env, deployment) {
  try {
    await run('pnpm', ['exec', 'wrangler', 'deploy', '-c', config], { cwd: root,
      env: { ...env, CHIMERA_DEPLOYMENT: deployment, CLOUDFLARE_ACCOUNT_ID: secrets.cloudflare.accountId, CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN } });
  } catch { throw new Error('wrangler deploy failed (output not shown, it may hold secrets); run it by hand to see why'); }
}

// Cloudflare API: read the group, append the missing emails to its include rules, write it back. Errors carry no body.
export async function addToAccessGroup(fetchImpl, accountId, groupId, token, emails) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/groups/${encodeURIComponent(groupId)}`;
  const call = async (method, body) => {
    let res;
    try { res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error' }); }
    catch { throw new Error('Cloudflare Access API request failed'); }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || !data?.success) throw new Error(`Cloudflare Access API refused the ${method} (${res.status}); add the emails by hand`);
    return data.result;
  };
  const group = await call('GET');
  const have = new Set((group.include ?? []).map(r => r.email?.email?.toLowerCase()).filter(Boolean));
  const include = [...(group.include ?? []), ...emails.filter(e => !have.has(e.toLowerCase())).map(email => ({ email: { email } }))];
  await call('PUT', { name: group.name, include, ...(group.exclude ? { exclude: group.exclude } : {}), ...(group.require ? { require: group.require } : {}) });
}

async function questionnaire(question, id, say) {
  say('Chimera setup. Only these questions need a person; the rest is derived. Emails and the account ID go into the ignored secrets.json only.');
  const askUntil = async (q, ok, why) => { for (;;) { const v = await question(q); if (ok(v)) return v; say(`  ${why}`); } };
  const a = {};
  a.deployment = id ?? await askUntil('Deployment id (folder name under deployments/, e.g. acme): ', v => ID.test(v) && !['all', 'example'].includes(v), 'lowercase letters, digits, dash or underscore');
  a.displayName = await askUntil('Display name: ', v => !!v, 'required');
  a.origin = await askUntil('Origin (https://bridge.example.com): ', v => { try { return new URL(v).origin === v && v.startsWith('https://'); } catch { return false; } }, 'an HTTPS origin with no path');
  a.accountId = await askUntil('Cloudflare account ID (32 hex characters): ', v => /^[a-fA-F0-9]{32}$/.test(v), 'the 32-character account ID from the Cloudflare dashboard');
  a.workerName = await askUntil(`Worker name [${a.deployment}-bridge]: `, v => !v || ID.test(v), 'lowercase letters, digits, dash or underscore') || `${a.deployment}-bridge`;
  const people = async (label, min) => {
    const used = () => [...(a.admins ?? []), ...(a.members ?? [])].map(p => p.name);
    for (;;) {
      const names = (await question(`${label} (comma-separated person names, no dashes): `)).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = names.filter(n => !PERSON.test(n) || n === 'all');
      const dup = names.filter((n, i) => names.indexOf(n) !== i || used().includes(n));
      if (bad.length) { say(`  no dashes or other characters in person names: ${bad.join(', ')}`); continue; }
      if (dup.length) { say(`  each person name is used once: ${[...new Set(dup)].join(', ')}`); continue; }
      if (names.length < min) { say('  at least one'); continue; }
      const list = [];
      for (const name of names) list.push({ name, email: await askUntil(`  ${name}'s sign-in email: `, v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'an email address') });
      return list;
    }
  };
  a.admins = await people('Admins', 1);
  a.members = await people('Other members (blank for none)', 0);
  if (/^y(es)?$/i.test(await question('Is Cloudflare Access in front of the bridge (sign-in by email)? [y/N] '))) {
    const groupId = await question('  Access group id, to add the emails through the API (blank to do it by hand): ');
    a.access = { enabled: true, ...(groupId ? { groupId } : {}) };
  } else a.access = false;
  return a;
}

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (a === '--answers') o.answers = args[++i];
    else if (a === '--resume') o.resume = true;
    else if (a === '--yes') o.yes = true;
    else throw new Error(`unsupported option ${JSON.stringify(a)}; use --deployment <id>, --answers <file.json>, --resume, --yes`);
  }
  if (o.deployment !== undefined && (!ID.test(o.deployment) || o.deployment === 'all')) throw new Error('invalid --deployment id');
  if ('answers' in o && !o.answers) throw new Error('--answers needs a file');
  return o;
}

async function onlyState(root) {
  let files = [];
  try { files = (await readdir(path.join(root, STATE_DIR))).filter(f => f.endsWith('.json')); } catch {}
  if (files.length !== 1) throw new Error(files.length ? 'several setups in progress: name one with --deployment <id>' : 'nothing to resume: run setup without --resume first');
  return files[0].slice(0, -5);
}
async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
async function exists(file) {
  try { await lstat(file); return true; } catch { return false; }
}
function ignored(root, rel) {
  try { execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'pipe' }); return true; } catch { return false; }
}

if (isMain(import.meta.url)) process.exitCode = await setup({ argv: process.argv.slice(2) });
