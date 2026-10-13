import { GITHUB_OWNER, OTHER, OTHER_DEVICE, OTHER_EMAIL, OWNER, OWNER_DEVICE, OWNER_SECOND_DEVICE, escapeRegex } from "./harness/roles.mjs";
// Tasks: the backlog per person, REST and MCP parity, done notices and task-sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base, ownerToken, otherToken, outsiderToken, ownerDeviceToken, ownerSecondDeviceToken, ownerCloudToken, otherDeviceToken, rest, callTool, drain,
  useFakeAccess, signInThroughAccess, oauthToken,
} from "./helpers.mjs";

// Tasks: a backlog per person on the bridge. Each run files its tasks under its own repo name, so lists from earlier runs
// stay out of the way, and drops them at the end so the open list stays short.
const taskRepo = `tasks-${Date.now()}`;
const madeTasks = [];
async function makeTask(token, fields) {
  const res = await rest(token, "POST", "/v1/tasks", { repo: taskRepo, brief: "Do the thing and push.", ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  madeTasks.push(res.body.key);
  return res.body;
}
const taskKeys = async (token, query = "") => (await rest(token, "GET", `/v1/tasks?repo=${taskRepo}${query}`)).body.map((t) => t.key);
const lastInThread = async (token, threadId) => (await rest(token, "GET", `/v1/threads/${threadId}`)).body.at(-1);

const syncScript = new URL("../bin/task-sync.mjs", import.meta.url).pathname;
// HOME points at an empty folder so a real ~/.goonbridge/person-token is never read.
function taskSync(args, { url = base, token = ownerToken, home } = {}) {
  const env = { ...process.env, GOONBRIDGE_URL: url, GOONBRIDGE_TOKEN: token, HOME: home };
  const run = spawnSync(process.execPath, [syncScript, ...args], { env, encoding: "utf8", timeout: 30000 });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const fakeAccess = useFakeAccess();

test(`task_create for ${OTHER} as ${OWNER} opens a thread and ${OTHER}'s inbox gets the brief`, async () => {
  await drain(otherToken);
  const title = `Retry backoff ${Date.now()}`;
  const made = await callTool(ownerToken, "task_create", { title, brief: "In example-repo, wire the backoff into SyncEngine.", owner: OTHER, repo: taskRepo, priority: 2, labels: ["sync"] });
  assert.ok(!made.isError, made.content[0].text);
  const [, key, threadId] = made.content[0].text.match(new RegExp(String.raw`^Created (T-\d+) for ${escapeRegex(OTHER)} \(backlog, P2\): .*Thread (\d+) holds the brief, sent to ${escapeRegex(OTHER)}`, ""));
  madeTasks.push(key);
  const brief = (await rest(otherToken, "GET", "/v1/inbox")).body.find((m) => m.thread_id === Number(threadId));
  assert.ok(brief, `${OTHER}'s inbox has the brief`);
  assert.equal(brief.sender, OWNER);
  assert.equal(brief.subject, `Task ${key}: ${title}`);
  assert.match(brief.body, /^In example-repo, wire the backoff into SyncEngine\./);
  const task = (await rest(otherToken, "GET", `/v1/tasks/${key}`)).body.task;
  assert.equal(task.thread_id, Number(threadId));
  assert.equal(task.owner, OTHER);
  assert.equal(task.created_by, OWNER);
  assert.deepEqual(task.labels, ["sync"]);
  assert.equal(task.version, 1);
  await drain(otherToken);
});

test("task input is checked: owner is a person, devices count as their person", async () => {
  assert.equal((await rest(ownerToken, "POST", "/v1/tasks", { title: "x", brief: "y", owner: "nobody" })).status, 400);
  assert.match((await rest(ownerToken, "POST", "/v1/tasks", { title: "x", brief: "y" })).body.error, /owner is required/);
  assert.match((await rest(ownerToken, "POST", "/v1/tasks", { title: "x", owner: OTHER })).body.error, /brief is required/);
  assert.equal((await rest(ownerToken, "POST", "/v1/tasks", { title: "x", brief: "y", owner: OTHER, priority: 9 })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/tasks", { title: "x", brief: "y", owner: OTHER, due: "2026-02-30" })).status, 400);
  assert.equal((await rest(ownerToken, "POST", "/v1/tasks", { title: "x", brief: "y", owner: OTHER, state: "someday" })).status, 400);
  assert.equal((await callTool(ownerToken, "task_get", { key: "T-99999999" })).isError, true);
  const byDevice = await makeTask(ownerToken, { title: "owned by a device name", owner: OTHER_DEVICE });
  assert.equal(byDevice.owner, OTHER);
  await drain(otherToken);
});

test("task_list scopes: mine follows owner and assignee, owner:<person> and all group by owner", async () => {
  const forOther = await makeTask(ownerToken, { title: `scope: for ${OTHER}`, owner: OTHER });
  const forOwner = await makeTask(otherToken, { title: `scope: for ${OWNER}`, owner: OWNER });
  assert.ok((await taskKeys(otherToken)).includes(forOther.key), `mine as ${OTHER} includes ${OTHER}'s task`);
  assert.ok(!(await taskKeys(otherToken)).includes(forOwner.key));
  assert.ok(!(await taskKeys(ownerToken)).includes(forOther.key), `mine as ${OWNER} leaves out ${OTHER}'s task`);
  assert.ok((await taskKeys(otherDeviceToken)).includes(forOther.key), "a device's mine includes its person's tasks");

  await rest(otherToken, "PATCH", `/v1/tasks/${forOther.key}`, { assignee: OWNER_DEVICE });
  assert.ok((await taskKeys(ownerDeviceToken)).includes(forOther.key), "assigned to me is mine");
  assert.ok((await taskKeys(ownerToken)).includes(forOther.key), "assigned to one of my devices is mine");
  assert.ok(!(await taskKeys(ownerSecondDeviceToken, `&scope=owner:${OWNER}`)).includes(forOther.key));
  assert.deepEqual((await taskKeys(outsiderToken, `&scope=owner:${OTHER}`)).filter((k) => [forOther.key, forOwner.key].includes(k)), [forOther.key]);

  // Blocks follow the sorted person list, so the owner's block can be the first one, with no newline before it.
  const all = "\n" + (await callTool(outsiderToken, "task_list", { scope: "all", repo: taskRepo })).content[0].text;
  const ownerBlock = all.slice(all.indexOf(`
${OWNER} (`), all.indexOf(`
${OTHER} (`));
  const otherBlock = all.slice(all.indexOf(`
${OTHER} (`));
  assert.ok(ownerBlock.includes(`${forOwner.key} · backlog · P3 · scope: for ${OWNER}`), all);
  assert.ok(otherBlock.includes(`${forOther.key} · backlog · P3 · scope: for ${OTHER} · -> ${OWNER_DEVICE} · ${taskRepo}`), all);
  assert.match((await callTool(ownerToken, "task_list", { repo: "no-such-repo" })).content[0].text, /^No tasks/);
  await drain(otherToken); await drain(ownerToken);
});

test("expected_version refuses a stale update", async () => {
  const t = await makeTask(ownerToken, { title: "concurrency", owner: OWNER });
  const first = await rest(ownerSecondDeviceToken, "PATCH", `/v1/tasks/${t.key}`, { expected_version: 1, priority: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.task.version, 2);
  const stale = await rest(ownerDeviceToken, "PATCH", `/v1/tasks/${t.key}`, { expected_version: 1, priority: 4 });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /at version 2, not 1/);
  const tool = await callTool(ownerDeviceToken, "task_update", { key: t.key, expected_version: 1, state: "ready" });
  assert.equal(tool.isError, true);
  assert.equal((await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.task.priority, 1);
  await drain(ownerToken);
});

test("claim assigns the task to the caller; another claim needs expected_version", async () => {
  const t = await makeTask(otherToken, { title: "claim me", owner: OWNER, state: "ready" });
  const claimed = (await callTool(otherDeviceToken, "task_update", { key: t.key, state: "claim" })).content[0].text;
  assert.match(claimed, new RegExp(`^${t.key} is now version 2: .*assignee ${OTHER_DEVICE}.*state claimed`));
  let task = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.task;
  assert.equal(task.assignee, OTHER_DEVICE);
  assert.equal(task.state, "claimed");

  const grab = await callTool(ownerSecondDeviceToken, "task_update", { key: t.key, state: "claimed" });
  assert.equal(grab.isError, true);
  assert.match(grab.content[0].text, new RegExp(String.raw`already claimed by ${escapeRegex(OTHER_DEVICE)}`, ""));
  const takeover = await callTool(ownerSecondDeviceToken, "task_update", { key: t.key, state: "claimed", expected_version: 2 });
  assert.ok(!takeover.isError, takeover.content[0].text);
  task = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}`)).body.task;
  assert.equal(task.assignee, OWNER_SECOND_DEVICE);

  // Claimed with an assignee is a claim for that member: the same take-over guard, and the claim is stamped.
  assert.equal((await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { state: "claimed", assignee: OTHER_DEVICE })).status, 400);
  const handed = await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { state: "claimed", assignee: OTHER_DEVICE, expected_version: task.version });
  assert.equal(handed.body.task.assignee, OTHER_DEVICE, "claimed with an assignee assigns that member");
  assert.equal(handed.body.task.claim_session, OTHER_DEVICE);
  await drain(ownerToken);
});

test("a note lands in the task's thread as a comment from the caller", async () => {
  await drain(ownerToken);
  const t = await makeTask(ownerToken, { title: "note me", owner: OWNER, state: "ready" });
  await callTool(otherDeviceToken, "task_update", { key: t.key, state: "claim" });
  const res = (await callTool(otherDeviceToken, "task_update", { key: t.key, state: "in progress", branch: "claude/note-me", note: "Started; tests next." })).content[0].text;
  assert.match(res, /state in_progress/);
  assert.match(res, new RegExp(`Posted in thread ${t.thread_id} to ${OWNER}`));
  const last = await lastInThread(otherDeviceToken, t.thread_id);
  assert.equal(last.sender, OTHER_DEVICE);
  assert.equal(last.recipient, OWNER, "a comment from outside the owner's household goes to the owner");
  assert.equal(last.body, "Started; tests next.");
  assert.equal(last.subject, `Task ${t.key}: note me`);
  assert.ok((await rest(ownerToken, "GET", "/v1/inbox")).body.some((m) => m.id === last.id));
  await drain(ownerToken);
});

test("task_done by another person's device reports to the owner; reported by the owner's device it does not", async () => {
  await drain(ownerToken);
  const theirs = await makeTask(ownerToken, { title: `finish for ${OWNER}`, owner: OWNER, state: "ready" });
  await callTool(otherDeviceToken, "task_update", { key: theirs.key, state: "claim" });
  const done = (await callTool(otherDeviceToken, "task_done", { key: theirs.key, summary: "Pushed abc123 to claude/x.", pr_url: "https://dev.azure.com/example-org/x/_git/y/pullrequest/7" })).content[0].text;
  assert.match(done, /state review/);
  assert.match(done, new RegExp(String.raw`${escapeRegex(OWNER)} was told you reported it finished`, ""));
  const notice = (await rest(ownerToken, "GET", "/v1/inbox")).body.find((m) => m.thread_id === theirs.thread_id);
  assert.ok(notice, `${OWNER} got the done notice`);
  assert.equal(notice.sender, OTHER_DEVICE);
  assert.equal(notice.body, `Task ${theirs.key} (finish for ${OWNER}) was reported finished by ${OTHER_DEVICE}: Pushed abc123 to claude/x.`);
  const reported = (await rest(ownerToken, "GET", `/v1/tasks/${theirs.key}`)).body.task;
  assert.equal(reported.state, "review", "task_done never closes: the merge does");
  assert.equal(reported.closed_at, null);
  assert.equal(reported.pr_url, "https://dev.azure.com/example-org/x/_git/y/pullrequest/7");
  assert.ok((await taskKeys(ownerToken, "&state=review")).includes(theirs.key));

  await drain(ownerToken);
  const own = await makeTask(ownerToken, { title: "finish my own", owner: OWNER });
  const ownDone = (await callTool(ownerDeviceToken, "task_done", { key: own.key, summary: "Done on the Air." })).content[0].text;
  assert.doesNotMatch(ownDone, /was told/);
  assert.match(ownDone, /No PR on it yet/);
  assert.ok(!(await rest(ownerToken, "GET", "/v1/inbox")).body.some((m) => m.thread_id === own.thread_id), "no notice to the owner");
  assert.equal((await lastInThread(ownerToken, own.thread_id)).body, "Reported finished: Done on the Air.", "the summary is still in the thread");
  await drain(ownerToken);
});

test("events keep the trail; reopening clears closed_at", async () => {
  const t = await makeTask(ownerToken, { title: "trail", owner: OTHER });
  await rest(otherDeviceToken, "PATCH", `/v1/tasks/${t.key}`, { state: "claim" });
  await rest(otherDeviceToken, "PATCH", `/v1/tasks/${t.key}`, { pr_url: `https://github.com/${GITHUB_OWNER}/trail/pull/1` });
  await rest(otherDeviceToken, "PATCH", `/v1/tasks/${t.key}`, { state: "review", note: "PR up" });
  await rest(otherDeviceToken, "POST", `/v1/tasks/${t.key}/done`, { summary: "merged" });
  await rest(otherToken, "PATCH", `/v1/tasks/${t.key}`, { state: "dropped" });
  const reopened = (await rest(otherToken, "PATCH", `/v1/tasks/${t.key}`, { state: "ready", note: "one more thing" })).body.task;
  assert.equal(reopened.closed_at, null);
  assert.equal(reopened.closed_by, null);
  const { events } = (await rest(otherToken, "GET", `/v1/tasks/${t.key}`)).body;
  assert.deepEqual(events.map((e) => `${e.by} ${e.kind}`), [
    `${OWNER} created`, `${OTHER_DEVICE} claimed`, `${OTHER_DEVICE} updated`, `${OTHER_DEVICE} state`, `${OTHER_DEVICE} comment`, `${OTHER_DEVICE} report`, `${OTHER} closed`, `${OTHER} reopened`, `${OTHER} comment`,
  ]);
  assert.equal(events[3].data.state, "review");
  assert.equal(events[3].data.from_state, "claimed");
  const text = (await callTool(otherToken, "task_get", { key: t.key.toLowerCase() })).content[0].text;
  assert.match(text, new RegExp(`^${t.key} · trail\nowner ${OTHER} · assignee ${OTHER_DEVICE} · ready · P3 · version 6`));
  assert.match(text, new RegExp(`Thread ${t.thread_id} holds the brief`));
  assert.match(text, /\nBrief:\nDo the thing and push\.\n/);
  assert.match(text, new RegExp(String.raw`- \S+ ${escapeRegex(OTHER)} reopened state=ready`, ""));
  await drain(otherToken); await drain(ownerToken);
});

test("GET /tasks shows both backlogs as plain HTML, with the same sign-in as /mcp", async () => {
  const forOwner = await makeTask(otherToken, { title: `html <b>${OWNER}</b>`, owner: OWNER, state: "ready" });
  const forOther = await makeTask(ownerToken, { title: `html ${OTHER}`, owner: OTHER, assignee: OTHER_DEVICE });
  assert.equal((await fetch(new URL("/tasks", base))).status, 401);
  assert.equal((await fetch(new URL("/tasks", base), { headers: { Authorization: `Bearer ${"z".repeat(40)}` } })).status, 401);
  const res = await fetch(new URL("/tasks", base), { headers: { Authorization: `Bearer ${otherDeviceToken}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /^text\/html/);
  const html = await res.text();
  assert.ok(!/<script/i.test(html));
  const ownerAt = html.indexOf(`<h2>${OWNER} (`);
  const otherAt = html.indexOf(`<h2>${OTHER} (`);
  assert.ok(ownerAt > 0 && otherAt > 0, "both owners have a section");
  const ownerItem = html.indexOf(`<strong>${forOwner.key}</strong>`);
  const otherItem = html.indexOf(`<strong>${forOther.key}</strong>`);
  assert.ok(ownerItem > ownerAt && ownerItem < otherAt, `${OWNER}'s task sits under ${OWNER}`);
  assert.ok(otherItem > otherAt, `${OTHER}'s task sits under ${OTHER}`);
  assert.ok(html.includes(`html &#60;b&#62;${OWNER}&#60;/b&#62;`), "titles are escaped");
  assert.ok(html.lastIndexOf("<h3>ready (", ownerItem) > ownerAt, "grouped by state under the owner");
  if (fakeAccess) {
    const token = await oauthToken(await signInThroughAccess(OTHER_EMAIL));
    const viaOAuth = await fetch(new URL("/tasks", base), { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(viaOAuth.status, 200);
    assert.match(await viaOAuth.text(), new RegExp(String.raw`As ${escapeRegex(OTHER)},`, ""));
  }
  await drain(ownerToken); await drain(otherDeviceToken);
});

test("REST and MCP agree on create, list and get", async () => {
  const viaRest = await makeTask(ownerToken, { title: "parity", owner: OTHER, due: "2026-12-01", labels: ["a", "b"] });
  const listed = (await rest(otherToken, "GET", `/v1/tasks?repo=${taskRepo}&state=backlog,ready`)).body.find((t) => t.key === viaRest.key);
  assert.equal(listed.title, "parity");
  assert.equal(listed.brief, undefined, "lists leave the brief out");
  const got = (await rest(otherToken, "GET", `/v1/tasks/${viaRest.key}`)).body;
  assert.equal(got.task.brief, "Do the thing and push.");
  assert.equal(got.events[0].kind, "created");
  const text = (await callTool(otherToken, "task_list", { repo: taskRepo, state: ["backlog"] })).content[0].text;
  assert.ok(text.includes(`${viaRest.key} · backlog · P3 · parity · ${taskRepo} · due 2026-12-01 · #a #b`), text);
  const viaMcp = (await callTool(otherToken, "task_create", { title: "parity mcp", brief: "b", owner: OWNER, repo: taskRepo })).content[0].text;
  const key = viaMcp.match(/Created (T-\d+)/)[1];
  madeTasks.push(key);
  assert.equal((await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task.title, "parity mcp");
  await drain(otherToken); await drain(ownerToken);
});

test("bridge_help explains tasks and the session-start routine", async () => {
  const help = (await callTool(ownerCloudToken, "bridge_help")).content[0].text;
  assert.match(help, /## Tasks/);
  assert.match(help, /task_get.*task_update.*claim.*bridge_status_set.*task_done/s);
  assert.match(help, /bridge_inbox.*task_list/s);
  // Only a task's owner drops it.
  for (const key of madeTasks) {
    const owner = (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body.task.owner;
    await rest(owner === OTHER ? otherToken : ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  }
  for (const t of [ownerToken, otherToken, ownerDeviceToken, otherDeviceToken, otherDeviceToken]) await drain(t);
});
