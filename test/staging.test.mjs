import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async p => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), 'utf8'));
const accountId = '0'.repeat(32);

test('staging deployment validates: neutral members, Access off, workers.dev, short timings', async () => {
  const { loadDeployment } = await import('../bin/deployment.mjs');
  const { config, lock } = await loadDeployment({ deployment: 'staging' });
  assert.equal(config.deployment.id, 'staging');
  assert.equal(config.deployment.displayName, 'chimera staging');
  assert.equal(config.cloudflare.workerName, 'chimera-staging');
  assert.equal(config.cloudflare.workersDev, true);
  assert.match(new URL(config.deployment.origin).host, /^chimera-staging\.[a-z0-9-]+\.workers\.dev$/);
  assert.deepEqual(config.members.map(m => [m.name, m.kind]), [['staging', 'person'], ['probe', 'person']]);
  assert.deepEqual(config.admins, ['staging']);
  assert.equal(config.access, undefined);
  for (const seconds of Object.values(config.timing)) assert.ok(seconds <= 900);
  assert.equal(lock.workerName, 'chimera-staging');
});

test('a workers.dev origin generates no custom-domain route; a custom origin keeps its route', async () => {
  const { loadDeployment } = await import('../bin/deployment.mjs');
  const { generateWrangler } = await import('../bin/gen-wrangler.mjs');
  const staging = generateWrangler({ ...(await loadDeployment({ deployment: 'staging' })), accountId });
  assert.equal(staging.workers_dev, true);
  assert.equal(staging.routes, undefined);
  const example = generateWrangler({ ...(await loadDeployment({ deployment: 'example' })), accountId });
  assert.deepEqual(example.routes, [{ pattern: 'example.com', custom_domain: true }]);
});

test('a workers.dev origin needs workersDev on and the Worker name as its first label', async () => {
  const { loadDeployment } = await import('../bin/deployment.mjs');
  const { generateWrangler } = await import('../bin/gen-wrangler.mjs');
  const input = await loadDeployment({ deployment: 'staging' });
  const off = structuredClone(input); off.config.cloudflare.workersDev = false;
  assert.throws(() => generateWrangler({ ...off, lock: off.lock, accountId }), /workers\.dev/);
  const other = structuredClone(input);
  other.config.deployment.origin = other.lock.origin = 'https://someone-else.sub.workers.dev';
  assert.throws(() => generateWrangler({ ...other, accountId }), /workers\.dev/);
});

// A fake bridge: answers the routes the smoke uses and records each call (method, path, tool, args).
function fakeBridge({ fail } = {}) {
  const calls = [];
  let sent = '', title = '';
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const tool = (id, text, isError = false) => reply({ jsonrpc: '2.0', id, result: { ...(isError ? { isError } : {}), content: [{ type: 'text', text }] } });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', pathname, auth: init.headers?.Authorization, tool: body?.params?.name, args: body?.params?.arguments });
    if (fail && (fail === pathname || fail === body?.params?.name)) return body ? tool(body.id, 'refused', true) : reply({ error: 'no' }, 403);
    if (pathname === '/v1/me') return reply({ member: 'staging' });
    if (pathname === '/docs/status') return reply({ deployment: 'staging', version: { engine: '0.1.0', schema: 2, build: null }, members: 2 });
    if (pathname !== '/mcp') return reply({ error: 'not found' }, 404);
    const name = body.params.name;
    if (name === 'bridge_send') sent = body.params.arguments.body;
    if (name === 'task_create') title = body.params.arguments.title;
    if (name === 'bridge_send') return tool(body.id, 'Sent message 7 to probe in thread 7 ("staging smoke").');
    if (name === 'bridge_thread') return tool(body.id, `message 7 from staging to probe: ${sent}`);
    if (name === 'task_create') return tool(body.id, `Created T-12 for staging (ready, P3): "${title}". Thread 8 holds the brief; comments go there with task_update note.`);
    if (name === 'task_get') return tool(body.id, `T-12 · ${title}\nowner staging · assignee none · ready · P3 · version 1`);
    if (name === 'task_update') return tool(body.id, 'T-12 dropped.');
    return tool(body.id, `unknown tool ${name}`, true);
  };
  return { calls, fetchImpl };
}
const options = { origin: 'https://chimera-staging.sub.workers.dev', token: 't'.repeat(32), expectedDeployment: 'staging', log: () => {} };

test('staging smoke: status as admin, a send, a task created, read back and dropped', async () => {
  const { stagingSmoke } = await import('../bin/staging-smoke.mjs');
  const bridge = fakeBridge();
  await stagingSmoke({ ...options, fetchImpl: bridge.fetchImpl });
  assert.deepEqual(bridge.calls.map(c => c.tool ?? c.pathname), ['/v1/me', '/docs/status', 'bridge_send', 'bridge_thread', 'task_create', 'task_get', 'task_update']);
  assert.ok(bridge.calls.every(c => c.auth === `Bearer ${options.token}`));
  assert.equal(bridge.calls[2].args.to, 'probe');
  assert.equal(bridge.calls[3].args.thread_id, 7);
  assert.equal(bridge.calls[4].args.owner, 'staging');
  assert.equal(bridge.calls[5].args.key, 'T-12');
  assert.deepEqual(bridge.calls[6].args, { key: 'T-12', state: 'dropped' });
});

test('staging smoke fails on any failed step, still drops a created task, and never echoes the token', async () => {
  const { stagingSmoke } = await import('../bin/staging-smoke.mjs');
  for (const step of ['/v1/me', '/docs/status', 'bridge_send', 'bridge_thread', 'task_create', 'task_get', 'task_update']) {
    const bridge = fakeBridge({ fail: step });
    await assert.rejects(stagingSmoke({ ...options, fetchImpl: bridge.fetchImpl }), e => !e.message.includes(options.token) && /staging smoke/.test(e.message), step);
    if (step === 'task_get') assert.equal(bridge.calls.at(-1).tool, 'task_update', 'a created task is dropped even when reading it back fails');
  }
  const wrong = fakeBridge();
  const status = wrong.fetchImpl;
  wrong.fetchImpl = async (url, init) => new URL(url).pathname === '/docs/status' ? { ok: true, status: 200, json: async () => ({ deployment: 'other' }) } : status(url, init);
  await assert.rejects(stagingSmoke({ ...options, fetchImpl: wrong.fetchImpl }), /deployment/);
  await assert.rejects(stagingSmoke({ ...options, token: '' }), /token/);
  await assert.rejects(stagingSmoke({ ...options, origin: 'http://insecure.example' }), /HTTPS/);
});
