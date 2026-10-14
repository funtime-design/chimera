// pnpm run setup -- --web: the engine without a terminal, the questions against the skill's wording, and the local
// HTTP server end to end (port 0, stubbed wrangler/gh/pnpm and a fake Cloudflare). The no-secret contract: no
// secrets.json value (tokens, deploy token, Access secrets, account ID, emails) ever reaches the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detect } from '../bin/setup-detect.mjs';
import { STEPS, readState, refreshSecretsStep, runSteps, stateFileOf } from '../bin/setup-engine.mjs';
import { answerQuestion, nextQuestion } from '../bin/setup-questions.mjs';
import { CSP, GROUPS, startSetupWeb } from '../bin/setup-web.mjs';
import { accessFake } from './access-fake.mjs';

const hex = n => randomBytes(n).toString('hex');
const SECRET = { alice: `tok_alice_${hex(16)}`, bob: `tok_bob_${hex(16)}`, deploy: `cf_deploy_${hex(16)}`, account: hex(16), accessApi: `cf_access_api_${hex(12)}`, client: `client_secret_${hex(16)}` };
const EMAIL = { alice: 'alice@example.test', bob: 'bob@example.test' };
const skill = await readFile(new URL('../.claude/skills/chimera-setup/SKILL.md', import.meta.url), 'utf8');
const version = { engine: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, schema: 2, build: 'b1' };

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'chimera-setup-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), 'deployments/*/secrets.json\n.generated/\n.chimera-setup/\n');
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  return root;
}
function detector({ loggedIn = true } = {}) {
  const commands = {
    'npx wrangler whoami --json': loggedIn ? { code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: SECRET.account, name: 'Acme Account' }] }) } : { code: 1, stdout: '{"loggedIn":false}' },
    'npx wrangler auth token --json': { code: loggedIn ? 0 : 1, stdout: loggedIn ? JSON.stringify({ token: 'oauth_detect' }) : '' },
    'pnpm --version': { code: 0, stdout: '10.4.1' },
    'gh auth status': { code: 0, stdout: 'Logged in to github.com account acmegh' },
    'git config user.email': { code: 0, stdout: EMAIL.alice }, 'git config user.name': { code: 0, stdout: 'Alice' },
  };
  const run = async (cmd, args) => commands[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '', stderr: '' };
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname === '/client/v4/zones') return Response.json({ success: true, result: [{ name: 'example.test' }] });
    if (u.pathname.endsWith('/workers/subdomain')) return Response.json({ success: true, result: { subdomain: 'acme-sub' } });
    return Response.json({ success: false }, { status: 404 });
  };
  return ({ answers }) => detect({ root: tmpdir(), run, fetchImpl, env: {}, nodeVersion: '22.18.0', answers });
}
// The live bridge for the contract check, behind the fake Access API.
function cloudflare() {
  const live = async (url, init = {}) => {
    const req = new Request(url, init);
    if (req.headers.get('Authorization') !== `Bearer ${SECRET.alice}`) return new Response('no', { status: 401 });
    const p = new URL(url).pathname;
    if (p === '/v1/me') return Response.json({ member: 'alice' });
    if (p === '/v1/version') return Response.json({ worker: version, hub: version });
    if (p === '/v1/faults') return Response.json({ errors: [], work_threads: [] });
    if (p === '/v1/contract-check') return Response.json({ recorded: true });
    if (p === '/mcp') return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'task_report' }, { name: 'bridge_faults' }] } });
    return new Response('?', { status: 404 });
  };
  return accessFake({ token: SECRET.accessApi, account: SECRET.account, clientSecret: SECRET.client, leak: [EMAIL.alice], fallback: live });
}
async function fillSecrets(root, id = 'acme') {
  const file = path.join(root, `deployments/${id}/secrets.json`);
  const s = JSON.parse(await readFile(file, 'utf8'));
  s.GOONBRIDGE_TOKENS = Object.fromEntries(Object.keys(s.GOONBRIDGE_TOKENS).map(n => [n, SECRET[n]]));
  s.CLOUDFLARE_API_TOKEN = SECRET.deploy;
  s.CLOUDFLARE_ACCESS_TOKEN = SECRET.accessApi;
  await writeFile(file, JSON.stringify(s));
}
const leaks = text => [...Object.values(SECRET), ...Object.values(EMAIL)].filter(v => text.includes(v));

test('engine: the steps run without a terminal, stop at "until", and the secrets step finishes when the file is filled', async t => {
  const root = await sandbox(t);
  const lines = [];
  const say = l => lines.push(l);
  const answers = { deployment: 'acme', displayName: 'Acme', origin: 'https://bridge.example.test', accountId: SECRET.account, workerName: 'acme-bridge',
    admins: [{ name: 'alice', email: EMAIL.alice }], members: [], access: false, githubActions: false };
  const state = { deployment: 'acme', access: false, github: false, steps: {} };
  assert.equal(await runSteps({ root, state, answers, until: 'secrets', env: {}, say }), 2, lines.join('\n'));
  assert.equal(state.steps.config.status, 'done');
  assert.equal(state.steps.secrets.status, 'todo');
  assert.match(lines.join('\n'), /pnpm secrets:mint -- --deployment acme in your own terminal/);
  assert.equal((await refreshSecretsStep(root, structuredClone(state))).steps.secrets.status, 'todo', 'placeholders: still waiting');
  await fillSecrets(root);
  const fresh = await refreshSecretsStep(root, await readState(stateFileOf(root, 'acme')));
  assert.equal(fresh.steps.secrets.status, 'done', 'filled in another terminal: the step is done');
  lines.length = 0;
  assert.equal(await runSteps({ root, state: fresh, until: 'validate', env: {}, say }), 0, lines.join('\n'));
  assert.equal(fresh.steps.validate.status, 'done');
  assert.equal(fresh.steps.wrangler, undefined, 'stopped after "until"');
  await assert.rejects(runSteps({ root, state: fresh, env: {}, say, run: async () => {} }), /waiting for confirmation/, 'push without yes and without a terminal pauses');
  assert.deepEqual(leaks(lines.join('\n')), []);
});

test('questions: the same questions, headers and option texts as the chimera-setup skill', async () => {
  const report = await detector()({ answers: {} });
  const seen = [];
  let draft = {};
  const answer = async (value, text) => {
    const q = nextQuestion(report, draft);
    seen.push(q);
    const r = await answerQuestion(report, draft, { id: q.id, value: value ?? q.options[0].value, text });
    assert.equal(r.error, undefined, `${q.id}: ${r.error}`);
    draft = r.draft;
  };
  await answer('other', 'acme');
  await answer('https://bridge.example.test');
  await answer(null);
  await answer('detected');
  await answer('existing');
  await answer('provision');
  await answer('add');
  await answer('other', `bob ${EMAIL.bob}`);
  await answer('done');
  const confirm = nextQuestion(report, draft);
  seen.push(confirm);
  assert.deepEqual(seen.map(q => q.id), ['Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q6.1', 'Q7', 'Q8', 'Q8', 'Q9']);
  for (const q of seen) {
    assert.ok(skill.includes(`header "${q.header}"`), `${q.id}: header "${q.header}" is the skill's`);
    if (!['Q9'].includes(q.id)) assert.ok(skill.includes(`question "${q.question}"`), `${q.id}: question text is the skill's: ${q.question}`);
    for (const o of q.options) {
      if (/[<>]|@|acme|alice|example\.test|bridge\.example/i.test(o.label + o.description)) continue; // filled in from detection
      assert.ok(skill.includes(`- **${o.label}**: ${o.description}`), `${q.id}: option "${o.label}: ${o.description}" is word for word in the skill`);
    }
  }
  assert.ok(skill.includes(`with this description line first, word for word: "${seen[4].description}"`), 'Q6 description');
  assert.match(confirm.summary.join('\n'), /Sign-in: email code, setup creates it/);
  assert.match(confirm.summary.join('\n'), /GitHub Actions secrets: yes/);
  // A dashed or reused person name is refused with the reason, and the draft is unchanged.
  draft = { ...draft, _peopleDone: false };
  const q8 = nextQuestion(report, draft);
  assert.equal(q8.id, 'Q8');
  assert.match((await answerQuestion(report, draft, { id: 'Q8', value: 'other', text: `bob-smith ${EMAIL.bob}` })).error, /no dash/);
  assert.match((await answerQuestion(report, draft, { id: 'Q8', value: 'other', text: `alice ${EMAIL.bob}` })).error, /already used/);
  assert.match((await answerQuestion(report, draft, { id: 'Q2', value: 'acme' })).error, /not the one being asked/);
});

// HTTP against the running server, with the Host header a browser would send.
function call(port, method, p, { token, body, host = `127.0.0.1:${port}`, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...(token ? { 'x-setup-token': token } : {}), ...(data ? { 'content-type': type } : {}) } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

test('web: token, host and CSP guards; the page; questions to a written config; secrets advance when the file appears; every step runs; no secret reaches the browser', async t => {
  const root = await sandbox(t);
  const calls = [];
  const cf = cloudflare();
  const { url, close, web } = await startSetupWeb({ root, open: false, out: () => {}, detector: detector(), env: {}, fetchImpl: cf.fetchImpl,
    run: async (command, args) => { calls.push([command, ...args].join(' ')); }, exec: async () => ({ code: 1, stdout: '' }) });
  t.after(close);
  const { port } = new URL(url);
  const token = new URL(url).searchParams.get('t');
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{32}$/);
  assert.equal(web.server.address().address, '127.0.0.1', 'bound to loopback only');
  const all = [];
  const api = async (method, p, body) => { const r = await call(port, method, p, { token, body }); all.push(r.text); return r; };

  // Guards.
  for (const [method, p] of [['GET', '/api/state'], ['GET', '/api/prereqs'], ['GET', '/api/detect'], ['GET', '/api/run'], ['POST', '/api/answer'], ['POST', '/api/run/validate']]) {
    assert.equal((await call(port, method, p, { body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${p} without the token`);
    assert.equal((await call(port, method, p, { token: token.replace(/^./, c => c === 'a' ? 'b' : 'a'), body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${p} with a wrong token`);
  }
  assert.equal((await call(port, 'GET', `/api/state?t=${token}`)).status, 200, 'the token in the query works too');
  assert.equal((await call(port, 'GET', '/api/state', { token, host: `evil.example:${port}` })).status, 403, 'another Host (DNS rebinding) is refused');
  assert.equal((await call(port, 'POST', '/api/answer', { token, body: {}, type: 'text/plain' })).status, 415, 'POST must be JSON');

  // The page: the step list, no inline script or style, the CSP.
  const page = await call(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.match(CSP, /default-src 'none'/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  for (const g of GROUPS) assert.match(page.text, new RegExp(`data-id="${g.id}"[^\\n]*>${g.label}<`), `step list has ${g.label}`);
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/, 'no inline script');
  assert.doesNotMatch(page.text, /<style|style=/, 'no inline style');
  assert.doesNotMatch(page.text, /https?:\/\/(?!127\.0\.0\.1)/, 'no external asset');
  for (const asset of ['/app.js', '/app.css']) assert.equal((await call(port, 'GET', asset)).status, 200, asset);
  assert.doesNotMatch((await call(port, 'GET', '/app.js')).text, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, 'the page never parses server text as markup');

  // Prerequisites and detection.
  let s = (await api('GET', '/api/state')).json;
  assert.equal(s.screen.kind, 'prereqs');
  assert.equal(s.groups[0].status, 'current');
  const pre = (await api('GET', '/api/prereqs')).json;
  assert.equal(pre.ok, true);
  assert.ok(pre.list.some(p => p.key === 'wrangler' && p.status === 'ok'));
  const det = await api('GET', '/api/detect');
  assert.equal(det.json.fields.accountId.source, 'detected');
  assert.ok(!det.text.includes(SECRET.account), 'account ID masked');

  // The questions, one per screen; detected values offered.
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.screen.question.id, 'Q2');
  assert.deepEqual(s.screen.question.options.map(o => o.label), ['alice-test', 'alice', 'Something else']);
  const reply = async (id, value, text) => { const r = await api('POST', '/api/answer', { id, value, text }); assert.equal(r.status, 200, r.text); return r.json; };
  assert.equal((await api('POST', '/api/answer', { id: 'Q2', value: 'other', text: 'Bad Name!' })).status, 400, 'a bad name is refused');
  s = await reply('Q2', 'other', 'acme');
  assert.deepEqual(s.screen.question.options.map(o => o.value), ['https://bridge.example.test', 'workers.dev'], 'zones as choices');
  s = await reply('Q3', 'https://bridge.example.test');
  s = await reply('Q4', s.screen.question.options[0].value);
  assert.equal(s.screen.question.options[0].label, `Use ${EMAIL.alice}`, 'git email offered');
  s = await reply('Q5', 'detected');
  assert.equal(s.screen.question.id, 'Q6');
  assert.equal(s.groups.find(g => g.id === 'settings').status, 'done');
  assert.equal(s.groups.find(g => g.id === 'signin').status, 'current');
  s = await reply('Q6', 'provision');
  s = await reply('Q7', 'add');
  s = await reply('Q8', 'other', `bob ${EMAIL.bob}`);
  s = await reply('Q8', 'done');
  assert.equal(s.screen.question.id, 'Q9');
  assert.ok(s.screen.question.summary.some(l => l === 'Address: https://bridge.example.test'));
  assert.deepEqual(s.screen.question.problems, []);
  assert.ok(!all.join('\n').includes(SECRET.account), 'no account ID before the write either');
  s = await reply('Q9', 'yes');
  await web.wait();

  // Secrets: the browser never takes the token; the page polls until secrets.json is filled.
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.screen.kind, 'secrets');
  assert.equal(s.screen.command, 'pnpm secrets:mint -- --deployment acme --access-token');
  assert.equal(s.screen.guide, 'master-token');
  const guide = await api('GET', '/api/guide/master-token');
  assert.equal(guide.status, 200);
  assert.match(guide.json.markdown, /^1\. Open https:\/\/dash\.cloudflare\.com\/profile\/api-tokens/m);
  assert.match(guide.json.markdown, /`pnpm secrets:mint -- --deployment acme --access-token` in your own terminal/, 'the guide names the same command as the box');
  assert.match(guide.json.markdown, /!\[[^\]]+\]\(\.\.\/images\/master-token-1\.png\)/);
  assert.equal((await call(port, 'GET', '/api/guide/master-token')).status, 401, 'guides need the token too');
  assert.equal((await api('GET', '/api/guide/nope')).status, 404);
  const png = await call(port, 'GET', '/images/master-token-1.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  for (const bad of ['/images/..%2Fguides%2Fmaster-token.md', '/images/README.md', '/images/missing.png']) assert.equal((await call(port, 'GET', bad)).status, 404, bad);
  assert.equal(s.displayName, 'acme bridge');
  assert.deepEqual(s.groups.map(g => g.status), ['done', 'done', 'done', 'current', 'todo', 'todo', 'todo', 'todo']);
  assert.equal((await api('POST', '/api/run/validate', { })).status, 409, 'not the current step');
  assert.equal((await api('POST', '/api/answer', { id: 'Q2', value: 'acme' })).status, 409, 'settings are written; no more answers');
  await fillSecrets(root);
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.screen.kind, 'step');
  assert.equal(s.screen.step, 'signin', 'advanced by itself once the tokens are there');
  assert.equal(s.groups.find(g => g.id === 'secrets').status, 'done');
  assert.equal((await readState(stateFileOf(root, 'acme'))).steps.secrets.status, 'done', 'the shared state file says so');

  // Each step: Run, poll the log, the result line.
  const runStep = async (step, body = {}) => {
    const started = await api('POST', `/api/run/${step}`, body);
    assert.equal(started.status, 202, `${step}: ${started.text}`);
    await web.wait();
    const r = (await api('GET', '/api/run')).json;
    assert.equal(r.step, step);
    assert.equal(r.code, 0, `${step}: ${r.lines.join('\n')}`);
    assert.equal(r.result, 'Result: done');
    assert.ok(r.lines.some(l => /^Step \d+ of 8: /.test(l)), `${step}: streamed the step line`);
    return r;
  };
  await runStep('signin');
  assert.equal((await api('GET', '/api/run?since=1000')).json.lines.length, 0, 'since skips lines already shown');
  await runStep('validate');
  await runStep('wrangler');
  assert.equal((await api('POST', '/api/run/push', {})).status, 400, 'push needs the confirm click');
  assert.equal(calls.length, 0, 'nothing pushed yet');
  s = (await api('GET', '/api/state')).json;
  assert.match(s.screen.confirm, /This deploys to Cloudflare/);
  assert.equal(s.screen.position, 'Step 6 of 8');
  await runStep('push', { confirm: true });
  assert.ok(calls.some(c => c === 'npx wrangler secret put GOONBRIDGE_TOKENS --name acme-bridge'));
  assert.equal((await api('POST', '/api/run/deploy', {})).status, 400, 'deploy needs the confirm click');
  await runStep('deploy', { confirm: true });
  assert.ok(calls.includes('pnpm exec wrangler deploy -c .generated/wrangler.acme.jsonc'));
  await runStep('contract');
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.screen.kind, 'done');
  assert.equal(s.screen.origin, 'https://bridge.example.test');
  assert.ok(s.groups.every(g => g.status === 'done'), JSON.stringify(s.groups));
  const state = await readState(stateFileOf(root, 'acme'));
  for (const [step] of STEPS) assert.equal(state.steps[step].status, 'done', step);

  // Nothing from secrets.json ever reached the browser: not in any response, not in the page.
  const secrets = JSON.parse(await readFile(path.join(root, 'deployments/acme/secrets.json'), 'utf8'));
  assert.equal(secrets.ACCESS_CLIENT_SECRET, SECRET.client, 'the sign-in step wrote the Access secret');
  const responses = all.join('\n') + (await call(port, 'GET', '/')).text;
  const after = all.slice(all.findIndex(text => text.includes('"kind":"secrets"'))).join('\n');
  for (const v of [...Object.values(SECRET), ...Object.keys(secrets.GOONBRIDGE_MEMBERS)]) assert.ok(!after.includes(v), 'no secrets.json value in any response once the file exists');
  assert.deepEqual(leaks(responses).filter(v => !Object.values(EMAIL).includes(v)), [], 'no token, account ID or Access secret in any response, ever');
});

test('web: /api/state strips every secrets.json value, even ones the state could echo', async t => {
  const root = await sandbox(t);
  const id = 'acme';
  await mkdir(path.join(root, `deployments/${id}`), { recursive: true });
  // A state whose notes echo secret values (a corrupted or hostile state file) and a filled secrets file.
  const secrets = { GOONBRIDGE_TOKENS: { alice: SECRET.alice }, GOONBRIDGE_MEMBERS: { [EMAIL.alice]: 'alice' }, cloudflare: { accountId: SECRET.account }, CLOUDFLARE_API_TOKEN: SECRET.deploy, contractToken: 'alice', GOONBRIDGE_GITHUB_WEBHOOK_SECRET: 'REPLACE_ME_later' };
  await writeFile(path.join(root, `deployments/${id}/secrets.json`), JSON.stringify(secrets));
  await mkdir(path.join(root, '.chimera-setup'), { recursive: true });
  await writeFile(stateFileOf(root, id), JSON.stringify({ deployment: id, access: false, steps: { config: { status: 'done', note: `${SECRET.deploy} ${EMAIL.alice}` } } }));
  await writeFile(path.join(root, `deployments/${id}/bridge.config.json`), JSON.stringify({ deployment: { id, displayName: `Acme ${SECRET.alice}`, origin: 'https://bridge.example.test' } }));
  const { url, close } = await startSetupWeb({ root, deployment: id, open: false, out: () => {}, detector: detector(), env: {} });
  t.after(close);
  const token = new URL(url).searchParams.get('t');
  const r = await call(new URL(url).port, 'GET', '/api/state', { token });
  assert.equal(r.status, 200, r.text);
  for (const v of [SECRET.alice, SECRET.deploy, SECRET.account, EMAIL.alice]) assert.ok(!r.text.includes(v), 'stripped');
  assert.match(r.json.displayName, /^Acme \[hidden\]$/);
  assert.equal(r.json.screen.kind, 'secrets', 'resumes on the current step');
});
