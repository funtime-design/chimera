import type { Timing, Labels } from "./schema";

export const engineTiming: Timing = { claimSeconds: 900, claimLeaseSeconds: 300, bootSeconds: 300, onlineSeconds: 180, statusExpirySeconds: 28800, deploySeconds: 900 };
export const engineLabels: Labels = { ciRed: 'ci-red', branchGone: 'branch-gone', deployFailed: 'deploy-failed', reReview: 're-review', revert: 'revert', exempt: ['audit', 'no-pr', 'question', 'ops'] };
export const DEFAULT_BRANCH_PREFIX = "claude/";

// Shared prompt/client timings; prose and the inbox use the same limits.
export const MAX_WAIT_SECONDS = 25;
export const REACHABLE_IDLE_SECONDS = 30 * 60;
export const HEARTBEAT_INTERVAL_SECONDS = 60;
export const HEARTBEAT_IDLE_SECONDS = 30 * 60;
export const WARM_MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const DELIVERY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const WORK_THREAD_KEEP_MS = 24 * 60 * 60 * 1000;
