import { readFile, realpath } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { selectedDeploymentId } from './selected-deployment.mjs';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let validator;
export async function validation() {
  if (!validator) validator = (async () => {
    const { outputFiles } = await build({ entryPoints: [path.join(projectRoot, 'src/config/secrets-schema.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  })();
  return validator;
}
export async function readJson(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { throw new Error('required deployment file missing or unreadable'); }
  try { return JSON.parse(text); } catch { throw new Error('deployment JSON is invalid (contents redacted)'); }
}
export function deploymentDir(root, deployment) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(deployment ?? '') || deployment === 'all') throw new Error('invalid deployment id');
  return path.join(root, 'deployments', deployment);
}
export const engineTemplate = () => readJson(path.join(projectRoot, 'config/wrangler.template.json'));
export function identityOf(config, template) {
  return { workerName: config.cloudflare.workerName, ...config.identity, migrationTags: template.migrations.map(m => m.tag), migrations: structuredClone(template.migrations), kvBinding: template.kv_namespaces[0].binding, oauthKvId: config.cloudflare.oauthKvId ?? null, origin: config.deployment.origin };
}
export function validateLock(config, lock, template) {
  if (!isDeepStrictEqual(identityOf(config, template), lock)) throw new Error('deployment identity lock mismatch; review and update deployment.lock.json in the same change');
  if (template.migrations[0]?.tag !== 'v1' || !template.migrations[0]?.new_sqlite_classes?.includes('Hub')) throw new Error('deployment identity lock requires the original v1 Hub lineage');
  const binding = template.durable_objects.bindings;
  if (binding.length !== 1 || binding[0].name !== config.identity.hubBinding || binding[0].class_name !== config.identity.hubClass) throw new Error('deployment identity lock does not match engine binding');
}
export async function loadDeployment({ root = projectRoot, deployment } = {}) {
  const dir = deploymentDir(root, deployment);
  const { validateConfig } = await validation();
  const config = validateConfig(await readJson(path.join(dir, 'bridge.config.json')));
  if (config.deployment.id !== deployment) throw new Error('deployment id does not match directory');
  const lock = await readJson(path.join(dir, 'deployment.lock.json')), template = await engineTemplate();
  validateLock(config, lock, template);
  return { config, lock, template };
}
export async function requirePrivateSecrets(root, deployment) {
  const rel = `deployments/${deployment}/secrets.json`, file = path.join(deploymentDir(root, deployment), 'secrets.json');
  let canonical;
  try { canonical = await realpath(file); } catch { throw new Error('secrets.json missing'); }
  // Do not permit a symlink to an unguarded file, including a symlinked deployment directory.
  if (canonical !== path.join(await realpath(root), rel)) throw new Error('secrets.json must not be a symlink');
  const git = args => { try { execFileSync('git', args, { cwd: root, stdio: 'pipe' }); return true; } catch { return false; } };
  if (git(['ls-files', '--error-unmatch', '--', rel])) throw new Error('secrets.json is tracked; refusing');
  if (!git(['check-ignore', '-q', '--', rel])) throw new Error('secrets.json must be gitignored');
  return file;
}
// Suppress child output: CLI errors may echo stdin. Callers report only a command/name.
export function runCommand(command, args, { input, cwd = projectRoot, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'ignore', 'ignore'], shell: false });
    child.on('error', () => reject(new Error('external command failed')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('external command failed')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function argsFor(argv, flags = []) {
  const args = argv.filter(a => a !== '--');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--deployment') options.deployment = args[++i];
    else if (flags.includes(args[i])) options[args[i].slice(2)] = true;
    else throw new Error('unsupported command option');
  }
  options.deployment ??= selectedDeploymentId();
  deploymentDir(projectRoot, options.deployment);
  return options;
}
export const isMain = url => !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;
export async function cli(main) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
