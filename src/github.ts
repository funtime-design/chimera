import { deploymentDefaults } from "./deployment";
import { resolveConfig, runtimeEnv } from "./config/resolve";
import { buildReviewNotice, buildReviewWarning } from "./rules";
import { hubOf, rosterOf, type Env } from "./env";
import { reviewersMax } from "./hub/settings";
import { json } from "./http";
import type { GithubEvent, Hub, ReviewRequest } from "./hub";
import { reviewBrief, fireReviewer } from "./routines";

const MAX_PAYLOAD = 1024 * 1024;
const DEFAULT_OWNER = resolveConfig().github.owner;
const DEFAULT_DEPLOY_WORKFLOW = resolveConfig().github.deployWorkflow;

// POST /v1/github/webhook: one org-level hook on the configured owner covers every repo. GitHub cannot send a bearer, so this runs
// before auth; the HMAC over the raw body is the credential. Anything signed but not actionable answers 200 so GitHub
// never marks the delivery failed (a run of failures disables the hook).
export async function githubWebhook(request: Request, env: Env): Promise<Response> {
  env = runtimeEnv(env);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
  const secret = env.GOONBRIDGE_GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ error: `github webhook is not configured: ${deploymentDefaults.envPrefix}_GITHUB_WEBHOOK_SECRET is not set` }, 503);
  const raw = await readCapped(request, MAX_PAYLOAD);
  if (!raw) return json({ error: "payload too large" }, 413);
  if (!(await signatureOk(secret, raw, request.headers.get("X-Hub-Signature-256")))) return json({ error: "invalid signature" }, 401);

  const name = request.headers.get("X-GitHub-Event") ?? "";
  if (name === "ping") return json({ ok: true, pong: true });
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const owner = (env.GOONBRIDGE_GITHUB_OWNER || DEFAULT_OWNER).toLowerCase();
  if (String(body?.repository?.owner?.login ?? "").toLowerCase() !== owner) return json({ ignored: true, reason: `repository owner is not ${owner}` });
  const event = normalize(name, body, env.GOONBRIDGE_DEPLOY_WORKFLOW || DEFAULT_DEPLOY_WORKFLOW, env.GOONBRIDGE_DEPLOY_ENVIRONMENT || "production");
  if (!event) return json({ ignored: true, reason: `${name || "(no event)"} ${body?.action ?? ""} is not handled`.replace(/ +/g, " ") });
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!delivery) return json({ error: "missing X-GitHub-Delivery" }, 400);

  const hub = hubOf(env);
  const members = rosterOf(env);
  const { review, ...result } = await hub.githubEvent(members, delivery, event, reviewOptions(env));
  // The hub claimed this PR's one reviewer; fire it here (a fetch cannot run inside the hub's synchronous call).
  const reviewer = review ? await startReviewer(env, hub, members, review) : null;
  const out = { ...result, ...(reviewer ? { reviewer } : {}) };
  return json(out.ignored ? { ...out, ignored: true } : { ok: true, ...out });
}

// Reads the body up to `max` bytes; past that it keeps reading and discarding to the end, then returns null. Answering
// 413 with the body unread lets local workerd drop the client's kept-alive connection ("Network connection lost").
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) return null;
  const raw = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { raw.set(chunk, at); at += chunk.byteLength; }
  return raw;
}

// Auto-review: start one fresh cloud session to review the PR. A new fire is always a new session (it never joins a live
// one), and the author's name is in the brief, so the reviewer is never the session that wrote the PR. Fired through the
// same routines path as fire_routine and the cloud send; recorded with recordFire so the orphan tracker faults a reviewer
// that never boots to the task's owner (requester).
// Auto-review settings the hub needs: on unless GOONBRIDGE_AUTO_REVIEW is "off"; the per-PR cap (T-55).
export function reviewOptions(env: Env): { autoReview: boolean; maxReviewers: number } {
  return { autoReview: resolveConfig(env).github.autoReview, maxReviewers: reviewersMax(env) };
}

export async function startReviewer(env: Env, hub: DurableObjectStub<Hub>, members: string[], req: ReviewRequest): Promise<{ ok: boolean; session_id?: string; url?: string; error?: string; superseded?: boolean; warning?: string }> {
  // Only a failed dispatch frees the reservation: once a reviewer is running, a bookkeeping error below must not let the
  // next ready or re-review fire a second, paid one.
  let fired: Awaited<ReturnType<typeof fireReviewer>>;
  try {
    fired = await fireReviewer(env, req, reviewBrief(req));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await hub.reviewFailed(members, req, error).catch(() => {});
    return { ok: false, error };
  }
  try {
    // The reservation is satisfied first (session_id stamped), so a recordFire failure below cannot leave it to expire in
    // sweepReviews and let a later ready event pay for a second reviewer.
    const current = await hub.reviewFired(req, fired.session_id, fired.url);
    await hub.recordFire({ member: fired.member, requester: req.owner, message_id: 0, thread_id: req.thread_id, task_key: req.task_key, session_id: fired.session_id, url: fired.url });
    // Reported back after the reservation expired and a retry took over: on record as a fire, but not the PR's reviewer.
    if (!current) return { ok: true, superseded: true, session_id: fired.session_id, url: fired.url };
    // As system, not the cloud parent: a post from the parent would ack its unread messages in the thread (T-67).
    await hub.notice(fired.member, members, req.thread_id, buildReviewNotice(req.pr_number, fired.url, fired.session_id), req.owner).catch(() => {});
    return { ok: true, session_id: fired.session_id, url: fired.url };
  } catch (err) {
    const warning = buildReviewWarning(err instanceof Error ? err.message : String(err));
    return { ok: true, session_id: fired.session_id, url: fired.url, warning };
  }
}

// Reduces a webhook payload to what the Hub reads, or null for anything the bridge does not act on.
export function normalize(name: string, body: any, deployWorkflow: string, deployEnvironment = "production"): GithubEvent | null {
  const r = body?.repository;
  if (!r) return null;
  const repo = { full_name: String(r.full_name ?? ""), default_branch: String(r.default_branch ?? "main") };
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  if (name === "pull_request") {
    const pr = body.pull_request;
    if (!pr || typeof body.action !== "string") return null;
    return {
      kind: "pr", action: body.action, repo,
      pr: {
        number: Number(pr.number), title: str(pr.title), html_url: str(pr.html_url), draft: pr.draft === true, merged: pr.merged === true,
        merge_commit_sha: typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : null,
        merged_by: typeof pr.merged_by?.login === "string" ? pr.merged_by.login : null,
        head_ref: str(pr.head?.ref), base_ref: str(pr.base?.ref), head_sha: str(pr.head?.sha) || null,
      },
      label: str(body.label?.name) || null,
    };
  }

  if ((name === "check_suite" || name === "check_run") && body.action === "completed") {
    const c = name === "check_suite" ? body.check_suite : body.check_run;
    const suite = name === "check_suite" ? c : c?.check_suite;
    const conclusion = c?.conclusion;
    // A green single run proves nothing about the PR; only a failed run or suite, or a green suite, is acted on.
    if (conclusion !== "failure" && !(conclusion === "success" && name === "check_suite")) return null;
    const prs = (Array.isArray(c.pull_requests) ? c.pull_requests : (suite?.pull_requests ?? []))
      .filter((p: any) => typeof p?.url === "string" && Number.isFinite(Number(p.number)))
      .map((p: any) => ({ number: Number(p.number), html_url: htmlPull(p.url), title: "" }));
    return {
      kind: "check", repo, conclusion, prs,
      head_branch: str(suite?.head_branch), head_sha: str(c.head_sha), name: str(c.name) || str(c.app?.name) || name,
    };
  }

  if (name === "delete") {
    if (body.ref_type !== "branch" || typeof body.ref !== "string" || !body.ref) return null;
    return { kind: "delete", repo, ref: body.ref };
  }

  if (name === "workflow_run" && body.action === "completed") {
    const w = body.workflow_run;
    if (!w || str(w.name).toLowerCase() !== deployWorkflow.toLowerCase() || w.head_branch !== repo.default_branch) return null;
    const outcome = w.conclusion === "success" ? "success" : ["failure", "timed_out", "startup_failure"].includes(w.conclusion) ? "failure" : null;
    return outcome ? { kind: "deploy", repo, sha: str(w.head_sha), name: str(w.name), outcome, url: str(w.html_url) } : null;
  }

  if (name === "deployment_status") {
    const d = body.deployment_status;
    const outcome = d?.state === "success" ? "success" : d?.state === "failure" || d?.state === "error" ? "failure" : null;
    // Only the production environment says the merge is live; a preview or staging deploy of the same SHA does not.
    const environment = str(body.deployment?.environment) || str(d?.environment);
    if (!outcome || !body.deployment?.sha || environment.toLowerCase() !== deployEnvironment.toLowerCase()) return null;
    return { kind: "deploy", repo, sha: str(body.deployment.sha), name: `deployment ${environment}`, outcome, url: str(d.target_url) || str(d.log_url) };
  }
  return null;
}

// https://api.github.com/repos/o/r/pulls/12 -> https://github.com/o/r/pull/12
const htmlPull = (api: string) => api.replace("://api.github.com/repos/", "://github.com/").replace(/\/pulls\/(\d+)/, "/pull/$1");

async function signatureOk(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  const match = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const sig = Uint8Array.from(match[1].match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, sig, body);
}
