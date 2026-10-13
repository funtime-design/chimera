import { deploymentDefaults } from "./deployment";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { personOf } from "./hub";
import { BridgeError } from "./hub/validate";
import { handleAuthorize, handleCallback, type OAuthProps } from "./oauth";
import { boardTimes, groupRoster } from "./board";
import { fullRoster, hubOf, memberForEmail, parseTokens, rosterOf, type Env } from "./env";
import { authenticate, grantStands, memberForToken, oauthMember, personStands } from "./auth";
import { handleMcp } from "./mcp";
import { handleRest } from "./rest";
import { pagesEndpoint } from "./pages";
import { handleDevice } from "./device";
import { identify } from "./devices";
import { json, withBridge } from "./http";

// The OAuth resource must be this bridge's own canonical /mcp URL, which differs between local dev and the deployed Worker.
const providers = new Map<string, OAuthProvider<Env>>();
export function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: { fetch: mcpEndpoint },
      defaultHandler: { fetch: restEndpoint },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: deploymentDefaults.name },
      // Static GOONBRIDGE_TOKENS bearer tokens (Claude Code, Buzz, pipelines) keep working next to OAuth tokens.
      resolveExternalToken: async ({ token, env }) => {
        const member = await memberForToken(token, parseTokens(env.GOONBRIDGE_TOKENS));
        return member ? { props: { member } satisfies OAuthProps, audience: `${origin}/mcp` } : null;
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

async function mcpEndpoint(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const props = ctx.props as OAuthProps;
  // An OAuth grant lasts until it expires; dropping someone from GOONBRIDGE_MEMBERS should cut them off now, and so should
  // dropping the device they connected as. Grants from before device sign-in carry no person; theirs is the member.
  // identify() runs first because its members include the registered devices the grant may have been issued to.
  const unauthorized = () => json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
  if (!personStands(props, env)) return unauthorized();
  return withBridge(env, async () => {
    const { member, members, evicted } = await identify(request, env, props.member, true);
    if (!grantStands(props, env, members)) return unauthorized();
    return handleMcp(request, hubOf(env), member, members, new URL(request.url).origin, boardTimes(env), env, evicted ?? null);
  });
}

async function restEndpoint(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER!;
  if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) return pagesEndpoint(request, env);
  if (url.pathname === "/authorize") return handleAuthorize(request, env, oauth, Object.values(groupRoster(await fullRoster(env)).devices).flat());
  if (url.pathname === "/callback") {
    const members = await fullRoster(env);
    // A roster device answers with its person; a new name is checked now (the Hub says why it can't be the signer's:
    // another person's prefix, a bad label, a name that is or was in use) and registered only once the grant exists.
    const deviceOf = async (member: string, person: string) => {
      if (members.includes(member)) return personOf(member, members);
      const why = await hubOf(env).checkDevice(person, member, rosterOf(env));
      if (why) throw new BridgeError(why);
      return person;
    };
    const afterGrant = async (member: string, person: string) => {
      if (!members.includes(member)) await hubOf(env).registerDevice(person, member, rosterOf(env));
    };
    return handleCallback(request, env, oauth, (email) => memberForEmail(email, env), deviceOf, afterGrant);
  }
  const device = await handleDevice(request, env, oauth, url.origin);
  if (device) return device;
  if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
  // A static token first (cloud sessions, pipelines), then an OAuth access token issued for /mcp: a daemon signed in on the
  // web polls and replies over REST with the same grant, and oauthMember re-checks the grant still stands on every call.
  const member = (await authenticate(request, parseTokens(env.GOONBRIDGE_TOKENS))) ?? (await oauthMember(request, env, url.origin, await fullRoster(env)));
  if (!member) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  return withBridge(env, async () => {
    const who = await identify(request, env, member);
    // A killed session is told to stop on every REST check-in (heartbeat, inbox poll, session line) with 410 Gone.
    if (who.evicted) return json({ error: who.evicted, evicted: true }, 410);
    return handleRest(request, url, hubOf(env), who.member, who.members, env);
  });
}
