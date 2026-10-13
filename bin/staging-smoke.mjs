// Staging-only smoke after the contract check (deploy.yml runs it when DEPLOYMENT is "staging"): with the contract
// member's token it reads /docs/status as an admin, sends one message over MCP and reads its thread back, then creates,
// reads and drops one task. Any failure fails the job. The token is never printed.
import { argsFor, cli, isMain, loadDeployment, projectRoot, readJson, requirePrivateSecrets, validation } from './deployment.mjs';

const fail = why => { throw new Error(`staging smoke: ${why}`); };

export async function stagingSmoke({ origin, token, expectedDeployment, peer = 'probe', fetchImpl = fetch, log = console.log, timeoutMs = 15_000 }) {
  let url;
  try { url = new URL(origin); } catch { fail('origin must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.origin !== origin) fail('origin must be an HTTPS origin');
  if (!token || /\s/.test(token)) fail('contract bearer token missing or invalid');
  const request = async (endpoint, body) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${endpoint}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { fail(`request failed: ${endpoint}`); }
    if (!response.ok) fail(`HTTP ${response.status}: ${endpoint}`);
    try { return await response.json(); } catch { fail(`invalid JSON: ${endpoint}`); }
  };
  let id = 0;
  const call = async (name, args) => {
    const reply = await request('/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const text = reply?.result?.content?.[0]?.text;
    if (reply?.error || reply?.result?.isError || typeof text !== 'string') fail(`${name} failed${typeof text === 'string' ? `: ${text.slice(0, 200)}` : ''}`);
    return text;
  };

  const me = (await request('/v1/me'))?.member;
  if (typeof me !== 'string' || !me) fail('/v1/me names no member');
  const status = await request('/docs/status');
  if (status?.deployment !== expectedDeployment) fail(`/docs/status reports deployment ${JSON.stringify(status?.deployment)}, expected ${expectedDeployment}`);
  if (typeof status?.version?.engine !== 'string') fail('/docs/status has no engine version');
  log(`status: ${status.deployment} engine ${status.version.engine}`);

  const stamp = new Date().toISOString();
  const sent = await call('bridge_send', { to: peer, subject: 'staging smoke', body: `staging smoke ${stamp}` });
  const thread = Number(sent.match(/in thread (\d+)/)?.[1]);
  if (!thread) fail('bridge_send reply names no thread');
  if (!(await call('bridge_thread', { thread_id: thread })).includes(`staging smoke ${stamp}`)) fail('bridge_thread does not hold the sent message');
  log(`send: thread ${thread}`);

  const key = (await call('task_create', { owner: me, title: `staging smoke ${stamp}`, brief: 'Created by the staging smoke after a deploy; dropped by it straight away.' })).match(/^Created (T-\d+) /)?.[1];
  if (!key) fail('task_create reply names no task key');
  // Drop the task whatever happens next, so a failed read never leaves smoke tasks behind.
  let readError;
  try { if (!(await call('task_get', { key })).startsWith(`${key} · staging smoke ${stamp}`)) fail(`task_get ${key} does not match the created task`); }
  catch (error) { readError = error; }
  await call('task_update', { key, state: 'dropped' });
  if (readError) throw readError;
  log(`task: ${key} created, read and dropped`);
}

if (isMain(import.meta.url)) await cli(async () => {
  const options = argsFor(process.argv.slice(2));
  const { config } = await loadDeployment(options);
  let token = process.env.BRIDGE_CONTRACT_TOKEN;
  if (!token) {
    const file = await requirePrivateSecrets(projectRoot, options.deployment);
    const { validateSecrets } = await validation();
    const secrets = validateSecrets(await readJson(file), config);
    token = secrets.GOONBRIDGE_TOKENS[secrets.contractToken];
  }
  await stagingSmoke({ origin: config.deployment.origin, token, expectedDeployment: config.deployment.id });
  console.log('Staging smoke passed');
});
