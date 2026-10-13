import { readFileSync } from 'node:fs';
import { ownerEmails } from './owner-emails.mjs';
import { fileURLToPath } from 'node:url';
import { rolesFor } from './fixture.mjs';
import { loadSelectedConfig } from '../../bin/selected-deployment.mjs';
export const NEUTRAL = !!process.env.CHIMERA_NEUTRAL;
export const { OWNER, OTHER, OUTSIDER, OWNER_DEVICE, OWNER_SECOND_DEVICE, OWNER_CLOUD, OTHER_DEVICE, OTHER_CLOUD } = rolesFor(NEUTRAL);
export const ACTIVE_CONFIG = NEUTRAL && process.env.CHIMERA_TEST_FIXTURE
  ? JSON.parse(process.env.CHIMERA_TEST_FIXTURE).config
  : NEUTRAL ? JSON.parse(readFileSync(new URL('../fixtures/neutral/bridge.config.json', import.meta.url), 'utf8')) : loadSelectedConfig();
export const PRODUCT = ACTIVE_CONFIG.deployment.productName ?? 'chimera';
export const REPO = ACTIVE_CONFIG.presentation?.exampleRepo ?? ACTIVE_CONFIG.deployment.id;
export const GITHUB_OWNER = ACTIVE_CONFIG.github.owner;
export const CONFIG_REPO = ACTIVE_CONFIG.cloud?.legacyConfigRepo ?? 'example/cloud-session-config';
export const ORIGIN = ACTIVE_CONFIG.deployment.origin;
export const SESSION_HEADER = `${ACTIVE_CONFIG.compatibility.headerPrefix}-Session`;
export const CONTEXT_HEADER = `${ACTIVE_CONFIG.compatibility.headerPrefix}-Context`;
export const MORE_HEADER = `${ACTIVE_CONFIG.compatibility.headerPrefix}-More`;
const emails = NEUTRAL ? {} : ownerEmails(fileURLToPath(new URL('../..', import.meta.url)), OWNER, OTHER);
export const OWNER_EMAIL = NEUTRAL ? 'alice@example.test' : emails.owner;
export const OTHER_EMAIL = NEUTRAL ? 'Bob@example.test' : emails.other;
export const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
