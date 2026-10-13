import { deploymentDefaults } from "./deployment";
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { bridgeErrorMessage } from "./hub/validate";

// Sign-in for OAuth clients (claude.ai connectors): goonbridge is the OAuth server for MCP clients and an
// OIDC client of a Cloudflare Access for SaaS app, which says who the user is (their verified email).

// `member` is who the session acts as: the person, or one of their devices picked on the consent page.
export type OAuthProps = { member: string; email?: string; person?: string };
// `requested` is the `member` the /authorize URL asked for (the device-code sign-in always asks for its device).
type UpstreamData = { verifier: string; member: string; requested?: string };

// What a new device name must look like to be offered on the consent page; registerDevice does the full check later.
const NEW_DEVICE = /^[a-z0-9]+-[a-z0-9-]+$/;

// GET shows the consent page; POST (Continue) sends the browser to the Cloudflare sign-in.
// `devices` is every device on the roster; who signs in is not known yet, so the callback checks the pick.
// A `member` query parameter preselects that device, or offers to register it when it is not on the roster yet.
export async function handleAuthorize(request: Request, env: Env, oauth: OAuthHelpers, devices: string[]): Promise<Response> {
  const requested = new URL(request.url).searchParams.get("member") ?? "";
  const known = devices.includes(requested);
  let registering = !known && NEW_DEVICE.test(requested);
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      // Only the device-code flow (our own /device/callback) may offer to register a new name: a stranger's client could
      // otherwise send a link whose pre-checked "Register new device" lands them a device under the victim's name.
      if (registering && authRequest.redirectUri !== new URL("/device/callback", request.url).href) registering = false;
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      const from = details.clientDomain
        ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
        : "This app registered itself; its name is not verified.";
      const loopback = details.redirectIsLoopback ? "<p><strong>Access goes to an app on this computer.</strong> Continue only if you just started connecting from it.</p>" : "";
      const radio = (value: string, label: string, checked: boolean) =>
        `<label><input type="radio" name="member" value="${escape(value)}"${checked ? " checked" : ""}> ${escape(label)}</label>`;
      const connectAs = devices.length || registering
        ? `<fieldset><legend>Connect as</legend>
${radio("", "Yourself", !known && !registering)}
${devices.map((d) => radio(d, d, d === requested)).join("\n")}
${registering ? radio(requested, `Register new device ${requested}`, true) : ""}
</fieldset>
`
        : "";
      const body = `<h1>Connect ${escape(details.clientName)} to ${escape(deploymentDefaults.name)}?</h1>
<p>${from} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}<p>You sign in with your Cloudflare account next.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(consent.handle)}">
${connectAs}
<button name="decision" value="approve">Continue</button> <button name="decision" value="deny">Cancel</button>
</form>`;
      return new Response(page(`Connect to ${deploymentDefaults.name}`, body), { headers: consent.headers });
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const access = accessConfig(env);
      if (!access) return htmlError(500, "Sign-in is not set up on this bridge yet.");
      const approved = await oauth.approveConsent(request, handle);
      if (registering && approved.request.redirectUri !== new URL("/device/callback", request.url).href) registering = false;
      const verifier = randomToken();
      // A name that is neither on the roster nor the one this URL offered to register is no pick at all: registering
      // takes the explicit "Register new device" choice, never a hand-edited form.
      const picked = String(form.get("member") ?? "");
      const member = devices.includes(picked) || (registering && picked === requested) ? picked : "";
      const data: UpstreamData = { verifier, member, requested };
      const { state, headers } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
      const to = new URL(access.authorizationUrl);
      to.searchParams.set("client_id", access.clientId);
      to.searchParams.set("redirect_uri", callbackUrl(request));
      to.searchParams.set("response_type", "code");
      to.searchParams.set("scope", "openid email profile");
      to.searchParams.set("state", state);
      to.searchParams.set("code_challenge", await s256(verifier));
      to.searchParams.set("code_challenge_method", "S256");
      headers.set("Location", to.toString());
      return new Response(null, { status: 302, headers });
    }
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  } catch (err) {
    return authorizeError(err);
  }
}

// The Cloudflare sign-in sends the browser back here with a code; the verified email decides the person, and the
// device picked on the consent page counts only if it is one of that person's. `deviceOf(member, person)` says whose a
// roster device is, registers a new name for `person` (returning `person`), or throws a BridgeError saying why it can't.
// A pick that is another person's roster device falls back to the person, as it always did. The device-code sign-in is
// stricter: its daemon will believe it is the device it asked for, so anything but exactly that device is refused.
export async function handleCallback(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  memberForEmail: (email: string) => string | null,
  deviceOf: (member: string, person: string) => Promise<string | null>,
  afterGrant: (member: string, person: string) => Promise<void> = async () => {},
): Promise<Response> {
  let resumed;
  try {
    resumed = await oauth.finishUpstream<UpstreamData>(request);
  } catch (err) {
    return authorizeError(err);
  }
  const { request: original, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const access = accessConfig(env);
  if (!access) return htmlError(500, "Sign-in is not set up on this bridge yet.");

  const tokenResponse = await fetch(access.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(request),
      client_id: access.clientId,
      client_secret: access.clientSecret,
      code_verifier: data.verifier,
    }),
  });
  const idToken = tokenResponse.ok ? ((await tokenResponse.json()) as { id_token?: unknown }).id_token : undefined;
  if (typeof idToken !== "string") return htmlError(502, "Cloudflare sign-in failed. Try again.");

  const claims = await verifyIdToken(idToken, access);
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
  if (!email) return htmlError(403, "Sign-in could not be verified.");
  const person = memberForEmail(email);
  if (!person) return htmlError(403, `${email} is not a ${deploymentDefaults.name} member.`);
  let mine: boolean;
  try {
    mine = !!data.member && (await deviceOf(data.member, person)) === person;
  } catch (err) {
    const why = bridgeErrorMessage(err);
    if (why === null) throw err;
    return htmlError(403, why);
  }
  const deviceFlow = original.redirectUri === new URL("/device/callback", request.url).href;
  if (deviceFlow && !(mine && data.member === data.requested)) {
    return htmlError(403, `"${data.requested || data.member || person}" is not your device; this sign-in can only approve "${person}-..." devices of yours, as the device asked.`);
  }
  const member = mine ? data.member : person;

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: member,
    metadata: { email },
    scope: original.scope,
    props: { member, email, person } satisfies OAuthProps,
  });
  // Registration (a new device name) happens only now, once the grant exists.
  if (mine) await afterGrant(member, person);
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

type AccessConfig = { clientId: string; clientSecret: string; authorizationUrl: string; tokenUrl: string; jwksUrl: string; issuer: string };

function accessConfig(env: Env): AccessConfig | null {
  const { ACCESS_CLIENT_ID: clientId, ACCESS_CLIENT_SECRET: clientSecret, ACCESS_AUTHORIZATION_URL: authorizationUrl, ACCESS_TOKEN_URL: tokenUrl, ACCESS_JWKS_URL: jwksUrl } = env;
  if (!clientId || !clientSecret || !authorizationUrl || !tokenUrl || !jwksUrl) return null;
  // Access for SaaS serves every OIDC endpoint under its issuer: <issuer>/token, <issuer>/authorization, <issuer>/jwks.
  return { clientId, clientSecret, authorizationUrl, tokenUrl, jwksUrl, issuer: tokenUrl.replace(/\/token$/, "") };
}

// RS256 ID token from the Access app: signature against its JWKS, then issuer, audience and expiry.
async function verifyIdToken(token: string, access: AccessConfig): Promise<Record<string, unknown> | null> {
  return verifyRs256(token, access.jwksUrl, access.issuer, access.clientId);
}

// Any RS256 JWT from Cloudflare Access: signature against the keys at jwksUrl, then issuer, audience and expiry.
// Self-hosted Access apps sign with the keys at <team domain>/cdn-cgi/access/certs; Access for SaaS with <issuer>/jwks.
export async function verifyRs256(token: string, jwksUrl: string, issuer: string, audience: string): Promise<Record<string, unknown> | null> {
  try {
    const [rawHeader, rawPayload, rawSignature] = token.split(".");
    if (!rawHeader || !rawPayload || !rawSignature || token.split(".").length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(rawHeader))) as { alg?: string; kid?: string };
    if (header.alg !== "RS256") return null;
    const jwks = (await (await fetch(jwksUrl)).json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = jwks.keys?.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(rawSignature), signed))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(rawPayload))) as Record<string, unknown>;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer || !aud.includes(audience)) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    return claims;
  } catch {
    return null;
  }
}

function authorizeError(err: unknown): Response {
  if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
  if (err instanceof AuthorizationError) return htmlError(400, `${err.description}. Start again from your app.`);
  if (err instanceof CimdFetchError) return htmlError(400, "This app could not be verified.");
  throw err;
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.4rem 1rem}fieldset{margin:0 0 1rem}label{display:block}</style>
</head><body>
${body}
</body></html>`;
}

export function htmlError(status: number, message: string): Response {
  return new Response(page(deploymentDefaults.name, `<p>${escape(message)}</p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'none'" },
  });
}
