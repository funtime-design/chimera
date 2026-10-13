import type { Faults, Message, Rollup, Task, TaskChange, TaskEvent, TaskSummary, ThreadMessage } from "./hub";

function taskLine(t: TaskSummary): string {
  const where = [t.repo, t.branch].filter(Boolean).join(" @ ");
  return [
    t.key, t.kind === "epic" ? `epic ${t.state}` : t.state, `P${t.priority}`, t.title,
    t.assignee ? `-> ${t.assignee}` : "",
    where,
    t.due ? `due ${t.due}` : "",
    t.labels.length ? t.labels.map((l) => `#${l}`).join(" ") : "",
    t.pr_url ?? "",
    t.orphaned_at ? `ORPHANED (was ${t.orphaned_from})` : "",
  ].filter(Boolean).join(" · ");
}

// Grouped by owner; with scope all every person gets a heading, so the backlogs read side by side.
export function byOwner(tasks: TaskSummary[], owners: string[]): Map<string, TaskSummary[]> {
  const groups = new Map<string, TaskSummary[]>(owners.map((o) => [o, []]));
  for (const t of tasks) {
    const list = groups.get(t.owner) ?? [];
    list.push(t);
    groups.set(t.owner, list);
  }
  return groups;
}

export function taskListText(tasks: TaskSummary[], owners: string[], scope: string, member: string): string {
  if (tasks.length === 0 && owners.length === 0) return `No tasks (scope ${scope}, as ${member}).`;
  const blocks = [...byOwner(tasks, owners)].map(([owner, list]) =>
    `${owner} (${list.length})${list.length ? `\n${grouped(list).join("\n")}` : ""}`);
  return `${blocks.join("\n\n")}\n\ntask_get <key> reads the brief and history.`;
}

// An epic in the list is followed by its rollup line and the children listed with it, indented; the rest as before.
function grouped(list: TaskSummary[]): string[] {
  const epics = new Set(list.filter((t) => t.kind === "epic").map((t) => t.key));
  const out: string[] = [];
  for (const t of list) {
    if (t.parent && epics.has(t.parent)) continue;
    out.push(`  ${taskLine(t)}`);
    if (t.kind !== "epic") continue;
    if (t.rollup) out.push(`      ${rollupLine(t.rollup)}`);
    for (const c of list.filter((x) => x.parent === t.key)) out.push(`      ${taskLine(c)}`);
  }
  return out;
}

export function rollupLine(r: Rollup): string {
  const deploy = Object.entries(r.deploy).map(([s, k]) => `${k} deploy ${s}`);
  return [`${r.done}/${r.total} done`, r.review ? `${r.review} in review` : "", r.blocked ? `${r.blocked} blocked` : "",
    r.orphaned ? `${r.orphaned} orphaned` : "", r.ci_red ? `${r.ci_red} ci-red` : "", ...deploy].filter(Boolean).join(", ");
}

function short(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function taskText(t: Task, events: TaskEvent[], total = events.length, epic: { children?: TaskSummary[]; rollup?: Rollup } = {}): string {
  const lines = [
    `${t.key} · ${t.title}`,
    `owner ${t.owner} · assignee ${t.assignee ?? "none"} · ${t.kind === "epic" ? "epic, " : ""}${t.state} · P${t.priority} · version ${t.version}${t.parent ? ` · part of epic ${t.parent}` : ""}`,
    ...(epic.children && epic.rollup ? [`Children (${epic.children.length}, ${rollupLine(epic.rollup)}; the epic's state follows them):`, ...epic.children.map((c) => `  ${taskLine(c)}`)] : []),
    ...[[t.repo ? `repo ${t.repo}` : "", t.branch ? `branch ${t.branch}` : "", t.pr_url ? `PR ${t.pr_url}` : "", t.labels.length ? `labels ${t.labels.join(", ")}` : "", t.due ? `due ${t.due}` : ""]
      .filter(Boolean).join(" · ")].filter(Boolean),
    ...(t.claim_session ? [`claim held by ${t.claim_session}, last heartbeat ${t.claim_beat_at ? ago(Math.max(0, Math.round((Date.now() - t.claim_beat_at) / 1000))) : "never"}`] : []),
    ...(t.orphaned_at ? [`ORPHANED: ${t.orphaned_from} held it and went silent (${t.orphan_reason}) ${ago(Math.max(0, Math.round((Date.now() - t.orphaned_at) / 1000)))}; it is back to ready and unfinished`] : []),
    ...(t.merged_sha ? [`MERGED ${t.merged_sha.slice(0, 10)} · ${t.deploy_state === "live" ? "deployed and LIVE" : t.deploy_state === "failed" ? "DEPLOY FAILED, not live" : t.deploy_state === "not_seen" ? "DEPLOY NOT SEEN, not known to be live" : "deploy pending, not known to be live yet"}`] : []),
    `created by ${t.created_by} at ${t.created_at} · updated ${t.updated_at}${t.closed_at ? ` · closed by ${t.closed_by} at ${t.closed_at}` : ""}`,
    `Thread ${t.thread_id} holds the brief and every comment: bridge_thread with thread_id ${t.thread_id}. Comment with task_update note.`,
    "",
    "Brief:",
    t.brief,
    "",
    events.length < total ? `Events (${events.length} of ${total}, oldest first):` : `Events (all ${total}, oldest first):`,
    ...events.map((e) => `- ${e.at} ${e.by} ${e.kind}${Object.keys(e.data).length ? ` ${Object.entries(e.data).map(([k, v]) => `${k}=${short(v)}`).join(", ")}` : ""}`),
  ];
  return lines.join("\n");
}

// bridge_faults: GET /v1/faults as text, for the phone. Open errors, failed fires and orphaned tasks.
export function faultsText(f: Faults): string {
  const at = (ms: number) => ago(Math.max(0, Math.round((Date.now() - ms) / 1000)));
  const errors = f.errors.map((e) => `- ${e.id} · seen ${e.count} time${e.count === 1 ? "" : "s"} · last by ${e.last_by} ${e.last_at}\n  ${e.command}\n  -> ${e.outcome}`);
  const fires = f.fires.map((x) => `- ${x.fault} · ${x.child ?? x.session_id ?? "no session"}${x.task_key ? ` · ${x.task_key}` : ""} · thread ${x.thread_id} · ${at(x.fault_at)}${x.error ? ` · ${x.error}` : ""}`);
  const orphans = f.orphaned_tasks.map((t) => `- ${t.key} · ${t.title} · ${t.state} · was ${t.orphaned_from} (${t.reason ?? "?"}) · ${at(t.orphaned_at)}`);
  const block = (title: string, rows: string[]) => `${title} (${rows.length}):${rows.length ? `\n${rows.join("\n")}` : " none"}`;
  return [block("Open errors", errors), block("Fire faults", fires), block("Orphaned tasks", orphans)].join("\n\n") + "\n\nResolve an error with error_resolve <id>.";
}

export function changeText(c: TaskChange, member: string): string {
  const t = c.task;
  const changes = c.changed.filter((f) => f !== "closed_at" && f !== "closed_by").map((f) => `${f} ${short(f === "brief" ? "(new brief)" : (t as Record<string, unknown>)[f] ?? "none")}`);
  const head = changes.length ? `${t.key} is now version ${t.version}: ${changes.join(", ")}.` : `No change to ${t.key} (version ${t.version}).`;
  const posted = c.message_id === null ? "" : c.posted_to === member ? ` Posted in thread ${t.thread_id}.` : ` Posted in thread ${t.thread_id} to ${c.posted_to}.`;
  const notice = c.notified ? ` ${c.notified} was told you reported it ${c.verdict ?? "finished"}.` : t.state === "done" && c.changed.includes("state") ? " You own it, so no notice was sent." : "";
  return `${head}${posted}${notice}`;
}

export function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function format(m: Message | ThreadMessage): string {
  const status = "status" in m ? ` · ${Object.entries(m.status).map(([who, state]) => `${who}: ${state}`).join(", ")}` : "";
  return `--- thread ${m.thread_id} · message ${m.id} · from ${m.sender} to ${m.recipient} · ${m.created_at}${status}\nSubject: ${m.subject}\n\n${m.body}`;
}
