// `claude -p` runs, tracked so stopping the responder stops them too.
import { spawn } from "node:child_process";
import { MAX_ANSWER, claudeBin, model, timeoutMs, envPrefix } from "./config.mjs";
import { firstLine } from "./log.mjs";

// Read-only: the file tools only, confined to cwd by --restricted. No Bash at all, not even an allowlist of git
// commands: `git diff a b` with both paths outside the work tree is an implicit --no-index that prints any file the
// owner can read, so a "read-only" git allowlist is a read of the whole home folder for whoever sends the message.
export const TOOLS = "Read,Grep,Glob";
export const ALLOWED = ["Read", "Grep", "Glob"];
export const DENIED = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch"];

export const children = new Set();

// Remove every bridge namespace, including local configured prefixes, before starting a session.
export const scrubbedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !["GOONBRIDGE", "CHIMERA", envPrefix].some(prefix => k.startsWith(`${prefix}_`)) && k !== "BRIDGE_CONFIG"));

// full: the owner's own ask, which may change files; every tool runs without asking.
export function runClaude(prompt, cwd, { full = false } = {}) {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--model", model,
      ...(full
        ? ["--dangerously-skip-permissions"]
        : ["--restricted", "--tools", TOOLS, "--allowedTools", ...ALLOWED, "--disallowedTools", ...DENIED, "--permission-mode", "dontAsk"]),
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format", "json",
    ];
    let child;
    try {
      child = spawn(claudeBin, args, { cwd, env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, reason: `could not start claude: ${err.message}` });
      return;
    }
    children.add(child);
    child.once("close", () => children.delete(child));
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { if (out.length < MAX_ANSWER * 2) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 4096) err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: `could not start claude: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      let result = null;
      try { result = JSON.parse(out); } catch { /* falls through to the failure below */ }
      const text = typeof result?.result === "string" ? result.result.trim() : "";
      if (code !== 0 || !text) resolve({ ok: false, reason: `claude exited ${code}`, detail: firstLine(err) });
      else resolve({ ok: true, out: text.slice(0, MAX_ANSWER) });
    });
  });
}
