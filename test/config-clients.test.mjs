import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule } from './hub-memory.mjs';
import { brandingPattern } from './harness/baselines.mjs';
const root = new URL('..', import.meta.url).pathname;
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const neutral = JSON.parse(read('test/fixtures/neutral/bridge.config.json'));
function sandbox(t) {
  const dir = mkdtempSync(join(root, 'test/.config-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GOONBRIDGE_|CHIMERA_|BRIDGE_CONFIG$|CLAUDE_CODE_REMOTE)/.test(k)));
  env.BRIDGE_CONFIG = join(dir, 'bridge.json');
  return { dir, env };
}

test('responder reads generated client config and legacy env overrides still win', async t => {
  const { env } = sandbox(t);
  const { clientConfig } = await loadModule('src/config/client.ts');
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify(clientConfig(neutral)));
  const code = "import {base,stateDir} from './bin/responder/config.mjs'; console.log(JSON.stringify({base,stateDir}));";
  const run = extra => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }));
  assert.equal(run({}).base, 'https://example.com');
  assert.match(run({}).stateDir, /\.chimera$/);
  assert.equal(run({ CHIMERA_URL: 'https://alias.example.com', GOONBRIDGE_URL: 'https://legacy.example.com' }).base, 'https://legacy.example.com');
  assert.equal(run({ GOONBRIDGE_STATE_DIR: 'relative-state' }).stateDir, 'relative-state');
});

test('approval hook uses configured approver and protected branches, with no bridge call', async t => {
  const { env } = sandbox(t);
  const { clientConfig } = await loadModule('src/config/client.ts');
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ ...clientConfig(neutral), protected_branches: ['trunk'] }));
  const code = `import {destructive,decide} from './.claude/hooks/approval.mjs';
    const asked = [];
    const result = decide('git push origin trunk', 'push to trunk', '.', (method,path,body) => {
      if(path === '/v1/me') return {member:'alice-cloud'};
      if(path.startsWith('/v1/threads')) return [];
      asked.push(body.to); return {thread_id:1};
    });
    console.log(JSON.stringify({asked,result,main:destructive('git push origin main'),trunk:destructive('git push origin trunk')}));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' }));
  assert.deepEqual(out.asked, ['alice']);
  assert.equal(out.main, null);
  assert.equal(out.trunk, 'push to trunk');
  assert.doesNotMatch(out.result.reason, brandingPattern());
});

test('shell hooks read URL, header names and token reference from bridge.json without eval', async t => {
  const { env } = sandbox(t);
  const { clientConfig } = await loadModule('src/config/client.ts');
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ ...clientConfig(neutral), token_env: 'TEST_CLIENT_TOKEN' }));
  const script = '. .claude/hooks/bridge-config.sh\nprintf "%s\\n" "$bridge_url" "$bridge_session_header" "$bridge_context_header" "$bridge_name" "${bridge_token:+present}"';
  const run = extra => execFileSync('sh', ['-c', script], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(run({ TEST_CLIENT_TOKEN: 'synthetic' }), ['https://example.com', 'Chimera-Session', 'Chimera-Context', 'chimera', 'present']);
  assert.equal(run({ GOONBRIDGE_URL: 'https://legacy.example.com' })[0], 'https://legacy.example.com');
});

test('cloud setup writes the complete nonsecret projection; installer reads it without changing install identity', async t => {
  const { env } = sandbox(t);
  const { clientConfig, clientScript } = await loadModule('src/config/client.ts');
  const rendered = clientScript(read('bin/cloud-setup.sh'), neutral);
  // Execute only the local config-writing block. No provisioning, downloads, shell RC or credential writes.
  const prelude = rendered.slice(rendered.indexOf("bridge_defaults='"), rendered.indexOf('\nenvfile='));
  const block = rendered.slice(rendered.indexOf('# Endpoint and reference'), rendered.indexOf('# Values for later shells'));
  execFileSync('sh', ['-c', `set -eu\n${prelude}\nhas() { command -v "$1" >/dev/null 2>&1; }\n${block}`], { cwd: root, env });
  assert.deepEqual(JSON.parse(readFileSync(env.BRIDGE_CONFIG, 'utf8')), clientConfig(neutral));
  const installer = clientScript(read('bin/install-responder-macos.sh'), neutral);
  const configOnly = installer.slice(installer.indexOf("bridge_defaults='"), installer.indexOf('\nif [ "${1:-}"'));
  const out = execFileSync('sh', ['-c', `${configOnly}\nprintf '%s\\n' "$label" "$state_name" "$(bridge_value url)"`], { cwd: root, env, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['com.example.chimera-responder', '.chimera', 'https://example.com']);
  for (const script of [rendered, installer]) execFileSync('sh', ['-n'], { input: script });
});

test('all touched scripts parse, and cloud URL persistence quotes shell metacharacters literally', () => {
  for (const path of ['bin/cloud-setup.sh', 'bin/install-responder-macos.sh', '.claude/hooks/bridge-config.sh', '.claude/hooks/heartbeat.sh', '.claude/hooks/heartbeat-loop.sh', '.claude/hooks/wind-down.sh', '.claude/hooks/fetch-external-skills.sh']) execFileSync('sh', ['-n', path], { cwd: root });
  const script = read('bin/cloud-setup.sh');
  const quoting = script.slice(script.indexOf('  quoted_bridge='), script.indexOf('  [ -n "$cf_token"', script.indexOf('  quoted_bridge=')));
  const expected = "https://example.com/'$(false)";
  const exported = execFileSync('sh', ['-c', quoting], { env: { ...process.env, bridge: expected }, encoding: 'utf8' });
  const actual = execFileSync('sh', ['-c', `${exported}\nprintf '%s' "$GOONBRIDGE_URL"`], { encoding: 'utf8' });
  assert.equal(actual, expected);
});
