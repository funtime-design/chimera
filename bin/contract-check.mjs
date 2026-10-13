import { argsFor, cli, isMain, loadDeployment, projectRoot, readJson, requirePrivateSecrets, runCommand, validation } from './deployment.mjs';
import path from 'node:path';

export class StaleHubError extends Error {}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const versionShape = v => record(v) && typeof v.engine === 'string' && v.engine.length > 0 && Number.isInteger(v.schema) && v.schema > 0 && (v.build === null || (typeof v.build === 'string' && v.build.length > 0));

export async function checkContract({ origin, token, expectedEngine, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('contract origin must be an HTTPS origin');
  if (!token || /\s/.test(token)) throw new Error('contract bearer token missing or invalid');
  const get = async (endpoint, body) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${endpoint}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error(`contract request failed: ${endpoint}`); }
    if (!response.ok) throw new Error(`contract HTTP failure: ${endpoint} (${response.status})`);
    try { return await response.json(); } catch { throw new Error(`contract invalid JSON: ${endpoint}`); }
  };
  const me = await get('/v1/me');
  if (!record(me) || typeof me.member !== 'string' || !me.member) throw new Error('contract /v1/me: member missing');
  // Check version before Hub-backed shapes so an old Hub gets its one recovery deploy.
  const version = await get('/v1/version');
  if (!record(version) || !versionShape(version.worker) || (expectedEngine && version.worker.engine !== expectedEngine)) throw new Error('contract /v1/version: Worker version mismatch or malformed response');
  if (version.hub === null) throw new StaleHubError('stale Hub: version RPC unavailable');
  if (!versionShape(version.hub)) throw new Error('contract /v1/version: malformed Hub version');
  if (['engine', 'schema', 'build'].some(key => version.worker[key] !== version.hub[key])) throw new StaleHubError('stale Hub: Worker and Hub versions differ');
  const faults = await get('/v1/faults');
  if (!record(faults) || !Array.isArray(faults.errors) || !Array.isArray(faults.work_threads)) throw new Error('contract /v1/faults: errors and work_threads must be arrays');
  const mcp = await get('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  if (mcp?.jsonrpc !== '2.0' || mcp.id !== 1 || mcp.error || !Array.isArray(mcp.result?.tools) || !['task_report', 'bridge_faults'].every(name => mcp.result.tools.some(t => t?.name === name))) throw new Error('contract MCP tools/list: required tools missing');
  return version;
}

export async function checkAfterDeploy({ redeploy, log = console.log, ...options }) {
  try { return await checkContract(options); }
  catch (error) {
    if (!(error instanceof StaleHubError) || !redeploy) throw error;
    log('Hub is stale; redeploying once');
    try { await redeploy(); } catch { throw new Error('contract recovery deploy failed (output redacted)'); }
    return checkContract(options);
  }
}

if (isMain(import.meta.url)) await cli(async () => {
  const options = argsFor(process.argv.slice(2), ['--redeploy-on-stale']);
  const { config } = await loadDeployment(options);
  let token = process.env.BRIDGE_CONTRACT_TOKEN;
  if (!token) {
    const file = await requirePrivateSecrets(projectRoot, options.deployment);
    const { validateSecrets } = await validation();
    const secrets = validateSecrets(await readJson(file), config);
    token = secrets.GOONBRIDGE_TOKENS[secrets.contractToken];
  }
  const pkg = await readJson(path.join(projectRoot, 'package.json'));
  await checkAfterDeploy({ origin: config.deployment.origin, token, expectedEngine: pkg.version,
    ...(options['redeploy-on-stale'] ? { redeploy: () => runCommand('pnpm', ['exec', 'wrangler', 'deploy', '-c', `.generated/wrangler.${options.deployment}.jsonc`]) } : {}),
  });
  console.log('Post-deploy contract passed');
});
