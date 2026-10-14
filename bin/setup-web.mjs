// pnpm run setup -- --web [--deployment <id>]: the setup steps and questions on a local page in the browser.
//
// A small HTTP server on 127.0.0.1 (a free port, or $PORT) serves one hand-written page (bin/setup-web/) and JSON under
// /api/*. It holds no step logic of its own: prerequisites and detection come from bin/setup-detect.mjs, the questions
// from bin/setup-questions.mjs (the chimera-setup skill's wording), and every step from runSteps() in
// bin/setup-engine.mjs, the same function the terminal runs, writing the same .chimera-setup/<id>.json.
//
// Security: bound to 127.0.0.1 only; the Host header must name that address (no DNS rebinding); every /api call needs
// the random session token from the printed URL (?t=..., or the x-setup-token header), so another local process or a
// web page cannot drive it; POSTs must be JSON. The browser never takes the master token (the page tells the person to
// run secrets:mint in their own terminal), and no secrets.json value reaches it: step output goes through the engine's
// redactor, and every JSON response is scrubbed of every value in secrets.json and every detected account ID.
// Responses carry a strict CSP (no inline script or style, no external origin), no-store and no-referrer.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot, readJson, runCommand } from './deployment.mjs';
import { makeRedactor } from './secrets-common.mjs';
import { capture, detect, formatPrereqs, mergeAnswers, prereqs, prereqsOk, publicView } from './setup-detect.mjs';
import { ID, Pause, SHOW, SHOW_END, STEPS, accessOf, activeSteps, checkAnswers, currentStep, exists, mintCommand, readState, refreshSecretsStep, runSteps, secretValues, shown, stateFileOf } from './setup-engine.mjs';
import { answerQuestion, answersOf, nextQuestion } from './setup-questions.mjs';
import { GUIDES, IMAGES_DIR, IMAGE_NAME, fillIn, guideSource } from './guides.mjs';

const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-web');
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The page's left-hand list. Each entry covers engine steps (or, before the settings are written, the questions).
export const GROUPS = [
  { id: 'prereqs', label: 'Prerequisites' },
  { id: 'settings', label: 'Settings' },
  { id: 'signin', label: 'Sign-in' },
  { id: 'secrets', label: 'Secrets', steps: ['secrets'] },
  { id: 'access', label: 'Create sign-in', steps: ['signin'] },
  { id: 'validate', label: 'Validate', steps: ['validate', 'wrangler'] },
  { id: 'deploy', label: 'Deploy', steps: ['push', 'deploy'] },
  { id: 'check', label: 'Check', steps: ['contract'] },
];
const SHORT = { config: 'Write settings', secrets: 'Secrets', signin: 'Create sign-in', validate: 'Validate', wrangler: 'Generate', push: 'Push', deploy: 'Deploy', contract: 'Check' };
const CONFIRM = { push: 'This deploys to Cloudflare: it sends the secrets to your Worker (and GitHub Actions when gh is set up).', deploy: 'This deploys to Cloudflare: it puts the bridge online.' };

// The left-hand list as served, before the script fills in the markers.
const stepList = () => GROUPS.map(g => `    <li data-id="${g.id}" data-status="todo"><span class="mark" aria-hidden="true"></span><span class="label">${g.label}</span><span class="sr" data-sr></span></li>`).join('\n');

export function createSetupWeb({
  root = projectRoot, deployment = null, env = process.env, run = runCommand, fetchImpl = fetch,
  detector = ({ answers }) => detect({ root, env, run: capture, answers }), exec = capture, token = randomBytes(24).toString('base64url'),
} = {}) {
  let report = null, prereqList = null, prereqsPassed = false;
  let draft = deployment ? { deployment } : {};
  let id = deployment;
  let job = null;
  let written = null; // the confirmed answers, kept until the settings step is done

  const detectNow = async () => {
    report = await detector({ answers: answersOf(draft) });
    prereqList = prereqs(report);
    if (prereqsOk(prereqList)) prereqsPassed = true;
    return report;
  };
  const loadState = async () => id ? refreshSecretsStep(root, await readState(stateFileOf(root, id))) : null;
  const configured = async () => !!id && await exists(path.join(root, 'deployments', id, 'bridge.config.json'));
  // Every value that must never reach the browser: the secrets file's values and its email keys, and account IDs.
  const forbidden = async () => {
    const out = (report?.fields.accounts.value ?? []).map(a => a.id);
    if (id && ID.test(id)) {
      try {
        const s = JSON.parse(await readFile(path.join(root, 'deployments', id, 'secrets.json'), 'utf8'));
        out.push(...secretValues(s), ...Object.keys(s.GOONBRIDGE_MEMBERS ?? {}));
      } catch {}
    }
    return out.filter(v => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length);
  };

  // What the page shows: the step list with markers, and the one screen for the current step.
  async function view() {
    const state = await loadState();
    const steps = state || await configured();
    const groups = GROUPS.map(g => ({ id: g.id, label: g.label, status: 'todo' }));
    const set = (gid, s) => { groups.find(g => g.id === gid).status = s; };
    let screen;
    if (steps) {
      const st = state ?? { deployment: id, access: null, steps: {} };
      const active = activeSteps(st).map(([s]) => s);
      for (const g of groups) {
        const def = GROUPS.find(x => x.id === g.id);
        if (!def.steps) { g.status = 'done'; continue; }
        const mine = def.steps.filter(s => active.includes(s));
        g.status = !mine.length ? 'skipped' : mine.every(s => st.steps[s]?.status === 'done') ? 'done' : 'todo';
      }
      const step = currentStep(st);
      const gid = step ? (GROUPS.find(g => g.steps?.includes(step))?.id ?? 'settings') : null;
      if (gid) set(gid, 'current');
      screen = step === 'secrets' && await exists(path.join(root, 'deployments', id, 'secrets.json'))
        ? { kind: 'secrets', command: mintCommand(st), fill: `pnpm secrets:fill -- --deployment ${id}`, guide: 'master-token' }
        : step ? { kind: 'step', step, label: SHORT[step], title: STEPS.find(([s]) => s === step)[1], position: `Step ${active.indexOf(step) + 1} of ${active.length}`, confirm: CONFIRM[step] ?? null }
          : { kind: 'done', origin: await originOf() };
    } else if (job && !job.done) {
      set('prereqs', 'done'); set('settings', 'done'); set('signin', 'current');
      screen = { kind: 'writing' };
    } else if (!prereqsPassed) {
      set('prereqs', 'current');
      screen = { kind: 'prereqs' };
    } else if (draft._stopped) {
      set('prereqs', 'done');
      screen = { kind: 'stopped' };
    } else {
      if (!report) await detectNow();
      const question = nextQuestion(report, draft);
      set('prereqs', 'done');
      if (question) {
        if (question.group === 'signin') set('settings', 'done');
        set(question.group, 'current');
        screen = { kind: 'question', question };
      } else {
        set('settings', 'done'); set('signin', 'current');
        screen = { kind: 'writing' };
      }
      const mode = accessOf(answersOf(draft));
      if (draft.access !== undefined && !mode) set('access', 'skipped');
    }
    return { deployment: id, displayName: await displayName(), groups, screen, run: job && publicJob(job, 0) };
  }
  async function displayName() {
    try { return (await readJson(path.join(root, 'deployments', id, 'bridge.config.json'))).deployment.displayName; } catch { return null; }
  }
  async function originOf() {
    try { return (await readJson(path.join(root, 'deployments', id, 'bridge.config.json'))).deployment.origin; } catch { return null; }
  }

  // One engine run at a time; its lines are kept for the page to poll.
  function start(step, { yes = false, answers = null } = {}) {
    const { hide, redact } = makeRedactor();
    for (const a of report?.fields.accounts.value ?? []) hide(a.id);
    if (answers?.accountId) hide(answers.accountId);
    const j = { step, lines: [], done: false, code: null };
    const say = line => j.lines.push(...redact(line).split('\n'));
    j.promise = (async () => {
      try {
        const state = (await readState(stateFileOf(root, id))) ?? { deployment: id, access: answers ? accessOf(answers) : null, steps: {} };
        if (answers) { state.github = answers.githubActions !== false; state.access = accessOf(answers); }
        j.code = await runSteps({ root, state, answers, until: step, yes, isTTY: false, run, fetchImpl, env, say, warn: say, hide });
      } catch (error) {
        if (error instanceof Pause) { say(shown(error.message)); j.code = 2; } else { say(`setup: ${error.message}`); j.code = 1; }
      } finally { j.done = true; }
    })();
    job = j;
    return j;
  }
  function publicJob(j, since = 0) {
    const result = [...j.lines].reverse().find(l => /^\s*Result: /.test(l))?.trim() ?? null;
    // The pause: the last show block that is not the closing status checklist.
    const blocks = [];
    for (let i = 0, open = -1; i < j.lines.length; i++) {
      if (j.lines[i] === SHOW) open = i; else if (j.lines[i] === SHOW_END && open >= 0) { blocks.push(j.lines.slice(open + 1, i).join('\n')); open = -1; }
    }
    const pause = j.code === 2 ? blocks.filter(b => !/^Setup status for /.test(b)).at(-1) ?? null : null;
    const guide = pause?.match(/docs\/guides\/([a-z-]+)\.md/)?.[1] ?? null;
    return { step: j.step, done: j.done, code: j.code, result, pause, guide, since, lines: j.lines.slice(since) };
  }

  const api = {
    'GET /api/state': async () => [200, await view()],
    'GET /api/prereqs': async () => {
      await detectNow();
      return [200, { ok: prereqsOk(prereqList), list: prereqList, text: formatPrereqs(prereqList) }];
    },
    'GET /api/detect': async () => [200, publicView(report ?? await detectNow())],
    'GET /api/run': async (_body, url) => [200, job ? publicJob(job, Number(url.searchParams.get('since')) || 0) : null],
    'POST /api/answer': async body => {
      if (body?.reset) { draft = deployment ? { deployment } : {}; id = deployment; return [200, await view()]; }
      if (!prereqsPassed) return [409, { error: 'the prerequisites are not all there yet' }];
      if (await configured() || job && !job.done) return [409, { error: 'the settings are already written' }];
      if (!report) await detectNow();
      const before = draft.accountName;
      const r = await answerQuestion(report, draft, body ?? {}, { run: exec });
      if (r.error) return [400, { error: r.error }];
      draft = r.draft;
      if (draft._resume && draft._resume !== 'new') { id = draft._resume; draft = { deployment: id }; return [200, await view()]; }
      if (draft.accountName !== before) await detectNow(); // the domains and subdomain of the chosen account
      if (draft._confirmed) {
        const { answers, missing } = mergeAnswers(answersOf(draft), report);
        const problems = missing.length ? missing.map(k => `${k} is missing`) : checkAnswers(answers);
        if (problems.length) { delete draft._confirmed; return [400, { error: problems.join('; ') }]; }
        id = answers.deployment;
        if (await exists(stateFileOf(root, id)) || await configured()) { delete draft._confirmed; id = deployment; return [409, { error: `deployments/${answers.deployment} already exists or is half set up; restart with --deployment ${answers.deployment}` }]; }
        written = answers;
        start('secrets', { answers });
        draft = { deployment: id };
      }
      return [200, await view()];
    },
  };

  async function handle(req, res, port) {
    const send = async (status, body, type = 'application/json; charset=utf-8') => {
      let text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (type.startsWith('application/json')) for (const v of await forbidden()) text = text.split(v).join('[hidden]');
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin' });
      res.end(text);
    };
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'wrong host' });
    const url = new URL(req.url, `http://${host}`);
    const image = req.method === 'GET' && url.pathname.match(/^\/images\/([^/]+)$/)?.[1];
    if (image) {
      if (!IMAGE_NAME.test(image)) return send(404, { error: 'not found' });
      try { return send(200, await readFile(path.join(IMAGES_DIR, image)), 'image/png'); } catch { return send(404, { error: 'not found' }); }
    }
    if (!url.pathname.startsWith('/api/')) {
      const asset = req.method === 'GET' && ASSETS[url.pathname];
      if (!asset) return send(404, { error: 'not found' });
      let text = await readFile(path.join(PAGE_DIR, asset[0]), 'utf8');
      if (asset[0] === 'index.html') text = text.replace('<!--steps-->', stepList());
      return send(200, text, asset[1]);
    }
    const given = Buffer.from(String(req.headers['x-setup-token'] ?? url.searchParams.get('t') ?? ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: 'missing or wrong session token: open the URL setup printed' });
    let body = null;
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'send JSON' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send(413, { error: 'too large' }); }
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'not JSON' }); }
    }
    try {
      const runMatch = req.method === 'POST' && url.pathname.match(/^\/api\/run\/([a-z]+)$/);
      if (runMatch) return send(...await runStep(runMatch[1], body ?? {}));
      const guide = req.method === 'GET' && url.pathname.match(/^\/api\/guide\/([a-z-]+)$/)?.[1];
      if (guide) return send(...await guideOf(guide));
      const route = api[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'not found' });
      return send(...await route(body, url));
    } catch (error) {
      return send(500, { error: `setup: ${error.message}` });
    }
  }

  // A guide's markdown with this bridge's id and mint command filled in; the page renders it, images from /images/.
  async function guideOf(name) {
    if (!GUIDES.includes(name)) return [404, { error: 'no such guide' }];
    const state = await loadState();
    const subs = id ? { 'pnpm secrets:mint -- --deployment <id>': mintCommand(state ?? { deployment: id, access: null }), '<id>': id } : {};
    return [200, { name, markdown: fillIn(guideSource(name), subs) }];
  }

  async function runStep(step, body) {
    if (!STEPS.some(([s]) => s === step)) return [404, { error: 'no such step' }];
    if (!id) return [409, { error: 'answer the questions first' }];
    if (job && !job.done) return [409, { error: `${SHORT[job.step]} is still running` }];
    const state = await loadState() ?? (await configured() ? { deployment: id, access: null, steps: {} } : null);
    if (!state) return [409, { error: 'answer the questions first' }];
    if (currentStep(state) !== step) return [409, { error: `the current step is ${SHORT[currentStep(state)] ?? 'none: setup is finished'}` }];
    if (CONFIRM[step] && body.confirm !== true) return [400, { error: 'confirm first: this step changes Cloudflare' }];
    start(step, { yes: body.confirm === true, answers: ['config', 'secrets'].includes(step) ? written : null });
    return [202, publicJob(job)];
  }

  const server = createServer((req, res) => { handle(req, res, server.address().port).catch(() => { try { res.writeHead(500).end(); } catch {} }); });
  return { server, token, wait: () => job?.promise };
}

// Starts the server and opens the page. Resolves with { url, close } once it listens.
export async function startSetupWeb({ port = Number(process.env.PORT) || 0, open = true, out = line => process.stdout.write(`${line}\n`), ...options } = {}) {
  const web = createSetupWeb(options);
  await new Promise((resolve, reject) => { web.server.once('error', reject); web.server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${web.server.address().port}/?t=${web.token}`;
  out(`Setup is open in your browser at:\n  ${url}\nThe link holds a one-time key for this session; keep it to yourself. Press Ctrl-C here to stop.`);
  if (open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
    if (cmd) { try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {} }
  }
  return { url, close: () => new Promise(resolve => web.server.close(resolve)), web };
}

