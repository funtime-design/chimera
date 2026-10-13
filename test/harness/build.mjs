import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../..', import.meta.url));
export function configPlugin(config) {
  return { name: 'engine-test-config', setup(b) {
    // Replace only the deployment input, never rewrite compiled engine behavior or expectations.
    b.onLoad({ filter: /[/\\]src[/\\]config[/\\]deployment\.ts$/ }, () => ({ contents: `export default ${JSON.stringify(config)};`, loader: 'ts' }));
  } };
}
export async function buildResponder(config) {
  const { outputFiles } = await build({ absWorkingDir: root, entryPoints: ['bin/responder/main.mjs'], bundle: true, write: false,
    format: 'esm', platform: 'node', banner: { js: '#!/usr/bin/env node' }, plugins: [configPlugin(config)] });
  return outputFiles[0].text;
}
export async function buildEngine(config) {
  const responder = await buildResponder(config);
  const { outputFiles } = await build({
    absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    external: ['cloudflare:*', 'node:*'], loader: { '.md': 'text', '.sh': 'text' },
    plugins: [configPlugin(config), { name: 'worker-text-assets', setup(b) {
      b.onLoad({ filter: /[/\\]bin[/\\]goonbridge-(?:mcp|responder)\.mjs$/ }, async ({ path }) => ({ contents: path.endsWith('goonbridge-responder.mjs') ? responder : await readFile(path, 'utf8'), loader: 'text' }));
    } }],
  });
  return outputFiles[0].text;
}
