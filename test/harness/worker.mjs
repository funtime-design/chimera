import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { command } from './process.mjs';
import { cleanEnvironment, workerConfig } from './fixture.mjs';
const require = createRequire(import.meta.url);
export function wranglerCli() {
  const metadataPath = require.resolve('wrangler/package.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  return join(dirname(metadataPath), typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.wrangler);
}

export function readyUrl(message) {
  let event;
  try { event = typeof message === 'string' ? JSON.parse(message) : message; } catch { return null; }
  return event?.event === 'DEV_SERVER_READY' && event.ip === '127.0.0.1' && Number.isInteger(event.port) && event.port > 0 && event.port <= 65535
    ? `http://${event.ip}:${event.port}` : null;
}

export async function startWorker(directory, vars) {
  await mkdir(directory, { recursive: true });
  const config = join(directory, 'wrangler.json');
  await writeFile(config, JSON.stringify(workerConfig(process.env.CHIMERA_ENGINE_BUNDLE)));
  // Synthetic credentials remain in memory/argv; no .dev.vars, token file or credential-bearing config is written.
  const args = ['--require', require.resolve('./offline.cjs'), wranglerCli(), 'dev', '--local', '--config', config,
    '--persist-to', join(directory, 'state'), '--port', '0', '--inspector-port', '0', '--ip', '127.0.0.1', '--show-interactive-dev-session=false'];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);
  // Stay in the bootstrap's process group (not a group of our own): when setup.mjs stops the
  // test file with SIGTERM/SIGKILL, Wrangler and workerd go with it instead of being orphaned.
  const run = command(process.execPath, args, { detached: false, cwd: directory, env: { ...cleanEnvironment(), WRANGLER_LOG_PATH: join(directory, 'logs') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = '';
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local Worker readiness timed out')), 45000);
      const read = chunk => { log += chunk.toString(); };
      run.child.on('message', message => {
        const ready = readyUrl(message);
        if (ready) { clearTimeout(timer); resolve(ready); }
      });
      run.child.stdout.on('data', read); run.child.stderr.on('data', read);
      run.exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`local Worker exited (${code}) before readiness`)); }, error => { clearTimeout(timer); reject(error); });
    });
    // The bootstrap owns this process group. Let node:test finish its own after hooks
    // before the bootstrap stops Wrangler and workerd together.
    run.child.unref(); run.child.stdout.unref(); run.child.stderr.unref(); run.child.channel?.unref();
    return { url, stop: () => run.stop() };
  } catch (error) {
    await run.stop();
    // Wrangler's output can include binding values. Redact synthetic inputs too.
    for (const value of Object.values(vars)) if (value) log = log.replaceAll(value, '[fixture]');
    throw new Error(`${error.message}\n${log.slice(-6000)}`);
  }
}
