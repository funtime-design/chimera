import { OWNER } from "./harness/roles.mjs";
// DEFECT 20 (T-66 verification): the responder must not lose an answer it paid for. Run against a fake bridge in this
// process, so /v1/send and /v1/done can fail on demand; the real bundled responder (bin/goonbridge-responder.mjs) runs it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.env.CHIMERA_RESPONDER_BIN ?? new URL("../bin/goonbridge-responder.mjs", import.meta.url).pathname;
const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// The bridge: one message from alice to the device in the inbox; `fail` names the endpoints that answer 500.
const bridge = { fail: new Set(), sends: [], dones: [], message: null };
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://x");
  const send = (status, data) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
  if (url.pathname === "/v1/me") return send(200, { member: `${OWNER}-tfail`, person: OWNER, members: [OWNER], devices: { [OWNER]: [`${OWNER}-tfail`] }, trusted: [] });
  if (url.pathname === "/v1/status") return send(200, {});
  if (url.pathname === "/v1/inbox") { const m = bridge.message; bridge.message = null; return send(200, m ? [m] : []); }
  // `failOnce`: the endpoint fails its next call only, then recovers (a transient outage).
  const down = (name) => bridge.fail.has(name) || !!bridge.failOnce?.delete(name);
  if (url.pathname === "/v1/send") { bridge.sends.push(JSON.parse(body)); return down("send") ? send(500, { error: "send down" }) : send(200, { id: 99 }); }
  if (url.pathname === "/v1/done") { bridge.dones.push(JSON.parse(body)); return down("done") ? send(500, { error: "done down" }) : send(200, {}); }
  return send(404, { error: "no" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

const fakeBin = tmp("fake-claude-fail-");
writeFileSync(join(fakeBin, "claude"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ result: "the paid answer" }));\n`);
chmodSync(join(fakeBin, "claude"), 0o755);

function rig() {
  const state = tmp("goonbridge-responder-fail-");
  writeFileSync(join(state, "grant.json"), JSON.stringify({ client_id: "c", device: `${OWNER}-tfail`, access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3600e3 }), { mode: 0o600 });
  const run = () => {
    const r = spawn(process.execPath, [bin, "run", "--once"], {
      env: { ...process.env, GOONBRIDGE_URL: base, GOONBRIDGE_STATE_DIR: state, GOONBRIDGE_REPOS_ROOT: tmp("repos-fail-"), GOONBRIDGE_CLAUDE_BIN: join(fakeBin, "claude") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((res) => r.on("exit", (code) => res(code)));
  };
  return { state, run };
}
const message = (id) => ({ id, thread_id: id, sender: OWNER, recipient: `${OWNER}-tfail`, subject: "q", body: "what is 2+2", created_at: new Date().toISOString() });

test("a failed send whose fallback done also fails leaves the message unhandled, so it comes back", async () => {
  const { state, run } = rig();
  bridge.fail = new Set(["send", "done"]);
  bridge.message = message(501);
  await run();
  assert.ok(bridge.sends.some((s) => s.thread_id === 501), "the answer was attempted");
  assert.equal(existsSync(join(state, "handled", "501")), false, "no handled marker: the redelivery answers again");
  bridge.fail = new Set();
});

test("a thread marker that cannot be written does not stop the answer being sent", async () => {
  const { state, run } = rig();
  mkdirSync(join(state, "threads", "502"), { recursive: true }); // a folder where the marker file goes: the write fails
  bridge.sends.length = 0;
  bridge.message = message(502);
  await run();
  const sent = bridge.sends.filter((s) => s.thread_id === 502);
  assert.equal(sent.length, 1, "sent once");
  assert.match(sent[0].body, /the paid answer/, "the answer, not the error notice");
  assert.match(readFileSync(join(state, "responder.log"), "utf8"), /could not mark thread 502/);
});

test("send and done fail once, then recover: the answer is not replaced by an error reply, and the message comes back", async () => {
  const { state, run } = rig();
  bridge.sends.length = 0;
  bridge.dones.length = 0;
  bridge.failOnce = new Set(["send", "done"]);
  bridge.message = message(503);
  await run();
  const sent = bridge.sends.filter((s) => s.thread_id === 503);
  assert.ok(sent.some((s) => /the paid answer/.test(s.body)), "the answer was attempted");
  assert.ok(!sent.some((s) => /hit an error/.test(s.body)), `no error reply: ${JSON.stringify(sent)}`);
  assert.equal(bridge.dones.filter((d) => d.message_id === 503).length, 1, "no second done after the failed one");
  assert.equal(existsSync(join(state, "handled", "503")), false, "no handled marker: the redelivery answers again");
});
