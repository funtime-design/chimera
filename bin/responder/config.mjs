// Settings read once from the environment; every module imports them from here. Nothing here needs a grant, so `login`
// can run before one exists.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import deployment from '../../src/config/deployment.ts';
const home = homedir();
let bridge = {};
try { bridge = JSON.parse(readFileSync(process.env.BRIDGE_CONFIG || join(home, ".claude", "bridge.json"), "utf8")); } catch {}
const setting = (name) => process.env['GOONBRIDGE_' + name] || process.env['CHIMERA_' + name];
export const envPrefix = bridge.env_prefix || deployment.compatibility.envPrefix;
export const base = setting("URL") || bridge.url || deployment.deployment.origin;
export const stateDir = setting("STATE_DIR") || join(home, bridge.state_dir_name || deployment.clients.stateDirName);
export const grantFile = join(stateDir, "grant.json");
export const logFile = join(stateDir, "responder.log");
export const reposRoot = setting("REPOS_ROOT") || join(home, "Repo");
export const defaultRepo = setting("DEFAULT_REPO") || "";
export const model = setting("RESPONDER_MODEL") || "sonnet";
export const claudeBin = setting("CLAUDE_BIN") || "claude";
export const timeoutMs = (Number(setting("RESPONDER_TIMEOUT_SECONDS")) || 15 * 60) * 1000;
export const HEARTBEAT_MS = 60 * 1000;
export const MAX_ANSWER = 60 * 1024;
