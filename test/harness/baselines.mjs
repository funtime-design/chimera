// Owner-mode baselines: byte fixtures captured from a private deployment before the engine split. They live in
// .private/fixtures/<id>/ (never published) and run only when deployments/<id>/ is present too; otherwise they skip.
// Nothing here names a deployment: a fork with its own folder and baselines gets the same checks.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
export const baselineUrl = (id, name) => new URL(`.private/fixtures/${id}/${name}`, root);

// Every deployment folder in this checkout (the public tree ships "example" and "staging").
export function presentDeployments() {
  return readdirSync(new URL('deployments/', root)).filter(id => existsSync(new URL(`deployments/${id}/bridge.config.json`, root))).sort();
}
export const readDeployment = id => JSON.parse(readFileSync(new URL(`deployments/${id}/bridge.config.json`, root), 'utf8'));
// Present deployments that also have the named private baseline.
export const baselineDeployments = name => presentDeployments().filter(id => existsSync(baselineUrl(id, name)));
// The deployment src/config/deployment.ts currently points at, which is what every bundled test renders.
export function bundledDeploymentId() {
  return readFileSync(new URL('src/config/deployment.ts', root), 'utf8').match(/deployments\/([^/]+)\/bridge\.config\.json/)?.[1];
}
// { skip, id, path } for a baseline of the bundled deployment: skip is a reason string when it cannot run.
export function bundledBaseline(name) {
  const id = bundledDeploymentId();
  const ok = id && existsSync(baselineUrl(id, name));
  return { id, url: ok ? baselineUrl(id, name) : null, skip: ok ? false : `owner-mode baseline: no .private/fixtures/${id}/${name} for the bundled deployment` };
}
export function skipUnless(ids, name) {
  return ids.length ? false : `owner-mode baseline: no deployment folder with .private/fixtures/<id>/${name}`;
}

// The deployment folders the public repo itself ships: the example, and staging (the public repo's own staging bridge).
export const PUBLIC_DEPLOYMENTS = ['example', 'staging'];
// What neutral output must never contain: the legacy compatibility name, plus the identity of every private deployment
// folder present in this checkout (its id, product name, owner, origin host and GitHub owner).
export function brandingWords() {
  const words = new Set(['goonbridge']);
  for (const id of presentDeployments().filter(id => !PUBLIC_DEPLOYMENTS.includes(id))) {
    const c = readDeployment(id);
    for (const w of [id, c.deployment.productName, c.presentation?.owner, new URL(c.deployment.origin).host, c.github?.owner]) if (w && w !== 'chimera') words.add(w);
  }
  return [...words];
}
const pattern = words => words.length ? new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : /(?!)/;
// Only the private deployments' identity, for artifacts that legitimately carry the compatibility aliases (the responder).
export const ownerPattern = () => pattern(brandingWords().filter(w => w !== 'goonbridge'));
export const brandingPattern = () => pattern(brandingWords());
