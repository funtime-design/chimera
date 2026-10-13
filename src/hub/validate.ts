import { MAX_BODY, TASK_STATES } from "./schema.ts";

// The prefix survives the Durable Object RPC boundary, where the subclass does not.
export const BRIDGE_ERROR_PREFIX = "goonbridge: ";
export class BridgeError extends Error {
  constructor(message: string) {
    super(BRIDGE_ERROR_PREFIX + message);
  }
}

export function bridgeErrorMessage(err: unknown): string | null {
  if (err instanceof Error && err.message.startsWith(BRIDGE_ERROR_PREFIX)) return err.message.slice(BRIDGE_ERROR_PREFIX.length);
  return null;
}

// Accepts the states, "claim", and loose spellings such as "in progress" or "In-Progress".
export function stateOf(raw: string): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "claim" || TASK_STATES.includes(s)) return s;
  throw new BridgeError(`unknown state "${raw}"; states: ${TASK_STATES.join(", ")} (or claim)`);
}

export function requiredText(raw: string | undefined, max: number, what: string): string {
  const v = (raw ?? "").trim();
  if (!v) throw new BridgeError(`${what} is required`);
  if (v.length > max) throw new BridgeError(`${what} is over ${max} characters`);
  return v;
}

export function optText(raw: string | null | undefined, max: number, what: string): string | null {
  const v = (raw ?? "").trim();
  if (v.length > max) throw new BridgeError(`${what} is over ${max} characters`);
  return v || null;
}

export function checkBrief(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) throw new BridgeError("brief is required: what to do, in which repo, and how to know it is finished");
  if (new TextEncoder().encode(v).length > MAX_BODY) throw new BridgeError(`brief is over ${MAX_BODY} bytes`);
  return v;
}

export function checkPriority(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new BridgeError("priority must be 1 (highest) to 4");
  return n;
}

export function checkLabels(raw: string[]): string[] {
  const labels = [...new Set(raw.map((l) => String(l).trim()).filter(Boolean))];
  if (labels.length > 20 || labels.some((l) => l.length > 40)) throw new BridgeError("labels: up to 20, each up to 40 characters");
  return labels;
}

export function checkDue(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new BridgeError(`due must be a date like 2026-10-31, not "${v}"`);
  }
  return v;
}

export function checkUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new BridgeError(`pr_url is not a URL: "${v.slice(0, 80)}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BridgeError("pr_url must be an http(s) link");
  if (v.length > 500) throw new BridgeError("pr_url is over 500 characters");
  return v;
}
