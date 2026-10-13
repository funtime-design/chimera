import { CONTEXT_HEADER, GITHUB_OWNER, OWNER, OWNER_CLOUD, REPO, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// Auto-review: a PR that goes up for review (webhook: opened / reopened / ready_for_review on a matched task) fires one fresh,
// independent reviewer session through the routines path. A fake routines API stands in.
// Needs GOONBRIDGE_ROUTINES_URL and GOONBRIDGE_ROUTINES (alice -> trig_local_test) in .dev.vars, GOONBRIDGE_GITHUB_WEBHOOK_SECRET=test-webhook-secret,
// and GOONBRIDGE_BOOT_SECONDS of a few seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { base, ownerToken, ownerCloudToken, otherToken, rest, sleep, drain, serverWindows, useFakeRoutines, devVars } from "./helpers.mjs";

const fake = useFakeRoutines();
const skip = (!fake || !devVars.GOONBRIDGE_ROUTINES) && "needs GOONBRIDGE_ROUTINES_URL and GOONBRIDGE_ROUTINES in .dev.vars";
const SECRET = (devVars.GOONBRIDGE_GITHUB_WEBHOOK_SECRET ?? "test-webhook-secret");
const repoName = `review${Date.now()}`;
const sign = (raw) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

async function hook(payload, { delivery = randomUUID() } = {}) {
  const text = JSON.stringify(payload);
  const res = await fetch(new URL("/v1/github/webhook", base), {
    method: "POST", body: text,
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": sign(text) },
  });
  return { status: res.status, body: await res.json() };
}
let n = 500;
function pr({ branch, action, draft = false, merged = false, number, title = "A change", sha } = {}) {
  number ??= ++n;
  return {
    action, repository: { full_name: `${GITHUB_OWNER}/${repoName}`, default_branch: "main", owner: { login: GITHUB_OWNER } },
    pull_request: {
      number, title, draft, merged, html_url: `https://github.com/${GITHUB_OWNER}/${repoName}/pull/${number}`,
      merge_commit_sha: merged ? "abc123def4567890abc123def4567890abc12345" : null, merged_by: merged ? { login: OWNER } : null,
      head: { ref: branch, ...(sha ? { sha } : {}) }, base: { ref: "main" },
    },
  };
}
const uniq = (p) => `${p}-${randomUUID().slice(0, 8)}`;
const newSession = () => `cse_${randomBytes(8).toString("hex")}`;
const get = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task;
const thread = async (task) => (await rest(ownerToken, "GET", `/v1/threads/${task.thread_id}`)).body;
async function makeTask(fields) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, brief: "Do it.", title: "Review me", repo: `${GITHUB_OWNER}/${repoName}`, state: "in_progress", ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
// Fires that carry this task's key: the reviewer brief names it.
const firesFor = (key) => fake.fires.filter((f) => f.text.includes(`automatic review of ${key} `));
// A cloud session claims the task, as the authoring session does.
async function claimAs(session, key) {
  const res = await fetch(new URL(`/v1/tasks/${key}`, base), {
    method: "PATCH", body: JSON.stringify({ state: "claim" }),
    headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: session, [CONTEXT_HEADER]: REPO },
  });
  assert.equal(res.status, 200);
  return (await get(key)).claim_session;
}

test("a PR opened on a matched task fires exactly one reviewer, never the authoring session", { skip }, async () => {
  const branch = uniq("claude/auto");
  const task = await makeTask({ branch, state: "ready" });
  const author = await claimAs(newSession(), task.key);
  assert.match(author, new RegExp(String.raw`^${escapeRegex(OWNER_CLOUD)}-`, ""));
  const p = pr({ branch, action: "opened" });
  const out = await hook(p);
  assert.equal(out.body.outcome, "review");
  assert.equal(out.body.reviewer.ok, true);
  assert.match(out.body.reviewer.session_id, /^session_fake\d+$/);
  const fires = firesFor(task.key);
  assert.equal(fires.length, 1);
  const brief = fires[0].text;
  assert.equal(fires[0].trigger, "trig_local_test");
  assert.ok(brief.includes(p.pull_request.html_url) && brief.includes(branch) && brief.includes(`${GITHUB_OWNER}/${repoName}`));
  assert.ok(brief.includes(`written by ${author}`), "the brief names the authoring session");
  assert.match(brief, /fresh, independent reviewer session/);
  assert.match(brief, /Do NOT merge, deploy, push/);
  assert.match(brief, /typecheck and the full test suite/);
  assert.ok(brief.includes(`bridge_send (thread_id ${task.thread_id}, to "${OWNER}")`), "the verdict goes to the task's thread");
  // A new routine session, not a live one picking it up: its id is not the author's session, and it is a fresh fire.
  assert.notEqual(out.body.reviewer.session_id, author);
  assert.ok(!out.body.reviewer.session_id.includes(author));
  const t = await get(task.key);
  assert.equal(t.state, "review");
  assert.equal(t.pr_url, p.pull_request.html_url);
  assert.match((await thread(task)).at(-1).body, /Auto-review started for PR #\d+: https:\/\/claude\.ai\/code\/session_fake\d+/);
});

test("a redelivery, a reopen, new commits and a repeated open fire nothing more", { skip }, async () => {
  const branch = uniq("claude/dupe");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened" });
  const delivery = randomUUID();
  assert.equal((await hook(p, { delivery })).body.reviewer.ok, true);
  assert.equal(firesFor(task.key).length, 1);

  const again = await hook(p, { delivery });
  assert.equal(again.body.duplicate, true);
  assert.equal(firesFor(task.key).length, 1, "same delivery id");

  assert.equal((await hook(p)).body.outcome, "already_review");
  assert.equal(firesFor(task.key).length, 1, "a second open of the same PR");

  const push = await hook({ ...p, action: "synchronize" });
  assert.equal(push.body.outcome, "review_stale");
  assert.equal((await get(task.key)).state, "in_progress");
  assert.equal((await hook({ ...p, action: "ready_for_review" })).body.outcome, "review");
  assert.equal((await get(task.key)).state, "review");
  assert.equal(firesFor(task.key).length, 1, "new commits, then ready again, on a PR already reviewed");

  await hook({ ...p, action: "closed" });
  assert.equal((await get(task.key)).state, "ready");
  assert.equal((await hook({ ...p, action: "reopened" })).body.outcome, "review");
  assert.equal(firesFor(task.key).length, 1, "close and reopen");
});

test("a draft PR fires nothing; marking it ready fires one", { skip }, async () => {
  const branch = uniq("claude/draft");
  const task = await makeTask({ branch });
  const draft = pr({ branch, action: "opened", draft: true });
  const out = await hook(draft);
  assert.equal(out.body.outcome, "draft");
  assert.equal(out.body.reviewer, undefined);
  assert.equal(firesFor(task.key).length, 0);
  assert.equal((await hook({ ...draft, pull_request: { ...draft.pull_request, draft: true }, action: "opened" })).body.outcome, "draft_unchanged");
  assert.equal(firesFor(task.key).length, 0);

  const ready = await hook({ ...draft, action: "ready_for_review", pull_request: { ...draft.pull_request, draft: false } });
  assert.equal(ready.body.outcome, "review");
  assert.equal(firesFor(task.key).length, 1);
  assert.equal((await get(task.key)).state, "review");
});

test("no matching task, a merge and a close fire nothing; merge still marks the task done", { skip }, async () => {
  const before = fake.fires.length;
  assert.equal((await hook(pr({ branch: uniq("claude/stray"), action: "opened" }))).body.ignored, true);
  assert.equal(fake.fires.length, before, "no task matches");

  const branch = uniq("claude/merged");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened" });
  await hook(p);
  assert.equal(firesFor(task.key).length, 1);
  const merged = await hook({ ...p, action: "closed", pull_request: { ...p.pull_request, merged: true, merge_commit_sha: "abc123def4567890abc123def4567890abc12345", merged_by: { login: OWNER } } });
  assert.equal(merged.body.outcome, "done");
  assert.equal((await get(task.key)).state, "done");
  assert.equal(firesFor(task.key).length, 1, "merge fires no second reviewer");
});

test("a fire that fails tells the owner, frees the PR, and a later open tries again", { skip }, async () => {
  const branch = uniq("claude/fail");
  const task = await makeTask({ branch, title: "MAKE-IT-FAIL review" });
  const p = pr({ branch, action: "opened" });
  const out = await hook(p);
  assert.equal(out.body.outcome, "review");
  assert.equal(out.body.reviewer.ok, false);
  assert.match(out.body.reviewer.error, /rate limited/);
  assert.equal((await get(task.key)).state, "review", "the webhook's own work stands");
  assert.match((await thread(task)).at(-1).body, /AUTO-REVIEW NOT STARTED for PR #\d+.*rate limited/);
  assert.equal((await hook(p)).body.reviewer.ok, false, "the failed claim was released, so the next open tries once more");
  assert.equal(firesFor(task.key).length, 2);
});

test("a reviewer that never boots is flagged never_started to the owner by the existing fault path", { skip }, async () => {
  const boot = (await serverWindows()).boot_seconds ?? 3;
  assert.ok(boot <= 10, "set GOONBRIDGE_BOOT_SECONDS to a few seconds for tests");
  const branch = uniq("claude/ghost");
  const task = await makeTask({ branch });
  const out = await hook(pr({ branch, action: "opened" }));
  const sessionId = out.body.reviewer.session_id;
  await sleep((boot + 2) * 1000);
  const faults = (await rest(ownerToken, "GET", "/v1/faults")).body;
  const f = faults.fires.find((x) => x.session_id === sessionId);
  assert.equal(f?.fault, "never_started");
  assert.equal(f.task_key, task.key);
  assert.equal(f.thread_id, task.thread_id);
  assert.match((await thread(task)).at(-1).body, /FAULT never_started/);
});

// T-69: the PR's reviewer reservation is committed before the Worker dispatches. A dispatch that never reports back (the
// Worker died between the two) used to hold the reservation for good, so no event could ever start a reviewer again.
test("a reviewer dispatch that never reports back expires: the owner is told and the next event retries", { skip }, async () => {
  const boot = (await serverWindows()).boot_seconds ?? 3;
  const branch = uniq("claude/stall");
  const task = await makeTask({ branch, title: "HANG-FIRE review" });
  const p = pr({ branch, action: "opened" });
  const first = hook(p); // the fake routines API holds this fire past the boot window
  await sleep((boot + 1) * 1000);
  const retry = await hook({ ...p, action: "reopened" });
  assert.equal(retry.body.outcome, "already_review");
  assert.ok(retry.body.reviewer, "the stale reservation was given up, so the reopen dispatches a reviewer");
  assert.equal(retry.body.reviewer.ok, true);
  assert.ok((await thread(task)).some((m) => /AUTO-REVIEW NOT STARTED for PR #\d+.*did not report back/.test(m.body)), "the owner was told");
  // The stalled dispatch reports back late: it is ignored, the retry stays the PR's reviewer.
  const late = (await first).body.reviewer;
  assert.equal(late.superseded, true, JSON.stringify(late));
  const started = (await thread(task)).filter((m) => m.body.startsWith("Auto-review started"));
  assert.equal(started.length, 1, "one reviewer announced");
  assert.ok(started[0].body.includes(retry.body.reviewer.session_id));
});

// T-55: review follows the PR's head. A revised PR (a new head after a review) gets one new reviewer when it is marked
// ready again (GitHub ready_for_review, a re-review label, or the author's "ready for re-review" note), up to a cap.
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const SHA3 = "3333333333333333333333333333333333333333";
const max = Number(devVars.GOONBRIDGE_REVIEWERS_MAX ?? 3);
const atHead = (p, sha, action, extra = {}) => ({ ...p, action, ...extra, pull_request: { ...p.pull_request, head: { ...p.pull_request.head, sha } } });

test("a revised PR gets exactly one new reviewer on ready_for_review; the same head never fires twice", { skip }, async () => {
  const branch = uniq("claude/revise");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened", sha: SHA1 });
  assert.equal((await hook(p)).body.reviewer.ok, true);

  const push = await hook(atHead(p, SHA2, "synchronize"));
  assert.equal(push.body.outcome, "review_stale");
  assert.equal((await get(task.key)).state, "in_progress");
  assert.equal(firesFor(task.key).length, 1, "a push alone fires nothing");

  const ready = await hook(atHead(p, SHA2, "ready_for_review"));
  assert.equal(ready.body.outcome, "review");
  assert.equal(ready.body.reviewer.ok, true);
  assert.equal((await get(task.key)).state, "review", "ready_for_review returns the task to review");
  assert.equal(firesFor(task.key).length, 2, "one new reviewer for the new head");

  assert.equal((await hook(atHead(p, SHA2, "ready_for_review"))).body.reviewer, undefined);
  assert.equal((await hook(atHead(p, SHA2, "reopened"))).body.reviewer, undefined);
  assert.equal(firesFor(task.key).length, 2, "the same head again fires nothing");
});

test("a re-review label or the author's note asks for a reviewer of the new head", { skip }, async () => {
  const branch = uniq("claude/relabel");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened", sha: SHA1 });
  await hook(p);
  await hook(atHead(p, SHA2, "synchronize"));
  assert.equal((await hook(atHead(p, SHA2, "labeled", { label: { name: "bug" } }))).body.ignored, true);
  const labeled = await hook(atHead(p, SHA2, "labeled", { label: { name: "re-review" } }));
  assert.equal(labeled.body.reviewer?.ok, true, JSON.stringify(labeled.body));
  assert.equal((await get(task.key)).state, "review");
  assert.equal(firesFor(task.key).length, 2);

  // A push, then the author says so in the task's thread.
  await hook(atHead(p, SHA3, "synchronize"));
  assert.equal((await get(task.key)).state, "in_progress");
  const noted = await rest(ownerToken, "PATCH", `/v1/tasks/${task.key}`, { note: "Fixed the review points. Ready for re-review." });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.equal(noted.body.reviewer?.ok, true, JSON.stringify(noted.body));
  assert.equal(firesFor(task.key).length, 3);
  assert.equal((await get(task.key)).state, "review");
  assert.equal((await rest(ownerToken, "PATCH", `/v1/tasks/${task.key}`, { note: "ready for re-review" })).body.reviewer, undefined, "same head again");
  assert.equal(firesFor(task.key).length, 3);
});

test("past the reviewer cap the owner is told once and nothing fires", { skip }, async () => {
  const branch = uniq("claude/cap");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened", sha: SHA1 });
  await hook(p);
  const head = (i) => String(i + 1).repeat(40);
  for (let i = 1; i < max; i++) await hook(atHead(p, head(i), "ready_for_review"));
  assert.equal(firesFor(task.key).length, max);
  const over = await hook(atHead(p, head(max), "ready_for_review"));
  assert.equal(over.body.reviewer, undefined);
  assert.equal(firesFor(task.key).length, max, "the cap holds");
  const capped = (await thread(task)).filter((m) => /AUTO-REVIEW CAP/.test(m.body));
  assert.equal(capped.length, 1);
  assert.match(capped[0].body, new RegExp(`${max} reviewers`));
  await hook(atHead(p, head(max + 1), "ready_for_review"));
  assert.equal((await thread(task)).filter((m) => /AUTO-REVIEW CAP/.test(m.body)).length, 1, "told once");
});

// A row from before T-55 has head_sha "" (the same as a fire for an event that carried no head). The first head seen
// after the upgrade is adopted as the one reviewed: no extra reviewer for a PR that already had one.
test("a review row with no head adopts the first head seen: ready_for_review then fires nothing", { skip }, async () => {
  const branch = uniq("claude/legacy");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened" }); // no head sha, as before T-55
  assert.equal((await hook(p)).body.reviewer.ok, true);
  const adopted = await hook(atHead(p, SHA1, "ready_for_review"));
  assert.equal(adopted.body.reviewer, undefined, "the legacy row took this head");
  assert.equal(firesFor(task.key).length, 1);
  // A later revision is reviewed as usual.
  assert.equal((await hook(atHead(p, SHA2, "ready_for_review"))).body.reviewer?.ok, true);
  assert.equal(firesFor(task.key).length, 2);
});

test("a re-review note from someone who is not the PR's author, or a negated one, does nothing", { skip }, async () => {
  const branch = uniq("claude/stranger");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened", sha: SHA1 });
  await hook(p);
  await hook(atHead(p, SHA2, "synchronize"));
  const stranger = await rest(otherToken, "PATCH", `/v1/tasks/${task.key}`, { note: "ready for re-review" });
  assert.equal(stranger.status, 200);
  assert.equal(stranger.body.reviewer, undefined);
  const negated = await rest(ownerToken, "PATCH", `/v1/tasks/${task.key}`, { note: "Not ready for re-review yet." });
  assert.equal(negated.body.reviewer, undefined);
  assert.equal(firesFor(task.key).length, 1);
  assert.equal((await get(task.key)).state, "in_progress");
  await drain(otherToken);
});

test("a second reviewer's brief points at the earlier review", { skip }, async () => {
  const branch = uniq("claude/delta");
  const task = await makeTask({ branch });
  const p = pr({ branch, action: "opened", sha: SHA1 });
  const first = await hook(p);
  await hook(atHead(p, SHA2, "ready_for_review"));
  const brief = firesFor(task.key)[1].text;
  assert.ok(brief.includes(first.body.reviewer.url), "names the earlier reviewer session");
  assert.ok(brief.includes(SHA1.slice(0, 10)) && brief.includes(SHA2.slice(0, 10)), "names both heads");
});
