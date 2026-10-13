import { PRODUCT, OTHER, OWNER, escapeRegex } from "./harness/roles.mjs";
// The MCP endpoint: handshake, tool list, help and the stdio adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  base, ownerToken, otherToken, mcp, callTool,
} from "./helpers.mjs";

test("MCP handshake and tool list", async () => {
  const init = await mcp(ownerToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, PRODUCT);
  assert.match(init.result.instructions, new RegExp(String.raw`You are "${escapeRegex(OWNER)}"`, ""));
  const tools = (await mcp(ownerToken, "tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(tools, ["bridge_send", "bridge_inbox", "bridge_done", "bridge_thread", "bridge_threads", "bridge_help", "bridge_members", "bridge_status_set", "bridge_status", "bridge_sessions", "bridge_session_log",
    "task_create", "revert", "task_stamp", "bridge_trust", "kill", "task_list", "task_get", "task_update", "task_done", "task_report", "error_log", "error_resolve", "bridge_faults", "fire_routine"]);
});

test("bridge_help returns the guide to a connected agent", async () => {
  const help = await callTool(otherToken, "bridge_help");
  assert.match(help.content[0].text, new RegExp(String.raw`You are "${escapeRegex(OTHER)}"`, ""));
  assert.match(help.content[0].text, /Good requests/);
});

test("stdio adapter forwards to the bridge", async () => {
  const child = spawn(process.execPath, [new URL("../bin/goonbridge-mcp.mjs", import.meta.url).pathname], {
    env: { ...process.env, GOONBRIDGE_URL: base, GOONBRIDGE_TOKEN: otherToken },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bridge_members", arguments: {} } }) + "\n");
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.match(lines[1].result.content[0].text, new RegExp(String.raw`You are "${escapeRegex(OTHER)}"`, ""));
});

test("bridge_help leads with the read-first banner", async () => {
  const help = (await callTool(otherToken, "bridge_help")).content[0].text;
  assert.match(help, /^# READ THIS FIRST/);
  assert.match(help, /How the owner drives this/);
});
