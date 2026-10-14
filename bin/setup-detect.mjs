// What setup can find out before asking anything, and the step-0 prerequisites checklist.
//
//   pnpm run setup -- --detect     prints the detection as JSON (account IDs masked, no token)
//   pnpm run setup -- --prereqs    prints the checklist; exit 0 when everything required is there, 2 otherwise
//
// Every field carries { value, source, howToGet }: source is "detected" (read from this machine or Cloudflare),
// "default" (a suggestion the person can accept) or "needs-answer" (only the person knows). howToGet is one sentence
// naming the exact place or command. The wrangler OAuth token (from `npx wrangler auth token --json`, or
// CLOUDFLARE_API_TOKEN) is used only to list zones and the workers.dev subdomain; it is never returned or printed.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './deployment.mjs';

export const STATE_DIR = '.chimera-setup';
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const NODE_MIN = [22, 18];
const RESERVED = new Set(['all', 'example', 'staging']);

// Runs a command and captures its output (for detection only; never used for commands that receive secrets).
export function capture(cmd, args, { cwd = projectRoot, env = process.env, timeout = 60000 } = {}) {
  return new Promise(resolve => {
    let child, stdout = '', stderr = '';
    try { child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch { resolve({ code: 127, stdout, stderr }); return; }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

const field = (value, source, howToGet, extra = {}) => ({ value, source, howToGet, ...extra });
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const slug = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const notInstalled = r => r.code === 127 || /command not found|could not determine executable|ENOENT/i.test(r.stderr ?? '');

export async function detect({ root = projectRoot, run = capture, fetchImpl = fetch, env = process.env, nodeVersion = process.versions.node, answers = {} } = {}) {
  const sh = async (cmd, args) => { try { return await run(cmd, args, { cwd: root, env }); } catch { return { code: 127, stdout: '', stderr: '' }; } };
  const [who, gh, pnpm, gitEmail, gitName] = await Promise.all([
    sh('npx', ['wrangler', 'whoami', '--json']), sh('gh', ['auth', 'status']), sh('pnpm', ['--version']),
    sh('git', ['config', 'user.email']), sh('git', ['config', 'user.name']),
  ]);

  // Node
  const [major = 0, minor = 0] = String(nodeVersion ?? '').split('.').map(Number);
  const nodeOk = major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1]);
  // wrangler
  const whoami = json(who.stdout);
  const wranglerInstalled = !notInstalled(who);
  const loggedIn = who.code === 0 && whoami?.loggedIn === true;
  const accounts = loggedIn ? (whoami.accounts ?? []).filter(a => /^[a-fA-F0-9]{32}$/.test(a?.id ?? '')).map(a => ({ id: a.id, name: String(a.name ?? '') })) : [];
  // gh (status prints to stdout or stderr depending on the version)
  const ghText = `${gh.stdout ?? ''}\n${gh.stderr ?? ''}`;
  const ghInstalled = !notInstalled(gh);
  const ghLoggedIn = gh.code === 0;
  const ghUser = ghText.match(/account (\S+)/)?.[1] ?? ghText.match(/Logged in to \S+ as (\S+)/)?.[1] ?? null;

  // The account: the answer, else the only one.
  const chosen = accounts.find(a => a.id === answers.accountId) ?? accounts.find(a => a.name === answers.accountName) ?? (accounts.length === 1 ? accounts[0] : null);

  // Zones and the workers.dev subdomain, with the wrangler token (or an API token in the environment).
  let zones = null, subdomain = null, workers = [];
  if (loggedIn || env.CLOUDFLARE_API_TOKEN) {
    let token = env.CLOUDFLARE_API_TOKEN || '';
    if (!token) { const t = json((await sh('npx', ['wrangler', 'auth', 'token', '--json'])).stdout); if (typeof t?.token === 'string') token = t.token; }
    if (token) {
      const api = async p => {
        try {
          const res = await fetchImpl(`https://api.cloudflare.com/client/v4${p}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
          const data = await res.json().catch(() => null);
          return res.ok && data?.success ? data.result : null;
        } catch { return null; }
      };
      const list = await api(`/zones?per_page=50&status=active${chosen ? `&account.id=${chosen.id}` : ''}`);
      if (Array.isArray(list)) zones = list.map(z => z?.name).filter(n => typeof n === 'string').sort();
      if (chosen) subdomain = (await api(`/accounts/${chosen.id}/workers/subdomain`))?.subdomain ?? null;
      if (chosen) workers = ((await api(`/accounts/${chosen.id}/workers/scripts`)) ?? []).map(w => w?.id).filter(n => typeof n === 'string');
    }
    token = '';
  }

  // Folders and saved progress
  const list = async dir => { try { return (await readdir(path.join(root, dir), { withFileTypes: true })); } catch { return []; } };
  const existing = (await list('deployments')).filter(d => d.isDirectory()).map(d => d.name).sort();
  const inProgress = (await list(STATE_DIR)).filter(d => d.isFile() && d.name.endsWith('.json')).map(d => d.name.slice(0, -5)).sort();

  // Suggestions
  const email = gitEmail.code === 0 ? gitEmail.stdout.trim() : '';
  const name = gitName.code === 0 ? gitName.stdout.trim() : '';
  const person = slug(name.split(/\s+/)[0]) || slug(email.split('@')[0]) || '';
  let suggested = person || slug(zones?.[0]?.split('.')[0]) || 'mybridge';
  if (!ID.test(suggested) || RESERVED.has(suggested) || existing.includes(suggested)) suggested = `${suggested || 'my'}bridge`;
  // A first run is usually a throwaway; the plain name tends to be the live bridge's id (and its GOONBRIDGE_TOKENS
  // entry). So on a first run, or when a live Worker or a .private/deployments/<name> folder says the name is in use,
  // <name>-test is offered first. The plain name stays a choice.
  const firstRun = !existing.some(d => !RESERVED.has(d)) && !inProgress.length;
  const privateIds = new Set((await list('.private/deployments')).filter(d => d.isDirectory()).map(d => d.name));
  const inUse = id => workers.includes(id) || workers.includes(`${id}-bridge`) || privateIds.has(id);
  const testFirst = ID.test(suggested) && (inUse(suggested) || (firstRun && suggested === person)) && !existing.includes(`${suggested}-test`);
  const choices = testFirst
    ? [{ value: `${suggested}-test`, description: `throwaway for testing; use ${suggested} when you migrate the live bridge` },
      { value: suggested, description: inUse(suggested) ? 'the id that looks in use (a live Worker or a private deployment); pick it to set up that bridge' : 'your own name; best kept for your real, long-lived bridge' }]
    : [{ value: suggested, description: 'suggested from your git name or your domain' }];
  const deployment = answers.deployment ?? choices[0].value;
  const firstName = name.split(/\s+/)[0];
  const originChoices = [...(zones ?? []).map(z => `https://bridge.${z}`), 'workers.dev'];

  const login = 'Run `npx wrangler login` in this folder (it opens the browser; sign in to Cloudflare and click Allow), then run detect again.';
  const tools = {
    node: field(nodeVersion ?? null, nodeVersion ? 'detected' : 'needs-answer', 'Install Node 22.18 or newer from https://nodejs.org/en/download, or run `brew install node`.', { ok: nodeOk }),
    pnpm: field(pnpm.code === 0 ? pnpm.stdout.trim() : null, pnpm.code === 0 ? 'detected' : 'needs-answer', 'Run `corepack enable` (comes with Node), or `npm i -g pnpm`.', { ok: pnpm.code === 0 }),
    wrangler: field({ installed: wranglerInstalled, loggedIn, email: loggedIn ? whoami.email ?? null : null }, loggedIn ? 'detected' : 'needs-answer',
      wranglerInstalled ? login : 'Run `pnpm install` in this folder (wrangler comes with the project), then `npx wrangler login`.', { ok: loggedIn }),
    gh: field({ installed: ghInstalled, loggedIn: ghLoggedIn, user: ghUser }, ghLoggedIn ? 'detected' : 'needs-answer',
      ghInstalled ? 'Run `gh auth login` (only needed to deploy from GitHub Actions).' : 'Install the GitHub CLI with `brew install gh` (https://cli.github.com), then run `gh auth login`.', { ok: ghLoggedIn }),
  };
  const fields = {
    accounts: field(accounts, loggedIn ? 'detected' : 'needs-answer', loggedIn ? 'From `npx wrangler whoami`.' : login),
    accountId: chosen ? field(chosen.id, 'detected', `From \`npx wrangler whoami\` (account "${chosen.name}").`, { accountName: chosen.name })
      : field(null, 'needs-answer', loggedIn
        ? 'Pick one of the accounts wrangler can see (answer accountName), or copy it from the Cloudflare dashboard > Workers & Pages > Overview, right-hand column "Account ID".'
        : login, { choices: accounts.map(a => a.name) }),
    zones: field(zones, zones ? 'detected' : 'needs-answer', zones
      ? 'Domains on this Cloudflare account (dashboard > Websites).'
      : 'Could not list your domains; log in with `npx wrangler login`, or check the Cloudflare dashboard > Websites (https://dash.cloudflare.com).'),
    deployment: field(deployment, answers.deployment ? 'detected' : 'default', 'A short lowercase name for this bridge; it becomes the folder deployments/<id>/ (letters, digits, dash).', { choices }),
    displayName: field(firstName ? `${firstName}'s bridge` : `${deployment} bridge`, 'default', 'The name people see for the bridge; any text.'),
    origin: originChoices.length === 1 && subdomain
      ? field('workers.dev', 'default', `No domain on this account, so the bridge uses a free address: https://${deployment}-bridge.${subdomain}.workers.dev.`, { choices: originChoices })
      : field(null, 'needs-answer', 'Pick a domain on this Cloudflare account (the bridge lives at bridge.<domain>), or "workers.dev" for a free address; domains are listed at Cloudflare dashboard > Websites.', { choices: originChoices }),
    workerName: field(`${deployment}-bridge`, 'default', 'The name of the Worker (the Cloudflare service that runs the bridge); the default is fine.'),
    admins: email && person
      ? field([{ name: person, email }], 'detected', 'From `git config user.name` and `git config user.email`; an admin opens the status and settings pages.')
      : field(null, 'needs-answer', 'Your name (lowercase, no dash) and the email you sign in with; set a default with `git config --global user.email you@example.com`.'),
    members: field([], 'default', 'Other people who use the bridge: a name (lowercase, no dash) and sign-in email each; none is fine to start.'),
    access: field(false, 'default', 'How people sign in: "provision" (setup creates a Cloudflare Access email-code sign-in), or "existing" (you already have an Access for SaaS app; give its client id as accessClientId). Cloudflare Access is the only way people sign in; without it (false, the default when unanswered) only scripts and cloud sessions connect, with tokens.'),
    githubActions: field(ghLoggedIn, 'default', ghLoggedIn ? 'gh is logged in, so setup also copies the deploy secrets to GitHub Actions.' : 'gh is not logged in, so setup skips the GitHub Actions secrets; run `gh auth login` to include them.'),
    existingDeployments: field(existing, 'detected', 'Folders under deployments/.'),
    setupInProgress: field(inProgress, 'detected', 'Saved progress in .chimera-setup/; resume with `pnpm run setup -- --deployment <id> --resume`.'),
  };
  return { tools, fields, workersSubdomain: subdomain };
}

// The printed view: account IDs reduced to their last four characters. (The report never holds a token.)
export function publicView(report) {
  const ids = (report.fields.accounts.value ?? []).map(a => a.id);
  const mask = v => typeof v === 'string' ? ids.reduce((s, id) => s.split(id).join(`****${id.slice(-4)}`), v) : v;
  return JSON.parse(JSON.stringify(report, (_k, v) => mask(v)));
}

// Answers file first, detection for the rest. Returns the merged answers and the fields still needing a person.
const REQUIRED = ['deployment', 'displayName', 'origin', 'accountId', 'workerName', 'admins'];
// The sign-in answer as "provision", "existing" or false. Off unless the answer clearly picks one: a missing key, false,
// null, "no" or "false" are all off. The option labels map to their mode ("Email code ..." is provision, "I already
// have ..." is existing); true and { enabled: true } are the old "Access is already in front" answer, so existing.
// Anything else is left as given, so checkAnswers refuses it instead of guessing.
export function accessAnswer(v) {
  if (v === undefined || v === null || v === '' || v === false) return false;
  if (v === true) return 'existing';
  if (typeof v === 'object') return v.enabled === true ? 'existing' : v.enabled === false ? false : v;
  if (typeof v !== 'string') return v;
  const t = v.trim().toLowerCase();
  if (/^(no|n|false|off)\b/.test(t)) return false;
  if (/^(provision|email code|auto)/.test(t)) return 'provision';
  if (/^(existing|i already have|yes|y|true|on)\b/.test(t)) return 'existing';
  return v;
}
export function mergeAnswers(given = {}, report) {
  const f = report.fields;
  const a = { ...given };
  const pick = key => f[key]?.source === 'needs-answer' ? undefined : f[key]?.value ?? undefined;
  a.deployment ??= pick('deployment');
  if (a.accountName && !a.accountId) a.accountId = (f.accounts.value ?? []).find(x => x.name === a.accountName)?.id;
  delete a.accountName;
  a.accountId ??= pick('accountId');
  a.workerName ??= a.deployment ? `${a.deployment}-bridge` : undefined;
  a.displayName ??= pick('displayName');
  a.admins ??= pick('admins');
  a.members ??= pick('members') ?? [];
  a.origin ??= pick('origin');
  a.access = accessAnswer(a.access);
  if (a.githubActions === undefined) a.githubActions = !!f.githubActions?.value;
  if (a.origin === 'workers.dev') {
    const sub = a.workersDevSubdomain ?? report.workersSubdomain;
    a.origin = sub && a.workerName ? `https://${a.workerName}.${sub}.workers.dev` : undefined;
  }
  delete a.workersDevSubdomain;
  const missing = REQUIRED.filter(k => a[k] === undefined || a[k] === null || a[k] === '').sort();
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  return { answers: a, missing };
}
// One sentence per missing field, naming where to get it.
export function howToGet(report, key) {
  if (key === 'origin') return `${report.fields.origin.howToGet}${report.workersSubdomain ? '' : ' (workers.dev needs the subdomain from dashboard > Workers & Pages > Overview, right-hand column "Subdomain"; answer workersDevSubdomain)'}`;
  return report.fields[key]?.howToGet ?? '';
}

// Step 0: the checklist. Required lines block; optional lines never do.
export function prereqs(report) {
  const { node, pnpm, wrangler, gh } = report.tools;
  const zones = report.fields.zones.value;
  const accounts = report.fields.accounts.value ?? [];
  const w = wrangler.value;
  return [
    { key: 'node', required: true, label: 'Node 22 or newer', status: node.ok ? 'ok' : 'missing',
      detail: node.value ? `you have ${node.value}` : 'not found', fix: 'download it from https://nodejs.org/en/download, or run `brew install node`' },
    { key: 'pnpm', required: true, label: 'pnpm installed', status: pnpm.ok ? 'ok' : 'missing',
      detail: pnpm.value ? `version ${pnpm.value}` : 'not found', fix: 'run `corepack enable` (comes with Node), or `npm i -g pnpm`' },
    { key: 'cloudflare', required: true, label: 'A Cloudflare account (it runs the bridge)', status: accounts.length ? 'ok' : w.loggedIn ? 'missing' : 'unknown',
      detail: accounts.length ? accounts.map(a => a.name).join(', ') : w.loggedIn ? 'none found' : 'cannot tell until wrangler is logged in',
      fix: 'sign up at https://dash.cloudflare.com/sign-up (the free plan is enough)' },
    { key: 'wrangler', required: true, label: 'wrangler logged in to that account', status: w.loggedIn ? 'ok' : 'missing',
      detail: w.loggedIn ? (w.email ? `as ${w.email}` : 'yes') : w.installed ? 'not logged in' : 'not installed',
      fix: w.installed ? 'run `npx wrangler login` (it opens the browser; no Cloudflare account yet? sign up at https://dash.cloudflare.com/sign-up first)' : 'run `pnpm install` in this folder, then `npx wrangler login`' },
    { key: 'gh', required: false, label: 'GitHub account with `gh` logged in (only to deploy from GitHub Actions)', status: gh.ok ? 'ok' : 'optional',
      detail: gh.ok ? (gh.value.user ? `as ${gh.value.user}` : 'yes') : 'not set up; setup skips the GitHub secrets',
      fix: gh.value.installed ? 'run `gh auth login`' : 'run `brew install gh`, then `gh auth login`' },
    { key: 'domain', required: false, label: 'A domain on that Cloudflare account', status: zones?.length ? 'ok' : 'optional',
      detail: zones?.length ? zones.join(', ') : zones ? 'none, so the bridge uses a free workers.dev address' : 'not checked; workers.dev works without one',
      fix: 'add one at Cloudflare dashboard > Websites > Add a domain' },
    { key: 'passwords', required: false, label: 'A password manager to keep the one master token', status: 'optional',
      detail: 'any one works (1Password, Bitwarden, Apple Passwords)', fix: '' },
  ];
}

const MARK = { ok: '✓', missing: '✗', unknown: '?', optional: '○' };
export const prereqsOk = list => list.every(p => !p.required || p.status !== 'missing');
export function formatPrereqs(list) {
  const lines = ['Step 0: checking what you have'];
  for (const p of list) {
    const tag = !p.required && p.status !== 'ok' ? ' (optional)' : '';
    lines.push(`  ${MARK[p.status]} ${p.label}${tag}: ${p.detail}${!p.required && p.status !== 'ok' && p.fix ? `; to add it: ${p.fix}` : ''}`);
  }
  const blocker = list.find(p => p.required && p.status === 'missing');
  if (blocker) {
    lines.push(`Next: ${blocker.fix}.`);
    lines.push('Run again when done: pnpm run setup -- --prereqs');
  } else lines.push('All set: everything required is here.');
  return lines.join('\n');
}
