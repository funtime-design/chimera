// The log file and the text helpers that keep secrets and terminal noise out of logs and replies.
import { appendFileSync, mkdirSync } from "node:fs";
import { logFile, stateDir } from "./config.mjs";
import { currentGrant } from "./auth.mjs";

// The state folder holds the grant, so only this user may list or read it.
export const ensureStateDir = () => mkdirSync(stateDir, { recursive: true, mode: 0o700 });

export function log(line) {
  try {
    ensureStateDir();
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Logging must never stop the responder.
  }
}

export const firstLine = (s) => String(s ?? "").split("\n")[0].slice(0, 80);

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const clean = (s) => String(s ?? "").replace(ANSI, "");
// The grant's own tokens, and any long opaque string that could be a token, never reach a reply.
export const redact = (s) => {
  let out = String(s ?? "");
  const g = currentGrant();
  for (const secret of [g?.access_token, g?.refresh_token].filter((t) => t && t.length >= 16)) out = out.split(secret).join("[redacted]");
  return out.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/(^|[^A-Za-z0-9_+/=.-])([A-Za-z0-9_+=:-]{40,})(?![A-Za-z0-9_+/=.-])/g, (all, before, word) => (/^[0-9a-f]+$/i.test(word) ? all : `${before}[redacted]`));
};
