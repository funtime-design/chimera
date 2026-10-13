import { isMain, validation } from './deployment.mjs';
import { loadSelectedConfig } from './selected-deployment.mjs';

export async function clientDefaults(config = loadSelectedConfig()) {
  const { clientConfig } = await validation();
  return clientConfig(config);
}
if (isMain(import.meta.url)) console.log(JSON.stringify(await clientDefaults()));
