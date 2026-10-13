import { deploymentDefaults } from "../../src/deployment.ts";
// The device's OAuth grant: `login` gets one with the device-code flow (a phone approves), and every call afterwards
// uses its access token, refreshed shortly before it expires. grant.json is 0600 in a 0700 folder.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { base, grantFile, stateDir } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SIGNED_OUT = `signed out: run ${deploymentDefaults.responderCommand} login --device <name>`;

let grant;
export function currentGrant() {
  if (grant === undefined) {
    try { grant = JSON.parse(readFileSync(grantFile, "utf8")); } catch { grant = null; }
  }
  return grant;
}
// Written to a 0600 temp file and renamed, so the grant is never readable by others, not even half-written.
function saveGrant(next) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const tmp = `${grantFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, grantFile);
  grant = next;
}

async function post(path, body, form = false) {
  const res = await fetch(new URL(path, base), {
    method: "POST",
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${r.data?.error_description ?? r.data?.error ?? ""}`.trim());
  return r.data;
};
const withExpiry = (tok) => ({ access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000 });

// say(first, done) prints: the code to approve, then the result. `--json` makes the first a JSON line for scripts.
export async function login({ device, say }) {
  if (!device) throw new Error(`usage: ${deploymentDefaults.responderCommand} login --device <person>-<label>`);
  const redirect = new URL("/device/callback", base).href;
  const { client_id } = must(await post("/oauth/register", { client_name: `${deploymentDefaults.name} responder ${device}`, redirect_uris: [redirect], token_endpoint_auth_method: "none" }), "register");
  const verifier = randomBytes(32).toString("base64url");
  const start = must(await post("/device/start", { client_id, code_challenge: createHash("sha256").update(verifier).digest("base64url"), device }), "device start");
  say.code(start);
  const deadline = Date.now() + start.expires_in * 1000;
  for (;;) {
    await sleep(start.interval * 1000);
    if (Date.now() > deadline) throw new Error("the code expired before anyone approved it; run login again");
    const r = await post("/device/token", { device_code: start.device_code });
    if (r.ok && r.data.code) {
      const tok = must(await post("/oauth/token", { grant_type: "authorization_code", code: r.data.code, redirect_uri: r.data.redirect_uri, client_id, code_verifier: verifier }, true), "token");
      saveGrant({ client_id, device, ...withExpiry(tok) });
      say.done(device, grantFile);
      return;
    }
    if (r.data.error === "authorization_pending") continue;
    throw new Error(r.data.error === "expired_token" ? "the code expired or was already used; run login again" : `device token: HTTP ${r.status} ${r.data.error ?? ""}`.trim());
  }
}

// One refresh at a time: the heartbeat and the inbox poll may both find the token stale, and the refresh token rotates.
let refreshing = null;
export function refresh() {
  return (refreshing ??= (async () => {
    const g = currentGrant();
    if (!g?.refresh_token) throw new Error(SIGNED_OUT);
    const r = await post("/oauth/token", { grant_type: "refresh_token", refresh_token: g.refresh_token, client_id: g.client_id }, true);
    if (!r.ok || !r.data.access_token) throw new Error(`${SIGNED_OUT} (refresh refused: ${r.data?.error ?? `HTTP ${r.status}`})`);
    saveGrant({ ...g, ...withExpiry({ ...r.data, refresh_token: r.data.refresh_token ?? g.refresh_token }) });
  })().finally(() => { refreshing = null; }));
}

export async function accessToken() {
  const g = currentGrant();
  if (!g?.access_token) throw new Error(SIGNED_OUT);
  if (g.expires_at - 60_000 < Date.now()) await refresh();
  return currentGrant().access_token;
}
