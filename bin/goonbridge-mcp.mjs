#!/usr/bin/env node
// stdio MCP server that forwards every JSON-RPC message to the goonbridge Worker's /mcp endpoint.
import { createInterface } from "node:readline";

const base = process.env.GOONBRIDGE_URL;
const token = process.env.GOONBRIDGE_TOKEN;
if (!base || !token) {
  process.stderr.write("goonbridge-mcp: set GOONBRIDGE_URL and GOONBRIDGE_TOKEN\n");
  process.exit(1);
}
const endpoint = new URL("/mcp", base).toString();

let pending = Promise.resolve();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  pending = pending.then(() => forward(line));
});
rl.on("close", () => pending.then(() => process.exit(0)));

async function forward(line) {
  let id = null;
  try {
    id = JSON.parse(line).id ?? null;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: line,
    });
    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    process.stdout.write(text.trim() + "\n");
  } catch (err) {
    if (id !== null) write({ jsonrpc: "2.0", id, error: { code: -32000, message: `goonbridge unreachable: ${err.message}` } });
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
