import { deploymentDefaults } from "../deployment";
import { resolveConfig } from "../config/resolve";
import { DELIVERY_KEEP_MS } from "./settings";
import type { Task } from "./schema";
import { changeTask, findTask, taskById, taskEvent } from "./tasks";
import { rolesOf } from "./state";
import { firstOf, post, type Waiters } from "./messages";
import { EXEMPT_LABELS, LABEL_BRANCH_GONE, LABEL_CI_RED, LABEL_DEPLOY_FAILED, writeTask } from "./state";

// The bridge reacting to what GitHub already did. The Worker (src/github.ts) has verified the signature and owner and
// reduced the payload to a GithubEvent; everything here (dedupe, match, update, post) runs in one Hub call, and a
// Durable Object is single-threaded with no await in between, so two deliveries cannot interleave.
// Tasks are changed as caller "github": a bridge-side actor like "system", never a roster member.

const CALLER = "github";
const CLOSED = ["done", "dropped"];
// A pull request attaches only to work that is actually in flight; backlog is not building anything.
const IN_FLIGHT = ["ready", "claimed", "in_progress", "blocked", "review"];
// Tasks of these kinds never own a PR: the matcher skips them entirely (the list lives with the state machine).
export { EXEMPT_LABELS };
export { LABEL_BRANCH_GONE, LABEL_CI_RED, LABEL_DEPLOY_FAILED };

export type Repo = { full_name: string; default_branch: string };
export type GithubEvent =
  | {
      kind: "pr";
      action: string;
      repo: Repo;
      pr: { number: number; title: string; html_url: string; draft: boolean; merged: boolean; merge_commit_sha: string | null; merged_by: string | null; head_ref: string; base_ref: string; head_sha?: string | null };
      // The label of a `labeled` event (T-55: `re-review` asks for a reviewer of the current head).
      label?: string | null;
    }
  | { kind: "check"; repo: Repo; head_branch: string; head_sha: string; name: string; conclusion: "failure" | "success"; prs: { number: number; html_url: string; title: string }[] }
  | { kind: "delete"; repo: Repo; ref: string }
  | { kind: "deploy"; repo: Repo; sha: string; name: string; outcome: "success" | "failure"; url: string };

// What the Worker needs to fire an independent reviewer for a PR head that just went up for review. Returned only when this
// call is the first to claim that head in review_fires, so asking twice for one head is impossible by construction.
export type ReviewRequest = {
  task_key: string; owner: string; thread_id: number; title: string;
  pr_url: string; pr_number: number; repo: string; branch: string; base: string;
  // The session that wrote the PR (the task's claim holder, else its last claimant, else the assignee), for the brief.
  author: string | null;
  // When the reservation was made: the dispatch reports back against it (reviewFired, reviewFailed).
  requested_at: number;
  // The PR head this reviewer looks at ("" when GitHub sent none), and the review before it on the same PR, if any (T-55).
  head_sha: string;
  previous: { head_sha: string; url: string | null; session_id: string | null } | null;
};
export type WebhookResult = { ignored?: boolean; duplicate?: boolean; reason?: string; tasks?: string[]; outcome?: string; review?: ReviewRequest };
// maxReviewers: automatic reviewers per PR, across its heads (GOONBRIDGE_REVIEWERS_MAX, default 3).
export type HandleOptions = { autoReview?: boolean; maxReviewers?: number };
export const DEFAULT_REVIEWERS_MAX = 3;
// The note phrase by which a PR's author asks for a reviewer of its new head (task_update note).
// "not ready", "not yet ready", "never ready", "isn't (yet) ready" and the like are not the signal.
export const RE_REVIEW_NOTE = /(?<!\b(?:not|never)\s+(?:yet\s+)?|n't\s+(?:yet\s+)?)\bready for re-?review\b/i;
const RE_REVIEW_LABEL = resolveConfig().labels.reReview;

export function initGithub(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)");
  // One row per PR head that has had (or is getting) an automatic reviewer: the idempotency key for auto-review. Never
  // expires, so a reopen, a re-ready or a redelivery of the same head years later still fires nothing. A new head (the PR
  // was revised) may get one more, on a ready signal, up to the cap (T-55).
  // Hubs from before T-55 keyed it by pr_url alone: the table is rebuilt once with their rows under head_sha "".
  const old = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('review_fires')").toArray();
  if (old.length > 0 && !old.some((c) => c.name === "head_sha")) sql.exec("ALTER TABLE review_fires RENAME TO review_fires_v1");
  sql.exec(`CREATE TABLE IF NOT EXISTS review_fires (pr_url TEXT NOT NULL COLLATE NOCASE, head_sha TEXT NOT NULL DEFAULT '' COLLATE NOCASE, task_key TEXT NOT NULL,
    author TEXT, requested_at INTEGER NOT NULL, session_id TEXT, url TEXT, error TEXT, PRIMARY KEY (pr_url, head_sha))`);
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_fires_v1'").toArray().length > 0) {
    sql.exec("INSERT OR IGNORE INTO review_fires (pr_url, head_sha, task_key, author, requested_at, session_id, url, error) SELECT pr_url, '', task_key, author, requested_at, session_id, url, error FROM review_fires_v1");
    sql.exec("DROP TABLE review_fires_v1");
  }
  // The last state GitHub reported for each PR a task matched: its head (a task_update "ready for re-review" note asks for
  // a reviewer of it), and the one-shot owner notices (the two-task question, the reviewer cap).
  sql.exec(`CREATE TABLE IF NOT EXISTS pull_requests (pr_url TEXT PRIMARY KEY COLLATE NOCASE, repo TEXT NOT NULL, number INTEGER NOT NULL,
    branch TEXT NOT NULL, base TEXT NOT NULL, head_sha TEXT NOT NULL DEFAULT '', draft INTEGER NOT NULL DEFAULT 0, asked_at INTEGER, capped_at INTEGER, updated_at INTEGER NOT NULL)`);
  // A deploy result for a SHA no task has merged yet (the deploy beat the merge webhook): kept until the merge arrives.
  sql.exec("CREATE TABLE IF NOT EXISTS held_deploys (sha TEXT NOT NULL COLLATE NOCASE, repo TEXT NOT NULL, outcome TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, delivery TEXT NOT NULL, received_at INTEGER NOT NULL)");
}

export function handle(sql: SqlStorage, waiters: Waiters, members: string[], delivery: string, event: GithubEvent, opts: HandleOptions = {}): WebhookResult {
  const now = Date.now();
  sql.exec("DELETE FROM webhook_deliveries WHERE received_at < ?", now - DELIVERY_KEEP_MS);
  sql.exec("DELETE FROM held_deploys WHERE received_at < ?", now - DELIVERY_KEEP_MS);
  // A redelivery reuses the delivery id; the first one wins.
  const fresh = sql.exec("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?) RETURNING delivery_id", delivery, now).toArray().length > 0;
  if (!fresh) return { duplicate: true, ignored: true, reason: "duplicate delivery" };
  const ctx = { sql, waiters, members, delivery, autoReview: opts.autoReview !== false, maxReviewers: opts.maxReviewers ?? DEFAULT_REVIEWERS_MAX };
  switch (event.kind) {
    case "pr": return pullRequest(ctx, event);
    case "check": return checkFailed(ctx, event);
    case "delete": return branchDeleted(ctx, event);
    case "deploy": return deployResult(ctx, event);
  }
}

type Ctx = { sql: SqlStorage; waiters: Waiters; members: string[]; delivery: string; autoReview: boolean; maxReviewers: number };

function say(sql: SqlStorage, waiters: Waiters, members: string[], task: Task, body: string): void {
  const subject = firstOf(sql, task.thread_id)?.subject ?? `Task ${task.key}: ${task.title}`;
  const m = post(sql, waiters, task.thread_id || null, CALLER, task.owner, subject, body, members);
  taskEvent(sql, task.id, CALLER, "comment", { message_id: m.id, to: m.recipient, note: body.slice(0, 200) });
}

const withLabel = (t: Task, add: string[], remove: string[] = []) => [...t.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !t.labels.includes(l))];

function pullRequest(c: Ctx, event: Extract<GithubEvent, { kind: "pr" }>): WebhookResult {
  const { sql, waiters, members } = c;
  // T-55: a `re-review` label on a PR that is not a draft is the same signal as ready_for_review.
  const relabel = event.action === "labeled" && event.label?.toLowerCase() === RE_REVIEW_LABEL && !event.pr.draft;
  const e = relabel ? { ...event, action: "ready_for_review" } : event;
  const pr = e.pr;
  const ref = `PR #${pr.number} (${e.repo.full_name}, ${pr.html_url})`;
  const handled = ["opened", "reopened", "ready_for_review", "synchronize", "closed"];
  if (!handled.includes(e.action)) return { ignored: true, reason: `action ${e.action}${event.label ? ` (${event.label})` : ""} is not handled` };
  const mode: Mode = e.action === "closed" && pr.merged ? "merge" : "live";
  const { tasks: matches, conflict } = matchTasks(sql, { urls: [pr.html_url], branch: pr.head_ref, title: pr.title, repo: e.repo.full_name }, e.action === "opened" || e.action === "reopened" || e.action === "ready_for_review" ? "open" : mode);
  if (conflict) {
    const named = conflict.named.map((t) => t.key).join(", ");
    const held = conflict.branch.map((t) => t.key).join(", ");
    // A push repeats every time; flag only the first events of a PR.
    if (e.action !== "synchronize") {
      for (const t of [...conflict.named, ...conflict.branch]) say(sql, waiters, members, t, `${ref} ${e.action} names ${named} (T-NN in its branch or title), but the branch field of ${held} matches instead. Changed nothing; fix the right task by hand.`);
    }
    return { tasks: [...conflict.named, ...conflict.branch].map((t) => t.key), outcome: "conflict" };
  }
  if (matches.length === 0) return { ignored: true, reason: "no task matches this pull request" };
  const keys = matches.map((t) => t.key);
  const now = Date.now();
  sql.exec(
    `INSERT INTO pull_requests (pr_url, repo, number, branch, base, head_sha, draft, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (pr_url) DO UPDATE SET branch = excluded.branch, base = excluded.base, draft = excluded.draft, updated_at = excluded.updated_at,
       head_sha = CASE WHEN excluded.head_sha != '' THEN excluded.head_sha ELSE pull_requests.head_sha END`,
    pr.html_url, e.repo.full_name, pr.number, pr.head_ref, pr.base_ref, pr.head_sha ?? "", pr.draft ? 1 : 0, now,
  );

  // T-53: one PR for several children of one epic (named in the title, by the epic's key or branch, or sharing the
  // pr_url) moves them all, one note each. Unrelated tasks change nothing; T-55: their owner gets one question per PR.
  const siblings = matches.length > 1 && matches.every((t) => t.parent !== null && t.parent === matches[0].parent);
  if (matches.length > 1 && !siblings) {
    if (sql.exec("UPDATE pull_requests SET asked_at = ? WHERE pr_url = ? AND asked_at IS NULL", now, pr.html_url).rowsWritten > 0) {
      const a = keys[0];
      for (const owner of new Set(matches.map((t) => t.owner))) {
        post(sql, waiters, null, CALLER, owner, `Which task is PR #${pr.number} for? ${keys.join(" or ")}`,
          `${ref} "${pr.title}" ${e.action}, and it names ${keys.join(", ")}, which are not one epic, so the bridge changed nothing. Which task is it for?\n` +
          `- ${a}: task_update ${a} pr_url ${pr.html_url} (the PR's url then decides; the same for ${keys.slice(1).join(", ")}).\n` +
          `- both: they are one piece of work: put them under one epic (task_update parent <epic key> on each, owner only; task_create kind epic makes one). The next event of this PR then moves all of them together.\n` +
          `- neither: take the extra keys out of the PR title.`, members);
      }
    }
    return { tasks: keys, outcome: "ambiguous" };
  }
  const results = matches.map((t) => prOne(c, e, taskById(sql, t.id), ref));
  // The merge of every task is recorded before a deploy that came first is replayed, so it reaches all of them.
  if (results.some((r) => r.stamped)) applyHeld(c, pr.merge_commit_sha);
  if (results.length === 1) return { tasks: keys, ...results[0].result };
  const outcomes = [...new Set(results.map((r) => r.result.outcome ?? "ignored"))];
  const review = results.find((r) => r.result.review)?.result.review;
  const all = results.every((r) => r.result.ignored);
  return { tasks: keys, outcome: outcomes.join(","), ...(all ? { ignored: true, reason: results.map((r) => r.result.reason).join("; ") } : {}), ...(review ? { review } : {}) };
}

// What one matched task does with a pull request event. `stamped`: a merge was recorded on it (held deploys apply).
function prOne(c: Ctx, e: Extract<GithubEvent, { kind: "pr" }>, task: Task, ref: string): { result: WebhookResult; stamped?: boolean } {
  const { sql, waiters, members } = c;
  const pr = e.pr;
  const r = (result: WebhookResult, stamped = false) => ({ result, stamped });

  if (e.action === "synchronize") {
    if (task.state !== "review") return r({ ignored: true, reason: `${task.key} is ${task.state}, not review` });
    changeTask(sql, waiters, CALLER, members, task, {
      state: "in_progress", remove_labels: [LABEL_CI_RED],
      note: `New commits were pushed to ${ref}; the earlier review is stale. Back to in_progress; it returns to review when the work is ready again.`,
    });
    return r({ outcome: "review_stale" });
  }

  if (e.action !== "closed") {
    if (CLOSED.includes(task.state)) return r({ ignored: true, reason: `${task.key} is already ${task.state}` });
    // A draft is not up for review yet: remember the PR, keep the state.
    const draft = pr.draft && e.action !== "ready_for_review";
    if (draft && task.pr_url === pr.html_url) return r({ outcome: "draft_unchanged" });
    if (!draft && task.state === "review" && task.pr_url === pr.html_url) return r({ outcome: "already_review", ...reviewOf(c, task, e) });
    changeTask(sql, waiters, CALLER, members, task, {
      ...(draft ? {} : { state: "review" }), pr_url: pr.html_url,
      note: draft ? `${ref} opened as a draft. Task state is unchanged (${task.state}).` : `${ref} ${e.action === "opened" ? "opened" : e.action}: task is now in review.`,
    });
    return r({ outcome: draft ? "draft" : "review", ...(draft ? {} : reviewOf(c, taskById(sql, task.id), e)) });
  }

  if (!pr.merged) {
    if (CLOSED.includes(task.state)) return r({ ignored: true, reason: `${task.key} is already ${task.state}` });
    if (task.state === "review") {
      changeTask(sql, waiters, CALLER, members, task, { state: "ready", remove_labels: [LABEL_CI_RED], note: `${ref} was closed unmerged. Task moved from review back to ready.` });
      return r({ outcome: "closed_unmerged_ready" });
    }
    say(sql, waiters, members, task, `${ref} was closed unmerged. Task state is unchanged (${task.state}).`);
    return r({ outcome: "closed_unmerged" });
  }

  const sha = pr.merge_commit_sha;
  const shown = sha ?? "unknown";
  if (pr.base_ref !== e.repo.default_branch) {
    say(sql, waiters, members, task, `${ref} merged into ${pr.base_ref}, not trunk (${e.repo.default_branch}), SHA ${shown}. Task state is unchanged (${task.state}).`);
    return r({ outcome: "merged_non_trunk" });
  }
  if (task.state === "dropped") return r({ ignored: true, reason: `${task.key} is dropped` });
  const by = pr.merged_by ? `, merged by ${pr.merged_by}` : "";
  const watch = sha ? "Deploy pending: it is live only when the deploy reports success." : "GitHub sent no merge SHA, so the deploy cannot be watched.";
  taskEvent(sql, task.id, CALLER, "merged", { pr: pr.number, pr_url: pr.html_url, sha: shown, base: pr.base_ref, merged_by: pr.merged_by, delivery: c.delivery });
  if (task.state === "done") {
    // A session closed it first; still record the merge so the deploy can be watched.
    if (task.merged_sha) return r({ outcome: "already_done" });
    stamp(sql, task.id, sha);
    say(sql, waiters, members, task, `${ref} merged to ${pr.base_ref}, SHA ${shown}${by}. The task was already done. ${watch}`);
    return r({ outcome: "done_already_recorded" }, true);
  }
  stamp(sql, task.id, sha);
  changeTask(sql, waiters, CALLER, members, task, {
    state: "done", pr_url: task.pr_url ?? pr.html_url, remove_labels: [LABEL_CI_RED],
    note: `${ref} merged to ${pr.base_ref}, SHA ${shown}${by}. ${watch}`,
  });
  return r({ outcome: "done" }, true);
}

// Auto-review: a PR that is up for review (not a draft) gets one independent reviewer per head. The claim on
// review_fires (pr_url, head_sha) is the guard: a redelivery, a reopen, a re-ready or a push-then-review of the same
// head all find the row and fire nothing. The Worker fires the routine afterwards (a fetch cannot run inside this call).
function reviewOf(c: Ctx, task: Task, e: Extract<GithubEvent, { kind: "pr" }>): { review?: ReviewRequest } {
  if (e.pr.draft && e.action !== "ready_for_review") return {};
  const pr = { url: e.pr.html_url, number: e.pr.number, repo: e.repo.full_name, branch: e.pr.head_ref, base: e.pr.base_ref, head: e.pr.head_sha ?? "" };
  return { review: reserveReview(c, task, pr, e.action === "ready_for_review").review };
}

type PrRef = { url: string; number: number; repo: string; branch: string; base: string; head: string };

// T-55: the first reviewer of a PR comes with any open event; a later head (the PR was revised after a review) gets one
// only on a ready signal (`ready` true: GitHub ready_for_review, a re-review label, or the author's note), never while the
// last dispatch is still unanswered, and at most `maxReviewers` per PR; past the cap the owner is told once.
function reserveReview(c: Ctx, task: Task, pr: PrRef, ready: boolean): { review?: ReviewRequest; pending?: boolean } {
  if (!c.autoReview) return {};
  const { sql } = c;
  const rows = sql.exec<{ head_sha: string; requested_at: number; session_id: string | null; url: string | null }>(
    "SELECT head_sha, requested_at, session_id, url FROM review_fires WHERE pr_url = ? ORDER BY requested_at DESC", pr.url,
  ).toArray();
  if (rows.some((r) => r.head_sha.toLowerCase() === pr.head.toLowerCase())) return {};
  const previous = rows[0] ?? null;
  // A row from before T-55 has no head: the first head seen after the upgrade is taken to be the one it reviewed, so a
  // PR already reviewed does not get a second reviewer just for the deploy.
  if (previous && previous.head_sha === "" && pr.head) {
    sql.exec("UPDATE review_fires SET head_sha = ? WHERE pr_url = ? AND head_sha = ''", pr.head, pr.url);
    return {};
  }
  if (previous && ready && previous.session_id === null) return { pending: true };
  if (previous && !ready) return {};
  if (rows.length >= c.maxReviewers) {
    if (sql.exec("UPDATE pull_requests SET capped_at = ? WHERE pr_url = ? AND capped_at IS NULL", Date.now(), pr.url).rowsWritten > 0) {
      say(sql, c.waiters, c.members, task, `AUTO-REVIEW CAP: PR #${pr.number} (${pr.url}) has had ${rows.length} reviewers (the cap is ${c.maxReviewers} reviewers per PR, ${deploymentDefaults.envPrefix}_REVIEWERS_MAX), so its new head ${pr.head.slice(0, 10) || "(unknown)"} gets none. Review it yourself, or fire a reviewer by hand.`);
    }
    return {};
  }
  const author = authorOf(sql, task);
  const requested_at = Date.now();
  sql.exec("INSERT INTO review_fires (pr_url, head_sha, task_key, author, requested_at) VALUES (?, ?, ?, ?, ?)", pr.url, pr.head, task.key, author, requested_at);
  return {
    review: {
      task_key: task.key, owner: task.owner, thread_id: task.thread_id, title: task.title, pr_url: pr.url, pr_number: pr.number, repo: pr.repo,
      branch: pr.branch, base: pr.base, author, requested_at, head_sha: pr.head,
      previous: previous ? { head_sha: previous.head_sha, url: previous.url, session_id: previous.session_id } : null,
    },
  };
}

// T-55: the PR's author (its claimant or the owner) writes "ready for re-review" in a task_update note: the task returns
// to review (as the github actor, as on ready_for_review) and the PR's current head gets a reviewer by the same rules.
export function noteReReview(sql: SqlStorage, waiters: Waiters, members: string[], caller: string, key: string, note: string | undefined, opts: HandleOptions = {}): ReviewRequest | undefined {
  if (!note || !RE_REVIEW_NOTE.test(note)) return undefined;
  const task = findTask(sql, key);
  if (!task?.pr_url || !IN_FLIGHT.includes(task.state)) return undefined;
  // Never a session for an epic (T-53): one converted from a reviewed task still has its pr_url and PR row.
  if (task.kind === "epic") return undefined;
  const roles = rolesOf(caller, task, members);
  if (!roles.includes("owner") && !roles.includes("claimant")) return undefined;
  const row = sql.exec<{ repo: string; number: number; branch: string; base: string; head_sha: string; draft: number }>(
    "SELECT repo, number, branch, base, head_sha, draft FROM pull_requests WHERE pr_url = ?", task.pr_url,
  ).toArray()[0];
  if (!row || row.draft) return undefined;
  const c: Ctx = { sql, waiters, members, delivery: "", autoReview: opts.autoReview !== false, maxReviewers: opts.maxReviewers ?? DEFAULT_REVIEWERS_MAX };
  // The move back to review is the author's own, made with its own roles; a move the state machine refuses skips quietly.
  if (task.state !== "review") {
    try {
      changeTask(sql, waiters, caller, members, task, { state: "review" });
    } catch {
      return undefined;
    }
  }
  const out = reserveReview(c, taskById(sql, task.id), { url: task.pr_url, number: row.number, repo: row.repo, branch: row.branch, base: row.base, head: row.head_sha }, true);
  if (out.pending) {
    const subject = firstOf(sql, task.thread_id)?.subject ?? `Task ${task.key}: ${task.title}`;
    post(sql, waiters, task.thread_id || null, CALLER, caller, subject, `A reviewer for PR #${row.number} is still pending (its dispatch has not reported back); ask again once it has.`, members);
  }
  return out.review;
}

// Who wrote the PR: the session holding the claim, else the last session that claimed it, else the assignee.
function authorOf(sql: SqlStorage, task: Task): string | null {
  const last = sql.exec<{ session: string }>("SELECT session FROM task_claims WHERE task_id = ? ORDER BY id DESC LIMIT 1", task.id).toArray()[0]?.session;
  return task.claim_session ?? last ?? task.assignee ?? null;
}

// The Worker's answer after trying to fire. A failed fire frees the PR (so the next reopen or ready tries again) and
// tells the owner in the task's thread; a fire that went out is remembered with its session.
// Both apply only to the reservation the dispatch was made for (`requested_at`): a dispatch that reports back after its
// reservation expired and was retried (sweepReviews) is stale, and changes nothing. Returns whether it was current.
export function reviewFired(sql: SqlStorage, req: ReviewRequest, session_id: string, url: string): boolean {
  return sql.exec("UPDATE review_fires SET session_id = ?, url = ? WHERE pr_url = ? AND requested_at = ? AND session_id IS NULL", session_id, url, req.pr_url, req.requested_at).rowsWritten > 0;
}

export function reviewFailed(sql: SqlStorage, waiters: Waiters, members: string[], req: ReviewRequest, error: string): void {
  if (sql.exec("DELETE FROM review_fires WHERE pr_url = ? AND requested_at = ?", req.pr_url, req.requested_at).rowsWritten === 0) return;
  const task = findTask(sql, req.task_key);
  if (task) say(sql, waiters, members, task, `AUTO-REVIEW NOT STARTED for PR #${req.pr_number} (${req.pr_url}): ${error}. ${task.key} is in review with no reviewer; fire one by hand, or reopen the PR to try again.`);
}

// The one place a merge is recorded. A real merge event leaves the default (pending, watched by the sweep); the admin
// stamp (src/hub/stamp.ts) passes an explicit terminal state, or null for none, so no watch starts.
export function stamp(sql: SqlStorage, id: number, sha: string | null, state: string | null | undefined = undefined): void {
  const now = Date.now();
  const deploy = state === undefined ? (sha ? "pending" : null) : state;
  writeTask(sql, id, { merged_sha: sha, merged_at: now, deploy_state: deploy, deployed_at: deploy === "live" ? now : null });
}

function checkFailed(c: Ctx, e: Extract<GithubEvent, { kind: "check" }>): WebhookResult {
  const { sql, waiters, members } = c;
  if (e.head_branch === e.repo.default_branch) return { ignored: true, reason: "checks on the default branch are not a PR" };
  const { tasks: matches, conflict } = matchTasks(sql, { urls: e.prs.map((p) => p.html_url), branch: e.head_branch, title: e.prs[0]?.title ?? "", repo: e.repo.full_name }, "live");
  if (conflict) return { ignored: true, reason: "the branch field and the T-NN in the PR disagree" };
  if (matches.length === 0) return { ignored: true, reason: "no open task matches this check" };
  const keys = matches.map((t) => t.key);
  const where = `${e.repo.full_name}@${e.head_branch} ${e.head_sha.slice(0, 7)}`;
  // Children of one epic sharing the PR (T-53) are flagged and cleared together.
  const siblings = matches.length > 1 && matches.every((t) => t.parent !== null && t.parent === matches[0].parent);
  if (e.conclusion === "success") {
    // Only a green suite (every check) clears the flag; a single green run says nothing.
    const red = matches.filter((t) => t.labels.includes(LABEL_CI_RED));
    if ((matches.length === 1 || siblings) && red.length > 0) {
      for (const t of red) changeTask(sql, waiters, CALLER, members, t, { remove_labels: [LABEL_CI_RED], note: `CI is green again on ${where}. Cleared ${LABEL_CI_RED}.` });
      return { tasks: keys, outcome: "ci_green" };
    }
    return { tasks: keys, ignored: true, reason: "green and nothing was flagged" };
  }
  if (siblings) {
    const fresh = matches.filter((t) => !t.labels.includes(LABEL_CI_RED));
    for (const t of fresh) changeTask(sql, waiters, CALLER, members, t, { add_labels: [LABEL_CI_RED], note: `CI FAILED (${e.name}) on ${where}. Flagged ${LABEL_CI_RED}; it clears when CI passes or new commits arrive.` });
    return { tasks: keys, outcome: fresh.length ? "ci_red" : "already_ci_red" };
  }
  if (matches.length > 1) {
    for (const t of matches) say(sql, waiters, members, t, `CI FAILED on ${where}, but it matches ${keys.join(", ")}. Changed nothing; check the right task by hand.`);
    return { tasks: keys, outcome: "ambiguous" };
  }
  const task = matches[0];
  // Many check runs fail together; flag and tell once.
  if (task.labels.includes(LABEL_CI_RED)) return { tasks: keys, outcome: "already_ci_red" };
  changeTask(sql, waiters, CALLER, members, task, {
    add_labels: [LABEL_CI_RED],
    note: `CI FAILED (${e.name}) on ${where}${task.state === "review" ? ". The PR is red: do not review it as green" : ""}. Flagged ${LABEL_CI_RED}; it clears when CI passes or new commits arrive.`,
  });
  return { tasks: keys, outcome: "ci_red" };
}

function branchDeleted(c: Ctx, e: Extract<GithubEvent, { kind: "delete" }>): WebhookResult {
  const { sql, waiters, members } = c;
  const { tasks: matches, conflict } = matchTasks(sql, { urls: [], branch: e.ref, title: "", repo: e.repo.full_name }, "any");
  if (conflict) return { ignored: true, reason: "the branch field and the T-NN in the branch name disagree" };
  if (matches.length === 0) return { ignored: true, reason: "no task matches this branch" };
  const keys = matches.map((t) => t.key);
  if (matches.length > 1) {
    for (const t of matches) say(sql, waiters, members, t, `Branch ${e.ref} of ${e.repo.full_name} was deleted, but it matches ${keys.join(", ")}. Changed nothing.`);
    return { tasks: keys, outcome: "ambiguous" };
  }
  const task = matches[0];
  if (task.labels.includes(LABEL_BRANCH_GONE)) return { tasks: keys, outcome: "already_gone" };
  // The cleanup after a merge deletes many branches of finished tasks: label those quietly, tell the owner only for open work.
  const closed = CLOSED.includes(task.state);
  changeTask(sql, waiters, CALLER, members, task, {
    add_labels: [LABEL_BRANCH_GONE],
    ...(closed ? {} : { note: `Branch ${e.ref} of ${e.repo.full_name} was deleted while ${task.key} is ${task.state}. Marked ${LABEL_BRANCH_GONE}; the task is closable if the work is finished.` }),
  });
  return { tasks: keys, outcome: closed ? "branch_gone_quiet" : "branch_gone" };
}

// The deploy workflow (or a deployment status) reported on a commit. Live only on success.
function deployResult(c: Ctx, e: Extract<GithubEvent, { kind: "deploy" }>): WebhookResult {
  const { sql, waiters, members } = c;
  const repo = lastSegment(e.repo.full_name);
  const tasks = sql.exec<{ id: number }>("SELECT id FROM tasks WHERE merged_sha = ? COLLATE NOCASE AND deploy_state IS NOT NULL", e.sha).toArray()
    .map((r) => taskById(sql, r.id)).filter((t) => lastSegment(t.repo) === repo || t.repo === null);
  if (tasks.length === 0) {
    // Its delivery id is already spent, so a redelivery would be a duplicate: hold it for the merge instead of dropping it.
    sql.exec("INSERT INTO held_deploys (sha, repo, outcome, name, url, delivery, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)", e.sha, e.repo.full_name, e.outcome, e.name, e.url, c.delivery, Date.now());
    return { ignored: true, reason: "no merged task has this SHA yet; held until its merge arrives" };
  }
  const keys = tasks.map((t) => t.key);
  const now = Date.now();
  let changed = false;
  for (const task of tasks) {
    if (e.outcome === "success" && task.deploy_state !== "live") {
      writeTask(sql, task.id, { deploy_state: "live", deployed_at: now, labels: withLabel(task, [], [LABEL_DEPLOY_FAILED]) });
      taskEvent(sql, task.id, CALLER, "deployed", { sha: e.sha, workflow: e.name, url: e.url, delivery: c.delivery });
      say(sql, waiters, members, task, `DEPLOYED AND LIVE: ${task.key} (merge ${e.sha.slice(0, 10)}) deployed by ${e.name} on ${e.repo.full_name}. ${e.url}`);
      changed = true;
    } else if (e.outcome === "failure" && (task.deploy_state === "pending" || task.deploy_state === "not_seen")) {
      writeTask(sql, task.id, { deploy_state: "failed", labels: withLabel(task, [LABEL_DEPLOY_FAILED]) });
      taskEvent(sql, task.id, CALLER, "deploy_failed", { sha: e.sha, workflow: e.name, url: e.url, delivery: c.delivery });
      say(sql, waiters, members, task, `MERGED BUT DEPLOY FAILED: ${task.key} (merge ${e.sha.slice(0, 10)}) is on trunk of ${e.repo.full_name} but ${e.name} failed, so it is NOT live. ${e.url} Fix forward, re-run the deploy, or ask for a revert (revert ${task.key}).`);
      changed = true;
    }
  }
  return { tasks: keys, outcome: changed ? (e.outcome === "success" ? "live" : "deploy_failed") : "deploy_no_change" };
}

// The merge of `sha` just landed: replay any deploy result that came first, oldest first.
function applyHeld(c: Ctx, sha: string | null): void {
  if (!sha) return;
  const rows = c.sql.exec<{ repo: string; outcome: "success" | "failure"; name: string; url: string; delivery: string; received_at: number }>(
    "DELETE FROM held_deploys WHERE sha = ? RETURNING repo, outcome, name, url, delivery, received_at", sha,
  ).toArray().sort((a, b) => a.received_at - b.received_at);
  for (const r of rows) deployResult({ ...c, delivery: r.delivery }, { kind: "deploy", repo: { full_name: r.repo, default_branch: "" }, sha, name: r.name, outcome: r.outcome, url: r.url });
}

// Merged tasks whose deploy has not reported inside the timeout: loud, never silent. Runs on the Hub alarm.
// T-69: a reviewer reservation is committed before the Worker fires (reviewOf). One whose dispatch never reported back
// within `expiryMs` (the Worker died between the two; a live fire gives up after 20 s and reports a failure) is given
// up: the row goes, so the next open, reopen or ready of the PR fires again, and the owner is told.
export function sweepReviews(sql: SqlStorage, waiters: Waiters, expiryMs: number): void {
  const stale = sql.exec<{ pr_url: string; head_sha: string; task_key: string }>("SELECT pr_url, head_sha, task_key FROM review_fires WHERE session_id IS NULL AND requested_at <= ?", Date.now() - expiryMs).toArray();
  for (const r of stale) {
    sql.exec("DELETE FROM review_fires WHERE pr_url = ? AND head_sha = ?", r.pr_url, r.head_sha);
    const task = findTask(sql, r.task_key);
    if (task) say(sql, waiters, [], task, `AUTO-REVIEW NOT STARTED for PR #${/\/pull\/(\d+)/.exec(r.pr_url)?.[1] ?? "?"} (${r.pr_url}): the reviewer dispatch did not report back within ${Math.round(expiryMs / 1000)}s. A reviewer may or may not be running; reopen the PR or mark it ready to try again.`);
  }
}

export function sweepDeploys(sql: SqlStorage, waiters: Waiters, timeoutMs: number): string[] {
  const rows = sql.exec<{ id: number }>("SELECT id FROM tasks WHERE deploy_state = 'pending' AND COALESCE(merged_at, 0) <= ?", Date.now() - timeoutMs).toArray();
  const keys: string[] = [];
  for (const r of rows) {
    const task = taskById(sql, r.id);
    writeTask(sql, task.id, { deploy_state: "not_seen", labels: withLabel(task, [LABEL_DEPLOY_FAILED]) });
    taskEvent(sql, task.id, CALLER, "deploy_not_seen", { sha: task.merged_sha, waited_ms: timeoutMs });
    say(sql, waiters, [], task, `MERGED BUT DEPLOY NOT SEEN: ${task.key} (merge ${task.merged_sha?.slice(0, 10)}) was merged to trunk ${Math.round(timeoutMs / 60000)} minutes ago and no deploy has reported. It is NOT known to be live. Check the Deploy workflow, or ask for a revert (revert ${task.key}).`);
    keys.push(task.key);
  }
  return keys;
}

const lastSegment = (v: string | null) => (v ?? "").trim().toLowerCase().split("/").filter(Boolean).pop() ?? "";

type Probe = { urls: string[]; branch: string; title: string; repo: string };
// What the event may attach to. open: a PR opened/reopened/ready. live: a push, a check, an unmerged close.
// merge: a merge also records itself on a task a session already closed without a merge. any: a branch delete.
export type Mode = "open" | "live" | "merge" | "any";
export type Match = { tasks: Task[]; conflict: { named: Task[]; branch: Task[] } | null };

const exempt = (t: Task) => t.labels.some((l) => EXEMPT_LABELS.includes(l.toLowerCase()));
const closedWithoutMerge = (t: Task) => t.state === "done" && !t.merged_sha;

// One resolver for every handler. Tasks that cannot own the event are dropped first (exempt kinds, wrong state), so a
// stale or closed task never counts toward ambiguity. Then: pr_url (unique) decides; else repo + branch (case-insensitive,
// last path segment of the repo, since tasks store "goonbridge" and "the configured owner/goonbridge" alike), but an explicit T-NN in
// the branch or title outranks the branch field: if they disagree nothing is matched and the conflict is returned.
export function matchTasks(sql: SqlStorage, probe: Probe, mode: Mode): Match {
  const load = (rows: { key: string }[]) => rows.map((r) => findTask(sql, r.key)).filter((t): t is Task => t !== null);
  const repo = lastSegment(probe.repo);
  const allowed = (t: Task) => !exempt(t) && (mode === "any" || IN_FLIGHT.includes(t.state) || (mode === "merge" && closedWithoutMerge(t)));
  // T-53: an epic never owns a PR; naming it (its key, or its branch epic/<slug>) names its children.
  const children = (ts: Task[]) => ts.flatMap((t) => t.kind !== "epic" ? [t]
    : load(sql.exec<{ key: string }>("SELECT key FROM tasks WHERE parent = ? ORDER BY id", t.key).toArray()));
  const keep = (ts: Task[]) => {
    const a = children(ts).filter(allowed);
    // A reused branch: the open task is the live one; closed ones only count when nothing open does.
    return mode === "any" && a.some((t) => !CLOSED.includes(t.state)) ? a.filter((t) => !CLOSED.includes(t.state)) : a;
  };

  for (const url of probe.urls.filter(Boolean)) {
    const byUrl = keep(load(sql.exec<{ key: string }>("SELECT key FROM tasks WHERE pr_url = ? COLLATE NOCASE", url).toArray()));
    if (byUrl.length > 0) return { tasks: byUrl, conflict: null };
  }
  const tokens = new Set<string>();
  for (const m of `${probe.branch} ${probe.title}`.matchAll(/(?<![A-Za-z0-9])T-(\d+)(?!\d)/gi)) tokens.add(m[1]);
  const named = children([...tokens].map((n) => findTask(sql, `T-${n}`)).filter((t): t is Task => t !== null))
    .filter((t, i, all) => (t.repo === null || lastSegment(t.repo) === repo) && all.findIndex((x) => x.id === t.id) === i);
  // Named tasks that could be the owner of this PR; a mention of a closed or exempt task (a revert, an audit) names no owner.
  const owners = named.filter((t) => !exempt(t) && (!CLOSED.includes(t.state) || (mode === "merge" && closedWithoutMerge(t))));

  const byBranch = probe.branch
    ? keep(load(sql.exec<{ key: string }>("SELECT key FROM tasks WHERE branch = ? COLLATE NOCASE", probe.branch).toArray()).filter((t) => lastSegment(t.repo) === repo))
    : [];
  if (byBranch.length > 0) {
    if (owners.length === 0) return { tasks: byBranch, conflict: null };
    const agreed = byBranch.filter((t) => owners.some((o) => o.id === t.id));
    if (agreed.length > 0) return { tasks: agreed, conflict: null };
    return { tasks: [], conflict: { named: owners, branch: byBranch } };
  }
  return { tasks: keep(named), conflict: null };
}
