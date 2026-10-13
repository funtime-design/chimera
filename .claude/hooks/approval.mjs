#!/usr/bin/env node
// PreToolUse hook for Bash: destructive commands require the configured owner’s approval.
//
// Destructive: a push to main/master, any force push (--force, -f, --force-with-lease, +refspec, flags after the branch
// included), a remote branch delete (--delete, -d, :branch), git branch -d/-D, op item/vault delete, op vault create,
// and any wrangler ... delete. Everything else passes through untouched (the settings' allow list decides).
//
// The first try is denied and posts a request to alice on the bridge, in a new thread named after the command's hash.
// A retry is allowed once alice (the person, not a device; this session posts as alice-cloud and cannot sign as alice)
// has replied "approve" in that thread. Using an approval posts "used" in the thread, so each one runs once; the next
// identical command asks again. All state lives in the bridge thread, none on disk.
//
// This guards against mistakes, not against a session that edits its own hooks.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
let config = {};
try { config = JSON.parse(readFileSync(process.env.BRIDGE_CONFIG || join(homedir(), ".claude", "bridge.json"), "utf8")); } catch {}
const APPROVER = process.env.GOONBRIDGE_APPROVER || process.env.CHIMERA_APPROVER || config.approver || "";
const PRODUCT = config.product_name || "chimera";
const SESSION_HEADER = process.env.GOONBRIDGE_SESSION_HEADER || process.env.CHIMERA_SESSION_HEADER || config.session_header || "Goonbridge-Session";
const BRIDGE = process.env.GOONBRIDGE_URL || process.env.CHIMERA_URL || config.url || "";
// No personal defaults: without a bridge and an approver nobody can approve, so destructive commands are refused.
const UNCONFIGURED = !BRIDGE || !APPROVER;
const PROTECTED = new Set(config.protected_branches || ["main", "master"]);
const APPROVE = /^\s*approved?\b/i;
const REFUSE = /^\s*(no|deny|denied|reject|refuse|don'?t)\b/i;

// --- classification -------------------------------------------------------------------------------------------------

// Simple shell split: segments on && || ; | and newlines, words on whitespace, quotes stripped. Enough for commands
// an agent writes; anything odd errs toward matching.
export function segments(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "")))
    .filter((w) => w.length > 0);
}

// Why a command is destructive, or null. `currentBranch` answers for a bare `git push`.
export function destructive(command, currentBranch = () => null) {
  for (const words of segments(command)) {
    const why = gitReason(words, currentBranch) ?? opReason(words) ?? wranglerReason(words);
    if (why) return why;
  }
  return null;
}

function gitReason(words, currentBranch) {
  const g = words.indexOf("git");
  if (g < 0) return null;
  // Skip git's own options (-C dir, -c k=v) to the subcommand.
  let i = g + 1;
  while (i < words.length && words[i].startsWith("-")) i += words[i] === "-C" || words[i] === "-c" ? 2 : 1;
  const sub = words[i];
  const args = words.slice(i + 1);
  if (sub === "branch") {
    if (args.some((a) => a === "--delete" || /^-[a-zA-Z]*[dD]/.test(a))) return "git branch delete";
    return null;
  }
  if (sub !== "push") return null;
  const flags = args.filter((a) => a.startsWith("-"));
  const plain = args.filter((a) => !a.startsWith("-"));
  for (const f of flags) {
    if (f.startsWith("--force") || f === "--mirror" || /^-[a-zA-Z]*f/.test(f)) return `force push (${f})`;
    if (f === "--delete" || f === "--prune" || /^-[a-zA-Z]*d/.test(f)) return `branch delete (${f})`;
  }
  const refspecs = plain.slice(1); // plain[0] is the remote
  if (refspecs.length === 0) {
    const b = currentBranch();
    return b && PROTECTED.has(b) ? `push to ${b}` : null;
  }
  for (const r of refspecs) {
    if (r.startsWith("+")) return `force push (${r})`;
    if (r.startsWith(":")) return `branch delete (${r})`;
    let dst = r.includes(":") ? r.slice(r.indexOf(":") + 1) : r;
    dst = dst.replace(/^refs\/heads\//, "");
    if (dst === "HEAD") dst = currentBranch() ?? dst;
    if (PROTECTED.has(dst)) return `push to ${dst}`;
  }
  return null;
}

function opReason(words) {
  const o = words.indexOf("op");
  if (o < 0) return null;
  const [noun, verb] = words.slice(o + 1).filter((w) => !w.startsWith("-"));
  if (noun === "item" && (verb === "delete" || verb === "rm")) return "op item delete";
  if (noun === "vault" && (verb === "delete" || verb === "rm" || verb === "create")) return `op vault ${verb}`;
  return null;
}

function wranglerReason(words) {
  const w = words.indexOf("wrangler");
  return w >= 0 && words.slice(w + 1).includes("delete") ? "wrangler delete" : null;
}

// --- bridge ---------------------------------------------------------------------------------------------------------

// curl, not fetch: it honours the cloud container's HTTPS proxy.
export function bridge(method, path, body, run = execFileSync) {
  const token = process.env.GOONBRIDGE_TOKEN || process.env.CHIMERA_TOKEN || process.env[config.token_env || "GOONBRIDGE_TOKEN"] || "";
  if (/[\r\n]/.test(token)) throw new Error("invalid bridge credential");
  const input = `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n`;
  const args = ["-sS", "-m", "15", "-X", method, "--config", "-", "-H", "Content-Type: application/json"];
  if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) args.push("-H", `${SESSION_HEADER}: ${process.env.CLAUDE_CODE_REMOTE_SESSION_ID}`);
  if (body !== undefined) args.push("--data-binary", JSON.stringify(body));
  const out = run("curl", [...args, `${BRIDGE}${path}`], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const data = JSON.parse(out);
  if (data && !Array.isArray(data) && data.error) throw new Error("bridge request failed");
  return data;
}

const subjectFor = (hash) => `Approval ${hash}`;
const quoted = (command) => `\n\`\`\`\n${command}\n\`\`\`\n`;

// The decision for a destructive command, from what the bridge holds for it.
export function decide(command, why, cwd, api = bridge) {
  const hash = createHash("sha256").update(command).digest("hex").slice(0, 12);
  const me = api("GET", "/v1/me").member;
  const mine = api("GET", "/v1/threads?limit=100").filter((t) => t.subject === subjectFor(hash) && t.started_by === me);
  for (const t of mine) {
    const msgs = api("GET", `/v1/threads/${t.thread_id}`);
    // The request must quote this exact command, so an approval for one command never covers another.
    if (!msgs[0] || msgs[0].sender !== me || !msgs[0].body.includes(quoted(command))) continue;
    if (msgs.some((m) => m.sender === me && /^used\b/.test(m.body))) continue;
    // Their latest decisive reply counts: one starting "approve", or a refusal ("no", "deny", "reject", "refuse").
    // Anything else they write (a nudge, a question) neither approves nor refuses.
    const decisive = msgs.filter((m) => m.sender === APPROVER && (APPROVE.test(m.body) || REFUSE.test(m.body))).at(-1);
    if (!decisive) return { decision: "deny", reason: `Still waiting for ${APPROVER} to approve in ${PRODUCT} thread ${t.thread_id}. Retry after they reply "approve".` };
    if (APPROVE.test(decisive.body)) {
      api("POST", "/v1/send", { thread_id: t.thread_id, to: APPROVER, body: "used: running it now." });
      return { decision: "allow", reason: `Approved by ${APPROVER} in ${PRODUCT} thread ${t.thread_id}.` };
    }
    return { decision: "deny", reason: `${APPROVER} refused (thread ${t.thread_id}: "${decisive.body.slice(0, 80)}"). Do not retry unless they change their mind.` };
  }
  const sent = api("POST", "/v1/send", {
    to: APPROVER,
    subject: subjectFor(hash),
    body: `${me} wants to run a destructive command (${why}) in ${cwd}:${quoted(command)}Reply "approve" to allow it once, or anything else to refuse.`,
  });
  return { decision: "deny", reason: `Destructive command (${why}): asked ${APPROVER} in ${PRODUCT} thread ${sent.thread_id}. Retry the exact same command after they reply "approve".` };
}

// --- hook entry -----------------------------------------------------------------------------------------------------

function currentBranchIn(cwd) {
  return () => {
    try {
      return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
}

async function main() {
  if (Array.isArray(config.enabled_hooks) && !config.enabled_hooks.includes("approval")) return;
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input || "{}");
  const command = event.tool_input?.command;
  if (event.tool_name !== "Bash" || typeof command !== "string") return;
  const cwd = event.cwd || process.cwd();
  const why = destructive(command, currentBranchIn(cwd));
  if (!why) return;
  let result;
  if (UNCONFIGURED) {
    result = { decision: "deny", reason: `Destructive command (${why}) needs approval, and no bridge is configured: set CHIMERA_URL and CHIMERA_APPROVER (or GOONBRIDGE_URL and GOONBRIDGE_APPROVER), or url and approver in ~/.claude/bridge.json (BRIDGE_CONFIG).` };
  } else try {
    result = decide(command, why, cwd);
  } catch (err) {
    result = { decision: "deny", reason: `Destructive command (${why}) needs ${APPROVER}'s approval on ${PRODUCT}, and the bridge could not be reached (error details redacted).` };
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result.decision, permissionDecisionReason: result.reason } }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
