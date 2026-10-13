import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// A synchronous final guard also covers process.exit(), uncaught failures and interrupted tests.
const owned = new Set();
const killOwned = () => { for (const signal of owned) signal('SIGKILL'); };
process.once('exit', killOwned);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  killOwned();
  // Let an enclosing harness finish its own directory cleanup, if it installed a handler.
  if (!process.listenerCount(signal)) process.exit(signal === 'SIGINT' ? 130 : 143);
});

// Each command is its own process group. Stop only groups this harness created, including Wrangler/workerd grandchildren.
export function command(executable, args, options = {}) {
  const detached = options.detached ?? process.platform !== 'win32';
  const child = spawn(executable, args, { ...options, detached });
  let settled = false;
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => { settled = true; reject(error); });
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal }); });
  });
  // A caller may still be waiting for readiness when spawn fails.
  exited.catch(() => {});
  const signal = value => {
    if (!child.pid) return;
    try {
      if (!detached || process.platform === 'win32') child.kill(value);
      else process.kill(-child.pid, value);
    // macOS answers EPERM for a group whose members are all still exiting (state E); that is "gone" too.
    } catch (e) { if (e.code !== 'ESRCH' && e.code !== 'EPERM') throw e; }
  };
  owned.add(signal);
  child.once('exit', () => { signal('SIGKILL'); owned.delete(signal); });
  child.once('error', () => owned.delete(signal));
  return { child, exited, async stop() {
    signal('SIGTERM');
    if (!settled) await Promise.race([exited.catch(() => {}), delay(2000, undefined, { ref: false })]);
    // A parent may exit before grandchildren; terminate remaining members of our group as well.
    signal('SIGKILL');
    owned.delete(signal);
    await Promise.race([exited.catch(() => {}), delay(2000, undefined, { ref: false })]);
  } };
}
