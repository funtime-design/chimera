import { bundledConfig } from "./config/resolve";
import { hubOf, rosterOf, type Env } from "./env";
import { personOf } from "./hub/roster";
import { validSession, type Signal } from "./hub/devices";
import { onlineSeconds } from "./hub/settings";

// A cloud session names itself with two headers its .mcp.json sends: Goonbridge-Session (the session id, e.g.
// ${CLAUDE_CODE_REMOTE_SESSION_ID}) and Goonbridge-Context (the repo). Under a <person>-cloud token that makes it a
// child device with a name of its own (see hub/devices.ts). Without the headers, or under any other token, nothing changes.
// On /mcp (mcp = true) the Mcp-Session-Id the bridge hands out on initialize is the fallback: a local Claude Code window
// cannot fill Goonbridge-Session (CLAUDE_CODE_SESSION_ID is not in its own env), but its MCP client echoes that header.
// An explicit Goonbridge-Session still wins. REST (/v1) has no MCP session, so it reads Goonbridge-Session only.
export async function identify(request: Request, env: Env, member: string, mcp = false): Promise<{ member: string; members: string[]; evicted?: string }> {
  const roster = rosterOf(env);
  const session = validSession(request.headers.get("Goonbridge-Session")) ?? validSession(request.headers.get(`${bundledConfig.compatibility.headerPrefix}-Session`)) ?? (mcp ? validSession(request.headers.get("Mcp-Session-Id")) : null);
  // Any device of a person (alice-cloud, alice-laptop, a registered name) that sends a session id gets a child name, so two
  // Claude Code windows on one Mac are told apart the way two cloud sessions are. Only the person part must be on the
  // roster: a registered device is not in the env roster, but its person is.
  const parent = session && personOf(member, roster) !== null ? member : null;
  const leaving = parent !== null && (await goingOffline(request));
  const found = await hubOf(env).identify(parent, session, request.headers.get("Goonbridge-Context") ?? request.headers.get(`${bundledConfig.compatibility.headerPrefix}-Context`), roster, onlineSeconds(env) * 1000, leaving, parent ? await signalOf(request) : "call");
  // Registered devices (signed in with the person's own sign-in, no static token) are members just like roster devices.
  const members = [...new Set([...roster, ...found.registered, ...found.children])].sort();
  return { member: found.member ?? member, members, ...(found.evicted ? { evicted: found.evicted } : {}) };
}

// Which liveness signal this call is (hub/claims.ts liveness): POST /v1/heartbeat is the PostToolUse hook ("tool")
// unless it says ?signal=process (the in-run loop); an inbox read, REST or bridge_inbox, is "poll"; anything else "call".
// An MCP batch is a poll only when every call in it is bridge_inbox.
export async function signalOf(request: Request): Promise<Signal> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/heartbeat") return url.searchParams.get("signal") === "process" ? "process" : "tool";
  if (url.pathname === "/v1/inbox" && request.method === "GET") return "poll";
  if (url.pathname === "/mcp" && request.method === "POST") {
    type Call = { params?: { name?: unknown } } | null;
    const body = (await request.clone().json().catch(() => null)) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length > 0 && calls.every((c) => c?.params?.name === "bridge_inbox")) return "poll";
  }
  return "call";
}

// Is this call the session posting itself offline (POST /v1/status or the bridge_status_set tool with state offline)?
// Such a call must not first take back an orphaned claim only to release it again with a second fault.
// Parsed the way setStatus parses a state (trimmed, any case); an MCP batch counts if any call in it posts offline.
export async function goingOffline(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const path = new URL(request.url).pathname;
  if (path !== "/v1/status" && path !== "/mcp") return false;
  type Call = { state?: unknown; params?: { name?: unknown; arguments?: { state?: unknown } } } | null;
  const body = (await request.clone().json().catch(() => null)) as Call | Call[];
  const offline = (state: unknown) => String(state ?? "").trim().toLowerCase() === "offline";
  if (path === "/v1/status") return !Array.isArray(body) && offline(body?.state);
  return (Array.isArray(body) ? body : [body]).some((c) => c?.params?.name === "bridge_status_set" && offline(c.params.arguments?.state));
}
