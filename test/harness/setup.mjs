import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, cleanEnvironment } from './fixture.mjs';
import { buildEngine, buildResponder, root } from './build.mjs';
import { command } from './process.mjs';
import { loadModule } from '../hub-memory.mjs';
import { execFileSync } from 'node:child_process';

// Temporary artifacts live in the OS temp directory, never in an owner's HOME, a sibling worktree or this checkout:
// a checkout path can carry the deployment name, which the neutral output checks would then see in every echoed path.
const temporary = await mkdtemp(join(tmpdir(), 'chimera-test-run-'));
let current;
let stopping = false;
const cleanup = async () => { stopping = true; await current?.stop(); await rm(temporary, { recursive: true, force: true }); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
try {
  const fixture = makeFixture();
  const { clientConfig } = await loadModule("src/config/client.ts");
  // Wrangler's no_bundle watcher recursively watches dirname(main). Give the bundle a
  // directory of its own, or every persist/log/home write under the run reloads the Worker.
  await mkdir(join(temporary, 'engine'));
  const bundle = join(temporary, 'engine', 'engine.js');
  await writeFile(bundle, await buildEngine(fixture.config));
  const responder = join(temporary, 'responder.mjs');
  await writeFile(responder, await buildResponder(fixture.config));
  const requested = process.argv.slice(2).filter(v => v !== '--');
  const all = (await readdir(join(root, 'test'))).filter(n => n.endsWith('.test.mjs')).sort();
  const files = requested.includes('--smoke') ? ['auth.test.mjs'] : requested.length ? requested.map(name => basename(name)) : all;
  if (files.some(n => !all.includes(n))) throw new Error('pass --smoke or existing test/*.test.mjs filenames');
  const compatibility = new Set(['rules.test.mjs', 'config.test.mjs', 'config-clients.test.mjs', 'external-skills.test.mjs']);
  if (files.some(file => ['cloud-config.test.mjs', 'config-clients.test.mjs'].includes(file))) {
    for (const binary of ['sh', 'git', 'curl', 'jq', 'sha256sum']) {
      try { execFileSync('sh', ['-c', 'command -v "$1"', 'engine-preflight', binary], { stdio: 'pipe' }); }
      catch { throw new Error(`test:engine requires ${binary} on PATH; install the suite's local tools before running (the harness never installs system tools)`); }
    }
  }
  for (const file of files) {
    if (stopping) break;
    console.log(`\nEngine: ${file}`);
    const sandbox = join(temporary, file);
    await mkdir(sandbox);
    const home = join(sandbox, "home");
    await mkdir(home);
    const env = { ...cleanEnvironment(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: join(root, "node_modules", ".bin") + delimiter + process.env.PATH, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox,
      CHIMERA_TEST_DIRECTORY: sandbox, CHIMERA_ENGINE_BUNDLE: bundle, CHIMERA_RESPONDER_BIN: responder };
    if (!compatibility.has(file)) {
      const clientFile = join(sandbox, 'bridge.json');
      await writeFile(clientFile, JSON.stringify(clientConfig(fixture.config)));
      Object.assign(env, { CHIMERA_NEUTRAL: '1', CHIMERA_TEST_FIXTURE: JSON.stringify(fixture), BRIDGE_CONFIG: clientFile });
    }
    current = command(process.execPath, ['--test', '--test-concurrency=1', join(root, 'test', file)], { cwd: root, env, stdio: 'inherit' });
    const timeout = setTimeout(() => { console.error(`Timed out: ${file}`); void current?.stop(); }, 10 * 60 * 1000);
    const result = await current.exited.finally(() => clearTimeout(timeout));
    await current.stop(); current = undefined;
    if (result.code !== 0) { process.exitCode = result.code || 1; break; }
  }
} finally {
  await cleanup();
}
