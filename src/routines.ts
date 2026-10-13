import { cloudParentOf, cloudMember } from "./config/names";
import { runtimeEnv } from "./config/resolve";
import { deploymentDefaults } from "./deployment";
import { buildPayload, buildReviewBrief, buildCloudNotice, buildRoutineNotice, buildRoutineResult } from "./rules";
import { BridgeError, MAX_BODY, personOf, type Hub, type Message, type Task } from "./hub";
import type { Env } from "./env";

// A cloud device (<person>-cloud) with no Mac behind it is a Claude Code routine with an API trigger, made once by that
// person at claude.ai/code/routines. Firing it starts a cloud session on their account; the payload names the goonbridge
// thread, so the session reads it, does the work and reports back in the thread.
export type Routine = { trigger: string; token: string };

export function parseRoutines(raw: string | undefined): Map<string, Routine> {
  const out = new Map<string, Routine>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [person, value] of Object.entries(parsed as Record<string, unknown>)) {
    const r = value as { trigger?: unknown; token?: unknown };
    if (typeof r?.trigger === "string" && typeof r?.token === "string" && r.trigger && r.token) out.set(person, { trigger: r.trigger, token: r.token });
  }
  return out;
}

export const ROUTINES_URL = "https://api.anthropic.com/v1/claude_code/routines";

export type Fired = { session_id: string; url: string };

export async function fireRoutine(routine: Routine, text: string, baseUrl = ROUTINES_URL): Promise<Fired> {
  const res = await fetch(`${baseUrl}/${encodeURIComponent(routine.trigger)}/fire`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${routine.token}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { claude_code_session_id?: string; claude_code_session_url?: string; error?: { message?: string } };
  if (!res.ok || !data.claude_code_session_url) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  return { session_id: data.claude_code_session_id ?? "", url: data.claude_code_session_url };
}

// The payload the routine's prompt reads. Plain lines; the session gets the thread itself from the bridge.
export const payloadFor = (m: Message, task?: Task | null): string => buildPayload(deploymentDefaults, m, task);

export type CloudStart = { member: string; url?: string; session_id?: string; forced?: boolean; error?: string; live?: boolean; note?: string };

// After a message reaches a cloud device: fire that person's routine, mark the device copy done, and answer in the
// thread as the device so the sender sees the session link. No routine for the person: nothing happens, the message
// waits in the device inbox as before. `fireId` is the intent row the routed send already wrote (Hub.sendRouted); with
// none (a task assignment), one is written here, still before the routines API is called (T-69).
export async function startCloud(
  hub: DurableObjectStub<Hub>, members: string[], routines: Map<string, Routine>, m: Message, task: Task | null, baseUrl?: string, forced = false, fireId?: number,
): Promise<CloudStart | null> {
  const member = m.recipient;
  if (cloudParentOf(member) === null || !members.includes(member)) return null;
  const routine = routines.get(cloudParentOf(member)!);
  if (!routine) return null;
  const id = fireId ?? (await hub.intendFire({ member, requester: m.sender, message_id: m.id, thread_id: m.thread_id, task_key: task?.key ?? null }));
  let fired: Fired;
  try {
    fired = await fireRoutine(routine, payloadFor(m, task), baseUrl);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // On record as a fault, told in the thread; the message waits in the parent's inbox for any session.
    await hub.fireFailed(id, error);
    return { member, error, ...(forced ? { forced } : {}) };
  }
  // Recorded first: done alone cannot tell a finished request from a session that never booted. fired() also marks the
  // message the fire carried (and only it, by id) done for the parent, since the session gets it in its prompt. A failure
  // to record is not swallowed: the caller gets the error (the intent row is still there, so the sweep reports the fire
  // as never_started rather than losing it). The notice is posted as system, so it acks nothing else in the thread (T-67).
  await hub.fired(id, fired.session_id, fired.url);
  await hub.notice(member, members, m.thread_id, buildCloudNotice(member, fired.url, fired.session_id), m.sender);
  return { member, url: fired.url, session_id: fired.session_id, ...(forced ? { forced } : {}) };
}

// Routines a caller picks by name (fire_routine), kept apart from the person -> cloud member map above. Each is a set of flat
// secrets, one plain string each: GOONBRIDGE_ROUTINE_<NAME>_TRIGGER and _TOKEN (both required), and optional _ALLOW, a comma
// separated list of members or people who may fire it (nobody is excluded when it is absent). Names are found at runtime.
export type NamedRoutine = Routine & { allow: string[] | null };

export function parseNamedRoutines(env: Record<string, unknown>): Map<string, NamedRoutine> {
  env = runtimeEnv(env);
  const out = new Map<string, NamedRoutine>();
  const str = (k: string) => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
  for (const key of Object.keys(env)) {
    const m = /^GOONBRIDGE_ROUTINE_([A-Z0-9]+)_TRIGGER$/.exec(key);
    if (!m) continue;
    const trigger = str(key);
    const token = str(`GOONBRIDGE_ROUTINE_${m[1]}_TOKEN`);
    if (!trigger || !token) continue;
    const allowRaw = str(`GOONBRIDGE_ROUTINE_${m[1]}_ALLOW`);
    const allow = allowRaw ? allowRaw.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean) : null;
    out.set(m[1].toLowerCase(), { trigger, token, allow });
  }
  return out;
}

// fire_routine: start the named routine with `text` as its payload, as asked by `member`. Nothing is added to the text.
// The fire is recorded (hub.recordFire) so the orphan tracker sees a session that never boots; the session id comes back
// in the text. With a thread_id, a one-line note with the session link is posted there as system.
export async function fireNamed(
  env: Env, hub: DurableObjectStub<Hub>, member: string, members: string[], input: { routine?: unknown; text?: unknown; thread_id?: unknown; task_key?: unknown },
): Promise<{ text: string; routine: string; session_id: string; url: string }> {
  const routines = parseNamedRoutines(env as unknown as Record<string, unknown>);
  const names = [...routines.keys()].sort();
  if (routines.size === 0) throw new BridgeError(`no routines are configured for fire_routine (set ${deploymentDefaults.envPrefix}_ROUTINE_<NAME>_TRIGGER and _TOKEN)`);
  const name = String(input.routine ?? "").trim().toLowerCase();
  const routine = routines.get(name);
  if (!routine) throw new BridgeError(`unknown routine "${name}"; routines: ${names.join(", ")}`);
  const who = [member, personOf(member, members)].filter((x): x is string => !!x);
  if (routine.allow && !routine.allow.some((a) => who.includes(a))) throw new BridgeError(`${member} may not fire routine "${name}"`);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new BridgeError("text is required: what the fired session should do");
  if (new TextEncoder().encode(text).length > MAX_BODY) throw new BridgeError(`text is over ${MAX_BODY} bytes`);
  // The task this fire works on, if any (T-58): with none, a text about merges, PRs, branches or deploys is flagged.
  let taskKey: string | null = null;
  if (typeof input.task_key === "string" && input.task_key.trim()) {
    const { task } = await hub.taskGet(input.task_key.trim());
    taskKey = (task as Task).key; // the stub types this RPC result as never
  }
  let fired: Fired;
  try {
    fired = await fireRoutine(routine, text, env.GOONBRIDGE_ROUTINES_URL);
  } catch (err) {
    throw new BridgeError(`could not fire routine "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const threadId = typeof input.thread_id === "number" && Number.isInteger(input.thread_id) ? input.thread_id : null;
  // message_id and thread_id are 0 when there is none: the fire is judged only on whether the session ever boots (never_started).
  const person = personOf(member, members) ?? member;
  await hub.recordFire({ member: cloudMember(person), requester: member, message_id: 0, thread_id: threadId ?? 0, task_key: taskKey, session_id: fired.session_id, url: fired.url }, text, members).catch(() => {});
  // As system, not the caller: a post from the caller would ack its unread messages in the thread (T-67).
  if (threadId !== null) await hub.notice(member, members, threadId, buildRoutineNotice(name, fired.url, fired.session_id)).catch(() => {});
  return { text: buildRoutineResult(name, fired.url, fired.session_id), routine: name, session_id: fired.session_id, url: fired.url };
}

// Auto-review (src/github.ts): the reviewer for a PR that just went up for review. The named routine "review" if the owner
// made one, else the task owner's own cloud routine, the same one a message to <owner>-cloud fires. No routine at all is an
// error the caller reports on the task. Always a fresh session: nothing here looks for, or joins, a live one.
export async function fireReviewer(env: Env, req: { owner: string }, text: string): Promise<{ member: string; session_id: string; url: string }> {
  const named = parseNamedRoutines(env as unknown as Record<string, unknown>).get("review");
  const person = req.owner.split("-")[0];
  const routine = named ?? parseRoutines(env.GOONBRIDGE_ROUTINES).get(person);
  if (!routine) throw new Error(`no routine to fire: set ${deploymentDefaults.envPrefix}_ROUTINE_REVIEW_TRIGGER and _TOKEN, or a ${person} entry in ${deploymentDefaults.envPrefix}_ROUTINES`);
  const fired = await fireRoutine(routine, text, env.GOONBRIDGE_ROUTINES_URL);
  return { member: cloudMember(person), ...fired };
}

// What the reviewer session is told. Review only: it reads, runs the checks and reports; it never merges, deploys, pushes,
// claims the task or closes it. The report goes in the task's thread, to the owner.
export const reviewBrief = (r: Parameters<typeof buildReviewBrief>[1]): string => buildReviewBrief(deploymentDefaults, r);
