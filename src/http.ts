import { bridgeErrorMessage } from "./hub";
import type { Env } from "./env";

export async function withBridge(env: Env, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    const message = bridgeErrorMessage(err);
    if (message !== null) return json({ error: message }, 400);
    throw err;
  }
}

export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
