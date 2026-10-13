import { verifyRs256, type OAuthProps } from "./oauth";
import { memberForEmail, type Env } from "./env";

// A grant stands while its email still names its person and its member is still a member. `members` is the merged roster
// (static tokens, sign-in emails, registered devices; see identify() and fullRoster()), so forgetting a registered device
// cuts its grant off on the next call, as dropping a static token does. Static-token grants carry no email.
export function grantStands(props: OAuthProps, env: Env, members: string[]): boolean {
  return personStands(props, env) && (props.email === undefined || members.includes(props.member));
}

// The part of grantStands that needs no roster: the grant's email still maps to its person. Checked before identify()
// runs, so a grant whose person was dropped cannot create or heartbeat a cloud child on its way to the 401.
export function personStands(props: OAuthProps, env: Env): boolean {
  return props.email === undefined || memberForEmail(props.email, env) === (props.person ?? props.member);
}

// The same two ways in as /mcp: a static GOONBRIDGE_TOKENS bearer token, or an OAuth access token issued for this bridge's /mcp.
export async function oauthMember(request: Request, env: Env, origin: string, members: string[]): Promise<string | null> {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  if (!match || !env.OAUTH_PROVIDER) return null;
  let summary;
  try {
    summary = await env.OAUTH_PROVIDER.unwrapToken<OAuthProps>(match[1]);
  } catch {
    return null;
  }
  if (!summary) return null;
  const audience = Array.isArray(summary.audience) ? summary.audience : [summary.audience];
  if (!audience.includes(`${origin}/mcp`)) return null;
  return grantStands(summary.grant.props, env, members) ? summary.grant.props.member : null;
}

// The JWT Cloudflare Access adds to a request it let through: verified against the team's keys, then its email names the person.
export async function accessMember(request: Request, env: Env): Promise<string | null> {
  const issuer = env.ACCESS_PAGES_ISSUER;
  const audience = env.ACCESS_PAGES_AUD;
  if (!issuer || !audience) return null;
  const cookie = (request.headers.get("Cookie") ?? "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie?.[1];
  if (!token) return null;
  const claims = await verifyRs256(token, `${issuer}/cdn-cgi/access/certs`, issuer, audience);
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
  return email ? memberForEmail(email, env) : null;
}

export async function authenticate(request: Request, tokens: Map<string, string> | null): Promise<string | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? memberForToken(match[1].trim(), tokens) : null;
}

export async function memberForToken(token: string, tokens: Map<string, string> | null): Promise<string | null> {
  if (!tokens) return null;
  const presented = await sha256(token);
  let found: string | null = null;
  for (const [token, name] of tokens) {
    if (timingSafeEqual(presented, await sha256(token))) found = name;
  }
  return found;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
