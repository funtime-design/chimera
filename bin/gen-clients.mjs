import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMain, projectRoot } from './deployment.mjs';
import { loadSelectedConfig } from './selected-deployment.mjs';

// Nonsecret entry points generated from the same selected deployment as the Worker.
export function generateClients(config) {
  const { deployment: d, compatibility: c, clients, hooks } = config;
  const enabled = name => hooks.enabled.includes(name);
  const command = (text, timeout) => ({ type: 'command', command: text, ...(timeout ? { timeout } : {}) });
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const local = (name, timeout, suffix = '') => command(`sh "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.sh"${suffix}`, timeout);
  const session = [command(`[ -n "\${CLAUDE_CODE_REMOTE:-}" ] && curl -fsSL ${shellQuote(d.origin + '/cloud-setup.sh')} | sh || true`)];
  if (enabled('fetch-external-skills') && hooks.externalSkills.length) session.push(local('fetch-external-skills', 30));
  if (enabled('heartbeat-loop')) session.push(local('heartbeat-loop', 10, ' start'));
  const entries = { SessionStart: [{ hooks: session }] };
  if (enabled('approval')) entries.PreToolUse = [{ matcher: 'Bash', hooks: [command('node "$CLAUDE_PROJECT_DIR/.claude/hooks/approval.mjs"', 60)] }];
  if (enabled('heartbeat')) entries.PostToolUse = [{ hooks: [local('heartbeat', 10)] }];
  if (enabled('wind-down')) entries.SessionEnd = [{ hooks: [local('wind-down', 15)] }];
  return {
    mcp: { mcpServers: { [clients.connectorName]: { type: 'http', url: `${d.origin}/mcp`, headers: {
      Authorization: `Bearer \${${c.envPrefix}_TOKEN:-}`, [`${c.headerPrefix}-Session`]: '${CLAUDE_CODE_REMOTE_SESSION_ID:-}', [`${c.headerPrefix}-Context`]: c.envPrefix === 'GOONBRIDGE' ? (config.presentation?.exampleRepo ?? d.id) : d.id,
    } } } },
    settings: { hooks: entries, permissions: { defaultMode: 'bypassPermissions', allow: [`mcp__${clients.connectorName}__*`, 'mcp__claude-code-remote__create_session'] } },
  };
}
export async function writeClients(config = loadSelectedConfig(), root = projectRoot) {
  const clients = generateClients(config);
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify(clients.mcp, null, 2) + '\n');
  await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify(clients.settings, null, 2) + '\n');
}
if (isMain(import.meta.url)) await writeClients();
