import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { json } from "./http";
import { escape, htmlError, page } from "./oauth";

// Device-code sign-in for a headless daemon (the Mac responder), layered on the normal /authorize consent and Cloudflare
// sign-in. The daemon registers an OAuth client whose redirect URI is this bridge's /device/callback, starts here with its
// PKCE challenge and the device name it wants, shows the user code, and polls /device/token. The person opens /device on
// any browser, types the code, approves on the consent page (the device preselected) and signs in; /callback then
// redirects the authorization code to /device/callback, which parks it for the daemon's next poll. The daemon swaps it at
// /oauth/token with its verifier, so the code alone, or the device code alone, is worth nothing to whoever sees it.

const TTL = 600; // seconds: a code nobody approved in ten minutes is dead, and KV forgets it
const INTERVAL = 5;
// No vowels (no words), no 0/O/1/I (no misreads): 28 symbols, 8 of them ~ 2^38 codes against a 10-minute window.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

export type DeviceCodeRecord = { client_id: string; code_challenge: string; device: string; user_code: string; code: string | null; redirect_uri: string };

const recordKey = (deviceCode: string) => `device:${deviceCode}`;
const userKey = (userCode: string) => `device:user:${userCode}`;
const callbackOf = (origin: string) => `${origin}/device/callback`;

// Every /device* route, or null when the path is not one of them.
export async function handleDevice(request: Request, env: Env, oauth: OAuthHelpers, origin: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/device/start" && request.method === "POST") return start(request, env, oauth, origin);
  if (url.pathname === "/device/token" && request.method === "POST") return poll(request, env);
  if (url.pathname === "/device/callback" && request.method === "GET") return callback(url, env);
  if (url.pathname === "/device" && request.method === "GET") return form(normalize(url.searchParams.get("code") ?? ""));
  if (url.pathname === "/device" && request.method === "POST") return submit(request, env, origin);
  if (url.pathname === "/device" || url.pathname.startsWith("/device/")) return new Response(null, { status: 405 });
  return null;
}

// The device name is only checked for shape here; whose it is can only be judged once the person has signed in.
async function start(request: Request, env: Env, oauth: OAuthHelpers, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const { client_id, code_challenge, device } = body ?? {};
  if (typeof client_id !== "string" || typeof code_challenge !== "string" || typeof device !== "string") {
    return json({ error: "client_id, code_challenge and device are required" }, 400);
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge)) return json({ error: "code_challenge must be an S256 PKCE challenge (base64url)" }, 400);
  if (!/^[a-z0-9]+-[a-z0-9-]+$/.test(device)) return json({ error: `device must look like <person>-<label> in lowercase: "${device}"` }, 400);
  const client = await oauth.lookupClient(client_id);
  if (!client) return json({ error: "unknown client_id; register at /oauth/register first" }, 400);
  if (!client.redirectUris.includes(callbackOf(origin))) return json({ error: `the client must register ${callbackOf(origin)} as a redirect URI` }, 400);

  const deviceCode = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const userCode = await freeUserCode(env);
  const record: DeviceCodeRecord = { client_id, code_challenge, device, user_code: userCode, code: null, redirect_uri: callbackOf(origin) };
  await env.OAUTH_KV.put(recordKey(deviceCode), JSON.stringify(record), { expirationTtl: TTL });
  await env.OAUTH_KV.put(userKey(userCode), deviceCode, { expirationTtl: TTL });
  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/device`,
    verification_uri_complete: `${origin}/device?code=${userCode}`,
    expires_in: TTL,
    interval: INTERVAL,
  });
}

// Pending until the person approves; the code once; then gone, so a replayed device code learns nothing.
async function poll(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { device_code?: unknown } | null;
  const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
  const record = deviceCode ? await env.OAUTH_KV.get<DeviceCodeRecord>(recordKey(deviceCode), "json") : null;
  if (!record) return json({ error: "expired_token" }, 400);
  if (!record.code) return json({ error: "authorization_pending" }, 400);
  await Promise.all([env.OAUTH_KV.delete(recordKey(deviceCode)), env.OAUTH_KV.delete(userKey(record.user_code))]);
  return json({ code: record.code, redirect_uri: record.redirect_uri });
}

// /callback sends the browser here with the authorization code and the device code as state. The user code dies now, so
// the same code cannot be approved twice.
async function callback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const record = state ? await env.OAUTH_KV.get<DeviceCodeRecord>(recordKey(state), "json") : null;
  if (!record) return htmlError(400, "This sign-in code has expired. Start again on the device.");
  if (!code || url.searchParams.get("error")) return htmlError(400, "Sign-in was cancelled. Start again on the device.");
  if (record.code) return htmlError(400, "This sign-in code was already used.");
  await env.OAUTH_KV.put(recordKey(state), JSON.stringify({ ...record, code } satisfies DeviceCodeRecord), { expirationTtl: TTL });
  await env.OAUTH_KV.delete(userKey(record.user_code));
  return new Response(page("Signed in", `<h1>Signed in as ${escape(record.device)}.</h1><p>You can close this page.</p>`), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// The code typed on the phone leads to the normal consent page for the daemon's client, with its device preselected.
async function submit(request: Request, env: Env, origin: string): Promise<Response> {
  const userCode = normalize(String((await request.formData()).get("code") ?? ""));
  const deviceCode = userCode ? await env.OAUTH_KV.get(userKey(userCode)) : null;
  const record = deviceCode ? await env.OAUTH_KV.get<DeviceCodeRecord>(recordKey(deviceCode), "json") : null;
  if (!deviceCode || !record || record.code) return form(userCode, 404, "That code is not valid or has expired. Check the device and try again.");
  const to = new URL("/authorize", origin);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: record.client_id, redirect_uri: record.redirect_uri, state: deviceCode,
    code_challenge: record.code_challenge, code_challenge_method: "S256", resource: `${origin}/mcp`, member: record.device,
  })) to.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: to.href, "Cache-Control": "no-store" } });
}

function form(code: string, status = 200, problem = ""): Response {
  const body = `<h1>Sign in a device</h1>
${problem ? `<p><strong>${escape(problem)}</strong></p>` : ""}<p>Enter the code the device shows.</p>
<form method="post" action="/device">
<input name="code" value="${escape(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required>
<button>Continue</button>
</form>`;
  return new Response(page("Sign in a device", body), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'none'" },
  });
}

// People type codes in lower case, without the dash or with spaces; the stored form is XXXX-XXXX.
function normalize(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

async function freeUserCode(env: Env): Promise<string> {
  for (;;) {
    const code = randomUserCode();
    if (!(await env.OAUTH_KV.get(userKey(code)))) return code;
  }
}

// Rejection sampling keeps every symbol equally likely (256 is not a multiple of 28).
function randomUserCode(): string {
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 252 && out.length < 8) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
