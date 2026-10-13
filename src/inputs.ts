import { BridgeError, type RevertInput, type SendInput, type SessionInput, type StatusInput, type TaskInput, type TaskQuery } from "./hub";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BridgeError("request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BridgeError("request body must be a JSON object");
  return body as Record<string, unknown>;
}

export function sendInput(args: Record<string, unknown>): SendInput {
  return { to: optString(args.to), subject: optString(args.subject), body: String(args.body ?? ""), thread_id: optInt(args.thread_id) };
}

export function sessionInput(args: Record<string, unknown>): SessionInput {
  return { session: optString(args.session), title: optString(args.title), cwd: optString(args.cwd), line: optString(args.line) };
}

export function statusInput(args: Record<string, unknown>): StatusInput {
  return { state: optString(args.state), repo: optString(args.repo), branch: optString(args.branch), summary: optString(args.summary) };
}

// For task fields: absent leaves the field alone, null or "" clears it.
function clearable(v: unknown, what: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new BridgeError(`${what} must be a string`);
  return v.trim() ? v : null;
}

function textArg(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BridgeError(`${what} must be a string`);
  return v;
}

function listArg(v: unknown, what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new BridgeError(`${what} must be a list of strings`);
}

export function taskInput(args: Record<string, unknown>): TaskInput {
  const priority = args.priority === undefined || args.priority === null ? undefined : Number(args.priority);
  const expected = args.expected_version === undefined || args.expected_version === null ? undefined : optInt(args.expected_version);
  if (expected === undefined && args.expected_version !== undefined && args.expected_version !== null) throw new BridgeError("expected_version must be an integer");
  return {
    title: textArg(args.title, "title"),
    brief: textArg(args.brief, "brief"),
    owner: textArg(args.owner, "owner"),
    assignee: clearable(args.assignee, "assignee"),
    repo: clearable(args.repo, "repo"),
    branch: clearable(args.branch, "branch"),
    pr_url: clearable(args.pr_url, "pr_url"),
    due: clearable(args.due, "due"),
    parent: clearable(args.parent, "parent"),
    kind: textArg(args.kind, "kind"),
    priority,
    labels: listArg(args.labels, "labels"),
    add_labels: listArg(args.add_labels, "add_labels"),
    remove_labels: listArg(args.remove_labels, "remove_labels"),
    state: optString(args.state),
    note: optString(args.note),
    expected_version: expected,
  };
}

export function revertInput(args: Record<string, unknown>): RevertInput {
  return { target: String(args.target ?? ""), repo: optString(args.repo), reason: optString(args.reason) };
}

export function stampInput(args: Record<string, unknown>): { merged_sha: string; deploy_state?: string } {
  return { merged_sha: String(args.merged_sha ?? ""), deploy_state: optString(args.deploy_state) };
}

export function doneInput(args: Record<string, unknown>): { summary?: string; verdict?: string; branch?: string; pr_url?: string; expected_version?: number } {
  return { summary: optString(args.summary), verdict: optString(args.verdict), branch: optString(args.branch), pr_url: optString(args.pr_url), expected_version: optInt(args.expected_version) };
}

export function queryFromArgs(args: Record<string, unknown>): TaskQuery {
  return { scope: optString(args.scope), states: listArg(args.state, "state"), repo: optString(args.repo), limit: optInt(args.limit) };
}

export function queryFromParams(params: URLSearchParams): TaskQuery {
  const limit = Number(params.get("limit"));
  return {
    scope: params.get("scope") ?? undefined,
    states: params.getAll("state").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
    repo: params.get("repo") ?? undefined,
    limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
  };
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function optInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}
