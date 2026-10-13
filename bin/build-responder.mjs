import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMain, projectRoot } from './deployment.mjs';
import { loadSelectedConfig, writeSelection } from './selected-deployment.mjs';

// Without a config, bundle src/config/deployment.ts as the selection wrote it (byte-identical to any other bundler's
// view of the selected deployment); with one, substitute it.
export async function buildResponder({ config, root = projectRoot, write = writeFile } = {}) {
  const selected = config ?? loadSelectedConfig();
  const name = selected.compatibility.assetNames.responder.slice(1);
  if (!/^[a-zA-Z0-9._-]+\.mjs$/.test(name)) throw new Error('invalid responder filename');
  const { outputFiles } = await build({ absWorkingDir: projectRoot, entryPoints: ['bin/responder/main.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', banner: { js: '#!/usr/bin/env node' },
    plugins: !config ? [] : [{ name: 'selected-responder-config', setup(b) {
      b.onLoad({ filter: /[/\\]src[/\\]config[/\\]deployment\.ts$/ }, () => ({ contents: `export default ${JSON.stringify(config)};`, loader: 'ts' }));
    } }],
  });
  for (const file of new Set(['goonbridge-responder.mjs', name])) await write(path.join(root, 'bin', file), outputFiles[0].text);
}
if (isMain(import.meta.url)) { writeSelection(); await buildResponder(); }
