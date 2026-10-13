import { versionInfo } from "./version";
import { bundledConfig } from "./config/resolve";
import { BridgeError, bootSeconds, claimLeaseSeconds, claimSeconds, onlineSeconds, personOf, statusExpirySeconds, type Hub, type TrustMode } from "./hub";
import type { Env } from "./env";
import { board, boardTimes, groupRoster } from "./board";
import { doneInput, optInt, stampInput, queryFromParams, readJson, revertInput, sendInput, sessionInput, statusInput, taskInput } from "./inputs";
import { inboxWait } from "./inbox";
import { cloudAfterTask, sendToCloud, updateTask } from "./cloud";
import { json } from "./http";
import { household } from "./hub/roster";
import { handleCloudConfig } from "./cloudconfig";
import { fireNamed } from "./routines";

export async function handleRest(request: Request, url: URL, hub: DurableObjectStub<Hub>, member: string, members: string[], env: Env): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/v1/version") {
    // A pre-version Hub may still serve a long poll on old code. Report unavailable without inventing its version.
    let hubVersion: ReturnType<typeof versionInfo> | null = null;
    try { hubVersion = await hub.version(); } catch { /* contract checker permits one recovery deploy */ }
    return json({ worker: versionInfo(env.CF_VERSION_METADATA), hub: hubVersion });
  }
  // bin/contract-check.mjs records a passed post-deploy check here; /docs/status reports the last one.
  if (request.method === "POST" && path === "/v1/contract-check") {
    const engine = (await readJson(request)).engine;
    await hub.recordContractCheck(member, typeof engine === "string" ? engine : "");
    return json({ recorded: true });
  }
  if (request.method === "GET" && path === "/v1/me") {
    // `members` stays the people (and standalone members); devices are listed under their person.
    const { people, devices } = groupRoster(members);
    const person = personOf(member, members);
    // `trusted`: the people the owner let run this device in full mode (T-41); the responder reads it per message.
    const trusted = person === null ? [] : await hub.trustedOn(member);
    return json({
      member, person, members: people, devices, trusted,
      claim_seconds: claimSeconds(env), claim_lease_seconds: claimLeaseSeconds(env), boot_seconds: bootSeconds(env), online_seconds: onlineSeconds(env), status_expiry_seconds: statusExpirySeconds(env),
    });
  }
  if (request.method === "POST" && path === "/v1/send") {
    const body = await readJson(request);
    const { sent, cloud } = await sendToCloud(env, hub, member, members, sendInput(body), body.new_session === true);
    return json(cloud ? { ...sent, cloud } : sent);
  }
  if (request.method === "POST" && path === "/v1/routines/fire") {
    const fired = await fireNamed(env, hub, member, members, await readJson(request));
    return json({ message: fired.text, routine: fired.routine, session_id: fired.session_id, url: fired.url });
  }
  if (request.method === "POST" && path === "/v1/done") {
    const messageId = optInt((await readJson(request)).message_id);
    if (messageId === undefined) throw new BridgeError("message_id is required");
    return json(await hub.done(member, members, messageId));
  }
  if (request.method === "GET" && path === "/v1/inbox") {
    const wait = Number(url.searchParams.get("wait") ?? 0) || 0;
    const { messages, more } = await inboxWait(hub, member, members, wait, url.searchParams.get("peek") === "1");
    return json(messages, 200, { "Goonbridge-More": String(more), [`${bundledConfig.compatibility.headerPrefix}-More`]: String(more) });
  }
  // A cloud session's proof of life between bridge calls (the PostToolUse hook). The call itself is the heartbeat.
  if (request.method === "POST" && path === "/v1/heartbeat") return json(await hub.heartbeat(member));
  if (request.method === "POST" && path === "/v1/status") return json(await hub.setStatus(member, statusInput(await readJson(request))));
  if (request.method === "POST" && path === "/v1/sessions") {
    const posted = await hub.sessionPost(member, sessionInput(await readJson(request)));
    return "evicted" in posted ? json({ error: posted.evicted, evicted: true }, 410) : json(posted);
  }
  // Kill a session by id or bridge name: owner only; revokes the claim, tombstones it, tells it to stop at its next check-in.
  if (request.method === "POST" && path === "/v1/kill") {
    const body = await readJson(request);
    return json(await hub.kill(member, members, String(body.session ?? ""), typeof body.reason === "string" ? body.reason : undefined));
  }
  if (request.method === "GET" && path === "/v1/sessions") {
    const who = url.searchParams.get("member") ?? undefined;
    // include=ended adds fired sessions that are over; the default stays the plain list of live lanes.
    if (url.searchParams.get("include") === "ended") return json({ live: await hub.sessions(members, who), ended: await hub.endedSessions(members, who) });
    return json(await hub.sessions(members, who));
  }
  const sess = path.match(/^\/v1\/sessions\/([^/]+)\/([^/]+)$/);
  if (request.method === "GET" && sess) return json(await hub.sessionLog(decodeURIComponent(sess[1]), decodeURIComponent(sess[2])));
  if (request.method === "GET" && path === "/v1/cloud-config") return handleCloudConfig(request, url, env);
  // Orphaned tasks and cloud sessions that never booted or died without replying: faults, not clean finishes.
  if (request.method === "GET" && path === "/v1/faults") return json(await hub.faults());
  if (request.method === "GET" && path === "/v1/status") return json(board(members, await hub.statuses(), boardTimes(env)));
  if (request.method === "GET" && path === "/v1/threads") return json(await hub.threads(member, Number(url.searchParams.get("limit") ?? 20) || 20));
  const m = path.match(/^\/v1\/threads\/(\d+)$/);
  if (request.method === "GET" && m) return json(await hub.thread(member, members, Number(m[1])));
  // Manual revert on request: becomes a top-priority task for the owner's cloud agent naming the merge commits to undo.
  if (request.method === "POST" && path === "/v1/revert") {
    const task = await hub.revert(member, members, revertInput(await readJson(request)));
    const cloud = await cloudAfterTask(env, hub, members, task, task.thread_id, member);
    return json(cloud ? { ...task, cloud } : task);
  }
  if (path === "/v1/tasks" && request.method === "GET") return json(await hub.taskList(member, members, queryFromParams(url.searchParams)));
  if (path === "/v1/tasks" && request.method === "POST") {
    const task = await hub.taskCreate(member, members, taskInput(await readJson(request)));
    const cloud = await cloudAfterTask(env, hub, members, task, task.thread_id, member);
    return json(cloud ? { ...task, cloud } : task);
  }
  // Owner-only backfill of a done task's merge SHA (and live deploy) when no GitHub event recorded it.
  const st = path.match(/^\/v1\/tasks\/([^/]+)\/stamp$/);
  if (st && request.method === "POST") return json(await hub.stamp(member, members, decodeURIComponent(st[1]), stampInput(await readJson(request))));
  // Device trust (T-41): the owner grants or revokes full mode on one of their local devices; their household may read it.
  const dt = path.match(/^\/v1\/devices\/([^/]+)\/trust$/);
  if (dt) {
    const device = decodeURIComponent(dt[1]).trim().toLowerCase();
    if (request.method === "GET") {
      if (!household(member, members).includes(device)) throw new BridgeError(`unknown device "${device}" in your household`);
      return json({ device, trusted: await hub.trustedOn(device) });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      return json(await hub.setTrust(member, members, device, String(body.person ?? "").trim().toLowerCase(), String(body.mode ?? "") as TrustMode));
    }
  }
  // Errors (T-52): log one (repeats are counted), resolve one. Open ones are listed in GET /v1/faults.
  if (request.method === "POST" && path === "/v1/errors") return json(await hub.logError(member, await readJson(request)));
  const er = path.match(/^\/v1\/errors\/([^/]+)\/resolve$/);
  if (er && request.method === "POST") return json(await hub.resolveError(member, members, decodeURIComponent(er[1]), (await readJson(request)).note));
  // /report is task_report (any verdict); /done is the same with verdict finished.
  const t = path.match(/^\/v1\/tasks\/([^/]+)(\/done|\/report)?$/);
  if (t) {
    const key = decodeURIComponent(t[1]);
    if (!t[2] && request.method === "GET") return json(await hub.taskGet(key, optInt(url.searchParams.get("limit") ?? undefined)));
    if (!t[2] && request.method === "PATCH") {
      const { change, cloud, reviewer } = await updateTask(env, hub, member, members, key, taskInput(await readJson(request)));
      // T-55: a "ready for re-review" note reserved a reviewer for the PR's new head.
      return json({ ...change, ...(cloud ? { cloud } : {}), ...(reviewer ? { reviewer } : {}) });
    }
    if (t[2] && request.method === "POST") {
      const input = doneInput(await readJson(request));
      return json(await hub.taskDone(member, members, key, t[2] === "/done" ? { ...input, verdict: "finished" } : input));
    }
  }
  return json({ error: "not found" }, 404);
}
