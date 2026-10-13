import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadModule } from '../hub-memory.mjs';
import { ACTIVE_CONFIG } from './roles.mjs';
const { clientConfig, clientScript } = await loadModule('src/config/client.ts');
export const clientSettings = clientConfig(ACTIVE_CONFIG);
export const servedScript = name => clientScript(readFileSync(new URL(`../../bin/${name}`, import.meta.url), 'utf8'), ACTIVE_CONFIG);
export const responderBin = process.env.CHIMERA_RESPONDER_BIN ?? fileURLToPath(new URL('../../bin/goonbridge-responder.mjs', import.meta.url));
