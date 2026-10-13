import { argsFor, cli, isMain, loadDeployment, projectRoot, readJson, requirePrivateSecrets, runCommand, validation } from './deployment.mjs';

// github: false skips the GitHub Actions secrets (no gh, or no deploys from Actions).
export async function pushSecrets({ root = projectRoot, deployment, dryRun = false, github = true, run = runCommand, log = console.log }) {
  const file = await requirePrivateSecrets(root, deployment);
  const { config } = await loadDeployment({ root, deployment });
  const { validateSecrets, runtimeSecrets } = await validation();
  const secrets = validateSecrets(await readJson(file), config);
  const runtime = runtimeSecrets(secrets, config);
  const plan = [
    ...Object.keys(runtime).sort().map(name => ({ name, command: 'npx', args: ['wrangler', 'secret', 'put', name, '--name', config.cloudflare.workerName], value: runtime[name], target: 'Worker' })),
    ...(github ? [{ name: 'BRIDGE_CONTRACT_TOKEN', command: 'gh', args: ['secret', 'set', 'BRIDGE_CONTRACT_TOKEN'], value: secrets.GOONBRIDGE_TOKENS[secrets.contractToken], target: 'GitHub Actions' },
    { name: 'CLOUDFLARE_ACCOUNT_ID', command: 'gh', args: ['secret', 'set', 'CLOUDFLARE_ACCOUNT_ID'], value: secrets.cloudflare.accountId, target: 'GitHub Actions' },
    { name: 'CLOUDFLARE_API_TOKEN', command: 'gh', args: ['secret', 'set', 'CLOUDFLARE_API_TOKEN'], value: secrets.CLOUDFLARE_API_TOKEN, target: 'GitHub Actions' }] : []),
  ];
  for (const step of plan) {
    log(`${dryRun ? 'Would set' : 'Setting'} ${step.name} (${step.target})`);
    if (!dryRun) {
      try { await run(step.command, step.args, { input: step.value, cwd: root, ...(step.command === 'npx' ? { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: secrets.cloudflare.accountId, CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN } } : {}) }); }
      catch { throw new Error(`failed setting ${step.name}; command output redacted`); }
    }
  }
}
if (isMain(import.meta.url)) await cli(async () => {
  const options = argsFor(process.argv.slice(2), ['--dry-run']);
  await pushSecrets({ deployment: options.deployment, dryRun: options['dry-run'] });
});
