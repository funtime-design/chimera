import { bundledConfig, resolveConfig } from "./config/resolve";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Hub } from "./hub";

export type Env = {
  HUB: DurableObjectNamespace<Hub>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  GOONBRIDGE_TOKENS?: string;
  GOONBRIDGE_MEMBERS?: string;
  GOONBRIDGE_CLAIM_SECONDS?: string;
  GOONBRIDGE_CLAIM_LEASE_SECONDS?: string;
  GOONBRIDGE_BOOT_SECONDS?: string;
  GOONBRIDGE_ONLINE_SECONDS?: string;
  GOONBRIDGE_STATUS_EXPIRY_SECONDS?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
  // The self-hosted Access app in front of /docs: its team domain (issuer) and application audience tag.
  ACCESS_PAGES_ISSUER?: string;
  ACCESS_PAGES_AUD?: string;
  // Routines with API triggers, one per person, that stand in for a cloud device with no Mac: {"alice":{"trigger","token"}}.
  GOONBRIDGE_ROUTINES?: string;
  GOONBRIDGE_ROUTINES_URL?: string;
  // Routines a caller fires by name with fire_routine are flat secrets found at runtime by pattern (see parseNamedRoutines):
  // GOONBRIDGE_ROUTINE_<NAME>_TRIGGER, GOONBRIDGE_ROUTINE_<NAME>_TOKEN, optional GOONBRIDGE_ROUTINE_<NAME>_ALLOW.
  // Read-only token for the private cloud-session-config repo, served to sessions by GET /v1/cloud-config.
  GITHUB_CONFIG_PAT?: string;
  // Tests point these at a fake GitHub; unset in production.
  GITHUB_CONFIG_REPO?: string;
  GITHUB_CONFIG_API_URL?: string;
  // GitHub webhook (POST /v1/github/webhook): the HMAC secret shared with the org hook, the org it must come from, the
  // name of the deploy workflow to watch, and how long a merge may wait for it to report.
  GOONBRIDGE_GITHUB_WEBHOOK_SECRET?: string;
  GOONBRIDGE_GITHUB_OWNER?: string;
  GOONBRIDGE_DEPLOY_WORKFLOW?: string;
  GOONBRIDGE_DEPLOY_SECONDS?: string;
  // The deployment_status environment that means live (default "production", compared case-insensitively).
  GOONBRIDGE_DEPLOY_ENVIRONMENT?: string;
  // Auto-review: "off" stops the webhook firing a reviewer session when a PR goes up for review. The reviewer is the named
  // routine "review" (GOONBRIDGE_ROUTINE_REVIEW_TRIGGER/_TOKEN) when set, else the task owner's cloud routine (GOONBRIDGE_ROUTINES).
  GOONBRIDGE_AUTO_REVIEW?: string;
  // At most this many automatic reviewers per PR across its revisions (default 3); past it the owner is told (T-55).
  GOONBRIDGE_REVIEWERS_MAX?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
};

export function hubOf(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("main"));
}

// Everyone with a token or a sign-in email: people, standalone members (pipelines) and devices (alice-laptop).
export function rosterOf(env: Env): string[] {
  const config = resolveConfig(env);
  const names = [...bundledConfig.members.map(m => m.name), ...(parseTokens(config.auth.staticTokens)?.values() ?? []), ...parseMembers(config.auth.memberEmails).values()];
  return [...new Set(names)].sort();
}

// The roster plus every registered device (hub/registered.ts): who may hold an OAuth grant, without the cloud children,
// who only ever arrive under their parent's static token. One Hub call, so callers on a hot path use identify() instead.
export async function fullRoster(env: Env): Promise<string[]> {
  const registered = (await hubOf(env).registeredDevices()).map((d) => d.name);
  return [...new Set([...rosterOf(env), ...registered])].sort();
}

// GOONBRIDGE_TOKENS is a JSON object mapping each bearer token to a member name.
export function parseTokens(raw: string | undefined): Map<string, string> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [token, name] of Object.entries(obj)) {
      if (token.length >= 24 && /^[a-z0-9_-]+$/.test(name) && name !== "all") map.set(token, name);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

// GOONBRIDGE_MEMBERS is a JSON object mapping each sign-in email to a member name.
export function parseMembers(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  try {
    for (const [email, name] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      if (email.includes("@") && /^[a-z0-9_-]+$/.test(name) && name !== "all") map.set(email.toLowerCase(), name);
    }
  } catch {
    // A malformed map signs nobody in.
  }
  return map;
}

export function memberForEmail(email: string, env: Env): string | null {
  return parseMembers(resolveConfig(env).auth.memberEmails).get(email.toLowerCase()) ?? null;
}
