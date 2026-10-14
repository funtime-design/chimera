// The setup engine: every step of `pnpm run setup` as plain functions with no terminal of their own. The terminal
// (bin/setup.mjs) and the browser page (bin/setup-web.mjs) both call these and share one state file,
// .chimera-setup/<id>.json, so a setup started in one can finish in the other.
//
// Nothing here prints a secret: every line goes out through the caller's say(), which redacts the values handed to
// hide(); child command output is discarded (runCommand).
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { engineTemplate, identityOf, loadDeployment, projectRoot, readJson, requirePrivateSecrets, runCommand, validation } from './deployment.mjs';
import { writeWrangler } from './gen-wrangler.mjs';
import { pushSecrets } from './secrets-push.mjs';
import { checkAfterDeploy } from './contract-check.mjs';
import { mintSecrets } from './secrets-mint.mjs';
import { buildResponder } from './build-responder.mjs';
import { provisionAccess } from './access-provision.mjs';
import { STATE_DIR } from './setup-detect.mjs';
import { guideHeading, guideLines, guideSource, parseGuide } from './guides.mjs';

export { STATE_DIR };
export const ID = /^[a-z0-9][a-z0-9_-]*$/;
// Person names: no dash (a dash separates a person from their device), never "all".
export const PERSON = /^[a-z0-9][a-z0-9_]*$/;
export const PLACEHOLDER = 'REPLACE_ME';

export class Pause extends Error {}

export const SHOW = '--- show this ---', SHOW_END = '--- end ---';
// The sign-in question, word for word in the skill (Q6) and on a terminal.
export const SIGNIN_EXPLAINED = 'Cloudflare Access is Cloudflare\'s free login screen: it emails a one-time code and lets in only the emails on your list. No tokens for people; tokens are only for scripts and cloud sessions.';
export const SIGNIN_OPTIONS = {
  provision: 'Email code via Cloudflare Access (recommended; setup creates it for you)',
  existing: 'I already have an Access app, use it (paste its client id when asked)',
};
export const shown = text => `${SHOW}\n${text}\n${SHOW_END}`;
// The master-token walkthrough: one copy, docs/guides/master-token.md (bin/guides.mjs). --token-steps prints it with its
// screenshot paths, the secrets pause shows it, and the browser page renders it.
export const TOKEN_STEPS = parseGuide(guideSource('master-token')).steps.map(s => `${s.n}. ${s.text}`);

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
  if (a.access !== undefined && a.access !== false && !ACCESS_MODES.includes(accessOf(a))) errors.push('access: "provision" (setup creates the sign-in), "existing" (you have an Access app) or false (no human sign-in, tokens only)');
  if (a.accessClientId !== undefined && (typeof a.accessClientId !== 'string' || !/^\S+$/.test(a.accessClientId))) errors.push('accessClientId: the client id of your Access for SaaS app (no spaces)');
  return errors;
}
export const ACCESS_MODES = ['provision', 'existing'];
// The sign-in mode: "provision", "existing" or false. true and { enabled: true } are the old "already in front" answer.
export const accessOf = a => {
  const v = a?.access;
  if (v === true || (v && typeof v === 'object' && v.enabled === true)) return 'existing';
  return ACCESS_MODES.includes(v) ? v : v === undefined || v === false || (v && typeof v === 'object' && v.enabled === false) ? false : v;
};
export const modeOf = state => state.access === true ? 'existing' : state.access || false;

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
  // "existing": the person's own app, its client id from the answers. "provision": access:provision writes the block.
  if (accessOf(a) === 'existing') c.access = { ...(a.accessClientId ? { clientId: a.accessClientId } : {}), clientSecret: { env: 'ACCESS_CLIENT_SECRET' } }; else delete c.access;
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
    ...(accessOf(a) === 'existing' ? { ACCESS_CLIENT_SECRET: `${PLACEHOLDER}_access_client_secret` } : {}),
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
export function secretValues(s) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== '$schema' && key !== 'contractToken' && v.length >= 4) out.push(v); }
    else if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) if (k !== 'GOONBRIDGE_MEMBERS') walk(child, k);
  };
  walk(s);
  return out;
}

export const STEPS = [
  ['config', 'writing the bridge settings (bridge.config.json and deployment.lock.json)'],
  ['secrets', 'creating the secrets file (secrets.json, never committed) and its tokens'],
  ['signin', 'creating the sign-in (Cloudflare Access)'],
  ['validate', 'checking the settings and the secrets fit together'],
  ['wrangler', 'generating the Worker config and the client files'],
  ['push', 'pushing secrets to Cloudflare (and to GitHub Actions when gh is set up)'],
  ['deploy', 'deploying the Worker to Cloudflare'],
  ['contract', 'checking the live bridge answers correctly'],
];


// The sign-in step runs only when people sign in through Access.
export const activeSteps = state => STEPS.filter(([s]) => s !== 'signin' || modeOf(state));
// The first active step that is not done, or null when setup is finished.
export const currentStep = state => activeSteps(state).find(([s]) => state.steps?.[s]?.status !== 'done')?.[0] ?? null;
export function status(state, heading = `Setup status for ${state.deployment}:`) {
  const lines = activeSteps(state).map(([s, title]) => `  [${state.steps[s]?.status ?? 'todo'}] ${title}`);
  return `${heading}\n${lines.join('\n')}`;
}
// The one command that fills the tokens; the pause message and the browser page both show it.
export const mintCommand = state => `pnpm secrets:mint -- --deployment ${state.deployment}${modeOf(state) ? ' --access-token' : ''}`;

export const stateFileOf = (root, id) => path.join(root, STATE_DIR, `${id}.json`);
export async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
export async function saveState(root, state) {
  const file = stateFileOf(root, state.deployment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
export async function onlyState(root) {
  let files = [];
  try { files = (await readdir(path.join(root, STATE_DIR))).filter(f => f.endsWith('.json')); } catch {}
  if (files.length !== 1) throw new Error(files.length ? 'several setups in progress: name one with --deployment <id>' : 'nothing to resume: run setup without --resume first');
  return files[0].slice(0, -5);
}
export async function exists(file) {
  try { await lstat(file); return true; } catch { return false; }
}
function ignored(root, rel) {
  try { execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'pipe' }); return true; } catch { return false; }
}

// The secrets file read through the guard, every value handed to hide(), and the keys still holding a placeholder.
async function loadSecrets(root, deployment, hide) {
  const s = await readJson(await requirePrivateSecrets(root, deployment));
  for (const v of secretValues(s)) hide(v);
  return s;
}

// The secrets step finishes outside setup (secrets:mint or secrets:fill in the person's own terminal). This notices it:
// once the settings are written and the file holds no placeholder, the step is marked done. Reads only key paths, never
// returns a value. Returns the state, updated or not.
export async function refreshSecretsStep(root, state) {
  if (!state || state.steps?.config?.status !== 'done' || state.steps?.secrets?.status === 'done') return state;
  try {
    const todo = unfilled(await loadSecrets(root, state.deployment, () => {}));
    if (todo.length) return state;
  } catch { return state; }
  state.steps.secrets = { status: 'done', at: new Date().toISOString() };
  await saveState(root, state);
  return state;
}

// The steps, in order, from the first one not done. Both the terminal (bin/setup.mjs) and the browser page
// (bin/setup-web.mjs) call this; neither repeats a step. Every printed line goes through say(), which the caller
// redacts. `until` stops after that step. `yes` answers the push and deploy confirmations; without it, a terminal
// asks (question) and anything else throws Pause. Returns 0 (done or stopped at `until`) or 2 (waiting for a person);
// throws Pause (a confirmation) or an Error (exit 1), after marking the step todo.
export async function runSteps({
  root = projectRoot, state, answers = null, until = null, yes = false, isTTY = false, question, prompt, releaseTerminal = () => {},
  run = runCommand, fetchImpl = fetch, env = process.env, say, warn = say, hide = () => {},
}) {
  const deployment = state.deployment;
  const mark = async (step, status, note) => { state.steps[step] = { status, at: new Date().toISOString(), ...(note ? { note } : {}) }; await saveState(root, state); };
  const confirm = async what => {
    if (yes) return true;
    if (!isTTY || !question) throw new Pause(`waiting for confirmation: re-run with --resume --yes to ${what}`);
    return /^y(es)?$/i.test(await question(`${what}? [y/N] `));
  };
  const ddir = path.join(root, 'deployments', deployment);
  let secrets = null;
  const secretsNow = async () => secrets ??= await loadSecrets(root, deployment, hide);
  let paused = null;
  for (const [step, title] of STEPS) {
    const active = activeSteps(state);
    if (!active.some(([s]) => s === step)) continue;
    const total = active.length;
    const n = active.findIndex(([s]) => s === step) + 1;
    if (state.steps[step]?.status === 'done') { say(`Step ${n} of ${total}: ${title}: already done`); if (step === until) break; continue; }
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
        if (state.access === null) state.access = config.access ? 'existing' : false;
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
            releaseTerminal();
            const code = await mintSecrets({ root, argv: ['--deployment', deployment, ...(modeOf(state) ? ['--access-token'] : [])], env, isTTY, ask: prompt, fetchImpl, offerPush: false,
              out: line => say(`  ${line}`), err: line => warn(`  ${line}`) });
            if (code !== 0) say('  secrets:mint did not finish; the placeholders below remain.');
          }
        }
        const todo = unfilled(await secretsNow());
        if (todo.length) {
          await mark(step, 'todo', `fill: ${todo.join(', ')}`);
          say(shown([`  Result: waiting for the tokens (${todo.join(', ')}).`,
            `  Next: run ${mintCommand(state)} in your own terminal. It asks for the one master token (typing stays hidden) and makes every other token.`,
            `  The master token. ${guideHeading('master-token')}`,
            ...guideLines('master-token', { 'pnpm secrets:mint -- --deployment <id>': mintCommand(state), '<id>': deployment }).map(l => `    ${l}`),
            `  Already hold the values? pnpm secrets:fill -- --deployment ${deployment} enters them instead.`,
            `  Then: pnpm run setup -- --deployment ${deployment} --resume`].join('\n')));
          paused = 'secrets'; break;
        }
        await mark(step, 'done');
      } else if (step === 'signin') {
        // access:provision prints its own lines and show blocks; they are relayed as they are.
        const code = await provisionAccess({ root, argv: ['--deployment', deployment, ...(modeOf(state) === 'existing' ? ['--existing'] : [])], env, fetchImpl,
          out: line => say(line), err: line => warn(line) });
        secrets = null;
        if (code === 2) { await mark(step, 'todo', 'waiting for the step above'); say('  Result: waiting for the step above, then run setup again with --resume'); paused = step; break; }
        if (code !== 0) throw new Error(`creating the sign-in failed (the reason is above); fix it, then pnpm run setup -- --deployment ${deployment} --resume`);
        await mark(step, 'done');
      } else if (step === 'validate') {
        const { config } = await loadDeployment({ root, deployment });
        (await validation()).validateSecrets(await secretsNow(), config);
        await mark(step, 'done');
      } else if (step === 'wrangler') {
        await writeWrangler({ root, deployment, accountId: (await secretsNow()).cloudflare.accountId });
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
        const s = await secretsNow();
        const config = `.generated/wrangler.${deployment}.jsonc`;
        say(`  will run: pnpm exec wrangler deploy -c ${config}`);
        if (!await confirm('deploy now')) { await mark(step, 'todo', 'not confirmed'); paused = step; break; }
        await deploy(run, root, config, s, env, deployment);
        await mark(step, 'done');
      } else if (step === 'contract') {
        const s = await secretsNow();
        const { config } = await loadDeployment({ root, deployment });
        const pkg = await readJson(path.join(projectRoot, 'package.json'));
        await checkAfterDeploy({ origin: config.deployment.origin, token: s.GOONBRIDGE_TOKENS[s.contractToken], expectedEngine: pkg.version, fetchImpl,
          redeploy: () => deploy(run, root, `.generated/wrangler.${deployment}.jsonc`, s, env, deployment), log: line => say(`  ${line}`) });
        await mark(step, 'done');
      }
      if (state.steps[step]?.status === 'done') say('  Result: done');
    } catch (error) {
      if (error instanceof Pause) { await mark(step, 'todo', 'waiting for confirmation'); say('  Result: waiting for your yes'); throw error; }
      say('  Result: failed (the reason follows)');
      await mark(step, 'todo', 'failed; see the message and re-run with --resume');
      throw error;
    }
    if (step === until) break;
  }
  say(shown(status(state)));
  return paused ? 2 : 0;
}

async function deploy(run, root, config, secrets, env, deployment) {
  try {
    await run('pnpm', ['exec', 'wrangler', 'deploy', '-c', config], { cwd: root,
      env: { ...env, CHIMERA_DEPLOYMENT: deployment, CLOUDFLARE_ACCOUNT_ID: secrets.cloudflare.accountId, CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN } });
  } catch { throw new Error('wrangler deploy failed (output not shown, it may hold secrets); run it by hand to see why'); }
}
