import { CONTEXT_HEADER, OTHER, OTHER_DEVICE, OWNER, OWNER_CLOUD, SESSION_HEADER, escapeRegex } from "./harness/roles.mjs";
// T-52: the single record. Every fact is an append-only row in `events`; task_events is a view of it. A report lands in
// the record even when its thread is full; task_get shows every event; errors keep a repeat count; ended sessions point
// at their report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { base, ownerToken, ownerCloudToken, otherToken, otherDeviceToken, rest, callTool, drain, useFakeRoutines } from "./helpers.mjs";

const repo = `events-${Date.now()}`;
const made = [];
async function make(fields = {}) {
  const res = await rest(ownerToken, "POST", "/v1/tasks", { owner: OWNER, title: "Events task", brief: "A task for the record tests.", repo, ...fields });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  made.push(res.body.key);
  return res.body;
}
const getTask = async (key) => (await rest(ownerToken, "GET", `/v1/tasks/${key}`)).body;

test("a report into a full task thread still lands in the record, and task_get shows it", async () => {
  const t = await make({ state: "ready" });
  assert.equal((await rest(otherDeviceToken, "PATCH", `/v1/tasks/${t.key}`, { state: "claim" })).status, 200);
  // Notes skip the reply cap, so they fill the thread past 20.
  for (let i = 1; i <= 20; i++) await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { note: `note ${i}` });
  const capped = await callTool(otherDeviceToken, "bridge_send", { thread_id: t.thread_id, body: "my report" });
  assert.equal(capped.isError, true);
  assert.match(capped.content[0].text, /The thread is full: report results with task_report on the task, or ask the owner/);
  const out = await callTool(otherDeviceToken, "task_report", { key: t.key, verdict: "blocked", summary: "Need the API key before going on." });
  assert.ok(!out.isError, out.content[0].text);
  const got = await getTask(t.key);
  const report = got.events.find((e) => e.kind === "report");
  assert.ok(report, JSON.stringify(got.events.map((e) => e.kind)));
  assert.equal(report.by, OTHER_DEVICE);
  assert.equal(report.data.verdict, "blocked");
  assert.equal(report.data.text, "Need the API key before going on.");
  assert.equal(typeof report.data.message_id, "number");
  const thread = (await rest(ownerToken, "GET", `/v1/threads/${t.thread_id}`)).body;
  assert.ok(thread.length > 20);
  assert.ok(thread.some((m) => m.id === report.data.message_id && m.body.includes("Need the API key")), "the thread line is posted");
  assert.equal(got.task.state, "claimed", "a blocked report changes no state");
  const text = (await callTool(ownerToken, "task_get", { key: t.key })).content[0].text;
  assert.match(text, new RegExp(String.raw`${escapeRegex(OTHER_DEVICE)} report verdict=blocked`, ""));
  // task_done is the same report with verdict finished.
  await callTool(otherDeviceToken, "task_done", { key: t.key, summary: "All done." });
  const after = await getTask(t.key);
  const last = after.events.filter((e) => e.kind === "report").at(-1);
  assert.equal(last.data.verdict, "finished");
  assert.equal(last.data.text, "All done.");
  await drain(ownerToken);
});

test("task_get shows the newest 50 events by default, more with a limit, and the total", async () => {
  const t = await make();
  for (let i = 1; i <= 54; i++) await rest(ownerToken, "PATCH", `/v1/tasks/${t.key}`, { note: `n${i}` });
  const got = await getTask(t.key);
  assert.equal(got.total, 55, "created + 54 comments");
  assert.equal(got.events.length, 50, "the default is the newest 50");
  assert.equal(got.events.at(-1).data.note, "n54");
  assert.equal(got.events[0].task_id, t.id, "the task_events shape is kept");
  const all = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}?limit=500`)).body.events;
  assert.equal(all.length, 55);
  assert.equal(all[0].kind, "created");
  const limited = (await rest(ownerToken, "GET", `/v1/tasks/${t.key}?limit=3`)).body.events;
  assert.deepEqual(limited.map((e) => e.data.note), ["n52", "n53", "n54"], "limit keeps the newest, oldest first");
  const text = (await callTool(ownerToken, "task_get", { key: t.key, limit: 2 })).content[0].text;
  assert.match(text, /Events \(2 of 55, oldest first\)/);
  assert.match((await callTool(ownerToken, "task_get", { key: t.key })).content[0].text, /Events \(50 of 55, oldest first\)/);
});

test("an error logged twice counts the repeat; once resolved, the next one says so; bridge_faults lists open errors", async () => {
  const command = `pnpm deploy --env ${[...Array(10)].map(() => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;
  const first = (await callTool(otherDeviceToken, "error_log", { command, outcome: "EACCES on /tmp/a1/wrangler.toml" })).content[0].text;
  const id = first.match(/\b(E-\d+)\b/)[1];
  assert.match(first, /first time/);
  const second = (await callTool(otherDeviceToken, "error_log", { command, outcome: "EACCES on /tmp/a1/wrangler.toml" })).content[0].text;
  assert.match(second, new RegExp(`${id}.*seen 2 times`));
  const other = (await callTool(otherDeviceToken, "error_log", { command, outcome: "a different outcome" })).content[0].text;
  assert.doesNotMatch(other, new RegExp(`\\b${id}\\b`), "another outcome is another error");
  let faults = (await rest(ownerToken, "GET", "/v1/faults")).body;
  assert.equal(faults.errors.find((e) => e.id === id)?.count, 2);
  assert.match((await callTool(ownerToken, "bridge_faults", {})).content[0].text, new RegExp(`${id} .*seen 2 times`));
  // Errors are bridge-wide, but only the household that logged one resolves it.
  const refused = await callTool(ownerToken, "error_resolve", { id });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, new RegExp(String.raw`logged by ${escapeRegex(OTHER_DEVICE)}; only ${escapeRegex(OTHER)}`, ""));
  const resolved = (await callTool(otherToken, "error_resolve", { id, note: "chmod fixed it" })).content[0].text;
  assert.match(resolved, new RegExp(`${id} resolved`));
  faults = (await rest(ownerToken, "GET", "/v1/faults")).body;
  assert.ok(!faults.errors.some((e) => e.id === id), "resolved errors leave the open list");
  // The same failure with another temp path and number is the same error (light normalisation).
  const again = (await callTool(otherDeviceToken, "error_log", { command, outcome: "EACCES on /tmp/x91/wrangler.toml" })).content[0].text;
  assert.match(again, new RegExp(`${id}.*seen 3 times.*previously resolved by ${OTHER}: chmod fixed it`));
  assert.ok((await rest(ownerToken, "GET", "/v1/faults")).body.errors.some((e) => e.id === id), "a repeat opens it again");
  const rest_ = await rest(otherDeviceToken, "POST", "/v1/errors", { command, outcome: "EACCES on /tmp/a1/wrangler.toml" });
  assert.equal(rest_.body.id, id);
  assert.equal(rest_.body.count, 4);
  await rest(otherDeviceToken, "POST", `/v1/errors/${id}/resolve`, { note: "again" });
  await callTool(otherDeviceToken, "error_resolve", { id: other.match(/\b(E-\d+)\b/)[1] });
});

const fakeRoutines = useFakeRoutines();
test("an ended session points at its report", { skip: !fakeRoutines && "no GOONBRIDGE_ROUTINES_URL in .dev.vars" }, async () => {
  await drain(ownerToken); await drain(ownerCloudToken);
  const t = await make({ state: "ready" });
  // A fired session: its fire row is what bridge_sessions include=ended lists.
  const sent = (await rest(ownerToken, "POST", "/v1/send", { to: OWNER_CLOUD, subject: "Report then end", body: "events test", new_session: true })).body;
  const fired = sent.cloud.session_id;
  const child = async (method, path, body) => fetch(new URL(path, base), {
    method, headers: { Authorization: `Bearer ${ownerCloudToken}`, "Content-Type": "application/json", [SESSION_HEADER]: fired.replace(/^session_/, "cse_"), [CONTEXT_HEADER]: "events" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const name = (await child("GET", "/v1/me")).body.member;
  assert.equal((await child("PATCH", `/v1/tasks/${t.key}`, { state: "claim" })).status, 200);
  const rep = await child("POST", `/v1/tasks/${t.key}/report`, { verdict: "finished", summary: "Wrote it, no PR needed." });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const messageId = rep.body.message_id;
  assert.equal((await rest(ownerToken, "POST", "/v1/kill", { session: name, reason: "test over" })).body.killed, true);
  const text = (await callTool(ownerToken, "bridge_sessions", { member: OWNER, include: "ended" })).content[0].text;
  const line = text.split("\n").find((l) => l.includes(name));
  assert.ok(line, text);
  assert.match(line, new RegExp(`report finished message ${messageId}`));
  const ended = (await rest(ownerToken, "GET", "/v1/sessions?include=ended")).body.ended.find((e) => e.child === name);
  assert.equal(ended.report?.message_id, messageId);
  await drain(ownerToken); await drain(ownerCloudToken);
});

// The migration from the old task_events table, against the real module and an in-memory SQLite (as bookkeeping.test).
const sqlite = process.getBuiltinModule?.("node:sqlite");
function memorySql() {
  const db = new sqlite.DatabaseSync(":memory:");
  const cursor = (rows) => ({ toArray: () => rows, one: () => rows[0] });
  return { db, exec: (q, ...p) => (p.length === 0 && /;\s*\S/.test(q.trim()) ? (db.exec(q), cursor([])) : cursor(db.prepare(q).all(...p))) };
}
test("an old task_events table is copied into events in order, once; the view reads and takes inserts", { skip: !sqlite && "node:sqlite is not available" }, async () => {
  const { outputFiles } = buildSync({ entryPoints: [new URL("../src/hub/events.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
  const events = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
  const sql = memorySql();
  sql.exec(`CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX task_events_task ON task_events(task_id, id);`);
  for (const [task, kind] of [[7, "created"], [8, "created"], [7, "claimed"], [7, "comment"]]) {
    sql.exec(`INSERT INTO task_events (task_id, at, by, kind, data) VALUES (?, ?, '${OWNER}', ?, '{"n":1}')`, task, new Date().toISOString(), kind);
  }
  // A real transaction whose rename fails (a view already holds the name task_events_v1): the copy rolls back with it.
  const savepoint = (db) => (fn) => { db.exec("SAVEPOINT m"); try { fn(); db.exec("RELEASE m"); } catch (e) { db.exec("ROLLBACK TO m"); db.exec("RELEASE m"); throw e; } };
  sql.exec("CREATE VIEW task_events_v1 AS SELECT 1 AS x");
  assert.throws(() => events.initEvents(sql, savepoint(sql.db)), /task_events_v1|already/);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM events").one().n, 0, "the copied rows rolled back with the failed rename");
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM task_events").one().n, 4, "the old table is untouched");
  sql.exec("DROP VIEW task_events_v1");
  let wrapped = 0;
  events.initEvents(sql, (fn) => { wrapped++; fn(); });
  assert.equal(wrapped, 1, "the copy runs inside the transaction");
  const read = () => sql.exec("SELECT task_id, by, kind, data FROM task_events WHERE task_id = 7 ORDER BY id").toArray();
  assert.deepEqual(read().map((e) => e.kind), ["created", "claimed", "comment"], "rows copied in order, readable through the view");
  assert.equal(read()[0].by, OWNER);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM task_events_v1").one().n, 4, "the old table is kept, renamed");
  events.initEvents(sql, (fn) => { wrapped++; fn(); });
  assert.equal(wrapped, 1, "a second start does not migrate again");
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM events").one().n, 4, "and copies nothing twice");
  // Code that still inserts into task_events lands in events.
  sql.exec("INSERT INTO task_events (task_id, at, by, kind, data) VALUES (7, '2026-10-11T00:00:00.000Z', 'lane', 'rollup', '{}')");
  assert.deepEqual(read().map((e) => e.kind), ["created", "claimed", "comment", "rollup"]);
  assert.equal(sql.exec("SELECT subject_kind, subject_id FROM events ORDER BY id DESC LIMIT 1").one().subject_id, "7");
  // A leftover empty task_events_v1 from an interrupted try does not block the rename.
  const again = memorySql();
  again.exec("CREATE TABLE task_events_v1 (id INTEGER); CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');");
  again.exec(`INSERT INTO task_events (task_id, at, by, kind) VALUES (1, 'x', '${OWNER}', 'created')`);
  events.initEvents(again);
  assert.equal(again.exec("SELECT COUNT(*) AS n FROM task_events_v1").one().n, 1);
  assert.equal(again.exec("SELECT COUNT(*) AS n FROM task_events").one().n, 1);
});

test("cleanup", async () => {
  for (const key of made) await rest(ownerToken, "PATCH", `/v1/tasks/${key}`, { state: "dropped" });
  await drain(ownerToken); await drain(otherDeviceToken); await drain(otherToken);
});
