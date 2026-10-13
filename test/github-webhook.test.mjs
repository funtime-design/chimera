import { GITHUB_OWNER, ORIGIN, OWNER, OWNER_CLOUD } from "./harness/roles.mjs";
// GitHub webhook: POST /v1/github/webhook keeps tasks in step with GitHub, and POST /v1/revert asks for a manual revert.
// Needs GOONBRIDGE_GITHUB_WEBHOOK_SECRET=test-webhook-secret and GOONBRIDGE_DEPLOY_SECONDS=3 in .dev.vars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { devVars,  base, ownerToken, otherToken, rest, sleep, drain  } from "./helpers.mjs";

const SECRET = (devVars.GOONBRIDGE_GITHUB_WEBHOOK_SECRET ?? "test-webhook-secret");
const repoName = `hook${Date.now()}`;
const SHA = "abc123def4567890abc123def4567890abc12345";
const sign = (raw, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

async function hook(payload, { event = "pull_request", delivery = randomUUID(), signature, raw } = {}) {
  const text = raw ?? JSON.stringify(payload);
  const headers = { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": delivery };
  if (signature !== null) headers["X-Hub-Signature-256"] = signature ?? sign(text);
  const res = await fetch(new URL("/v1/github/webhook", base), { method: "POST", headers, body: text });
  return { status: res.status, body: await res.json() };
}

const repository = (owner = GITHUB_OWNER, repo = repoName) => ({ full_name: `${owner}/${repo}`, default_branch: "main", owner: { login: owner } });
let n = 100;
function pr({ branch, base = "main", merged = false, action = "closed", title = "A change", url, sha = SHA, draft = false, number, owner, repo } = {}) {
  number ??= ++n;
  return {
    action, repository: repository(owner, repo),
    pull_request: {
      number, title, draft, html_url: url ?? `https://github.com/${owner ?? GITHUB_OWNER}/${repo ?? repoName}/pull/${number}`, merged,
      merge_commit_sha: merged ? sha : null, merged_by: merged ? { login: OWNER } : null, head: { ref: branch }, base: { ref: base },
    },
  };
}

async function makeTask(fields) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, brief: "Do it.", title: "Webhook task", repo: `${GITHUB_OWNER}/${repoName}`, ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;
const notes = async (task) => (await rest(ownerToken, "GET", `/v1/threads/${task.thread_id}`)).body;
const lastNote = async (task) => (await notes(task)).at(-1);
const uniq = (p) => `${p}-${randomUUID().slice(0, 8)}`;

test("unsigned and badly signed deliveries are rejected; a good ping answers 200", async () => {
  const p = pr({ branch: "x" });
  assert.equal((await hook(p, { signature: null })).status, 401);
  assert.equal((await hook(p, { signature: sign(JSON.stringify(p), "wrong") })).status, 401);
  assert.equal((await hook(p, { signature: "sha256=zz" })).status, 401);
  assert.equal((await hook(p, { signature: sign("other body") })).status, 401);
  const ping = await hook({ zen: "hi" }, { event: "ping" });
  assert.equal(ping.status, 200);
  assert.equal((await hook({}, { event: "ping", signature: "sha256=" + "0".repeat(64) })).status, 401);
});

test("unknown events, foreign owners and unhandled actions answer 200 ignored; oversize is refused", async () => {
  assert.deepEqual((await hook({ repository: repository() }, { event: "star" })).body.ignored, true);
  const foreign = await hook(pr({ branch: "x", owner: "someoneelse", merged: true }));
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.ignored, true);
  const odd = await hook(pr({ branch: "x", action: "labeled" }));
  assert.equal(odd.status, 200);
  assert.equal(odd.body.ignored, true);
  const big = await hook(null, { raw: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }) });
  assert.equal(big.status, 413);
});

test("merge to trunk: task done, SHA in the thread, closed by github, deploy pending; redelivery is a no-op", async () => {
  const branch = uniq("claude/merge");
  const task = await makeTask({ branch, state: "review" });
  const delivery = randomUUID();
  const p = pr({ branch, merged: true });
  const first = await hook(p, { delivery });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, "done");
  const t = (await get(task.key)).task;
  assert.equal(t.state, "done");
  assert.equal(t.closed_by, "github");
  assert.equal(t.merged_sha, SHA);
  assert.equal(t.deploy_state, "pending");
  assert.match(t.pr_url, /\/pull\/\d+$/);
  const before = (await notes(task)).length;
  const note = await lastNote(task);
  assert.match(note.body, new RegExp(`PR #${p.pull_request.number}.*merged to main, SHA ${SHA}`));
  assert.equal(note.recipient, OWNER);
  const again = await hook(p, { delivery });
  assert.equal(again.body.duplicate, true);
  assert.equal((await notes(task)).length, before);
});

test("merge into a non-trunk base is a note only", async () => {
  const branch = uniq("claude/stack");
  const task = await makeTask({ branch, state: "review" });
  const res = await hook(pr({ branch, base: "claude/other", merged: true }));
  assert.equal(res.body.outcome, "merged_non_trunk");
  assert.equal((await get(task.key)).task.state, "review");
  assert.match((await lastNote(task)).body, /not trunk/);
});

test("opened sets review and the PR url; a draft keeps the state; closed unmerged returns review to ready", async () => {
  const branch = uniq("claude/open");
  const task = await makeTask({ branch, state: "in_progress" });
  const p = pr({ branch, action: "opened" });
  assert.equal((await hook(p)).body.outcome, "review");
  let t = (await get(task.key)).task;
  assert.equal(t.state, "review");
  assert.equal(t.pr_url, p.pull_request.html_url);
  const closed = await hook(pr({ branch, action: "closed", url: p.pull_request.html_url, number: p.pull_request.number }));
  assert.equal(closed.body.outcome, "closed_unmerged_ready");
  assert.equal((await get(task.key)).task.state, "ready");

  const b2 = uniq("claude/draft");
  const t2 = await makeTask({ branch: b2, state: "in_progress" });
  assert.equal((await hook(pr({ branch: b2, action: "opened", draft: true }))).body.outcome, "draft");
  t = (await get(t2.key)).task;
  assert.equal(t.state, "in_progress");
  assert.ok(t.pr_url);
});

test("closed unmerged on a task that is not in review is a note only", async () => {
  const branch = uniq("claude/abandon");
  const task = await makeTask({ branch, state: "in_progress" });
  assert.equal((await hook(pr({ branch }))).body.outcome, "closed_unmerged");
  assert.equal((await get(task.key)).task.state, "in_progress");
});

test("red CI flags the task; new commits bump review to in_progress and clear the flag", async () => {
  const branch = uniq("claude/red");
  const task = await makeTask({ branch, state: "review" });
  const suite = (conclusion) => ({
    action: "completed", repository: repository(),
    check_suite: { conclusion, head_branch: branch, head_sha: SHA, pull_requests: [] },
  });
  assert.equal((await hook(suite("failure"), { event: "check_suite" })).body.outcome, "ci_red");
  let t = (await get(task.key)).task;
  assert.ok(t.labels.includes("ci-red"));
  assert.equal(t.state, "review");
  assert.match((await lastNote(task)).body, /CI FAILED/);
  // The next failing run does not repeat the note.
  const count = (await notes(task)).length;
  const run = { action: "completed", repository: repository(), check_run: { conclusion: "failure", name: "build", head_sha: SHA, check_suite: { head_branch: branch }, pull_requests: [] } };
  assert.equal((await hook(run, { event: "check_run" })).body.outcome, "already_ci_red");
  assert.equal((await notes(task)).length, count);
  // A green suite clears it.
  assert.equal((await hook(suite("success"), { event: "check_suite" })).body.outcome, "ci_green");
  assert.ok(!(await get(task.key)).task.labels.includes("ci-red"));

  await hook(suite("failure"), { event: "check_suite" });
  const sync = await hook(pr({ branch, action: "synchronize" }));
  assert.equal(sync.body.outcome, "review_stale");
  t = (await get(task.key)).task;
  assert.equal(t.state, "in_progress");
  assert.ok(!t.labels.includes("ci-red"));
  // A push to a PR that is no longer in review changes nothing.
  assert.equal((await hook(pr({ branch, action: "synchronize" }))).body.ignored, true);
});

test("branch delete marks the task's branch gone", async () => {
  const branch = uniq("claude/gone");
  const open = await makeTask({ branch, state: "in_progress" });
  const del = (ref, ref_type = "branch") => ({ ref, ref_type, repository: repository() });
  assert.equal((await hook(del(branch, "tag"), { event: "delete" })).body.ignored, true);
  assert.equal((await hook(del(branch), { event: "delete" })).body.outcome, "branch_gone");
  assert.ok((await get(open.key)).task.labels.includes("branch-gone"));
  assert.match((await lastNote(open)).body, /closable/);
  // A finished task is labelled quietly.
  const b2 = uniq("claude/gone-done");
  const done = await makeTask({ branch: b2, state: "done" });
  const before = (await notes(done)).length;
  assert.equal((await hook(del(b2), { event: "delete" })).body.outcome, "branch_gone_quiet");
  assert.ok((await get(done.key)).task.labels.includes("branch-gone"));
  assert.equal((await notes(done)).length, before);
  assert.equal((await hook(del("claude/nobody"), { event: "delete" })).body.ignored, true);
});

test("matching: pr_url first, then repo+branch (repo name normalized), then a T-NN token; no match is ignored", async () => {
  const branch = uniq("claude/match");
  const byBranch = await makeTask({ branch, repo: repoName.toUpperCase(), state: "review" });
  assert.equal((await hook(pr({ branch, merged: true }))).body.tasks[0], byBranch.key);

  // pr_url wins over a branch that another task has.
  const url = `https://github.com/${GITHUB_OWNER}/${repoName}/pull/9${n}`;
  const urlTask = await makeTask({ pr_url: url, state: "review" });
  const branchTask = await makeTask({ branch: uniq("claude/other"), state: "review" });
  const res = await hook(pr({ branch: branchTask.branch ?? "none", url, merged: true }));
  assert.deepEqual(res.body.tasks, [urlTask.key]);
  assert.equal((await get(branchTask.key)).task.state, "review");

  const token = await makeTask({ state: "review" });
  const viaToken = await hook(pr({ branch: `claude/${token.key}-thing`, merged: true, title: "no token here" }));
  assert.deepEqual(viaToken.body.tasks, [token.key]);
  const viaTitle = await makeTask({ state: "review" });
  assert.deepEqual((await hook(pr({ branch: uniq("claude/x"), merged: true, title: `${viaTitle.key}: fix` }))).body.tasks, [viaTitle.key]);

  // The same T-NN in a different repo is not a match.
  const elsewhere = await makeTask({ state: "review", repo: `${GITHUB_OWNER}/unrelated` });
  assert.equal((await hook(pr({ branch: `claude/${elsewhere.key}`, merged: true }))).body.ignored, true);
  assert.equal((await get(elsewhere.key)).task.state, "review");

  const none = await hook(pr({ branch: uniq("claude/nothing"), merged: true }));
  assert.equal(none.status, 200);
  assert.equal(none.body.ignored, true);
});

test("two unrelated tasks named in one PR title: nothing changes, the owner gets one question naming both, once per PR", async () => {
  await drain(ownerToken);
  const a = await makeTask({ state: "review" });
  const b = await makeTask({ state: "review" });
  const p = pr({ branch: uniq("claude/shared"), title: `${a.key} and ${b.key}: shared change`, action: "opened" });
  const res = await hook(p);
  assert.equal(res.body.outcome, "ambiguous");
  for (const t of [a, b]) assert.equal((await get(t.key)).task.state, "review");
  const asked = (await rest(ownerToken, "GET", "/v1/inbox")).body.filter((m) => m.body.includes(p.pull_request.html_url));
  assert.equal(asked.length, 1, JSON.stringify(asked));
  assert.ok(asked[0].body.includes(a.key) && asked[0].body.includes(b.key));
  assert.match(asked[0].body, /both/);
  assert.match(asked[0].body, /epic/);
  // The merge of the same PR asks nothing more, and still changes nothing.
  const merged = await hook({ ...p, action: "closed", pull_request: { ...p.pull_request, merged: true, merge_commit_sha: SHA, merged_by: { login: OWNER } } });
  assert.equal(merged.body.outcome, "ambiguous");
  assert.equal((await rest(ownerToken, "GET", "/v1/inbox")).body.filter((m) => m.body.includes(p.pull_request.html_url)).length, 0, "asked once");
  for (const t of [a, b]) assert.equal((await get(t.key)).task.state, "review");
  await drain(ownerToken);
});

test("synchronize moves review back to in_progress, and ready_for_review returns it to review", async () => {
  const branch = uniq("claude/sync");
  const task = await makeTask({ branch, state: "in_progress" });
  const p = pr({ branch, action: "opened" });
  assert.equal((await hook(p)).body.outcome, "review");
  assert.equal((await hook({ ...p, action: "synchronize" })).body.outcome, "review_stale");
  assert.equal((await get(task.key)).task.state, "in_progress");
  const back = await hook({ ...p, action: "ready_for_review" });
  assert.equal(back.body.outcome, "review");
  const t = (await get(task.key)).task;
  assert.equal(t.state, "review");
  assert.ok((await get(task.key)).events.some((e) => e.by === "github" && e.data.state === "review" && e.data.from_state === "in_progress"));
});

test("an explicit T-NN outranks a stale branch field: nothing is attached, both tasks are told", async () => {
  const branch = uniq("claude/stale");
  const stale = await makeTask({ branch, state: "ready" });
  const owner = await makeTask({ state: "in_progress" });
  const res = await hook(pr({ branch, action: "opened", title: `${owner.key}: the real change` }));
  assert.equal(res.body.outcome, "conflict");
  for (const t of [stale, owner]) {
    const now = (await get(t.key)).task;
    assert.equal(now.state, t.state);
    assert.equal(now.pr_url, null);
    assert.match((await lastNote(t)).body, /Changed nothing/);
  }
  // The same T-NN on the branch agrees with the branch field, so it matches normally.
  const agree = await makeTask({ branch: uniq("claude/agree"), state: "in_progress" });
  const ok = await hook(pr({ branch: agree.branch, action: "opened", title: `${agree.key}: fine` }));
  assert.equal(ok.body.outcome, "review");
  assert.deepEqual(ok.body.tasks, [agree.key]);
  // A merge for the named task still lands on it once the stale holder is gone.
  const merged = await hook(pr({ branch: uniq("claude/fresh"), title: `${owner.key}: the real change`, merged: true }));
  assert.deepEqual(merged.body.tasks, [owner.key]);
  assert.equal((await get(owner.key)).task.merged_sha, SHA);
});

test("backlog and audit-labelled tasks are never matched", async () => {
  const b1 = uniq("claude/backlog");
  const backlog = await makeTask({ branch: b1, state: "backlog" });
  assert.equal((await hook(pr({ branch: b1, action: "opened" }))).body.ignored, true);
  assert.equal((await get(backlog.key)).task.state, "backlog");
  assert.equal((await get(backlog.key)).task.pr_url, null);
  const viaToken = await hook(pr({ branch: uniq("claude/x"), action: "opened", title: `${backlog.key}: nope` }));
  assert.equal(viaToken.body.ignored, true);

  for (const label of ["audit", "no-pr", "question", "ops"]) {
    const branch = uniq(`claude/${label}`);
    const task = await makeTask({ branch, state: "in_progress", labels: [label] });
    const opened = await hook(pr({ branch, action: "opened", title: `${task.key}: x` }));
    assert.equal(opened.body.ignored, true, label);
    const merged = await hook(pr({ branch, merged: true }));
    assert.equal(merged.body.ignored, true, label);
    const t = (await get(task.key)).task;
    assert.equal(t.state, "in_progress", label);
    assert.equal(t.pr_url, null, label);
  }
});

test("closed tasks are excluded before ambiguity: a reused branch matches the open task only", async () => {
  const branch = uniq("claude/reused");
  const old = await makeTask({ branch, state: "done" });
  const dropped = await makeTask({ branch, state: "dropped" });
  const live = await makeTask({ branch, state: "in_progress" });
  const res = await hook(pr({ branch, action: "opened" }));
  assert.equal(res.body.outcome, "review");
  assert.deepEqual(res.body.tasks, [live.key]);
  assert.equal((await get(old.key)).task.pr_url, null);
  assert.equal((await get(dropped.key)).task.pr_url, null);
  // Only closed tasks hold it: a PR event is a plain no-match, not an ambiguous no-op.
  const b2 = uniq("claude/old");
  await makeTask({ branch: b2, state: "done" });
  await makeTask({ branch: b2, state: "dropped" });
  assert.equal((await hook(pr({ branch: b2, action: "opened" }))).body.ignored, true);
});

test("closing frees the branch and a dropped PR; reopening starts clean; a held branch or pr_url is rejected", async () => {
  const branch = uniq("claude/hygiene");
  const url = `https://github.com/${GITHUB_OWNER}/${repoName}/pull/7${n}`;
  const a = await makeTask({ branch, pr_url: url, state: "in_progress" });
  const dup = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, brief: "x", title: "dup", repo: `${GITHUB_OWNER}/${repoName}`, branch });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, new RegExp(`already held by open task ${a.key}`));
  const other = await makeTask({ state: "in_progress" });
  const upd = (key, body) => rest(ownerToken, "PATCH", `/v1/tasks/${key}`, body);
  const heldBranch = await upd(other.key, { branch });
  assert.equal(heldBranch.status, 400);
  assert.match(heldBranch.body.error, /branch .* already held by open task/);
  const heldUrl = await upd(other.key, { pr_url: url });
  assert.equal(heldUrl.status, 400);
  assert.match(heldUrl.body.error, /pr_url .* already held by open task/);
  assert.equal((await get(other.key)).task.branch, null);

  // Dropped: both cleared, and the branch is free for another open task.
  assert.equal((await upd(a.key, { state: "dropped" })).status, 200);
  let t = (await get(a.key)).task;
  assert.equal(t.branch, null);
  assert.equal(t.pr_url, null);
  assert.equal((await upd(other.key, { branch })).status, 200);

  // Done: the branch is cleared; a merged task keeps its PR as the record.
  const b2 = uniq("claude/hygiene-done");
  const merged = await makeTask({ branch: b2, state: "review" });
  await hook(pr({ branch: b2, merged: true }));
  t = (await get(merged.key)).task;
  assert.equal(t.state, "done");
  assert.equal(t.branch, null);
  assert.match(t.pr_url, /\/pull\/\d+$/);
  assert.ok(t.merged_sha);

  // Reopened: branch and pr_url come back empty.
  assert.equal((await upd(merged.key, { state: "ready" })).status, 200);
  t = (await get(merged.key)).task;
  assert.equal(t.branch, null);
  assert.equal(t.pr_url, null);
});

test("deploy watch: merged is not live until the deploy succeeds; failed and silent deploys are loud", async () => {
  const run = (sha, conclusion, name = "Deploy", head_branch = "main") => ({
    action: "completed", repository: repository(),
    workflow_run: { name, conclusion, head_sha: sha, head_branch, html_url: "https://github.com/run/1" },
  });
  const merge = async (sha) => {
    const branch = uniq("claude/ship");
    const task = await makeTask({ branch, state: "review" });
    await hook(pr({ branch, merged: true, sha }));
    return task;
  };

  const ok = await merge("a".repeat(40));
  assert.equal((await get(ok.key)).task.deploy_state, "pending");
  assert.ok((await get(ok.key)).task.version > ok.version, "the merge bumps version");
  const pendingAt = (await get(ok.key)).task.version;
  assert.equal((await hook(run("a".repeat(40), "success", "CI"), { event: "workflow_run" })).body.ignored, true);
  assert.equal((await get(ok.key)).task.deploy_state, "pending");
  assert.equal((await hook(run("a".repeat(40), "success"), { event: "workflow_run" })).body.outcome, "live");
  let t = (await get(ok.key)).task;
  assert.equal(t.deploy_state, "live");
  assert.ok(t.version > pendingAt, "deploy live bumps version");
  assert.equal(t.state, "done");
  assert.match((await lastNote(ok)).body, /DEPLOYED AND LIVE/);

  const bad = await merge("b".repeat(40));
  const mergedAt = (await get(bad.key)).task.version;
  assert.equal((await hook(run("b".repeat(40), "failure"), { event: "workflow_run" })).body.outcome, "deploy_failed");
  t = (await get(bad.key)).task;
  assert.equal(t.deploy_state, "failed");
  assert.ok(t.version > mergedAt, "deploy failed bumps version");
  assert.ok(t.labels.includes("deploy-failed"));
  assert.match((await lastNote(bad)).body, /MERGED BUT DEPLOY FAILED/);
  // A re-run that succeeds makes it live and clears the flag.
  await hook({ repository: repository(), deployment: { sha: "b".repeat(40), environment: "production" }, deployment_status: { state: "success", target_url: ORIGIN } }, { event: "deployment_status" });
  t = (await get(bad.key)).task;
  assert.equal(t.deploy_state, "live");
  assert.ok(!t.labels.includes("deploy-failed"));

  // Cancelled runs say nothing; a deploy that never reports is flagged at the timeout (3s in tests).
  const silent = await merge("c".repeat(40));
  const silentAt = (await get(silent.key)).task.version;
  assert.equal((await hook(run("c".repeat(40), "cancelled"), { event: "workflow_run" })).body.ignored, true);
  await sleep(4000);
  t = (await get(silent.key)).task;
  assert.equal(t.deploy_state, "not_seen");
  assert.ok(t.version > silentAt, "deploy not seen bumps version");
  assert.ok(t.labels.includes("deploy-failed"));
  assert.match((await lastNote(silent)).body, /MERGED BUT DEPLOY NOT SEEN/);
  assert.equal(t.state, "done");
});

test("revert: a task, a PR url, a SHA or a repo to last good becomes a P1 task for the cloud agent; only the owner may", async () => {
  const repo = uniq("revrepo");
  const mk = async (title, sha, deploy) => {
    const branch = uniq("claude/rev");
    const task = await makeTask({ title, branch, repo, state: "review" });
    await hook(pr({ branch, merged: true, sha, repo }));
    if (deploy) await hook({ action: "completed", repository: repository(GITHUB_OWNER, repo), workflow_run: { name: "Deploy", conclusion: deploy, head_sha: sha, head_branch: "main", html_url: "u" } }, { event: "workflow_run" });
    return (await get(task.key)).task;
  };
  const good = await mk("Good one", "1".repeat(40), "success");
  const badOne = await mk("Bad one", "2".repeat(40), "failure");
  const newest = await mk("Newest", "3".repeat(40), null);

  const byKey = await rest(ownerToken, "POST", "/v1/revert", { target: good.key, reason: "misbehaves" });
  assert.equal(byKey.status, 200, JSON.stringify(byKey.body));
  assert.equal(byKey.body.priority, 1);
  assert.equal(byKey.body.assignee, OWNER_CLOUD);
  assert.ok(byKey.body.labels.includes("revert"));
  const brief = (await get(byKey.body.key)).task.brief;
  assert.match(brief, new RegExp("1".repeat(40)));
  assert.match(brief, /git revert -m 1/);
  assert.match(brief, /misbehaves/);

  const byLast = await rest(ownerToken, "POST", "/v1/revert", { target: `${repo} to last good` });
  const lastBrief = (await get(byLast.body.key)).task.brief;
  assert.match(lastBrief, new RegExp(`1\\. ${newest.key}`));
  assert.match(lastBrief, new RegExp(`2\\. ${badOne.key}`));
  assert.doesNotMatch(lastBrief, new RegExp(`${good.key} "Good`));

  const byUrl = await rest(ownerToken, "POST", "/v1/revert", { target: good.pr_url });
  assert.match((await get(byUrl.body.key)).task.brief, new RegExp("1".repeat(40)));
  const bySha = await rest(ownerToken, "POST", "/v1/revert", { target: "2".repeat(12) });
  assert.match((await get(bySha.body.key)).task.brief, new RegExp(badOne.key));
  assert.equal((await rest(ownerToken, "POST", "/v1/revert", { target: "f".repeat(40) })).status, 400);

  const open = await makeTask({ state: "ready" });
  assert.equal((await rest(ownerToken, "POST", "/v1/revert", { target: open.key })).status, 400);
  assert.equal((await rest(otherToken, "POST", "/v1/revert", { target: good.key })).status, 400);
});
