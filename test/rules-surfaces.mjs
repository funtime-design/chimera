import { build } from 'esbuild';
import { configPlugin } from './harness/build.mjs';
import { readFile } from 'node:fs/promises';
// Wrangler's Text assets, with no server, auth services or network calls.
export async function loadSurfaces(config) {
  const { outputFiles } = await build({
    stdin: { contents: 'export { setupGuide, pagesEndpoint } from "./src/pages.ts"; export { handleMcp } from "./src/mcp.ts";', resolveDir: new URL('..', import.meta.url).pathname },
    bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.md': 'text', '.sh': 'text' },
    plugins: [...(config ? [configPlugin(config)] : []), { name: 'worker-assets', setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf' }));
      b.onLoad({ filter: /.*/, namespace: 'cf' }, () => ({ contents: 'export class DurableObject {} export class WorkerEntrypoint {}' }));
      b.onLoad({ filter: /\/bin\/goonbridge-(?:mcp|responder)\.mjs$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8'), loader: 'text' }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
}
