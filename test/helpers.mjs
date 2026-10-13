// Shared live helpers. pnpm test:engine supplies isolated neutral fixtures; pnpm test retains owner inputs.
import { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync as readText } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NEUTRAL, OWNER, OWNER_CLOUD, CONFIG_REPO, MORE_HEADER, escapeRegex } from './harness/roles.mjs';
export * from './harness/roles.mjs';
import { startWorker } from './harness/worker.mjs';
import { assertNeutralOutput } from './harness/output.mjs';
const fixture = NEUTRAL ? JSON.parse(process.env.CHIMERA_TEST_FIXTURE ?? 'null') : null;
if (NEUTRAL && !fixture) throw new Error('Run pnpm test:engine to provision the neutral live harness');
export let base = process.env.GOONBRIDGE_URL ?? "http://localhost:3305";
export const [ownerToken, otherToken, outsiderToken, ownerDeviceToken, ownerSecondDeviceToken, ownerCloudToken, otherDeviceToken, otherCloudToken] = (fixture?.tokens.join(" ") ?? process.env.GOONBRIDGE_TEST_TOKENS ?? readFileSync(new URL("../.goonbridge-test/tokens", import.meta.url), "utf8"))
  .trim().split(/\s+/);

export async function rest(token, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), more: Number(res.headers.get(MORE_HEADER) ?? 0) };
}

let rpcId = 0;
export async function mcp(token, method, params) {
  const res = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json();
}

export const callTool = async (token, name, args = {}) => (await mcp(token, "tools/call", { name, arguments: args })).result;
// Claimed messages come back after the claim timeout, so draining marks each one done.
export async function drain(token) {
  for (;;) {
    const got = (await rest(token, "GET", "/v1/inbox")).body;
    if (got.length === 0) return;
    for (const m of got) await rest(token, "POST", "/v1/done", { message_id: m.id });
  }
}
// device.test.mjs registers a fresh ownerToken-t<4 hex> device each run, and registered devices stay in the local state (nothing
// over HTTP forgets one), so tests that pin the exact roster leave these out.
export const testDevice = (name) => new RegExp(`^${escapeRegex(OWNER)}-t[0-9a-f]{4}$`).test(name);
export const withoutTestDevices = (text) => text.replace(new RegExp(String.raw`, ${escapeRegex(OWNER)}-t[0-9a-f]{4} \((?:online|offline)\)`, "g"), "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let claimMs;
export const waitPastClaim = async () => {
  claimMs ??= (await rest(ownerToken, "GET", "/v1/me")).body.claim_seconds * 1000;
  assert.ok(claimMs <= 10000, "set GOONBRIDGE_CLAIM_SECONDS to a few seconds for tests");
  await sleep(claimMs + 1000);
};

export const devVars = fixture?.vars ?? (() => {
  try {
    return Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n")
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^'(.*)'$/, "$1")]));
  } catch {
    return {};
  }
})();
let oidcIssuer = devVars.ACCESS_TOKEN_URL?.replace(/\/token$/, "") ?? (NEUTRAL ? "http://127.0.0.1/oidc" : undefined);
export const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const s256 = (v) => createHash("sha256").update(v).digest("base64url");

// Fake servers start once per test process; neutral mode lets the OS assign each port. Call these at the top level of a test file;
// the server closes when that file's tests finish.
// Issues codes the test asks for, checks PKCE at /token, and signs RS256 ID tokens served by /jwks.
let fakeAccess;
export function useFakeAccess() {
  if (fakeAccess !== undefined) return fakeAccess;
  return (fakeAccess = (() => {
  if (!oidcIssuer) return null;
  const kid = "test-key";
  const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const bad = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const codes = new Map();
  const path = new URL(oidcIssuer).pathname;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, oidcIssuer);
    if (url.pathname === `${path}/jwks` || url.pathname === "/cdn-cgi/access/certs") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ keys: [{ ...good.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] }));
    }
    if (url.pathname === `${path}/token` && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const issued = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      const ok = issued && form.get("client_id") === devVars.ACCESS_CLIENT_ID && form.get("client_secret") === devVars.ACCESS_CLIENT_SECRET
        && s256(form.get("code_verifier") ?? "") === issued.challenge && form.get("redirect_uri") === issued.redirectUri;
      res.setHeader("Content-Type", "application/json");
      if (!ok) { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" })); }
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: "RS256", kid }));
      const payload = b64url(JSON.stringify({ iss: oidcIssuer, aud: [devVars.ACCESS_CLIENT_ID], sub: "user-1", email: issued.email, iat: now, exp: now + 300 }));
      const signature = b64url(rsaSign("sha256", Buffer.from(`${head}.${payload}`), issued.badSignature ? bad.privateKey : good.privateKey));
      return res.end(JSON.stringify({ access_token: "upstream", token_type: "Bearer", id_token: `${head}.${payload}.${signature}` }));
    }
    res.statusCode = 404;
    res.end();
  });
  const ready = listenFake(server, oidcIssuer, (origin) => {
    oidcIssuer = origin + path;
    Object.assign(devVars, { ACCESS_AUTHORIZATION_URL: oidcIssuer + '/authorize', ACCESS_TOKEN_URL: oidcIssuer + '/token', ACCESS_JWKS_URL: oidcIssuer + '/jwks', ACCESS_PAGES_ISSUER: origin });
  });
  after(() => { server.closeAllConnections(); server.close(); });

  return { ready,
    // What Cloudflare Access puts in Cf-Access-Jwt-Assertion for a browser it let through to /docs.
    accessJwt: (email, { badSignature = false, aud = devVars.ACCESS_PAGES_AUD, expired = false } = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: "RS256", kid }));
      const payload = b64url(JSON.stringify({ iss: devVars.ACCESS_PAGES_ISSUER, aud: [aud], sub: "user-1", email, iat: now, exp: expired ? now - 10 : now + 300 }));
      const signature = b64url(rsaSign("sha256", Buffer.from(`${head}.${payload}`), badSignature ? bad.privateKey : good.privateKey));
      return `${head}.${payload}.${signature}`;
    },
    issue: (email, upstreamAuthorizeUrl, { badSignature = false } = {}) => {
      const q = new URL(upstreamAuthorizeUrl).searchParams;
      const code = randomBytes(16).toString("hex");
      codes.set(code, { email, challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), badSignature });
      return code;
    },
  };
})());
}

// A fake routines API: records every fire and answers with a session like api.anthropic.com would.
let routinesUrl = devVars.GOONBRIDGE_ROUTINES_URL ?? (NEUTRAL ? "http://127.0.0.1/v1/claude_code/routines" : undefined);
let fakeRoutines;
export function useFakeRoutines() {
  if (fakeRoutines !== undefined) return fakeRoutines;
  return (fakeRoutines = (() => {
  if (!routinesUrl) return null;
  const fires = [];
  // Session ids are unique per run, as the real API's are: the dev database outlives a test run.
  const run = Date.now();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const match = req.url.match(/\/routines\/([^/]+)\/fire$/);
    res.setHeader("Content-Type", "application/json");
    if (!match || req.method !== "POST" || req.headers.authorization !== "Bearer rt_local_test_token" || !req.headers["anthropic-beta"]) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "bad trigger or token" } }));
    }
    const fire = { trigger: match[1], text: JSON.parse(body).text, n: fires.length + 1 };
    fires.push(fire);
    if (fire.text.includes("MAKE-IT-FAIL")) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: "rate limited" } })); }
    // A slow routines API (up to 20 s in production): the window in which a sibling session could take the message.
    if (fire.text.includes("SLOW-FIRE")) await new Promise((r) => setTimeout(r, 1500));
    // Slower than GOONBRIDGE_BOOT_SECONDS, the first time a text is fired: a dispatch that never reported back in time.
    if (fire.text.includes("HANG-FIRE") && fires.filter((f) => f.text === fire.text).length === 1) await new Promise((r) => setTimeout(r, 5000));
    res.end(JSON.stringify({ type: "routine_fire", claude_code_session_id: `session_fake${run}${fire.n}`, claude_code_session_url: `https://claude.ai/code/session_fake${run}${fire.n}` }));
  });
  const ready = listenFake(server, routinesUrl, (origin) => { routinesUrl = origin + '/v1/claude_code/routines'; devVars.GOONBRIDGE_ROUTINES_URL = routinesUrl; });
  after(() => { server.closeAllConnections(); server.close(); });
  return { fires, ready };
})());
}

// A fake GitHub holding the cloud-session-config repo: commits made with commit(ref, files), read with the PAT in .dev.vars.
// The ref "pat-revoked" answers 401, like an expired token. Counts blob reads, to show bundles are cached by commit.
let githubUrl = devVars.GITHUB_CONFIG_API_URL ?? (NEUTRAL ? "http://127.0.0.1" : undefined);
let fakeGitHub;
export function useFakeGitHub() {
  if (fakeGitHub !== undefined) return fakeGitHub;
  return (fakeGitHub = (() => {
  if (!githubUrl) return null;
  const refs = new Map();
  const trees = new Map();
  const blobs = new Map();
  const state = { blobReads: 0 };
  const sha1 = (v) => createHash("sha1").update(v).digest("hex");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const url = new URL(req.url, githubUrl);
    const m = url.pathname.match(new RegExp(`^/repos/${escapeRegex(devVars.GITHUB_CONFIG_REPO ?? CONFIG_REPO)}/(commits|git/trees|git/blobs)/(.+)$`));
    if (!m || req.headers.authorization !== `Bearer ${devVars.GITHUB_CONFIG_PAT}`) return send(401, { message: "Bad credentials" });
    const key = decodeURIComponent(m[2]);
    if (m[1] === "commits") {
      if (key === "pat-revoked") return send(401, { message: "Bad credentials" });
      return refs.has(key) ? send(200, { sha: refs.get(key) }) : send(404, { message: "No commit found" });
    }
    if (m[1] === "git/trees") return trees.has(key) ? send(200, { sha: key, tree: trees.get(key), truncated: false }) : send(404, { message: "Not Found" });
    state.blobReads++;
    return blobs.has(key) ? send(200, { sha: key, content: Buffer.from(blobs.get(key)).toString("base64").replace(/(.{60})/g, "$1\n"), encoding: "base64" }) : send(404, { message: "Not Found" });
  });
  const ready = listenFake(server, githubUrl, (origin) => { githubUrl = origin; devVars.GITHUB_CONFIG_API_URL = origin; });
  after(() => { server.closeAllConnections(); server.close(); });
  return { ready,
    state,
    // Points ref at a new commit holding exactly these files; returns the commit sha.
    commit(ref, files) {
      const tree = Object.entries(files).map(([path, content]) => {
        const sha = sha1(content);
        blobs.set(sha, content);
        return { path, mode: "100644", type: "blob", sha, size: Buffer.byteLength(content) };
      });
      const commit = sha1(`${ref}${JSON.stringify(tree)}${Math.random()}`);
      trees.set(commit, [{ path: "hooks", mode: "040000", type: "tree", sha: sha1("dir") }, ...tree]);
      refs.set(ref, commit);
      return commit;
    },
  };
})());
}

export function cookieJar() {
  const jar = new Map();
  return {
    take(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        if (/max-age=0/i.test(c)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return res;
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

// Runs the claude.ai side of the flow up to the bridge's /callback; returns that response and what the client needs next.
// `connectAs` is the "Connect as" pick on the consent page (a device name); left out, the form sends none.
export async function signInThroughAccess(email, { connectAs, ...opts } = {}) {
  const redirectUri = "http://localhost:9/cb";
  const reg = await fetch(new URL("/oauth/register", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Connector", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201);
  const clientId = (await reg.json()).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const jar = cookieJar();
  const auth = new URL("/authorize", base);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state: "client-state",
    code_challenge: s256(verifier), code_challenge_method: "S256", resource: new URL("/mcp", base).href })) auth.searchParams.set(k, v);

  const done = await approveAuthorize(auth, email, jar, { connectAs, ...opts, consent: (html) => {
    assert.match(html, /Test Connector/);
    // Access goes to the client's redirect host (not the bridge's own host, which only matched while both were localhost).
    assert.ok(html.includes(`<strong>${new URL(redirectUri).hostname}</strong>`), "page names where access goes");
    assert.match(html, /<legend>Connect as<\/legend>/);
    assert.match(html, new RegExp(`name="member" value="${escapeRegex(OWNER_CLOUD)}"`), "devices are offered");
  } });
  return { done, clientId, verifier };
}

// The browser side of /authorize: GET the consent page, approve it, go through the fake Access sign-in and land on the
// bridge's /callback. `connectAs` overrides the "Connect as" pick; left out, the form sends the radio that is checked, as a
// browser would. When the URL asks for a `member`, that radio must be the checked one. A redirect from /callback back to
// this bridge (the device-code sign-in's /device/callback) is followed; the response returned is the last one.
export async function approveAuthorize(authorizeUrl, email, jar, { connectAs, consent: check, ...opts } = {}) {
  const auth = new URL(authorizeUrl);
  const consent = jar.take(await fetch(auth, { redirect: "manual", headers: { Cookie: jar.header() } }));
  assert.equal(consent.status, 200);
  const html = await consent.text();
  check?.(html);
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const checked = html.match(/name="member" value="([^"]*)" checked/)?.[1] ?? "";
  const wanted = auth.searchParams.get("member");
  if (wanted) assert.equal(checked, wanted, `consent page preselects ${wanted}`);
  const member = connectAs ?? checked;

  const toAccess = jar.take(await fetch(auth, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
    body: new URLSearchParams({ handle, decision: "approve", ...(member ? { member } : {}) }),
  }));
  assert.equal(toAccess.status, 302);
  const upstream = new URL(toAccess.headers.get("Location"));
  assert.equal(upstream.href.split("?")[0], devVars.ACCESS_AUTHORIZATION_URL);
  assert.equal(upstream.searchParams.get("code_challenge_method"), "S256");

  const code = useFakeAccess().issue(email, upstream, opts);
  const callback = new URL(upstream.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", upstream.searchParams.get("state"));
  const done = jar.take(await fetch(callback, { redirect: "manual", headers: { Cookie: jar.header() } }));
  const next = done.status === 302 ? new URL(done.headers.get("Location")) : null;
  if (next?.origin !== new URL(base).origin) return done;
  return jar.take(await fetch(next, { redirect: "manual", headers: { Cookie: jar.header() } }));
}

// Finishes a sign-in: checks the redirect back to the client and swaps its code for an MCP access token.
export async function oauthToken({ done, clientId, verifier }) {
  assert.equal(done.status, 302);
  const back = new URL(done.headers.get("Location"));
  assert.equal(back.origin + back.pathname, "http://localhost:9/cb");
  assert.equal(back.searchParams.get("state"), "client-state");

  const tokenRes = await fetch(new URL("/oauth/token", base), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: "http://localhost:9/cb",
      client_id: clientId, code_verifier: verifier, resource: new URL("/mcp", base).href }),
  });
  assert.equal(tokenRes.status, 200);
  return (await tokenRes.json()).access_token;
}

let windows;
export const serverWindows = async () => (windows ??= (await rest(ownerToken, "GET", "/v1/me")).body);

// Task mode: a task message starts `claude --cloud` (under script(1)) from a mirror checkout on a fresh claude/* branch.
export function taskRig() {
  const tmp = mkdtempSync(join(tmpdir(), "engine-task-"));
  const home = join(tmp, "home");
  const root = join(tmp, "repos");
  const mirrors = join(tmp, "mirrors");
  const bin = join(tmp, "bin");
  for (const d of [join(home, ".goonbridge"), join(root, "example-repo", "example-repo", ".git"), join(root, "example-app", "example-web", ".git"), join(root, "tasks", ".git"), mirrors, bin]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(home, ".goonbridge", "token"), ownerDeviceToken, { mode: 0o600 });
  // A bare "GitHub" origin with dev and main, and the mirror cloned from it.
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" });
  const origin = join(tmp, "origin.git");
  const seed = join(tmp, "seed");
  mkdirSync(seed);
  git(tmp, "init", "--bare", "-q", origin);
  git(seed, "init", "-q");
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", origin, "HEAD:main", "HEAD:dev");
  git(tmp, "clone", "-q", origin, join(mirrors, "example-repo"));
  // A workspace repo with no mirror, for local tasks: its own bare origin with main only.
  const thingOrigin = join(tmp, "thing-origin.git");
  git(tmp, "init", "--bare", "-q", thingOrigin);
  git(seed, "push", "-q", thingOrigin, "HEAD:main");
  git(tmp, "clone", "-q", thingOrigin, join(root, "DevOps", "thing"));
  const record = join(tmp, "calls.jsonl");
  const fake = join(bin, "claude");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const branch = args[0] === "--cloud" ? require("node:child_process").execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() : null;
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), args, branch, token: process.env.GOONBRIDGE_TOKEN ?? null }) + "\\n");
if (args[0] === "--cloud") {
  process.stdout.write("\\x1b[1mCreated cloud session: Fix retry backoff\\x1b[0m\\nView: https://claude.ai/code/session_abc123?from=cli&m=0\\nResume with: claude --teleport session_abc123\\n");
} else if (args[1].includes("FAIL-ONCE")) {
  const mark = ${JSON.stringify(record)} + ".failed-once";
  if (!fs.existsSync(mark)) {
    fs.writeFileSync(mark, "");
    fs.writeFileSync("HALF.md", "half done\\n");
    fs.writeFileSync("run.sh", "#!/bin/sh\\necho hi\\n");
    process.exit(1);
  }
  fs.appendFileSync("HALF.md", "finished\\n");
  console.log(JSON.stringify({ type: "result", result: "Finished HALF.md.", permission_denials: [] }));
} else if (args[1].includes("FAIL-AGENT")) {
  fs.writeFileSync("HALF.md", "half done\\n");
  process.exit(1);
} else if (args[1].includes("leak the token")) {
  console.log(JSON.stringify({ type: "result", result: "Sure: " + process.env.LEAK_TEST + " is the token.", permission_denials: [] }));
} else if (args[1].includes("which repo folder the task below")) {
  console.log(JSON.stringify({ type: "result", result: "DevOps/thing", permission_denials: [] }));
} else if (args[1].includes("throwaway worktree")) {
  fs.writeFileSync("NOTE.md", "added by the local agent\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "result", result: "Added NOTE.md with one line.", permission_denials: [] }));
} else {
  console.log(JSON.stringify({ type: "result", result: "example-repo is on main.", permission_denials: [] }));
}
`);
  chmodSync(fake, 0o755);
  const runResponder = async () => {
    const run = spawn(process.execPath, [process.env.CHIMERA_RESPONDER_BIN ?? new URL("../bin/goonbridge-responder.mjs", import.meta.url).pathname, "--once"], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GOONBRIDGE_URL: base, GOONBRIDGE_REPOS_ROOT: root, GOONBRIDGE_MIRRORS_ROOT: mirrors,
        GOONBRIDGE_DEFAULT_REPO: "", GOONBRIDGE_CLAUDE_BIN: fake, GOONBRIDGE_CLOUD_STDIN_SECONDS: "1", GOONBRIDGE_TOKEN: "must-not-leak", LEAK_TEST: ownerDeviceToken },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    run.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((r) => run.on("close", r));
    assert.equal(code, 0, stderr);
    return existsCalls(record);
  };
  return { tmp, home, mirrors, root, thingOrigin, runResponder };
}
export const existsCalls = (record) => { try { return readText(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const today = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };

const fakeServers = new Set();
function listenFake(server, url, configured) {
  fakeServers.add(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: NEUTRAL ? 0 : Number(new URL(url).port), ...(NEUTRAL ? { host: '127.0.0.1' } : {}) }, () => {
      if (NEUTRAL) configured('http://127.0.0.1:' + server.address().port);
      resolve();
    });
  });
}
// Each live file has its own Worker and all fake services, ready before tests are imported.
if (NEUTRAL) {
  try {
    await Promise.all([useFakeAccess().ready, useFakeRoutines().ready, useFakeGitHub().ready]);
    const worker = await startWorker(process.env.CHIMERA_TEST_DIRECTORY, devVars);
    base = worker.url;
    const fetchResponse = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await fetchResponse(...args);
      const url = new URL(args[0] instanceof Request ? args[0].url : args[0]);
      // Executable assets retain protocol/env/install compatibility identifiers. Agent prose, JSON and HTML do not.
      if (url.origin === new URL(base).origin && !/\.(?:mjs|sh)$/.test(url.pathname)) assertNeutralOutput(await response.clone().text());
      return response;
    };
    // The bootstrap tears down the process group after every test and after hook has finished.
  } catch (error) {
    for (const server of fakeServers) { server.closeAllConnections(); server.close(); }
    throw error;
  }
}
