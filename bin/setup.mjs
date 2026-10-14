// pnpm run setup: stand up a deployment from a short questionnaire, then validate, generate, push secrets, deploy and
// check the live contract. Every step says what it will do, runs, verifies, and records done/todo in the ignored state
// file .chimera-setup/<id>.json, so --resume continues and a finished setup re-run only prints its status.
// (`pnpm setup` is pnpm's own command; use `pnpm run setup`.)
//
//   pnpm run setup [-- --deployment <id>] [--resume] [--answers <file.json>] [--yes]
//   pnpm run setup -- --prereqs     step 0 only: the checklist of what this machine needs
//   pnpm run setup -- --detect      what setup can find out by itself, as JSON (bin/setup-detect.mjs)
//   pnpm run setup -- --token-steps the 6 numbered steps to create the master token in the Cloudflare dashboard
//
// Text the person must see word for word sits between a "--- show this ---" line and a "--- end ---" line; the
// chimera-setup skill relays those blocks verbatim (prerequisites, pauses, needs-answer lists, status checklists).
//
// A new setup starts with step 0 (prerequisites) and stops on the first missing one. Then it detects what it can
// (Cloudflare account, domains, git email as the first admin, defaults); --answers wins over detection, and on a
// terminal it asks only for the rest. Without a terminal, missing answers exit 2 with a "needs-answer" list.
// Exit 0: done (a manual Cloudflare Access step may remain, printed). Exit 2: waiting for a person (a prerequisite,
// an answer, secrets to mint, or a confirmation with --yes). Exit 1: an error. Secret values (tokens, account ID, Access secret) are never printed: every line goes
// through redact(), and child command output is discarded (runCommand).
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { engineTemplate, identityOf, isMain, loadDeployment, projectRoot, readJson, requirePrivateSecrets, runCommand, validation } from './deployment.mjs';
import { writeWrangler } from './gen-wrangler.mjs';
import { pushSecrets } from './secrets-push.mjs';
import { checkAfterDeploy } from './contract-check.mjs';
import { makeRedactor } from './secrets-common.mjs';
import { mintSecrets } from './secrets-mint.mjs';
import { buildResponder } from './build-responder.mjs';
import { STATE_DIR, accessAnswer, capture, detect, formatPrereqs, howToGet, mergeAnswers, prereqs, prereqsOk, publicView } from './setup-detect.mjs';

export { STATE_DIR };
const ID = /^[a-z0-9][a-z0-9_-]*$/;
// Person names: no dash (a dash separates a person from their device), never "all".
const PERSON = /^[a-z0-9][a-z0-9_]*$/;
const PLACEHOLDER = 'REPLACE_ME';

export class Pause extends Error {}

export const SHOW = '--- show this ---', SHOW_END = '--- end ---';
const shown = text => `${SHOW}\n${text}\n${SHOW_END}`;
// The one place the master-token walkthrough lives; --token-steps prints it, the skill's "Show me the steps again" runs it.
export const TOKEN_STEPS = [
  '1. Open https://dash.cloudflare.com/profile/api-tokens (Cloudflare dashboard > My Profile > API Tokens).',
  '2. Click Create Token, then Create Custom Token > Get started.',
  '3. Give it a name, such as "chimera master", and add one permission: Account / API Tokens / Edit. Nothing else.',
  '4. Under TTL, set the end date one year from today.',
  '5. Click Continue to summary, then Create Token.',
  '6. Copy the token into your password manager now (Cloudflare shows it once), then run pnpm secrets:mint -- --deployment <id> in your own terminal and paste it at the hidden prompt.',
];

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
  c.cloudflare = { workerName: a.workerName, workersDev: new URL(a.origin).host.endsWith('.workers.dev'), previewUrls: false, observability: true };
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
  ['config', 'writing the bridge settings (bridge.config.json and deployment.lock.json)'],
  ['secrets', 'creating the secrets file (secrets.json, never committed) and its tokens'],
  ['validate', 'checking the settings and the secrets fit together'],
  ['wrangler', 'generating the Worker config and the client files'],
  ['push', 'pushing secrets to Cloudflare (and to GitHub Actions when gh is set up)'],
  ['deploy', 'deploying the Worker to Cloudflare'],
  ['contract', 'checking the live bridge answers correctly'],
  ['access', 'adding each person to the Cloudflare Access group'],
];

export async function setup({
  root = projectRoot, argv = [], env = process.env, isTTY = !!(process.stdin.isTTY && process.stdout.isTTY),
  prompt, run = runCommand, fetchImpl = fetch, detector = ({ answers }) => detect({ root, env, run: capture, answers }), out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`),
} = {}) {
  const { hide, redact } = makeRedactor();
  const say = line => out(redact(line));
  const warn = line => err(redact(line));
  let ask = prompt, rl;
  const question = async q => {
    if (!ask) { rl = createInterface({ input: process.stdin, output: process.stdout }); ask = text => rl.question(text); }
    return String(await ask(q)).trim();
  };
  try {
    const opts = parseArgs(argv);
    if (opts.detect) { out(JSON.stringify(publicView(await detector({ answers: {} })), null, 2)); return 0; }
    if (opts.tokenSteps) { say(shown(['Create the master token:', ...TOKEN_STEPS].join('\n'))); return 0; }
    if (opts.prereqs) { const list = prereqs(await detector({ answers: {} })); say(shown(formatPrereqs(list))); return prereqsOk(list) ? 0 : 2; }
    let answers = null;
    if (opts.answers) {
      try { answers = JSON.parse(await readFile(path.resolve(opts.answers), 'utf8')); } catch { throw new Error('--answers: file missing or not valid JSON (contents not shown)'); }
    }
    if (answers?.accountId) hide(answers.accountId);
    if (answers) answers.access = accessAnswer(answers.access);
    const id = opts.deployment ?? answers?.deployment ?? (opts.resume ? await onlyState(root) : null);
    if (opts.deployment && answers?.deployment && answers.deployment !== opts.deployment) throw new Error('--deployment and the answers file name different deployments');
    const stateFile = id && ID.test(id) ? path.join(root, STATE_DIR, `${id}.json`) : null;
    let state = stateFile ? await readState(stateFile) : null;
    if (opts.resume && !state) throw new Error(`nothing to resume${id ? ` for "${id}"` : ''}: run setup without --resume first`);
    const dir = id && ID.test(id) ? path.join(root, 'deployments', id) : null;
    const configured = dir && await exists(path.join(dir, 'bridge.config.json'));
    if (!state?.steps?.config && !configured) {
      // Step 0, then detection: --answers wins, detection fills the rest, a terminal asks for what is left.
      const given = { ...(answers ?? {}), ...(id ? { deployment: id } : {}) };
      const report = await detector({ answers: given });
      for (const a of report.fields.accounts.value ?? []) hide(a.id);
      const list = prereqs(report);
      say(shown(formatPrereqs(list)));
      if (!prereqsOk(list)) return 2;
      let merged = mergeAnswers(given, report);
      if (isTTY && (!answers || merged.missing.length)) merged = mergeAnswers(await questionnaire(question, say, report, given), report);
      if (merged.missing.length) {
        say(shown([`Setup needs a person to answer these first (needs-answer): ${merged.missing.join(', ')}`,
          ...merged.missing.map(key => `  - ${key}: ${howToGet(report, key)}`),
          'Add them to the answers file and run: pnpm run setup -- --answers <file.json>'].join('\n')));
        return 2;
      }
      answers = merged.answers;
      if (answers.accountId) hide(answers.accountId);
    }
    if (answers) {
      const problems = checkAnswers(answers);
      if (problems.length) throw new Error(`answers need fixing:\n  - ${problems.join('\n  - ')}`);
    }
    const deployment = id ?? answers.deployment;
    const file = path.join(root, STATE_DIR, `${deployment}.json`);
    state ??= { deployment, access: answers ? accessOf(answers).enabled : null, steps: {} };
    if (answers) state.github = answers.githubActions !== false;
    if (opts.resume) say(shown(status(state, `Where setup stands for ${deployment}:`)));
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
      for (const v of secretValues(s)) hide(v);
      return s;
    };
    let paused = null;
    for (const [step, title] of STEPS) {
      if (step === 'access' && state.access === false) continue;
      const total = state.access === false ? STEPS.length - 1 : STEPS.length;
      const n = STEPS.findIndex(([s]) => s === step) + 1;
      if (state.steps[step]?.status === 'done') { say(`Step ${n} of ${total}: ${title}: already done`); continue; }
      say(`Step ${n} of ${total}: ${title}`);
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
            // A new file holds placeholders: secrets:mint fills them when a minter token is at hand (env or terminal).
            if (env.CHIMERA_TOKEN_MINTER || isTTY) {
              say('  secrets:mint: generating member tokens and minting the deploy token ...');
              rl?.close(); rl = null; ask = prompt;
              const code = await mintSecrets({ root, argv: ['--deployment', deployment], env, isTTY, ask: prompt, fetchImpl, offerPush: false,
                out: line => say(`  ${line}`), err: line => warn(`  ${line}`) });
              if (code !== 0) say('  secrets:mint did not finish; the placeholders below remain.');
            }
          }
          secrets = await loadSecrets();
          const todo = unfilled(secrets);
          if (todo.length) {
            await mark(step, 'todo', `fill: ${todo.join(', ')}`);
            say(shown([`  Result: waiting for the tokens (${todo.join(', ')}).`,
              `  Next: run pnpm secrets:mint -- --deployment ${deployment} in your own terminal. It asks for the one master token (typing stays hidden) and makes every other token.`,
              '  The master token: https://dash.cloudflare.com/profile/api-tokens > Create Token > Create Custom Token > permission Account / API Tokens / Edit, nothing else, TTL 1 year.',
              `  Already hold the values? pnpm secrets:fill -- --deployment ${deployment} enters them instead.`,
              `  Then: pnpm run setup -- --deployment ${deployment} --resume`].join('\n')));
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
          const github = state.github !== false;
          if (!github) say('  gh is not set up, so the GitHub Actions secrets are skipped');
          await pushSecrets({ root, deployment, dryRun: true, github, run, log: line => say(`  ${line}`) });
          if (!await confirm('push these secrets now')) { await mark(step, 'todo', 'not confirmed'); paused = step; break; }
          await pushSecrets({ root, deployment, github, run, log: line => say(`  ${line}`) });
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
          if (token) hide(token);
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
        if (state.steps[step]?.status === 'done') say('  Result: done');
        else if (state.steps[step]?.status === 'manual') say('  Result: one manual step left (above)');
      } catch (error) {
        if (error instanceof Pause) { await mark(step, 'todo', 'waiting for confirmation'); say('  Result: waiting for your yes'); throw error; }
        say('  Result: failed (the reason follows)');
        await mark(step, 'todo', 'failed; see the message and re-run with --resume');
        throw error;
      }
    }
    say(shown(status(state)));
    if (paused) return 2;
    return 0;
  } catch (error) {
    if (error instanceof Pause) { say(shown(error.message)); return 2; }
    warn(`setup: ${error.message}`);
    return 1;
  } finally {
    rl?.close();
  }
}

function status(state, heading = `Setup status for ${state.deployment}:`) {
  const lines = STEPS.filter(([s]) => s !== 'access' || state.access !== false)
    .map(([s, title]) => `  [${state.steps[s]?.status ?? 'todo'}] ${title}`);
  return `${heading}\n${lines.join('\n')}`;
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

// On a terminal: ask, one thing at a time, only what the answers file did not give, offering what detection found.
async function questionnaire(question, say, report, given) {
  say('A few questions; press Enter to take the suggestion in [brackets]. Emails and the account ID go only into the ignored secrets.json.');
  const f = report.fields;
  const askUntil = async (q, ok, why, fallback) => {
    for (;;) { const v = (await question(fallback ? `${q} [${fallback}]: ` : `${q}: `)) || fallback || ''; if (ok(v)) return v; say(`  ${why}`); }
  };
  const a = { ...given };
  a.deployment ??= await askUntil('Short name for this bridge (becomes the folder deployments/<name>/)', v => ID.test(v) && !['all', 'example'].includes(v), 'lowercase letters, digits, dash or underscore', f.deployment.value);
  a.displayName ??= await askUntil('Name people see for the bridge', v => !!v, 'required', f.displayName.source === 'needs-answer' ? '' : `${a.deployment === f.deployment.value ? f.displayName.value : `${a.deployment} bridge`}`);
  if (!a.origin) {
    const choices = f.origin.choices ?? ['workers.dev'];
    say('Where should the bridge live?');
    choices.forEach((c, i) => say(`  ${i + 1}) ${c === 'workers.dev' ? 'no custom domain: a free workers.dev address' : c}`));
    const v = await askUntil('Pick a number or type an https:// address', v => !!choices[Number(v) - 1] || isOrigin(v) || v === 'workers.dev', 'a number from the list, or an HTTPS address with no path', f.origin.value === 'workers.dev' ? String(choices.indexOf('workers.dev') + 1) : '');
    a.origin = choices[Number(v) - 1] ?? v;
  }
  if (!a.accountId && f.accountId.source === 'needs-answer') {
    a.accountId = await askUntil(`Cloudflare account ID (${f.accountId.howToGet})`, v => /^[a-fA-F0-9]{32}$/.test(v), 'the 32-character account ID');
  }
  a.workerName ??= await askUntil('Worker name (the Cloudflare service that runs the bridge)', v => ID.test(v), 'lowercase letters, digits, dash or underscore', `${a.deployment}-bridge`);
  const people = async (label, min, suggested) => {
    const used = () => [...(a.admins ?? []), ...(a.members ?? [])].map(p => p.name);
    for (;;) {
      const raw = await question(`${label} (person names separated by commas, no dashes)${suggested ? ` [${suggested.map(p => `${p.name} <${p.email}>`).join(', ')}]` : ''}: `);
      if (!raw && suggested) return suggested;
      const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = names.filter(n => !PERSON.test(n) || n === 'all');
      const dup = names.filter((n, i) => names.indexOf(n) !== i || used().includes(n));
      if (bad.length) { say(`  no dashes or other characters in person names: ${bad.join(', ')}`); continue; }
      if (dup.length) { say(`  each person name is used once: ${[...new Set(dup)].join(', ')}`); continue; }
      if (names.length < min) { say('  at least one'); continue; }
      const list = [];
      for (const name of names) list.push({ name, email: await askUntil(`  ${name}'s sign-in email`, v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'an email address') });
      return list;
    }
  };
  a.admins ??= await people('Admins (they open the status and settings pages)', 1, f.admins.source === 'needs-answer' ? null : f.admins.value);
  a.members ??= await people('Other people (blank for none)', 0);
  if (a.access === undefined) {
    say('Cloudflare Access is a sign-in screen Cloudflare can put in front of the bridge. Without it, people sign in with a token.');
    a.access = /^y(es)?$/i.test(await question('Is Cloudflare Access already in front of this domain? [y/N] '));
  }
  return a;
}
const isOrigin = v => { try { return new URL(v).origin === v && v.startsWith('https://'); } catch { return false; } };

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (a === '--answers') o.answers = args[++i];
    else if (a === '--resume') o.resume = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--detect') o.detect = true;
    else if (a === '--prereqs') o.prereqs = true;
    else if (a === '--token-steps') o.tokenSteps = true;
    else throw new Error(`unsupported option ${JSON.stringify(a)}; use --deployment <id>, --answers <file.json>, --resume, --yes, --prereqs, --detect, --token-steps`);
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
