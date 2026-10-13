// The one place that decides which deployments/<id>/ folder a build uses: build-time env CHIMERA_DEPLOYMENT,
// default "example". Node tools read the config through loadSelectedConfig(); bundlers (Wrangler, esbuild) read
// src/config/deployment.ts, which writeSelection() points at the same folder. The public tree ships only
// deployments/example; a private fork adds its own folder and sets CHIMERA_DEPLOYMENT.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_DEPLOYMENT = 'example';

export function selectedDeploymentId(env = process.env) {
  const id = env.CHIMERA_DEPLOYMENT || DEFAULT_DEPLOYMENT;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || id === 'all') throw new Error('invalid CHIMERA_DEPLOYMENT');
  return id;
}
export function loadSelectedConfig(id = selectedDeploymentId(), base = root) {
  let text;
  try { text = readFileSync(path.join(base, 'deployments', id, 'bridge.config.json'), 'utf8'); }
  catch { throw new Error(`deployments/${id}/bridge.config.json not found: CHIMERA_DEPLOYMENT=${id} needs that folder (a private fork adds its own)`); }
  return JSON.parse(text);
}
export const selectionModule = id => `// Written by bin/selected-deployment.mjs from CHIMERA_DEPLOYMENT (default "example"); do not edit by hand.\nexport { default } from '../../deployments/${id}/bridge.config.json' with { type: 'json' };\n`;
// Idempotent: writes only when the selection changes, so a watcher that reruns it does not loop.
export function writeSelection(id = selectedDeploymentId(), base = root) {
  loadSelectedConfig(id, base);
  const file = path.join(base, 'src/config/deployment.ts'), text = selectionModule(id);
  let current = null;
  try { current = readFileSync(file, 'utf8'); } catch {}
  if (current !== text) writeFileSync(file, text);
  return id;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) writeSelection();
