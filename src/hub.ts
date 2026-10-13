import { versionInfo } from "./version";
import { cloudParentOf } from "./config/names";
import { DurableObject } from "cloudflare:workers";
import type { Message, SendInput, SessionInput, SessionLine, SessionRow, StatusInput, StatusRow, Task, TaskChange, TaskEvent, TaskInput, TaskQuery, TaskSummary, ThreadMessage } from "./hub/schema";
import { initSchema } from "./hub/schema";
import { bootSeconds, claimLeaseSeconds, claimSeconds, deploySeconds } from "./hub/settings";
import * as messages from "./hub/messages";
import * as status from "./hub/status";
import * as sessions from "./hub/sessions";
import * as tasks from "./hub/tasks";
import * as devices from "./hub/devices";
import * as registered from "./hub/registered.ts";
import * as trust from "./hub/trust";
import * as claims from "./hub/claims";
import * as faults from "./hub/faults";
import * as events from "./hub/events";
import * as github from "./hub/github";
import * as killing from "./hub/kill";
import * as workthread from "./hub/workthread";
import { stampTask, type StampInput, type StampResult } from "./hub/stamp";
import { revertTask, type RevertInput } from "./hub/revert";
import { BridgeError } from "./hub/validate";

// What a routed send decided for a cloud parent: a live session gets it (`session` names it), or the fire intent row
// `fire` was written and the Worker must call the routines API for it.
export type CloudRoute = { live: boolean; session: string | null; fire?: number; note?: string; task_key?: string | null };

export {
  INBOX_LIMIT, MAX_BODY, MAX_SUMMARY, MAX_TASK_TITLE, MAX_THREAD_MESSAGES, TASK_LIST_LIMIT, TASK_STATES,
} from "./hub/schema";
export type { Rollup } from "./hub/schema";
export type {
  DeliveryState, Message, SendInput, SessionInput, SessionLine, SessionRow, StatusInput, StatusRow, Task, TaskChange, TaskEvent, TaskInput, TaskQuery, TaskSummary, ThreadMessage,
} from "./hub/schema";
export type { GithubEvent, WebhookResult, ReviewRequest } from "./hub/github";
export type { RevertInput } from "./hub/revert";
export type { KillResult } from "./hub/kill";
export type { StampInput, StampResult } from "./hub/stamp";
export type { TrustMode, TrustResult, TrustRow } from "./hub/trust";
export type { ClaimRecord, Faults, Fire } from "./hub/faults";
export type { ErrorLogged } from "./hub/events";
export type { EndedLane } from "./hub/sessions";
export { bootSeconds, claimLeaseSeconds, claimSeconds, deploySeconds, onlineSeconds, statusExpirySeconds } from "./hub/settings";
export { BRIDGE_ERROR_PREFIX, BridgeError, bridgeErrorMessage } from "./hub/validate";
export { personOf, receivesAll } from "./hub/roster";

// One hub holds every thread; traffic is two people's agents, so a single object keeps ordering simple.
// Every method here is called over Durable Object RPC from the Worker; the logic lives in ./hub/.
export class Hub extends DurableObject {
  private sql: SqlStorage;
  private readonly codeVersion: ReturnType<typeof versionInfo>;
  private waiters: messages.Waiters = new Set();
  private claimMs: number;
  private leaseMs: number;
  private bootMs: number;
  private deployMs: number;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.codeVersion = versionInfo((env as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA);
    this.sql = ctx.storage.sql;
    this.claimMs = claimSeconds(env) * 1000;
    this.leaseMs = claimLeaseSeconds(env) * 1000;
    this.bootMs = bootSeconds(env) * 1000;
    this.deployMs = deploySeconds(env) * 1000;
    initSchema(this.sql, (fn) => ctx.storage.transactionSync(fn));
    devices.initDevices(this.sql);
    registered.initRegistered(this.sql);
    trust.initTrust(this.sql);
    faults.initFaults(this.sql);
    github.initGithub(this.sql);
    killing.initKill(this.sql);
  }

  // Return this object instance's code identity, never the calling Worker's version.
  version() { return this.codeVersion; }

  // Judges what nobody is looking at: claims whose session went silent are released as orphans, and fires whose session
  // never booted or died without replying are flagged. Runs on the alarm while there is open work, and before any read of faults.
  private sweep(): void {
    claims.releaseStale(this.sql, this.waiters, this.leaseMs);
    faults.sweepFires(this.sql, this.waiters, this.bootMs, this.leaseMs);
    // Whatever ended a dead session, what was routed or reserved to it goes back to its parent's inbox.
    messages.handBackDead(this.sql, this.waiters, this.leaseMs);
    github.sweepDeploys(this.sql, this.waiters, this.deployMs);
    // A reviewer dispatch that has not reported back within the boot window (in production 300 s, past the 20 s fire timeout).
    github.sweepReviews(this.sql, this.waiters, this.bootMs);
  }

  // Keeps the sweep running while a claim or fire is waiting to be judged.
  private async arm(): Promise<void> {
    if (!faults.openWork(this.sql) || (await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + Math.max(1000, Math.min(60_000, Math.floor(this.leaseMs / 2))));
  }

  async alarm(): Promise<void> {
    this.sweep();
    await this.arm();
  }

  // A routine was fired for a message: remember which session it started, so a claim ties to a live session.
  // `text`, when given, is what the session was told: a taskless fire about real work is flagged (T-58).
  async recordFire(fire: faults.Fire, text = "", members: string[] = []): Promise<void> {
    const id = faults.recordFire(this.sql, fire);
    if (text) workthread.flagWorkThread(this.sql, this.waiters, id, text, members);
    await this.arm();
  }

  // T-69: the intent row of a fire, written before the routines API is called; then filled in, or marked failed.
  async intendFire(intent: faults.Intent): Promise<number> {
    const id = faults.intendFire(this.sql, intent);
    await this.arm();
    return id;
  }

  fired(id: number, sessionId: string, url: string): void {
    faults.fired(this.sql, id, sessionId, url);
  }

  fireFailed(id: number, error: string): void {
    faults.fireFailed(this.sql, this.waiters, id, error);
  }

  async faults(): Promise<faults.Faults> {
    this.sweep();
    await this.arm();
    return faults.faults(this.sql);
  }

  // Who a request acts as: a cloud session's own child name when `parent` (its cloud device) and `session` are given,
  // and the children addressable now (seen within the claim lease, at least `onlineMs`) and the registered devices, who
  // are members next to the roster. A child stays addressable while it has called the bridge within the claim lease (any call; the in-run process heartbeat alone keeps its claims but does not keep it addressable or routable) (T-50).
  async identify(parent: string | null, session: string | null, context: string | null, roster: string[], onlineMs: number, leaving = false, signal: devices.Signal = "call"): Promise<{ member: string | null; children: string[]; registered: string[]; evicted?: string }> {
    const names = registered.registeredDevices(this.sql).map((d) => d.name);
    // A killed session's check-in is refused before it can refresh anything: no heartbeat, no lane stamp, no revival.
    const evicted = session ? killing.evictionFor(this.sql, session) : null;
    if (evicted) return { member: null, children: devices.activeChildren(this.sql, Math.max(onlineMs, this.leaseMs)), registered: names, evicted };
    // A new child name must miss the registered devices too (a label may be "cloud-x7k"), so they count as roster here.
    const before = parent && session ? devices.lastSeen(this.sql, parent, session) : null;
    const member = parent && session ? devices.childFor(this.sql, parent, session, context, [...roster, ...names], signal) : null;
    // Any call from a cloud session is a heartbeat for the claims it holds, and takes back what a false orphan release
    // took, unless the call is the session saying it is going offline (`leaving`).
    if (member) {
      // A restored claim needs the sweep again: the alarm may have stopped when the release left nothing open.
      if (!leaving && this.resurface(member, before)) await this.arm();
      claims.beat(this.sql, member);
      sessions.touch(this.sql, member, session!, context);
      if (parent && session) {
        // A task attached to its work thread before it checked in is the session's to claim now (T-58).
        for (const key of faults.linkSession(this.sql, parent, session, member)) workthread.claimFor(this.sql, this.waiters, member, roster, key);
      }
    }
    return { member, children: devices.activeChildren(this.sql, Math.max(onlineMs, this.leaseMs)), registered: names };
  }

  // A session released for silence speaks again within two leases: its claims and its fire faults are lifted (T-48).
  // Only a session silent for at least a lease before this call can have been released, so a live one costs no query.
  // A taskless session has no claim to restore, but its died_without_reply fault is lifted all the same. Returns whether
  // a claim was restored.
  private resurface(child: string, seenBefore: number | null): boolean {
    if (seenBefore === null || seenBefore > Date.now() - this.leaseMs) return false;
    const restored = claims.resurface(this.sql, this.waiters, child, this.leaseMs * 2).length > 0;
    faults.resurfaceFires(this.sql, this.waiters, child);
    return restored;
  }

  // A person's own device, registered by signing in (see hub/registered.ts). `roster` is the static roster from env.
  checkDevice(person: string, name: string, roster: string[]): string | null {
    return registered.checkDevice(this.sql, person, name, roster);
  }

  registerDevice(person: string, name: string, roster: string[]): { name: string; created: boolean } {
    return registered.registerDevice(this.sql, person, name, roster);
  }

  registeredDevices(): { name: string; person: string; created_at: number }[] {
    return registered.registeredDevices(this.sql);
  }

  forgetDevice(name: string): boolean {
    return registered.forgetDevice(this.sql, name);
  }

  // Device trust (see hub/trust.ts): the owner lets another person run one of their local devices in full mode.
  setTrust(caller: string, members: string[], device: string, person: string, mode: trust.TrustMode): trust.TrustResult {
    return trust.setTrust(this.sql, caller, members, device, person, mode);
  }

  trustedOn(device: string): string[] {
    return trust.trustedOn(this.sql, device);
  }

  trustRows(devices: string[]): trust.TrustRow[] {
    return trust.trustRows(this.sql, devices);
  }

  send(sender: string, members: string[], input: SendInput): Message {
    return messages.send(this.sql, this.waiters, sender, members, input);
  }

  // A send from a caller (bridge_send, POST /v1/send). For a <person>-cloud recipient whose person has a routine
  // (`cloud.people`), who gets it is decided before it is stored, in this one call, so no sibling session polling the
  // parent's inbox can take it in between (T-50):
  //   - a message about a task held by a live session of this parent goes to that session's own inbox;
  //   - a task held by a session that is not a cloud session (a Mac window) is refused, naming it;
  //   - a message that needs a new session (new_session, or nobody live) gets a fire intent row (T-69), written here, and
  //     is reserved for the session that fire starts; the Worker then calls the routines API (route.fire is the row);
  //   - a message for a task or thread whose fire is still starting joins that fire instead of starting another;
  //   - anything else (no task, some session live) stays in the parent's inbox, and the route names the live session.
  async sendRouted(sender: string, members: string[], input: SendInput, cloud: { people: string[]; forceNew: boolean; onlineMs: number }): Promise<{ message: Message; route: CloudRoute | null }> {
    // `task: T-n` / `task: new` in a flagged work thread (T-58) attaches a task. It is an answer to the bridge, not a
    // message: the record is a system note to the sender (already done); nothing is routed, acked or fired.
    const attached = input.thread_id ? workthread.attachCommand(this.sql, this.waiters, sender, members, input.thread_id, input.body ?? "") : null;
    if (attached) {
      await this.arm();
      return { message: attached, route: { live: false, session: null, note: attached.body.slice(attached.body.indexOf("Attached")) } };
    }
    // The router runs inside messages.send, before the insert, and nothing in between awaits: the decision, the fire
    // intent row and the reserved message are written in one turn of the Durable Object, so no poll can see a gap.
    const routing = this.cloudRouter(sender, cloud);
    const message = messages.send(this.sql, this.waiters, sender, members, input, routing.router);
    return { message, route: await this.settleRoute(message, routing.route(), members) };
  }

  // The routing decision for a message to a <person>-cloud parent, shared by bridge_send (sendRouted) and a task_update
  // note (taskUpdate, T-56). The task is the one whose thread this is (tasks.thread_id), else the one the subject names.
  private cloudRouter(sender: string, cloud: { people: string[]; forceNew?: boolean; onlineMs: number }): tasks.NoteRouter & { route: () => CloudRoute | null } {
    let route: CloudRoute | null = null;
    // Would the router decide anything for this parent? (A person with no routine, or a device of the same person: no.)
    const applies = (to: string) => cloudParentOf(to) !== null && cloud.people.includes(cloudParentOf(to)!) &&
      (!!cloud.forceNew || !(sender.includes("-") && sender.split("-")[0] === to.split("-")[0]));
    const router: messages.Router = (to, subject, threadId) => {
      if (cloudParentOf(to) === null || !cloud.people.includes(cloudParentOf(to)!)) return null;
      const key = (threadId ? tasks.taskByThread(this.sql, threadId)?.key : null) ?? /^Task (T-\d+):/.exec(subject)?.[1] ?? null;
      // The intent row is written now; its message and thread ids are filled in once the message exists (settleRoute).
      const fire = () => {
        const id = faults.intendFire(this.sql, { member: to, requester: sender, message_id: 0, thread_id: threadId ?? 0, task_key: key });
        route = { live: false, session: null, fire: id, task_key: key };
        return { reserved_for: messages.fireTag(id) };
      };
      if (cloud.forceNew) return fire();
      // A device of the same person starts cloud sessions itself (the Mac responder does): its sends fire nothing.
      if (sender.includes("-") && sender.split("-")[0] === to.split("-")[0]) return null;
      const now = this.cloudLive(to, key, cloud.onlineMs, threadId);
      if (now.held) throw new BridgeError(`${key} is held by ${now.held}; send to it directly or take over the claim.`);
      if (now.note) {
        route = { live: false, session: now.session, note: now.note, task_key: key };
        return null;
      }
      if (!now.live) return fire();
      route = { live: true, session: now.session, task_key: key };
      if (now.fire !== undefined) return { reserved_for: messages.fireTag(now.fire) };
      return key && now.session && devices.parentOf(this.sql, now.session) === to ? { to: now.session } : null;
    };
    return { applies, router, route: () => route };
  }

  // A fire's intent row gets its message and thread; a taskless fire about work flags its thread (T-58).
  private async settleRoute(message: Message, route: CloudRoute | null, members: string[]): Promise<CloudRoute | null> {
    if (route?.fire !== undefined && !route.live) {
      this.sql.exec("UPDATE cloud_fires SET message_id = ?, thread_id = ? WHERE id = ?", message.id, message.thread_id, route.fire);
      workthread.flagWorkThread(this.sql, this.waiters, route.fire, message.body, members);
      await this.arm();
    }
    return route;
  }

  inbox(member: string, members: string[], waitSeconds = 0, peek = false): Promise<{ messages: Message[]; more: number }> {
    return messages.inbox(this.sql, this.waiters, this.claimMs, member, members, waitSeconds, peek);
  }

  // A bridge notice (fire started, auto-review started) in a thread `caller` can see, posted as system (T-67).
  notice(caller: string, members: string[], threadId: number, body: string, to?: string): Message {
    return messages.notice(this.sql, this.waiters, caller, members, threadId, body, to);
  }

  done(member: string, members: string[], messageId: number): { message_id: number; done_at: string } {
    return messages.done(this.sql, member, members, messageId);
  }

  thread(member: string, members: string[], threadId: number): ThreadMessage[] {
    return messages.thread(this.sql, this.claimMs, member, members, threadId);
  }

  threads(member: string, limit = 20): messages.ThreadSummary[] {
    return messages.threads(this.sql, member, limit);
  }

  // A task assigned to a cloud parent (cloud.ts cloudAfterTask): whether a session is live, the join of a fire that is
  // starting, and a new fire's intent row are decided in this one call, as sendRouted does for a send, so a routed send for
  // the same task in between cannot start a second session. The brief (the thread's first message), when it is the
  // parent's, is reserved for the fire it waits for, so no sibling takes it. `brief` is null when the thread has none.
  async assignFire(parent: string, taskKey: string, threadId: number, onlineMs: number): Promise<{ live: boolean; session: string | null; held?: string; note?: string; fire?: number; brief: Message | null }> {
    const now = this.cloudLive(parent, taskKey, onlineMs);
    if (now.held || now.note) return { ...now, brief: null };
    const brief = messages.firstOf(this.sql, threadId) ?? null;
    const reserve = (id: number) => {
      if (brief?.recipient === parent) this.sql.exec("UPDATE messages SET reserved_for = ? WHERE id = ? AND reserved_for IS NULL", messages.fireTag(id), brief.id);
    };
    if (now.live) {
      if (now.fire !== undefined) reserve(now.fire);
      return { ...now, brief };
    }
    if (!brief) return { live: false, session: null, brief: null };
    const fire = faults.intendFire(this.sql, { member: parent, requester: brief.sender, message_id: brief.id, thread_id: brief.thread_id, task_key: taskKey });
    reserve(fire);
    await this.arm();
    return { live: false, session: null, fire, brief };
  }

  // The heartbeat itself happens in identify(); this is the endpoint a hook can call to make one.
  heartbeat(member: string): { member: string; claims: number } {
    return { member, claims: this.sql.exec("SELECT 1 FROM tasks WHERE claim_session = ?", member).toArray().length };
  }

  // Should a message for a cloud parent start a new session? `taskKey` is the task it is about, when it names one.
  // With a task, liveness is TASK-level: live only if a session is heartbeating AND holds the claim for THAT task.
  // An unclaimed (or unknown) task is never live, whoever else is around: a session busy on task A must not swallow a
  // send for task B. A stale claim is released first, so the fresh session can claim the task.
  // With no task, any session of the parent showing life counts. `onlineMs` is only the fallback for a session that
  // sends no session id (no child name, nothing to heartbeat): its last poll or status post.
  // `session` is the real child (or member) that will pick the message up, so callers can report an id.
  // The claimant must be this parent's: another person's cloud session holding the task says nothing about whether this
  // parent has a session on it. A Mac session (a child of a device that is not a cloud parent) holding it is `held`: its
  // inbox is not this parent's and it is never released for silence, so the caller names it instead of firing.
  // Not live yet, but a fire for the same task (or, with no task, the same thread) is still starting or its session is
  // up and unclaimed: that counts as live (T-69), with `fire` set while the session has not called yet.
  // A held task whose holder is no longer reachable (silent past the lease), or a claimant of this parent that is idle,
  // gives a `note` instead: the message stays in the parent's inbox, nothing fires, and the sender is told why.
  cloudLive(parent: string, taskKey: string | null, onlineMs: number, threadId: number | null = null): { live: boolean; session: string | null; held?: string; fire?: number; note?: string } {
    this.sweep();
    if (taskKey) {
      const task = tasks.findTask(this.sql, taskKey);
      const claimant = task && task.state !== "done" && task.state !== "dropped" ? task.claim_session : null;
      const sig = claimant ? claims.signalsOf(this.sql, claimant) : null;
      const holder = sig?.parent ?? claimant;
      const now = Date.now();
      const reach = Math.max(onlineMs, this.leaseMs);
      const mins = (t: number | null) => (t ? `${Math.max(1, Math.round((now - t) / 60000))}m` : "ever");
      // A Mac session, or a device that claimed with no session id (the responder): not a cloud session, so a fired one
      // could not take the claim. Refused while it is reachable; otherwise the message waits for a person to decide.
      if (claimant && holder !== parent && holder?.includes("-") && cloudParentOf(holder) === null) {
        const kind = sig ? "a Mac session" : "a device, not a cloud session";
        const seen = sig ? sig.seen_at : this.sql.exec<{ seen_at: number }>("SELECT seen_at FROM status WHERE member = ?", claimant).toArray()[0]?.seen_at ?? 0;
        if (seen >= now - reach) return { live: false, session: null, held: `${claimant} (${kind})` };
        return { live: false, session: null, note: `${taskKey} is held by ${claimant} (${kind}, not seen for ${mins(seen || null)}); the message is left in ${parent}'s inbox. Take over the claim to have a cloud session work it.` };
      }
      if (sig && holder === parent && claims.liveness(sig, this.leaseMs) === "idle") {
        const acted = Math.max(sig.tool_at ?? 0, sig.call_at ?? 0) || null;
        return { live: false, session: claimant, note: `session ${claimant} is idle (alive, no tool activity for ${mins(acted)}); the message is left in ${parent}'s shared inbox.` };
      }
      const settled = task && (!claimant || holder === parent) ? claims.claimantLive(this.sql, task, this.leaseMs, onlineMs) : false;
      if (settled === true) return { live: true, session: task?.claim_session ?? null };
    } else if (!threadId || !faults.pendingFire(this.sql, parent, null, threadId, this.bootMs, this.leaseMs)) {
      // (A thread whose own fire is starting goes to that fire, below, not to whichever session is around.)
      const child = claims.liveChild(this.sql, parent, this.leaseMs);
      if (child) return { live: true, session: child };
      if (claims.seenWithin(this.sql, parent, onlineMs)) return { live: true, session: parent };
    }
    const pending = faults.pendingFire(this.sql, parent, taskKey, threadId, this.bootMs, this.leaseMs);
    if (pending?.child) {
      // The fire's session checked in; it gets the message only while it is working, as a claimant would (an idle one,
      // polling but not acting, would leave it unread). Otherwise it waits in the parent's inbox and nothing fires.
      const sig = claims.signalsOf(this.sql, pending.child);
      if (sig && claims.liveness(sig, this.leaseMs) !== "working") {
        return { live: false, session: pending.child, note: `session ${pending.child} is not working (no tool activity or call within the lease); the message is left in ${parent}'s shared inbox.` };
      }
      return { live: true, session: pending.child };
    }
    if (pending) return { live: true, session: pending.session_id || null, fire: pending.id };
    return { live: false, session: null };
  }

  setStatus(member: string, input: StatusInput): StatusRow {
    return status.setStatus(this.sql, member, input, this.leaseMs, this.waiters);
  }

  statuses(): StatusRow[] {
    return status.statuses(this.sql);
  }

  async sessionPost(member: string, input: SessionInput): Promise<SessionRow | { evicted: string }> {
    const evicted = killing.evictionFor(this.sql, (input.session ?? "").trim());
    if (evicted) return { evicted };
    const row = sessions.sessionPost(this.sql, member, input);
    // A line is proof of life. The hook may post as the person rather than the child, so match on the session id and
    // refresh the same stamps every bridge call does (cloud_devices.seen_at, the claims' claim_beat_at).
    const child = devices.touchBySession(this.sql, row.session);
    if (child) {
      if (this.resurface(child.name, child.seen_at)) await this.arm();
      claims.beat(this.sql, child.name);
    }
    return row;
  }

  // Revoke and tombstone one session (by id or bridge name), end its claims and leave a note in its thread, as one step.
  // It does not terminate a process: the session is told to stop at its next check-in.
  kill(caller: string, members: string[], target: string, reason?: string): killing.KillResult {
    return this.ctx.storage.transactionSync(() => killing.kill(this.sql, this.waiters, this.leaseMs, caller, members, target, reason?.trim() || null));
  }

  sessions(members: string[], member?: string): SessionRow[] {
    return sessions.sessions(this.sql, this.leaseMs, members, member);
  }

  endedSessions(members: string[], member?: string): sessions.EndedLane[] {
    return sessions.ended(this.sql, this.leaseMs, members, member);
  }

  sessionLog(member: string, session: string): { session: SessionRow; lines: SessionLine[] } {
    return sessions.sessionLog(this.sql, member, session);
  }

  async taskCreate(caller: string, members: string[], input: TaskInput): Promise<Task> {
    const task = tasks.taskCreate(this.sql, this.waiters, caller, members, input);
    await this.arm();
    return task;
  }

  taskList(caller: string, members: string[], query: TaskQuery = {}): TaskSummary[] {
    this.sweep();
    return tasks.taskList(this.sql, caller, members, query);
  }

  taskGet(key: string, limit?: number): ReturnType<typeof tasks.taskGet> & { claims: faults.ClaimRecord[] } {
    this.sweep();
    const got = tasks.taskGet(this.sql, key, limit);
    return { ...got, claims: faults.claimsOf(this.sql, got.task.id) };
  }

  // The task row alone (no events, no claims, no sweep), or null when the key names none.
  findTask(key: string): Task | null {
    return tasks.findTask(this.sql, key);
  }

  // Errors a session ran into (T-52, T-39): logged as events, counted on repeat, listed open in faults().
  logError(caller: string, input: { command?: unknown; outcome?: unknown }): events.ErrorLogged {
    return events.logError(this.sql, caller, input);
  }

  resolveError(caller: string, members: string[], id: string, note?: unknown): { id: string; already: boolean } {
    return events.resolveError(this.sql, caller, members, id, note);
  }

  // `cloud` (the people with a routine) turns on T-56 routing for the note: one for a cloud device goes through the same
  // router as bridge_send; `route` says what it decided, and the Worker fires when it says so (cloud.ts updateTask).
  // `review` (T-55): a "ready for re-review" note from the PR's author may reserve a reviewer, which the Worker then fires.
  async taskUpdate(
    caller: string, members: string[], key: string, input: TaskInput, cloud?: { people: string[]; onlineMs: number }, review?: github.HandleOptions,
  ): Promise<TaskChange & { route?: CloudRoute | null; message?: Message; review?: github.ReviewRequest }> {
    this.sweep();
    const routing = cloud ? this.cloudRouter(caller, cloud) : null;
    let change: TaskChange = tasks.taskUpdate(this.sql, this.waiters, caller, members, key, input, routing ?? undefined);
    const route = routing ? routing.route() : null;
    const req = review ? github.noteReReview(this.sql, this.waiters, members, caller, change.task.key, input.note, review) : undefined;
    if (review) change = { ...change, task: tasks.taskById(this.sql, change.task.id), ...(req ? { review: req } : {}) };
    if (!route) {
      await this.arm();
      return change;
    }
    const message = change.message_id === null ? undefined : this.sql.exec<Message>(
      "SELECT id, thread_id, sender, recipient, subject, body, created_at FROM messages WHERE id = ?", change.message_id,
    ).toArray()[0];
    if (message) await this.settleRoute(message, route, members);
    await this.arm();
    return { ...change, route, ...(message ? { message } : {}) };
  }

  taskDone(caller: string, members: string[], key: string, input: tasks.ReportInput): TaskChange {
    return tasks.taskDone(this.sql, this.waiters, caller, members, key, input);
  }

  // Owner-only backfill of merged_sha (and optionally a live deploy_state) on a done task whose merge the webhook never recorded.
  stamp(caller: string, members: string[], key: string, input: StampInput): StampResult {
    return this.ctx.storage.transactionSync(() => stampTask(this.sql, this.waiters, caller, members, key, input));
  }

  // A verified GitHub webhook event, already reduced by the Worker. Dedupe, match, update and post happen in this one call.
  async githubEvent(members: string[], delivery: string, event: github.GithubEvent, opts: github.HandleOptions = {}): Promise<github.WebhookResult> {
    this.sweep();
    // One transaction: a throw part-way (say while closing several epic children) rolls back the delivery id and every
    // write, so GitHub's redelivery retries cleanly.
    const result = this.ctx.storage.transactionSync(() => github.handle(this.sql, this.waiters, members, delivery, event, opts));
    await this.arm();
    return result;
  }

  // The Worker fired (or failed to fire) the auto-reviewer that githubEvent asked for.
  async reviewFired(req: github.ReviewRequest, sessionId: string, url: string): Promise<boolean> {
    return github.reviewFired(this.sql, req, sessionId, url);
  }

  async reviewFailed(members: string[], req: github.ReviewRequest, error: string): Promise<void> {
    github.reviewFailed(this.sql, this.waiters, members, req, error);
  }

  // "Revert this" from the owner: a top-priority task for their cloud agent naming the merge commits to undo.
  async revert(caller: string, members: string[], input: RevertInput): Promise<Task> {
    return this.taskCreate(caller, members, revertTask(this.sql, caller, members, input));
  }
}
