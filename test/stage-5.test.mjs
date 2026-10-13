import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { loadModule } from './hub-memory.mjs';
import { configPlugin, buildResponder } from './harness/build.mjs';
import { isDeepStrictEqual } from 'node:util';
import { presentDeployments, readDeployment, brandingPattern, ownerPattern, baselineDeployments, baselineUrl } from './harness/baselines.mjs';
const root = resolve('.');
const read = p => readFileSync(join(root, p), 'utf8');
const example = JSON.parse(read('deployments/example/bridge.config.json'));
function sandbox(t) {
  mkdirSync('.chimera-test', { recursive: true });
  const dir = mkdtempSync(join(root, '.chimera-test/stage5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GOONBRIDGE_|CHIMERA_|BRIDGE_CONFIG$|CLAUDE_CODE_REMOTE)/.test(k)));
  Object.assign(env, { HOME: dir, TMPDIR: dir, BRIDGE_CONFIG: join(dir, 'bridge.json') });
  return { dir, env };
}

test('D3 responder removes both aliases and a configured prefix from child env', async t => {
  const { dir, env } = sandbox(t);
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ env_prefix: 'CUSTOM' }));
  const { outputFiles } = await build({ entryPoints: ['bin/responder/claude.mjs'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const file = join(dir, 'claude.mjs'); writeFileSync(file, outputFiles[0].text);
  const code = `import {scrubbedEnv} from ${JSON.stringify(file)}; console.log(JSON.stringify(scrubbedEnv()));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, CHIMERA_TOKEN: 'synthetic', CHIMERA_STATE_DIR: 'hidden', GOONBRIDGE_TOKEN: 'synthetic', CUSTOM_TOKEN: 'synthetic' }, encoding: 'utf8' }));
  for (const key of ['CHIMERA_TOKEN', 'CHIMERA_STATE_DIR', 'GOONBRIDGE_TOKEN', 'CUSTOM_TOKEN']) assert.equal(out[key], undefined);
  assert.equal(out.HOME, env.HOME);
});

test('D4 selected responder defaults need no bridge.json; installer uses configured filename', async t => {
  const { dir, env } = sandbox(t);
  const { outputFiles } = await build({ stdin: { contents: `export {base,stateDir} from './bin/responder/config.mjs'`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [configPlugin(example)] });
  const bundle = join(dir, 'config.mjs'); writeFileSync(bundle, outputFiles[0].text);
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {base,stateDir} from ${JSON.stringify(bundle)}; console.log(JSON.stringify({base,stateDir}));`], { env, encoding: 'utf8' }));
  assert.equal(result.base, example.deployment.origin);
  assert.equal(result.stateDir, join(dir, example.clients.stateDirName));
  const { clientScript } = await loadModule('src/config/client.ts');
  const installer = clientScript(read('bin/install-responder-macos.sh'), example);
  const prelude = installer.slice(installer.indexOf("bridge_defaults='"), installer.indexOf('\nif [ "${1:-}"'));
  assert.equal(execFileSync('sh', ['-c', `${prelude}\nprintf '%s' "$responder_name"`], { env, encoding: 'utf8' }), 'chimera-responder.mjs');
  assert.match(installer, /\$script_dir\/\$responder_name/);
});

test('D5 cloud setup selects pinned commit', async t => {
  const { env } = sandbox(t);
  const { clientScript } = await loadModule('src/config/client.ts');
  const script = clientScript(read('bin/cloud-setup.sh'), example);
  const prelude = script.slice(script.indexOf("bridge_defaults='"), script.indexOf('\nenvfile='));
  const line = script.split('\n').find(l => l.trim().startsWith('config_ref='));
  assert.ok(line);
  assert.equal(execFileSync('sh', ['-c', `${prelude}\n${line}\nprintf '%s' "$config_ref"`], { env: { ...env, CLOUD_CONFIG_REF: 'main' }, encoding: 'utf8' }), example.cloud.configBundle.commit);
  assert.match(script, /cloud-config\?ref=\$\{config_ref\}/);
});

test('D8 substitution targets selected config entry even with another deployment selected', async () => {
  const registered = [];
  configPlugin(example).setup({ onLoad: (options, callback) => registered.push({ ...options, callback }) });
  const entry = registered.find(r => r.filter.test(join(root, 'src/config/deployment.ts')));
  assert.ok(entry, 'replace the deployment module itself');
  const built = await buildResponder(example);
  assert.doesNotMatch(built, ownerPattern());
});

test('D9 legacy claim overrides missing, empty, invalid or nonpositive fall back to 900', async () => {
  const { resolveConfig } = await loadModule('src/config/resolve.ts');
  // The fallback belongs to the GOONBRIDGE compatibility prefix, so resolve against a config on that prefix rather than
  // the bundled one (the neutral bundle's CHIMERA prefix keeps its own configured timing, by design).
  const legacy = { ...example, compatibility: { ...example.compatibility, envPrefix: 'GOONBRIDGE', headerPrefix: 'Goonbridge' } };
  assert.equal(legacy.compatibility.envPrefix, 'GOONBRIDGE');
  for (const value of [undefined, '', 'bad', '0', '-1']) assert.equal(resolveConfig(value === undefined ? {} : { GOONBRIDGE_CLAIM_SECONDS: value }, legacy).timing.claimSeconds, 900);
  assert.equal(resolveConfig({ GOONBRIDGE_CLAIM_SECONDS: '4500' }, legacy).timing.claimSeconds, 4500);
});

test('R5 schema rejects unsupported env prefixes', async () => {
  const { validateConfig } = await loadModule('src/config/schema.ts');
  for (const prefix of ['GOONBRIDGE', 'CHIMERA']) { const c = structuredClone(example); c.compatibility.envPrefix = prefix; assert.doesNotThrow(() => validateConfig(c)); }
  const c = structuredClone(example); c.compatibility.envPrefix = 'CUSTOM'; assert.throws(() => validateConfig(c));
});

test('D7 orphan fixture stays neutral without weakening the output guard', () => {
  assert.doesNotMatch(read('test/orphans.test.mjs'), /In goonbridge, do a thing/);
  assert.match(read('test/orphans.test.mjs'), /the requester is told the session never booted/);
});

test('D6 disabled hooks and empty skills do no work; every listed skill is fetched', async t => {
  const { dir, env } = sandbox(t);
  const tools = join(dir, 'tools'); mkdirSync(tools);
  const log = join(dir, 'calls');
  writeFileSync(join(tools, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\ncase "$*" in *show*) printf "skill content\\n";; esac\n', { mode: 0o755 });
  writeFileSync(join(tools, 'curl'), '#!/bin/sh\necho curl >> "$CALL_LOG"\n', { mode: 0o755 });
  const runEnv = { ...env, PATH: `${tools}:${env.PATH}`, CALL_LOG: log, CLAUDE_CODE_REMOTE: '1', CHIMERA_TOKEN: 'synthetic', CLAUDE_PROJECT_DIR: dir };
  const run = name => execFileSync('sh', [`.claude/hooks/${name}.sh`, 'start'], { env: runEnv });
  writeFileSync(log, '');
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ enabled_hooks: [], external_skills: [{ repo: 'https://example.test/disabled.git', commit: 'a'.repeat(40), path: 'skills/a/SKILL.md' }] }));
  for (const hook of ['fetch-external-skills', 'heartbeat', 'heartbeat-loop', 'wind-down']) run(hook);
  assert.equal(readFileSync(log, 'utf8'), '');
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ enabled_hooks: ['fetch-external-skills'], external_skills: [] }));
  run('fetch-external-skills'); assert.equal(readFileSync(log, 'utf8'), '');
  const skills = ['first', 'second'].map(name => ({ repo: `https://example.test/${name}.git`, commit: 'b'.repeat(40), path: `skills/${name}/SKILL.md` }));
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ enabled_hooks: ['fetch-external-skills'], external_skills: skills }));
  run('fetch-external-skills');
  for (const name of ['first', 'second']) {
    assert.match(readFileSync(log, 'utf8'), new RegExp(`example.test/${name}.git`));
    assert.equal(readFileSync(join(dir, `.claude/skills/${name}/SKILL.md`), 'utf8'), 'skill content\n');
  }
});

test('R3 approval curl credentials stay on stdin and errors never expose server bodies', async t => {
  const { dir, env } = sandbox(t);
  const { outputFiles } = await build({ entryPoints: ['.claude/hooks/approval.mjs'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const hook = join(dir, 'approval.mjs'); writeFileSync(hook, outputFiles[0].text);
  const tools = join(dir, 'tools'); mkdirSync(tools);
  // Stub consumes stdin in memory and records only whether credentials appeared in argv/stdin.
  writeFileSync(join(tools, 'curl'), `#!${process.execPath}\nlet input=''; for await (const c of process.stdin) input+=c; if(process.argv.join(' ').includes('synthetic-bearer')) process.exit(2); if(!input.includes('Authorization: Bearer synthetic-bearer')) process.exit(3); console.log(JSON.stringify({error:'raw-body-sentinel'}));\n`, { mode: 0o755 });
  const result = execFileSync(process.execPath, [hook], { env: { ...env, PATH: `${tools}:${env.PATH}`, CHIMERA_TOKEN: 'synthetic-bearer' }, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(result).hookSpecificOutput.permissionDecision, 'deny');
  assert.doesNotMatch(result, /raw-body-sentinel|synthetic-bearer|Command failed/);
});

test('D6 approval hook disabled in config makes no command or request', t => {
  const { dir, env } = sandbox(t);
  writeFileSync(env.BRIDGE_CONFIG, JSON.stringify({ enabled_hooks: [] }));
  const tools = join(dir, 'tools'); mkdirSync(tools);
  writeFileSync(join(tools, 'curl'), '#!/bin/sh\nexit 99\n', { mode: 0o755 }); env.PATH = `${tools}:${env.PATH}`;
  assert.equal(execFileSync(process.execPath, ['.claude/hooks/approval.mjs'], { env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), '');
});

test('D11 harness cleans children and grandchildren on exit, SIGINT and failure', async t => {
  const { dir } = sandbox(t);
  const { spawn } = await import('node:child_process');
  const { setTimeout: delay } = await import('node:timers/promises');
  for (const mode of ['exit', 'SIGINT', 'failure']) {
    const script = join(dir, `${mode}.mjs`);
    const moduleUrl = new URL('./harness/process.mjs', import.meta.url).href;
    writeFileSync(script, `import {command} from ${JSON.stringify(moduleUrl)};
const run=command(process.execPath,['-e', ${JSON.stringify(`const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`)}],{stdio:['ignore','pipe','ignore']});
run.child.stdout.once('data', data=>{ console.log(JSON.stringify([run.child.pid,Number(String(data).trim())])); ${mode === 'exit' ? 'process.exit(0)' : mode === 'failure' ? 'throw new Error("intentional failure")' : ''} });`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    let pids = [];
    t.after(() => { child.kill('SIGKILL'); for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
    pids = await new Promise((resolve, reject) => { child.stdout.once('data', d => resolve(JSON.parse(String(d)))); child.once('error', reject); });
    if (mode === 'SIGINT') child.kill('SIGINT');
    await closed;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let n = 0; n < 50 && pids.some(alive); n++) await delay(20);
    assert.ok(pids.every(pid => !alive(pid)), `${mode}: child or grandchild survived`);
  }
});

test('D2 owner emails come only from the private owner input', async t => {
  const { dir } = sandbox(t);
  const { ownerEmails } = await import('./harness/owner-emails.mjs');
  assert.deepEqual(ownerEmails(dir, 'alice', 'bob'), { owner: undefined, other: undefined });
  writeFileSync(join(dir, '.dev.vars'), `GOONBRIDGE_MEMBERS='${JSON.stringify({ 'alice@example.test': 'alice', 'bob@example.test': 'bob' })}'\n`);
  assert.deepEqual(ownerEmails(dir, 'alice', 'bob'), { owner: 'alice@example.test', other: 'bob@example.test' });
});

test('D2 publication candidate contains no personal email addresses', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const email = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  for (const file of new Set(files)) {
    let text; try { text = read(file); } catch { continue; }
    for (const match of text.matchAll(email)) assert.match(match[1], /^(?:example\.(?:com|org|net|test)|.*\.example\.(?:com|org|net|test))$/, `non-synthetic email in ${file}`);
  }
});

test('R3 curl runner receives bearer only via stdin and ignores response errors', async t => {
  const { dir, env } = sandbox(t);
  const file = join(dir, 'check.mjs');
  const hook = new URL('../.claude/hooks/approval.mjs', import.meta.url).href;
  writeFileSync(file, `import {bridge} from ${JSON.stringify(hook)};
const result = bridge('GET','/v1/me',undefined,(command,args,options)=>{
 if(command!=='curl'||args.includes('synthetic-bearer')||args.join(' ').includes('Authorization')) throw new Error('bad argv');
 if(!options.input.includes('Authorization: Bearer synthetic-bearer')) throw new Error('missing stdin auth');
 if(!args.includes('--config')||!args.includes('-')) throw new Error('missing stdin config');
 return '{"member":"alice"}';
}); console.log(result.member);`);
  assert.equal(execFileSync(process.execPath, [file], { env: { ...env, CHIMERA_TOKEN: 'synthetic-bearer' }, encoding: 'utf8' }).trim(), 'alice');
});

test('R4 generated default clients preserve owner context and match selected config', async () => {
  const { generateClients } = await import('../bin/gen-clients.mjs');
  // The committed client files are the generation of a deployment in this checkout (the example, or a fork's own).
  const generated = presentDeployments().map(id => generateClients(readDeployment(id)));
  assert.ok(generated.some(g => isDeepStrictEqual(g.mcp, JSON.parse(read('.mcp.json'))) && isDeepStrictEqual(g.settings, JSON.parse(read('.claude/settings.json')))), '.mcp.json and .claude/settings.json come from one deployment folder');
  // Owner mode: each deployment with private client baselines still generates them byte for byte (owner context kept).
  for (const id of baselineDeployments('mcp.json')) {
    const g = generateClients(readDeployment(id));
    assert.deepEqual(g.mcp, JSON.parse(readFileSync(baselineUrl(id, 'mcp.json'), 'utf8')));
    assert.deepEqual(g.settings, JSON.parse(readFileSync(baselineUrl(id, 'settings.json'), 'utf8')));
  }
  const selected = generateClients(example);
  assert.equal(selected.mcp.mcpServers.chimera.headers['Chimera-Context'], 'example');
  assert.match(selected.settings.hooks.SessionStart[0].hooks[0].command, /https:\/\/example.com\/cloud-setup.sh/);
  assert.equal(selected.settings.hooks.PreToolUse, undefined);
});

test('D1 credential gate precedes deployment and recovery uses the generated config', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.ok(workflow.indexOf('test -n "$BRIDGE_CONTRACT_TOKEN"') < workflow.indexOf('wrangler deploy -c'));
  assert.match(read('bin/contract-check.mjs'), /wrangler.*deploy.*-c.*generated\/wrangler/);
});

test('D4 build writes the configured checkout filename and the legacy asset alias', async () => {
  const { buildResponder } = await import('../bin/build-responder.mjs');
  const files = new Map();
  await buildResponder({ config: example, write: async (file, content) => files.set(file, content) });
  assert.equal(files.size, 2);
  const named = files.get(join(root, 'bin/chimera-responder.mjs'));
  assert.equal(named, files.get(join(root, 'bin/goonbridge-responder.mjs')));
  assert.doesNotMatch(named, ownerPattern());
  assert.match(named, /https:\/\/example.com/);
});

test('D4 installer copies the configured name and preserves every deployment installation identity', async t => {
  const { clientScript } = await loadModule('src/config/client.ts');
  for (const config of presentDeployments().map(readDeployment)) {
    const { dir, env } = sandbox(t);
    const name = config.compatibility.assetNames.responder.slice(1);
    writeFileSync(join(dir, name), '// synthetic responder artifact\n');
    const script = join(dir, 'install.sh');
    writeFileSync(script, clientScript(read('bin/install-responder-macos.sh'), config));
    const state = join(dir, config.clients.stateDirName); mkdirSync(state);
    writeFileSync(join(state, 'grant.json'), '{}');
    const tools = join(dir, 'tools'); mkdirSync(tools);
    writeFileSync(join(tools, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(tools, 'launchctl'), '#!/bin/sh\n[ "$1" != print ]\n', { mode: 0o755 });
    execFileSync('sh', [script], { env: { ...env, PATH: `${tools}:${env.PATH}` }, stdio: 'pipe' });
    assert.equal(readFileSync(join(state, name), 'utf8'), '// synthetic responder artifact\n');
    assert.match(readFileSync(join(state, config.deployment.productName ?? 'chimera'), 'utf8'), new RegExp(name.replaceAll('.', '\\.')));
    const plist = readFileSync(join(dir, 'Library/LaunchAgents', `${config.clients.launchdLabel}.plist`), 'utf8');
    assert.ok(plist.includes(config.deployment.origin));
    assert.ok(plist.includes(config.clients.stateDirName));
  }
});

test('D4 checkout installer loads selected defaults and missing config fails closed', async t => {
  const { clientDefaults } = await import('../bin/client-defaults.mjs');
  assert.equal((await clientDefaults(example)).url, example.deployment.origin);
  assert.equal((await clientDefaults(example)).responder_name, 'chimera-responder.mjs');
  const { dir, env } = sandbox(t);
  const raw = read('bin/install-responder-macos.sh');
  const file = join(dir, 'install.sh'); writeFileSync(file, raw);
  assert.throws(() => execFileSync('sh', [file], { env, stdio: 'pipe' }), /deployment launchd label missing/);
  // Execute the real checkout's default-loading block with its own script pathname, no launchd calls.
  const block = raw.slice(raw.indexOf("bridge_defaults='"), raw.indexOf('\nif [ "${1:-}"'));
  const out = execFileSync('sh', ['-c', `${block}\nprintf '%s' "$responder_name"`, join(root, 'bin/install-responder-macos.sh')], { env, encoding: 'utf8' });
  // The installer's environment selects the deployment (CHIMERA_DEPLOYMENT, default example), like every other tool.
  const { loadSelectedConfig, selectedDeploymentId } = await import('../bin/selected-deployment.mjs');
  assert.equal(out, loadSelectedConfig(selectedDeploymentId(env)).compatibility.assetNames.responder.slice(1));
});
