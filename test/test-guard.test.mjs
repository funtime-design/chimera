// bin/test-guard.mjs: plain `pnpm test` without GOONBRIDGE_URL says to run pnpm test:engine and exits 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../bin/test-guard.mjs', import.meta.url));
const run = env => spawnSync(process.execPath, [guard], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('without GOONBRIDGE_URL: one line pointing at pnpm test:engine, exit 1', () => {
  const r = run({});
  assert.equal(r.status, 1);
  assert.equal(`${r.stdout}${r.stderr}`.trim(), 'owner mode needs GOONBRIDGE_URL and fixtures; run `pnpm test:engine` for the self-contained suite');
});

test('with GOONBRIDGE_URL: passes through silently', () => {
  const r = run({ GOONBRIDGE_URL: 'http://localhost:3305' });
  assert.equal(r.status, 0);
  assert.equal(`${r.stdout}${r.stderr}`, '');
});

test('pnpm test runs the guard before anything else', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.pretest, /^node bin\/test-guard\.mjs && /);
});
