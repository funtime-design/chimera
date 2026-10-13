import { clientSettings, servedScript, responderBin } from "./harness/client.mjs";
import { OTHER, OWNER, OWNER_DEVICE, OWNER_EMAIL, PRODUCT, REPO, escapeRegex } from "./harness/roles.mjs";
// The Mac responder (bin/goonbridge-responder.mjs, bundled from bin/responder/): logs in with the device-code flow, then
// answers its inbox with a `claude -p` run per message. A fake `claude` stands in for Claude Code.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base, ownerToken, rest, drain, useFakeAccess, approveAuthorize, cookieJar } from "./helpers.mjs";

const fakeAccess = useFakeAccess();
const skip = !fakeAccess && "no ACCESS_* in .dev.vars";
const bin = responderBin;
// alice-t<4 hex>: the shape other tests already ignore, since a registered device stays in the local state.
const device = `${OWNER}-t${randomBytes(2).toString("hex")}`;
// Prefixed with the active product name: responses echo these paths, and neutral responses must not carry owner branding.
const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), `${PRODUCT}-${prefix}`)));
const state = tmp("responder-");
const repos = tmp("repos-");
// A fake `claude`: echoes its mode (mode=full with --dangerously-skip-permissions, else mode=read), the prompt (on one line) and its cwd back as a JSON result, and fails if it sees any GOONBRIDGE_* env.
const fakeBin = tmp("fake-claude-");
writeFileSync(join(fakeBin, "claude"), `#!${process.execPath}
if (Object.keys(process.env).some((k) => k.startsWith("GOONBRIDGE_"))) { console.error("leaked"); process.exit(9); }
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const mode = process.argv.includes("--dangerously-skip-permissions") ? "full" : "read";
if (prompt.includes("CRASHONCE") && !require("node:fs").existsSync(${JSON.stringify(join(fakeBin, "crashed"))})) {
  require("node:fs").writeFileSync(${JSON.stringify(join(fakeBin, "crashed"))}, "1");
  process.kill(process.ppid, "SIGKILL"); // the responder dies after taking the message and before replying
} else
process.stdout.write(JSON.stringify({ result: "mode=" + mode + " echo: " + prompt.replace(/\\s+/g, " ") + " (cwd " + process.cwd() + ")" }));
`);
chmodSync(join(fakeBin, "claude"), 0o755);
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GOONBRIDGE_URL: base, GOONBRIDGE_STATE_DIR: state, GOONBRIDGE_REPOS_ROOT: repos, GOONBRIDGE_CLAUDE_BIN: join(fakeBin, "claude") };
const grantFile = join(state, "grant.json");
const grant = () => JSON.parse(readFileSync(grantFile, "utf8"));

function runOnce() {
  const r = spawn(process.execPath, [bin, "run", "--once"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  r.stderr.on("data", (d) => (err += d));
  return new Promise((res) => r.on("exit", (code) => res({ code, err })));
}
async function ask(body) {
  await drain(ownerToken);
  return (await rest(ownerToken, "POST", "/v1/send", { to: device, subject: "q", body })).body;
}
const replyIn = async (threadId) => (await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body.find((m) => m.sender === device);
after(() => drain(ownerToken));

test("login: prints the code, the phone approves, grant.json is written 0600", { skip }, async (t) => {
  const child = spawn(process.execPath, [bin, "login", "--device", device, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill()); // a failed assertion must not leave it polling for ten minutes
  let out = "";
  for await (const chunk of child.stdout) { out += chunk; if (out.includes("\n")) break; }
  const first = JSON.parse(out.split("\n")[0]);
  assert.match(first.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(first.verification_uri_complete, new URL(`/device?code=${first.user_code}`, base).href);
  const jar = cookieJar();
  const form = jar.take(await fetch(new URL("/device", base), { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: first.user_code }) }));
  const done = await approveAuthorize(new URL(form.headers.get("Location")), OWNER_EMAIL, jar);
  assert.equal(done.status, 200);
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  const g = grant();
  assert.equal(g.device, device);
  assert.ok(g.client_id && g.access_token && g.refresh_token);
  assert.ok(g.expires_at > Date.now());
  assert.equal(statSync(grantFile).mode & 0o777, 0o600);
  assert.equal(statSync(state).mode & 0o777, 0o700);
});

test("run --once: answers a message as the device with a claude run in the named repo", { skip }, async () => {
  mkdirSync(join(repos, "demo"), { recursive: true });
  const sent = await ask("in repo demo: what is 2+2");
  const r = await runOnce();
  assert.equal(r.code, 0, r.err);
  const reply = await replyIn(sent.thread_id);
  assert.ok(reply, "the device replied in the thread");
  assert.match(reply.body, /echo: .*2\+2/);
  assert.match(reply.body, new RegExp(`cwd ${join(repos, "demo")}\\)`));
  assert.match(reply.body, /dangerously-skip-permissions|change files/i, "the owner's own ask runs with full permissions");
});

test("a rejected access token is refreshed once and the rotated refresh token is stored", { skip }, async () => {
  const before = grant();
  writeFileSync(grantFile, JSON.stringify({ ...before, access_token: "bogus" }), { mode: 0o600 });
  const sent = await ask("what is 3+3");
  const r = await runOnce();
  assert.equal(r.code, 0, r.err);
  assert.match((await replyIn(sent.thread_id))?.body ?? "", /echo: .*3\+3/);
  const after = grant();
  assert.notEqual(after.access_token, "bogus");
  assert.notEqual(after.refresh_token, before.refresh_token, "rotated refresh token saved");
  assert.equal(statSync(grantFile).mode & 0o777, 0o600);
});

// A thread an interactive window on this device had with alice: it opened the thread as the device and handled alice's
// reply itself. The responder never answered in it.
async function windowThread() {
  await drain(ownerToken);
  const opened = (await rest(grant().access_token, "POST", "/v1/send", { to: OWNER, subject: "window", body: "a question from an interactive window" })).body;
  assert.ok(opened.id, JSON.stringify(opened));
  await drain(ownerToken);
  const back = (await rest(ownerToken, "POST", "/v1/send", { thread_id: opened.thread_id, body: "the answer to the window" })).body;
  await rest(grant().access_token, "POST", "/v1/done", { message_id: back.id });
  return opened.thread_id;
}
const later = async (threadId, id) => (await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body.filter((m) => m.id > id);
const responderLog = () => readFileSync(join(state, "responder.log"), "utf8");

test("a device's reply in a thread another client of this device had is marked done, not answered", { skip }, async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const threadId = await windowThread();
  const theirs = (await rest(ownerDeviceToken, "POST", "/v1/send", { thread_id: threadId, to: device, body: "in repo demo: a cloud child's reply for the window" })).body;
  assert.equal((await runOnce()).code, 0);
  assert.equal((await later(threadId, theirs.id)).length, 0, "the responder did not answer");
  assert.equal((await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body.find((m) => m.id === theirs.id).status[device], "done");
  assert.match(responderLog(), new RegExp(`message ${theirs.id}: reply from ${OWNER_DEVICE} in a thread I never answered in, marked done`));
});

test("a person's reply in a thread another client of this device had is still answered", { skip }, async () => {
  const threadId = await windowThread();
  const theirs = (await rest(ownerToken, "POST", "/v1/send", { thread_id: threadId, body: "in repo demo: also what is 7+7" })).body;
  assert.equal((await runOnce()).code, 0);
  assert.match((await later(threadId, theirs.id)).find((m) => m.sender === device)?.body ?? "", /echo: .*7\+7/);
});

test("a thread this device wrote in before the markers existed counts as the responder's", { skip }, async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const sinceFile = join(state, "threads", ".since");
  const saved = readFileSync(sinceFile, "utf8");
  try {
    // .since falls between this device's message and the later messages in the thread: the rule is the device's own
    // message predating .since, not the thread being older than it.
    const threadId = await windowThread();
    const opened = (await rest(ownerToken, "GET", `/v1/threads/${threadId}`)).body[0];
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(sinceFile, new Date(Date.parse(opened.created_at) + 10).toISOString());
    await new Promise((r) => setTimeout(r, 20));
    const theirs = (await rest(ownerDeviceToken, "POST", "/v1/send", { thread_id: threadId, to: device, body: "in repo demo: what is 8+8" })).body;
    assert.ok(theirs.created_at > readFileSync(sinceFile, "utf8"), "the reply is newer than .since");
    assert.equal((await runOnce()).code, 0);
    assert.match((await later(threadId, theirs.id)).find((m) => m.sender === device)?.body ?? "", /echo: .*8\+8/);
    // The contrast: .since before the device's message, so its message is not from before the markers: not this responder's.
    const fresh = await windowThread();
    const first = (await rest(ownerToken, "GET", `/v1/threads/${fresh}`)).body[0];
    writeFileSync(sinceFile, new Date(Date.parse(first.created_at) - 1000).toISOString());
    const other = (await rest(ownerDeviceToken, "POST", "/v1/send", { thread_id: fresh, to: device, body: "in repo demo: what is 1+1" })).body;
    assert.equal((await runOnce()).code, 0);
    assert.equal((await later(fresh, other.id)).length, 0, "the device message after .since does not make the thread the responder's");
  } finally {
    writeFileSync(sinceFile, saved);
  }
});

test("a device's reply to the responder's own answer gets no answer, so two responders cannot loop", { skip }, async () => {
  const { ownerDeviceToken } = await import("./helpers.mjs");
  const sent = await ask("in repo demo: what is 9+9");
  assert.equal((await runOnce()).code, 0);
  assert.ok(await replyIn(sent.thread_id));
  const theirs = (await rest(ownerDeviceToken, "POST", "/v1/send", { thread_id: sent.thread_id, to: device, body: "in repo demo: my own answer back" })).body;
  assert.equal((await runOnce()).code, 0);
  assert.equal((await later(sent.thread_id, theirs.id)).length, 0);
  assert.match(responderLog(), new RegExp(`message ${theirs.id}: reply from a device to my answer, marked done`));
});

test("a reply to the responder's own answer is answered", { skip }, async () => {
  const sent = await ask("in repo demo: what is 4+4");
  assert.equal((await runOnce()).code, 0);
  assert.ok(await replyIn(sent.thread_id));
  const follow = (await rest(ownerToken, "POST", "/v1/send", { thread_id: sent.thread_id, body: "in repo demo: and 5+5" })).body;
  assert.equal((await runOnce()).code, 0);
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${sent.thread_id}`)).body;
  assert.match(thread.find((m) => m.id > follow.id && m.sender === device)?.body ?? "", /echo: .*5\+5/);
});

test("a crash between taking a message and replying leaves it to be answered on the next run", { skip }, async () => {
  const { waitPastClaim } = await import("./helpers.mjs");
  const sent = await ask("in repo demo: CRASHONCE what is 6+6");
  const crashed = await runOnce();
  assert.notEqual(crashed.code, 0, "the first run died");
  assert.equal(await replyIn(sent.thread_id), undefined);
  await waitPastClaim();
  assert.equal((await runOnce()).code, 0);
  assert.match((await replyIn(sent.thread_id))?.body ?? "", /echo: .*6\+6/);
});

// Before the refusal test below, which leaves the grant unusable.
test("trust: a trusted person's message runs full, their device runs read-only, and a revoke takes effect on the next message", { skip }, async () => {
  const { otherToken, otherDeviceToken } = await import("./helpers.mjs");
  await drain(ownerToken);
  // Before trust: bob is read-only.
  const a = (await rest(otherToken, "POST", "/v1/send", { to: device, subject: "t1", body: "in repo demo: hello" })).body;
  let r = spawn(process.execPath, [bin, "run", "--once"], { env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(await new Promise((res) => r.on("exit", res)), 0);
  assert.match((await rest(ownerToken, "GET", `/v1/threads/${a.thread_id}`)).body.find((m) => m.sender === device).body, /mode=read/);
  // The owner trusts bob on this device.
  assert.equal((await rest(ownerToken, "POST", `/v1/devices/${device}/trust`, { person: OTHER, mode: "full" })).status, 200);
  const b = (await rest(otherToken, "POST", "/v1/send", { to: device, subject: "t2", body: "in repo demo: hello again" })).body;
  const c = (await rest(otherDeviceToken, "POST", "/v1/send", { to: device, subject: "t3", body: `in repo demo: from ${OTHER}'s mac` })).body;
  for (let i = 0; i < 2; i++) { r = spawn(process.execPath, [bin, "run", "--once"], { env, stdio: ["ignore", "pipe", "pipe"] }); assert.equal(await new Promise((res) => r.on("exit", res)), 0); }
  assert.match((await rest(ownerToken, "GET", `/v1/threads/${b.thread_id}`)).body.find((m) => m.sender === device).body, /mode=full/, `${OTHER} himself is full`);
  assert.match((await rest(ownerToken, "GET", `/v1/threads/${c.thread_id}`)).body.find((m) => m.sender === device).body, /mode=read/, `${OTHER}'s device is not ${OTHER}`);
  assert.match(readFileSync(join(state, "responder.log"), "utf8"), new RegExp(String.raw`full mode for ${escapeRegex(OTHER)} \(trusted\)`, ""));
  // Revoke: next message is read-only, no restart.
  await rest(ownerToken, "POST", `/v1/devices/${device}/trust`, { person: OTHER, mode: "read" });
  const d = (await rest(otherToken, "POST", "/v1/send", { to: device, subject: "t4", body: "in repo demo: after revoke" })).body;
  r = spawn(process.execPath, [bin, "run", "--once"], { env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(await new Promise((res) => r.on("exit", res)), 0);
  assert.match((await rest(ownerToken, "GET", `/v1/threads/${d.thread_id}`)).body.find((m) => m.sender === device).body, /mode=read/);
  await drain(ownerToken); await drain(otherToken);
});

test("a grant that cannot be refreshed fails loudly", { skip }, async () => {
  writeFileSync(grantFile, JSON.stringify({ ...grant(), access_token: "bogus", refresh_token: "bogus:bogus:bogus" }), { mode: 0o600 });
  const r = await runOnce();
  assert.notEqual(r.code, 0);
  assert.match(r.err, new RegExp(String.raw`signed out: run ${escapeRegex(PRODUCT)}-responder login`, ""));
});

// The installer against a throwaway HOME and a fake launchctl: nothing is loaded into this Mac's launchd.
test("install-responder-macos.sh refuses without a grant, then writes the plist from $HOME", () => {
  const home = tmp("home-");
  const calls = join(home, "launchctl.calls");
  writeFileSync(join(fakeBin, "launchctl"), `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$1" = print ] && exit 1\nexit 0\n`);
  chmodSync(join(fakeBin, "launchctl"), 0o755);
  // The installer runs beside the configured responder bundle, as when both are downloaded from the Worker.
  const binDir = tmp("bin-");
  const script = join(binDir, "install-responder-macos.sh");
  copyFileSync(new URL("../bin/install-responder-macos.sh", import.meta.url), script);
  copyFileSync(bin, join(binDir, clientSettings.responder_name));
  const configFile = join(home, "bridge.json");
  writeFileSync(configFile, JSON.stringify(clientSettings));
  const stateName = clientSettings.state_dir_name;
  const ienv = { BRIDGE_CONFIG: configFile, PATH: `${fakeBin}:${process.env.PATH}`, HOME: home, GOONBRIDGE_URL: base, GOONBRIDGE_CLAUDE_BIN: join(fakeBin, "claude") };
  const refused = spawnSync("sh", [script], { env: ienv, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /login --device/);
  mkdirSync(join(home, stateName));
  writeFileSync(join(home, stateName, "grant.json"), "{}");
  const ok = spawnSync("sh", [script], { env: ienv, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const plist = readFileSync(join(home, `Library/LaunchAgents/${clientSettings.launchd_label}.plist`), "utf8");
  // launchd's first argument is what Login Items shows, so it is the launcher named after the product, not node and the bundle.
  const launcherName = clientSettings.product_name ?? "chimera";
  assert.ok(plist.includes(`<string>${join(home, stateName, launcherName)}</string>`), plist);
  assert.ok(!plist.includes(`${clientSettings.responder_name}</string>`), "the bundle is reached through the launcher");
  const launcher = readFileSync(join(home, stateName, launcherName), "utf8");
  assert.match(launcher, /^#!\/bin\/sh\n/);
  assert.ok(launcher.includes(join(home, stateName, clientSettings.responder_name)));
  assert.ok(statSync(join(home, stateName, launcherName)).mode & 0o100, "launcher is executable");
  assert.ok(plist.includes(`<key>GOONBRIDGE_REPOS_ROOT</key><string>${join(home, "Repo")}</string>`));
  assert.ok(plist.includes(`<key>HOME</key><string>${home}</string>`));
  assert.equal(statSync(join(home, stateName, "grant.json")).mode & 0o777, 0o600);
  assert.ok(existsSync(join(home, stateName, clientSettings.responder_name)));
  assert.match(readFileSync(calls, "utf8"), /^bootstrap gui\/\d+ /m);
  assert.equal(spawnSync("sh", [script, "--uninstall"], { env: ienv, encoding: "utf8" }).status, 0);
  assert.ok(!existsSync(join(home, `Library/LaunchAgents/${clientSettings.launchd_label}.plist`)));
});

test("the Worker serves the bundle and the installer as they are in bin/", async () => {
  for (const file of ["goonbridge-responder.mjs", "install-responder-macos.sh"]) {
    const res = await fetch(new URL(`/${file}`, base));
    assert.equal(res.status, 200, file);
    assert.equal(await res.text(), (file.endsWith(".sh") ? servedScript(file) : readFileSync(responderBin, "utf8")), file);
  }
});
