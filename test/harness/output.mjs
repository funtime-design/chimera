import assert from 'node:assert/strict';
import { brandingPattern } from './baselines.mjs';
const branding = brandingPattern();
export function assertNeutralOutput(text) {
  assert.ok(!branding.test(text), 'neutral agent-facing response contains deployment branding');
  return text;
}
