import { deploymentDefaults } from "./deployment";
import { buildMcpInstructions, buildHelpText, buildMemberHelp, buildStatusHelp } from "./rules";
import { BridgeError, bridgeErrorMessage, type Hub, type TrustMode } from "./hub";
import type { Env } from "./env";
import { board, groupRoster, type BoardTimes } from "./board";
import { SERVER_INFO, TOOLS } from "./tools";
import { changeText, faultsText, format, ago, taskListText, taskText } from "./text";
import { inboxWait } from "./inbox";
import { doneInput, optInt, queryFromArgs, revertInput, sendInput, stampInput, statusInput, taskInput } from "./inputs";
import { cloudAfterTask, cloudText, sendToCloud, updateTask } from "./cloud";
import { fireNamed } from "./routines";
import { setupGuide } from "./pages";
import { json, rpcError } from "./http";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

export async function handleMcp(request: Request, hub: DurableObjectStub<Hub>, member: string, members: string[], origin: string, times: BoardTimes, env: Env, evicted: string | null = null): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, -32700, "parse error"), 400);
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const replies = [];
  for (const msg of batch as RpcRequest[]) {
    const reply = await handleRpc(msg, hub, member, members, origin, times, env, evicted);
    if (reply) replies.push(reply);
  }
  if (replies.length === 0) return new Response(null, { status: 202 });
  // A fresh Mcp-Session-Id on initialize: Streamable HTTP clients echo it on every later request, so a local Claude Code
  // window gets a child name of its own without any header config (see identify()). Later requests need not send it.
  const initialized = (batch as RpcRequest[]).some((m) => m?.method === "initialize");
  return json(Array.isArray(payload) ? replies : replies[0], 200, initialized ? { "Mcp-Session-Id": newSessionId() } : {});
}

// 16 random bytes, base64url: fits validSession (letters, digits, - and _).
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // validSession wants a letter or digit first; base64url can start with - or _.
  return /^[A-Za-z0-9]/.test(id) ? id : `s${id}`;
}

async function handleRpc(msg: RpcRequest, hub: DurableObjectStub<Hub>, member: string, members: string[], origin: string, times: BoardTimes, env: Env, evicted: string | null) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id ?? null, -32600, "invalid request");
  if (msg.id === undefined || msg.id === null) return null;
  const id = msg.id as string | number;

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: buildMcpInstructions(deploymentDefaults, member),
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      // A killed session's next tool call, whichever it is, comes back as the order to stop.
      if (evicted) return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: evicted }] } };
      try {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: await callTool(name, args, hub, member, members, origin, times, env) }] } };
      } catch (err) {
        const message = bridgeErrorMessage(err);
        if (message !== null) return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: message }] } };
        throw err;
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>, hub: DurableObjectStub<Hub>, member: string, members: string[], origin: string, times: BoardTimes, env: Env): Promise<string> {
  switch (name) {
    case "bridge_send": {
      const { sent, cloud } = await sendToCloud(env, hub, member, members, sendInput(args), args.new_session === true);
      return `Sent message ${sent.id} to ${sent.recipient} in thread ${sent.thread_id} ("${sent.subject}").${cloudText(cloud)}`;
    }
    case "fire_routine":
      return (await fireNamed(env, hub, member, members, args)).text;
    case "bridge_inbox": {
      const { messages, more } = await inboxWait(hub, member, members, optInt(args.wait_seconds) ?? 0, args.peek === true);
      if (messages.length === 0) return "No unread messages.";
      const tail = more > 0 ? `\n\n${more} more waiting, call bridge_inbox again.` : "";
      return `${messages.length} unread message(s) for ${member}. Reply with bridge_send using the thread_id, or call bridge_done with the message_id if no reply is needed.\n\n${messages.map((m) => format(m)).join("\n\n")}${tail}`;
    }
    case "bridge_done": {
      const messageId = optInt(args.message_id);
      if (messageId === undefined) throw new BridgeError("message_id is required");
      await hub.done(member, members, messageId);
      return `Message ${messageId} marked done.`;
    }
    case "bridge_thread": {
      const threadId = optInt(args.thread_id);
      if (threadId === undefined) throw new BridgeError("thread_id is required");
      return (await hub.thread(member, members, threadId)).map((m) => format(m)).join("\n\n");
    }
    case "bridge_threads": {
      const rows = await hub.threads(member, optInt(args.limit) ?? 20);
      if (rows.length === 0) return "No threads yet.";
      return rows
        .map((t) => `#${t.thread_id} "${t.subject}" ${t.started_by} -> ${t.with}, ${t.messages} message(s), last from ${t.last_from} at ${t.last_at}`)
        .join("\n");
    }
    case "bridge_help":
      return buildHelpText(deploymentDefaults, setupGuide(origin), member, members);
    case "bridge_members": {
      const { people, devices } = groupRoster(members);
      const online = new Set(board(members, await hub.statuses(), times).filter((e) => e.online).map((e) => e.member));
      const lines = people.map((p) => {
        const own = devices[p] ?? [];
        return own.length ? `- ${p}: devices ${own.map((d) => `${d} (${online.has(d) ? "online" : "offline"})`).join(", ")}` : `- ${p}`;
      });
      return buildMemberHelp(deploymentDefaults, member, lines);
    }
    case "bridge_status_set": {
      const row = await hub.setStatus(member, statusInput(args));
      return `Status for ${member}: ${row.state}${row.repo ? ` in ${row.repo}` : ""}${row.branch ? ` on ${row.branch}` : ""}.`;
    }
    case "bridge_status": {
      const entries = board(members, await hub.statuses(), times);
      const lines = entries.map((e) => {
        const where = [e.repo, e.branch].filter(Boolean).join(" @ ");
        const detail = `${where ? ` · ${where}` : ""}${e.summary ? ` · ${e.summary}` : ""}`;
        const claim = !e.state || e.age_seconds === null
          ? "no status posted"
          : e.expired
            ? `idle (claim expired; posted ${ago(e.age_seconds)}${detail})`
            : `${e.state} · ${ago(e.age_seconds)}${detail}`;
        return `${e.member} · ${e.online ? "online" : "offline"} · ${claim}`;
      });
      return buildStatusHelp(deploymentDefaults, lines);
    }
    case "bridge_sessions": {
      const who = typeof args.member === "string" && args.member ? args.member : undefined;
      const rows = await hub.sessions(members, who);
      const now = Date.now();
      const live = rows.length === 0 ? "No live sessions." : rows.map((r) => `${r.member} · ${r.session}${r.title ? ` · ${r.title}` : ""} · ${ago(Math.round((now - r.updated_at) / 1000))}${r.liveness ? ` · ${r.liveness}` : ""}${r.last_line ? `\n  ${r.last_line}` : ""}`).join("\n");
      if (args.include !== "ended") return live;
      const gone = await hub.endedSessions(members, who);
      return `${live}\n\nEnded:\n${gone.map((f) => `${f.child ?? `${f.parent} (never checked in)`} · ${f.session_id} · ${f.fault ?? "silent"} · ended ${ago(Math.round((now - (f.ended_at ?? f.fired_at)) / 1000))}` +
        (f.report ? ` · report ${f.report.verdict} message ${f.report.message_id ?? "none"} (event ${f.report.event_id})` : "") +
        (f.work_thread ? ` · work thread ${f.thread_id}, ${f.task_key ?? "no task"}` : "") +
        (f.member && f.session ? ` · bridge_session_log member=${f.member} session=${f.session}` : "")).join("\n") || "none"}`;
    }
    case "bridge_session_log": {
      const { session, lines } = await hub.sessionLog(String(args.member ?? ""), String(args.session ?? ""));
      const head = `${session.member} · ${session.session}${session.title ? ` · ${session.title}` : ""}${session.cwd ? ` · ${session.cwd}` : ""}`;
      return `${head}\n${lines.map((l) => `${new Date(l.at).toISOString().slice(11, 16)} ${l.line}`).join("\n") || "(no lines yet)"}`;
    }
    case "task_create": {
      const task = await hub.taskCreate(member, members, taskInput(args));
      const sentTo = task.assignee ?? task.owner;
      const cloud = await cloudAfterTask(env, hub, members, task, task.thread_id, member);
      return `Created ${task.key} for ${task.owner} (${task.state}, P${task.priority}): "${task.title}". ` +
        `Thread ${task.thread_id} holds the brief${sentTo === member ? "" : `, sent to ${sentTo}`}; comments go there with task_update note.${cloudText(cloud)}`;
    }
    case "task_list": {
      const query = queryFromArgs(args);
      const tasks = await hub.taskList(member, members, query);
      const scope = (query.scope ?? "mine").trim().toLowerCase() || "mine";
      const owners = scope === "all" ? groupRoster(members).people : [];
      return taskListText(tasks, owners, scope, member);
    }
    case "task_get": {
      const { task, events, total, children, rollup } = await hub.taskGet(String(args.key ?? ""), optInt(args.limit));
      return taskText(task, events, total, { children, rollup });
    }
    case "task_update": {
      const { change, cloud, reviewer } = await updateTask(env, hub, member, members, String(args.key ?? ""), taskInput(args));
      const reviewed = reviewer ? (reviewer.ok ? ` A reviewer was started for the new head: ${reviewer.url}.` : ` A reviewer could not be started: ${reviewer.error}.`) : "";
      return `${changeText(change, member)}${cloudText(cloud)}${reviewed}`;
    }
    case "revert": {
      const task = await hub.revert(member, members, revertInput(args));
      const cloud = await cloudAfterTask(env, hub, members, task, task.thread_id, member);
      return `Revert requested as ${task.key} (P1, ${task.assignee ?? "unassigned"}): "${task.title}". Thread ${task.thread_id} lists the merge commits and the steps; the session reports there.${cloudText(cloud)}`;
    }
    case "kill": {
      const out = await hub.kill(member, members, String(args.session ?? ""), typeof args.reason === "string" ? args.reason : undefined);
      return out.message;
    }
    case "bridge_trust": {
      const device = String(args.device ?? "").trim().toLowerCase();
      const out = await hub.setTrust(member, members, device, String(args.person ?? "").trim().toLowerCase(), String(args.mode ?? "") as TrustMode);
      const what = out.mode === "full" ? `full (granted by ${member})` : "read (revoked)";
      return `Trust on ${out.device}: ${out.person} ${what}${out.changed ? "" : "; it already was"}.`;
    }
    case "task_stamp": {
      const out = await hub.stamp(member, members, String(args.key ?? ""), stampInput(args));
      return out.message;
    }
    // task_report is the canonical report (T-52); task_done is the same call with verdict finished.
    case "task_report":
    case "task_done": {
      const input = doneInput(args);
      const change = await hub.taskDone(member, members, String(args.key ?? ""), name === "task_done" ? { ...input, verdict: "finished" } : input);
      const finished = name === "task_done" || (input.verdict ?? "finished").trim().toLowerCase() === "finished";
      const next = !finished ? "Recorded; the state is unchanged." : change.task.pr_url ? "It is done when its PR merges to trunk." : "No PR on it yet: open one and set pr_url; the task is done when the PR merges.";
      return `${changeText(change, member)} ${next}`;
    }
    case "error_log": {
      const e = await hub.logError(member, { command: args.command, outcome: args.outcome });
      const prior = e.previously_resolved ? ` It was previously resolved by ${e.previously_resolved.by}${e.previously_resolved.note ? `: ${e.previously_resolved.note}` : ""}.` : "";
      return e.count === 1 ? `Logged ${e.id} (first time). Resolve it with error_resolve when fixed.` : `Logged ${e.id} again: seen ${e.count} times.${prior}`;
    }
    case "error_resolve": {
      const r = await hub.resolveError(member, members, String(args.id ?? ""), args.note);
      return r.already ? `${r.id} was already resolved.` : `${r.id} resolved.`;
    }
    case "bridge_faults":
      return faultsText(await hub.faults());
    default:
      throw new BridgeError(`unknown tool: ${name}`);
  }
}
