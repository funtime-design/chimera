import { execFileSync } from 'node:child_process';
import { writeClients } from './gen-clients.mjs';
import { writeSelection } from './selected-deployment.mjs';
import { writeFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { argsFor, cli, isMain, loadDeployment, projectRoot, validateLock } from './deployment.mjs';

export function generateWrangler({ config, lock, template, accountId }) {
  validateLock(config, lock, template);
  if (!/^[a-fA-F0-9]{32}$/.test(accountId ?? '')) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID');
  const c = config.cloudflare;
  // A workers.dev origin (staging) is served by the account subdomain, so it gets no custom-domain route.
  const host = new URL(config.deployment.origin).host, onWorkersDev = host.endsWith('.workers.dev');
  if (onWorkersDev && (!c.workersDev || !host.startsWith(`${c.workerName}.`))) throw new Error('a workers.dev origin needs cloudflare.workersDev true and the Worker name as its first label');
  return { ...structuredClone(template), name: c.workerName, account_id: accountId,
    kv_namespaces: [{ binding: template.kv_namespaces[0].binding, ...(c.oauthKvId ? { id: c.oauthKvId } : {}) }],
    vars: { GOONBRIDGE_CLAIM_SECONDS: String(config.timing.claimSeconds), ACCESS_PAGES_ISSUER: config.access?.pages?.issuer ?? '', ACCESS_PAGES_AUD: config.access?.pages?.audience ?? '' },
    observability: { enabled: c.observability }, workers_dev: c.workersDev, preview_urls: c.previewUrls,
    ...(onWorkersDev ? {} : { routes: [{ pattern: host, custom_domain: true }] }),
  };
}
export async function writeWrangler({ root = projectRoot, deployment, accountId = process.env.CLOUDFLARE_ACCOUNT_ID }) {
  const input = await loadDeployment({ root, deployment });
  const output = generateWrangler({ ...input, accountId });
  const relative = `.generated/wrangler.${deployment}.jsonc`;
  const git = args => { try { execFileSync('git', args, { cwd: root, stdio: 'pipe' }); return true; } catch { return false; } };
  if (git(['ls-files', '--error-unmatch', '--', relative]) || !git(['check-ignore', '-q', '--', relative])) throw new Error('generated Wrangler output must be ignored and untracked');
  const target = path.join(root, relative);
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error('generated Wrangler output must not be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.join(root, '.generated'), { recursive: true });
  output.main = '../' + output.main;
  output.$schema = '../' + output.$schema;
  await writeFile(path.join(root, relative), `${JSON.stringify(output, null, 2)}\n`);
  writeSelection(deployment, root);
  await writeClients(input.config, root);
}
if (isMain(import.meta.url)) await cli(async () => {
  await writeWrangler(argsFor(process.argv.slice(2)));
  console.log('Generated ignored Wrangler config and selected deployment/client inputs');
});
