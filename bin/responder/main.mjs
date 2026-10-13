import { buildResponderPrompt } from "../../src/rules.ts";
import { deploymentDefaults } from "../../src/deployment.ts";
// goonbridge-responder: answers goonbridge messages sent to this Mac's device with a fresh `claude -p` run in the repo the
// message names. `login --device <name>` signs the device in once (a phone approves); `run` (the default) is the daemon.
// Sources for bin/goonbridge-responder.mjs: `pnpm build:responder` bundles them into that one file, which the Worker serves.
import { relative } from "node:path";
import { HEARTBEAT_MS, model, reposRoot } from "./config.mjs";
import { ensureStateDir, firstLine, log } from "./log.mjs";
import { login } from "./auth.mjs";
import { api, postStatus, reply } from "./api.mjs";
import { children, runClaude } from "./claude.mjs";
import { ensureSince, markHandled, markThread, triage, wasHandled } from "./handled.mjs";
import { repoFor } from "./repos.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const personOf = (name) => name.split("-")[0];
// Every thread this responder answers in is remembered (before the send), so it can tell its own threads from those of
// other clients of this device.
// A marker that cannot be written (disk full) is logged; the answer is still sent.
const replyAs = async (m, body) => {
  try { markThread(m.thread_id); } catch (err) { log(`could not mark thread ${m.thread_id}: ${err.message}`); }
  await reply(m, body);
};

const promptFor = (me, m, repo, full) => buildResponderPrompt(deploymentDefaults, me, m, repo, full);

async function answer(me, self, m) {
  const repo = repoFor(`${m.subject ?? ""}\n${m.body}`);
  const where = relative(reposRoot, repo) || ".";
  // Full permissions only for exactly the owner's person or a person the owner trusts on this device (T-41); anyone else,
  // including the owner's other devices and a trusted person's devices or cloud children, gets read-only. The trust list
  // is read again for every message, so a revoke applies to the next one without a restart. A failed read throws, and
  // the message is answered with the error rather than run in any mode.
  const full = m.sender === self.person ? "owner" : (self.trusted ?? []).includes(m.sender) ? "trusted" : null;
  log(`message ${m.id}: ${full ? `full mode for ${m.sender} (${full})` : `read-only for ${m.sender}`}`);
  await postStatus({ state: "working", repo: where, summary: `answering ${m.sender} (thread ${m.thread_id})` });
  const started = Date.now();
  const result = await runClaude(promptFor(me, m, repo, full), repo, { full: full !== null });
  log(`message ${m.id}: ${result.ok ? "answered" : `failed, ${result.reason}${result.detail ? ` (${result.detail})` : ""}`} in ${where}${full ? " (full)" : ""} after ${Math.round((Date.now() - started) / 1000)}s`);
  await replyAs(m, result.ok ? result.out : `${me} could not answer this (${result.reason}). Ask again, or ask ${personOf(me)} directly.`);
  await postStatus({ state: "idle", summary: "waiting for messages" });
}

async function handle(me, m) {
  log(`message ${m.id} thread ${m.thread_id} from ${m.sender}: ${firstLine(m.subject)}`);
  if (wasHandled(m.id)) {
    await api("POST", "/v1/done", { message_id: m.id });
    log(`message ${m.id}: already handled, marked done`);
    return;
  }
  // Read per message, so a device registered or a person trusted after start is seen without a restart.
  const self = await api("GET", "/v1/me");
  const kind = await triage(me, self, m);
  if (kind === "not-mine") {
    await api("POST", "/v1/done", { message_id: m.id });
    log(`message ${m.id}: reply from ${m.sender} in a thread I never answered in, marked done`);
  } else if (kind === "reply-to-me") {
    await api("POST", "/v1/done", { message_id: m.id });
    log(`message ${m.id}: reply from a device to my answer, marked done`);
  } else {
    await answer(me, self, m);
  }
  // Only once the work is done: a crash before this leaves the message to come back after its claim and be done again.
  // A failed write must not turn a finished answer into a second "hit an error" reply.
  try { markHandled(m.id); } catch (err) { log(`message ${m.id}: could not record as handled, ${err.message}`); }
}

async function run(once) {
  const me = await api("GET", "/v1/me");
  ensureSince();
  log(`started as ${me.member}, model ${model}, repos ${reposRoot}`);
  await postStatus({ state: "idle", summary: "waiting for messages" });
  const heartbeat = setInterval(() => postStatus(), HEARTBEAT_MS);
  const stop = async (signal) => {
    clearInterval(heartbeat);
    log(`stopping on ${signal}${children.size ? `, stopping ${children.size} claude run(s)` : ""}`);
    for (const child of children) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
    await postStatus({ state: "offline", summary: "responder stopped" });
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  let backoff = 5000;
  for (;;) {
    try {
      const messages = await api("GET", `/v1/inbox?wait=${once ? 0 : deploymentDefaults.timing.waitSeconds}`);
      backoff = 5000;
      for (const m of messages) {
        try {
          await handle(me.member, m);
        } catch (err) {
          // One bad message must not stall the rest or come back forever: it is answered with the failure and marked done.
          if (err.message.startsWith("signed out")) throw err;
          // The answer was made but neither sent nor marked done: no error reply (it would replace the answer) and no
          // done, so the message comes back after its claim and is answered again.
          if (err.undelivered) { log(`message ${m.id}: answer not delivered, left for redelivery (${firstLine(err.message)})`); continue; }
          log(`message ${m.id}: failed, ${firstLine(err.message)}`);
          await replyAs(m, `${me.member} hit an error on this message (${firstLine(err.message)}). Send it again or ask ${personOf(me.member)}.`).catch(() => {});
          await api("POST", "/v1/done", { message_id: m.id }).catch(() => {});
        }
      }
    } catch (err) {
      // A lost grant does not heal by waiting: stop, so launchd's log and the board show it.
      if (err.message.startsWith("signed out")) throw err;
      log(`poll failed: ${err.message}`);
      if (once) throw err;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
    if (once) break;
  }
  clearInterval(heartbeat);
}

async function main() {
  ensureStateDir();
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  if (command === "login") {
    // The reader may stop listening after the code line (a script, a test); later writes must not crash the login.
    process.stdout.on("error", () => {});
    const json = flag("--json");
    await login({
      device: option("--device"),
      say: {
        code: (s) => process.stdout.write(json
          ? `${JSON.stringify({ user_code: s.user_code, verification_uri: s.verification_uri, verification_uri_complete: s.verification_uri_complete, expires_in: s.expires_in })}\n`
          : `Open ${s.verification_uri_complete} on your phone and approve code ${s.user_code}.\nWaiting (the code expires in ${Math.round(s.expires_in / 60)} minutes)...\n`),
        done: (device, file) => process.stderr.write(`Signed in as ${device}. Grant saved in ${file}.\n`),
      },
    });
    return;
  }
  if (command === "run") return run(flag("--once"));
  throw new Error(`unknown command ${command}; use: login --device <name> [--json] | run [--once]`);
}

main().then(() => process.exit(0), (err) => {
  log(`fatal: ${err.message}`);
  process.stderr.write(`${deploymentDefaults.responderCommand}: ${err.message}\n`);
  process.exit(1);
});
