import { resolveConfig, engineTiming } from "../config/resolve";
// A merge to trunk is not known to be live until the deploy reports; silence this long is flagged loudly.

export function claimSeconds(env: unknown): number {
  return env == null ? engineTiming.claimSeconds : resolveConfig(env as Record<string, unknown>).timing.claimSeconds;
}

// A cloud session's claim on a task stays live this long after the session last showed life (any bridge call, or a
// heartbeat from the in-run loop or the PostToolUse hook). Past it the claim is stale: released, and the task can be fired again.
export function claimLeaseSeconds(env: unknown): number {
  return env == null ? engineTiming.claimLeaseSeconds : resolveConfig(env as Record<string, unknown>).timing.claimLeaseSeconds;
}

// A fired cloud session must call the bridge within this long, or the fire is flagged as a fault (it never booted).
export function bootSeconds(env: unknown): number {
  return env == null ? engineTiming.bootSeconds : resolveConfig(env as Record<string, unknown>).timing.bootSeconds;
}

export function deploySeconds(env: unknown): number {
  return env == null ? engineTiming.deploySeconds : resolveConfig(env as Record<string, unknown>).timing.deploySeconds;
}

// Display only (board "online" dot, bridge_members), plus the fallback for a cloud session that sends no session id
// and so has no claim to heartbeat. Task routing for sessions that do identify themselves uses the claim lease instead.
export function onlineSeconds(env: unknown): number {
  return env == null ? engineTiming.onlineSeconds : resolveConfig(env as Record<string, unknown>).timing.onlineSeconds;
}

// A posted "working" (any state but idle/offline) stands until the member sets idle or this long passes.
export function statusExpirySeconds(env: unknown): number {
  return env == null ? engineTiming.statusExpirySeconds : resolveConfig(env as Record<string, unknown>).timing.statusExpirySeconds;
}

// Automatic reviewers per PR across its revisions (T-55); past it the owner is told and nothing fires.
export function reviewersMax(env: unknown): number {
  return resolveConfig((env ?? {}) as Record<string, unknown>).github.reviewersMax;
}

// Pure constants remain importable by Node's type-stripping tests without loading deployment JSON.
export { MAX_WAIT_SECONDS, REACHABLE_IDLE_SECONDS, HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_IDLE_SECONDS,
  WARM_MAX_AGE_MS, DELIVERY_KEEP_MS, SESSION_TTL_MS, WORK_THREAD_KEEP_MS } from "../config/defaults.ts";
