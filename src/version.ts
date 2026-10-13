import metadata from '../package.json';

export const ENGINE_VERSION = metadata.version;
// Baseline for the existing, idempotent Hub schema initializers. Bump when their schema contract changes.
export const HUB_SCHEMA_VERSION = 1;
export function versionInfo(metadata?: { id?: string }) {
  return { engine: ENGINE_VERSION, schema: HUB_SCHEMA_VERSION, build: metadata?.id ?? null };
}
