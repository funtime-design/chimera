import { argsFor, cli, isMain, loadDeployment } from './deployment.mjs';
if (isMain(import.meta.url)) await cli(async () => {
  await loadDeployment(argsFor(process.argv.slice(2)));
  console.log('Deployment config and identity lock valid');
});
