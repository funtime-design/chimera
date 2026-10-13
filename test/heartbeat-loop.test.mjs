import { SESSION_HEADER } from "./harness/roles.mjs";
import { clientSettings } from "./harness/client.mjs";
// T-49: the in-run heartbeat. A PostToolUse hook cannot beat during one long tool call, so SessionStart starts a detached
// loop that posts /v1/heartbeat every GOONBRIDGE_HEARTBEAT_SECONDS while the session runs; wind-down stops it. No worker:
// a local HTTP server stands in for the bridge.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hooks = fileURLToPath(new URL("../.claude/hooks/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "hb-loop-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
// The hooks under test run from the active client config, with the hooks under test enabled even where a deployment's
// list leaves them off (the neutral fixture enables none). File names follow the configured product name.
const product = clientSettings.product_name;
const bridgeConfig = join(scratch, "bridge.json");
const enabled = clientSettings.enabled_hooks && [...new Set([...clientSettings.enabled_hooks, "heartbeat-loop", "wind-down"])];
writeFileSync(bridgeConfig, JSON.stringify({ ...clientSettings, ...(enabled ? { enabled_hooks: enabled } : {}) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const calls = [];
let answer = 200;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push({ method: req.method, path: req.url, session: req.headers[SESSION_HEADER.toLowerCase()], auth: req.headers.authorization, body });
    res.statusCode = req.url.startsWith("/v1/heartbeat") ? answer : 200;
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => { server.closeAllConnections(); server.close(); });
const url = `http://127.0.0.1:${server.address().port}`;

function run(script, args, env) {
  const clean = { ...process.env };
  delete clean.CLAUDE_CODE_REMOTE;
  delete clean.GOONBRIDGE_TOKEN;
  // Async: the fake bridge runs in this process, so a blocking spawn would starve it.
  const child = spawn("sh", [join(hooks, script), ...args], { env: { ...clean, BRIDGE_CONFIG: bridgeConfig, TMPDIR: scratch, GOONBRIDGE_URL: url, GOONBRIDGE_HEARTBEAT_SECONDS: "1", ...env } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((r) => child.on("close", (status) => r({ status, stderr })));
}
const cloud = (id) => ({ CLAUDE_CODE_REMOTE: "true", GOONBRIDGE_TOKEN: "tok", CLAUDE_CODE_REMOTE_SESSION_ID: id });
const pidFile = (id) => join(scratch, `${product}-heartbeat-loop-${id}.pid`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("does nothing outside a cloud session", async () => {
  const r = await run("heartbeat-loop.sh", ["start"], { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_local" });
  assert.equal(r.status, 0);
  assert.equal(existsSync(pidFile("cse_local")), false);
});

test("beats while the session runs, starts once, and wind-down stops it", async () => {
  const id = "cse_looptest1";
  const start = await run("heartbeat-loop.sh", ["start"], cloud(id));
  assert.equal(start.status, 0, start.stderr);
  const pid = Number(readFileSync(pidFile(id), "utf8"));
  assert.ok(alive(pid), "the loop runs detached after the hook returned");
  await run("heartbeat-loop.sh", ["start"], cloud(id));
  assert.equal(Number(readFileSync(pidFile(id), "utf8")), pid, "a second SessionStart (resume, clear) keeps the one loop");
  await sleep(2500);
  const beats = calls.filter((c) => c.path === "/v1/heartbeat?signal=process" && c.session === id);
  assert.ok(beats.length >= 2, `beats every second: ${beats.length}`);
  assert.equal(beats[0].auth, "Bearer tok");
  const down = await run("wind-down.sh", [], cloud(id));
  assert.equal(down.status, 0, down.stderr);
  assert.equal(existsSync(pidFile(id)), false);
  await sleep(300);
  assert.equal(alive(pid), false, "wind-down stopped the loop");
  assert.ok(calls.some((c) => c.path === "/v1/status" && c.session === id && JSON.parse(c.body).state === "offline"));
});

test("a killed session (410) stops its own loop", async () => {
  const id = "cse_looptest2";
  answer = 410;
  try {
    assert.equal((await run("heartbeat-loop.sh", ["start"], cloud(id))).status, 0);
    const pid = Number(readFileSync(pidFile(id), "utf8"));
    await sleep(1500);
    assert.equal(alive(pid), false);
    assert.equal(existsSync(pidFile(id)), false);
  } finally {
    answer = 200;
  }
});

// The loop outlives the hook but not Claude Code: started through a `sh -c` wrapper (as a hook runs), it watches the
// wrapper's parent. Concurrent starts may race to two loops (a known gap, DEFER 11 of the T-66 verification); what holds
// is that every loop stops once that owner process is gone. (A real Claude ancestry is checked by hand on a cloud session.)
test("concurrent starts through a sh -c wrapper: every loop stops beating when the owner process exits", async () => {
  const id = "cse_looptest4";
  const clean = { ...process.env };
  delete clean.CLAUDE_CODE_REMOTE;
  delete clean.GOONBRIDGE_TOKEN;
  const env = { ...clean, ...cloud(id), BRIDGE_CONFIG: bridgeConfig, TMPDIR: scratch, GOONBRIDGE_URL: url, GOONBRIDGE_HEARTBEAT_SECONDS: "1" };
  const script = join(hooks, "heartbeat-loop.sh");
  // The owner: a long-lived node process standing in for Claude Code (not a shell: the script skips a shell parent as the
  // hook's wrapper), which runs both hooks through `sh -c` at once.
  const owner = spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process");
    for (let i = 0; i < 2; i++) spawn("sh", ["-c", 'sh "${script}" start'], { stdio: "ignore" });
    setTimeout(() => {}, 30000);`], { env, stdio: "ignore" });
  await sleep(2500);
  assert.ok(calls.filter((c) => c.session === id).length >= 1, "beating while the owner lives");
  owner.kill("SIGKILL");
  await sleep(2500);
  const settled = calls.filter((c) => c.session === id).length;
  await sleep(2500);
  assert.equal(calls.filter((c) => c.session === id).length, settled, "no loop beats after the owner exited");
});

test("no tool finished for the idle bound: the loop stops beating and exits", async () => {
  const id = "cse_looptest3";
  // The PostToolUse hook's stamp says the last tool finished ten minutes ago.
  writeFileSync(join(scratch, `${product}-heartbeat-${id}`), String(Math.floor(Date.now() / 1000) - 600));
  assert.equal((await run("heartbeat-loop.sh", ["start"], { ...cloud(id), GOONBRIDGE_HEARTBEAT_IDLE_SECONDS: "60" })).status, 0);
  const pid = Number(readFileSync(pidFile(id), "utf8"));
  await sleep(1500);
  assert.equal(calls.filter((c) => c.session === id).length, 0, "no beat for a session whose agent stopped acting");
  assert.equal(alive(pid), false);
  assert.equal(existsSync(pidFile(id)), false);
});
