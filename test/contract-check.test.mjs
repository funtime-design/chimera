import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContract, checkAfterDeploy } from '../bin/contract-check.mjs';
import { loadModule, memoryHub } from './hub-memory.mjs';

const current = { worker: { engine: '0.1.0', schema: 1, build: 'fresh-build' }, hub: { engine: '0.1.0', schema: 1, build: 'fresh-build' } };
const token = 'FAKE_contract_bearer_for_offline_tests';
// In-process HTTP server handler; no socket, port, listener or network service.
function server({ version = current, faults = { errors: [], work_threads: [] }, tools = ['task_report', 'bridge_faults'], status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const req = new Request(url, init); requests.push(req);
    assert.equal(req.headers.get('Authorization'), `Bearer ${token}`);
    assert.equal(req.redirect, 'error');
    const p = new URL(url).pathname;
    if (status !== 200) return new Response('private-sentinel', { status });
    if (p === '/v1/me') return Response.json({ member: 'alice' });
    if (p === '/v1/faults') return Response.json(faults);
    if (p === '/v1/version') return Response.json(typeof version === 'function' ? version() : version);
    if (p === '/v1/contract-check') { assert.equal(req.method, 'POST'); return Response.json({ recorded: true }); }
    assert.equal(p, '/mcp'); assert.equal(req.method, 'POST');
    assert.equal((await req.json()).method, 'tools/list');
    return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: tools.map(name => ({ name })) } });
  };
  return { fetchImpl, requests };
}
const options = stub => ({ origin: 'https://example.com', token, expectedEngine: '0.1.0', fetchImpl: stub.fetchImpl });

test('post-deploy fresh HTTP contracts pass with authenticated requests', async () => {
  const stub = server(); await checkContract(options(stub));
  assert.deepEqual(stub.requests.map(r => new URL(r.url).pathname).sort(), ['/mcp', '/v1/contract-check', '/v1/faults', '/v1/me', '/v1/version']);
  assert.equal(new URL(stub.requests.at(-1).url).pathname, '/v1/contract-check', 'recorded only after every check passed');
});

test('old faults/tools shape and invalid auth fail without redeploy or response leakage', async () => {
  for (const stub of [server({ faults: { orphaned_tasks: [], fires: [] } }), server({ faults: { errors: {}, work_threads: [] } }), server({ tools: ['task_report'] }), server({ status: 401 })]) {
    let redeploys = 0;
    await assert.rejects(checkAfterDeploy({ ...options(stub), redeploy: () => { redeploys++; } }), e => !e.message.includes('private-sentinel'));
    assert.equal(redeploys, 0);
  }
});

test('stale Hub then fresh triggers exactly one redeploy and rechecks all contracts', async () => {
  let fresh = false, redeploys = 0;
  const stub = server({ version: () => fresh ? current : { ...current, hub: { ...current.hub, build: 'old-build' } } });
  await checkAfterDeploy({ ...options(stub), redeploy: async () => { redeploys++; fresh = true; }, log: () => {} });
  assert.equal(redeploys, 1);
  assert.equal(stub.requests.filter(r => new URL(r.url).pathname === '/v1/me').length, 2);
});

test('persistent skew fails after one retry, even with unchanged package version', async () => {
  const stub = server({ version: { ...current, hub: { ...current.hub, build: 'old-build' } } });
  let redeploys = 0;
  await assert.rejects(checkAfterDeploy({ ...options(stub), redeploy: async () => { redeploys++; }, log: () => {} }), /stale/);
  assert.equal(redeploys, 1);
});

test('missing legacy Hub RPC is stale, but absent version route and old Worker fail closed', async () => {
  const missingHub = server({ version: { worker: current.worker, hub: null } });
  let redeploys = 0;
  await assert.rejects(checkAfterDeploy({ ...options(missingHub), redeploy: async () => { redeploys++; }, log: () => {} }), /stale/);
  assert.equal(redeploys, 1);
  for (const version of [{}, { worker: { ...current.worker, engine: 'old' }, hub: current.hub }, { ...current, hub: { ...current.hub, schema: 'one' } }]) {
    await assert.rejects(checkAfterDeploy({ ...options(server({ version })), redeploy: () => assert.fail('not a version skew'), log: () => {} }));
  }
});

test('version REST endpoint gets Hub engine/schema/build from Hub RPC, without database writes', async () => {
  const { handleRest } = await loadModule('src/rest.ts');
  const { ENGINE_VERSION, HUB_SCHEMA_VERSION } = await loadModule('src/version.ts');
  const { hub, sql } = await memoryHub({ CF_VERSION_METADATA: { id: 'hub-build' } });
  try {
    const before = sql.db.prepare('SELECT total_changes() AS n').get().n;
    const req = new Request('https://example.com/v1/version');
    const response = await handleRest(req, new URL(req.url), hub, 'alice', ['alice'], { CF_VERSION_METADATA: { id: 'worker-build' } });
    assert.deepEqual(await response.json(), { worker: { engine: ENGINE_VERSION, schema: HUB_SCHEMA_VERSION, build: 'worker-build' }, hub: { engine: ENGINE_VERSION, schema: HUB_SCHEMA_VERSION, build: 'hub-build' } });
    assert.equal(sql.db.prepare('SELECT total_changes() AS n').get().n, before);
    const legacy = await handleRest(req, new URL(req.url), { version: async () => { throw new Error('RPC unavailable'); } }, 'alice', ['alice'], {});
    assert.deepEqual((await legacy.json()).hub, null);
  } finally { sql.db.close(); }
});

test('a passed contract check is recorded once per call for /docs/status; a failed record does not fail the check', async () => {
  const { handleRest } = await loadModule('src/rest.ts');
  const { hub, sql } = await memoryHub();
  try {
    assert.equal((await hub.setupStatus()).last_contract_check, null);
    const req = new Request('https://example.com/v1/contract-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: '0.1.0' }) });
    const res = await handleRest(req, new URL(req.url), hub, 'alice', ['alice'], {});
    assert.deepEqual(await res.json(), { recorded: true });
    assert.match((await hub.setupStatus()).last_contract_check, /^\d{4}-/);
  } finally { sql.db.close(); }
  const failing = server();
  const fetchImpl = async (url, init) => new URL(url).pathname === '/v1/contract-check' ? new Response('private-sentinel', { status: 404 }) : failing.fetchImpl(url, init);
  await checkContract({ ...options(failing), fetchImpl });
});

test('contract rejects redirects, transport errors and malformed JSON without echoing bodies', async () => {
  for (const fetchImpl of [async () => { throw new Error('private-sentinel'); }, async () => new Response('private-sentinel'), async () => new Response('', { status: 302, headers: { Location: 'https://other.example.com' } })]) {
    await assert.rejects(checkAfterDeploy({ origin: 'https://example.com', token, fetchImpl, redeploy: () => assert.fail('no retry on non-skew failure') }), e => !e.message.includes('private-sentinel'));
  }
});

test('Worker routes version through existing bearer authentication and Hub main', async () => {
  const { build } = await import('esbuild');
  const { readFile } = await import('node:fs/promises');
  const { outputFiles } = await build({
    entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.md': 'text', '.sh': 'text' },
    plugins: [{ name: 'offline-worker', setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf' }));
      b.onLoad({ filter: /.*/, namespace: 'cf' }, () => ({ contents: 'export class DurableObject {} export class WorkerEntrypoint {}' }));
      b.onLoad({ filter: /[/\\]bin[/\\]goonbridge-(?:mcp|responder)\.mjs$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8'), loader: 'text' }));
    } }],
  });
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  const { hub, sql } = await memoryHub({ CF_VERSION_METADATA: { id: 'same-build' } });
  try {
    const env = { GOONBRIDGE_TOKENS: JSON.stringify({ [token]: 'alice' }), HUB: { idFromName(name) { assert.equal(name, 'main'); return name; }, get: () => hub }, CF_VERSION_METADATA: { id: 'same-build' } };
    const ctx = { waitUntil() {} };
    const url = 'https://example.com/v1/version';
    assert.equal((await worker.fetch(new Request(url), env, ctx)).status, 401);
    const response = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.worker.build, 'same-build');
    assert.deepEqual(body.hub, body.worker);
  } finally { sql.db.close(); }
});
