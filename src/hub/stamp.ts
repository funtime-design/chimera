import type { TaskChange } from "./schema";
import { stamp } from "./github";
import { changeTask, taskByKey, taskEvent } from "./tasks";
import { personOf } from "./roster";
import { BridgeError } from "./validate";
import { isCloud } from "./state";
import type { Waiters } from "./messages";

// Admin stamp: backfill merged_sha (and optionally deploy_state) on a task that is already done, for a merge the webhook
// never recorded (a false match, a missed delivery). It writes the two fields through the same stamp() a real merge uses
// and posts a note. It does not fabricate a GitHub event, a PR or a deploy, and it never starts a deploy watch.

export type StampInput = { merged_sha: string; deploy_state?: string };
export type StampResult = TaskChange & { stamped: boolean; message: string };

const SHA = /^[0-9a-f]{40}$/i;
// Only terminal states: pending would start the watch that flips to not_seen and faults the task.
const STATES = ["live"];

// Gate: the task's owner, as themselves or one of their own devices, never a cloud session. Revert and kill also admit a
// person's cloud children; a stamp writes the record revert trusts, so it is stricter.

export function stampTask(sql: SqlStorage, waiters: Waiters, caller: string, members: string[], key: string, input: StampInput): StampResult {
  const task = taskByKey(sql, key);
  if (isCloud(caller) || (personOf(caller, members) ?? caller) !== task.owner) {
    throw new BridgeError(`only ${task.owner} (or one of their own, non-cloud devices) can stamp ${task.key}; a cloud session cannot`);
  }
  const sha = String(input.merged_sha ?? "").trim().toLowerCase();
  if (!SHA.test(sha)) throw new BridgeError("merged_sha must be the full 40-character merge commit SHA");
  const state = input.deploy_state?.trim().toLowerCase();
  if (state !== undefined && !STATES.includes(state)) throw new BridgeError(`deploy_state must be ${STATES.join(" or ")} (or omitted); pending would start a deploy watch that faults the task`);
  if (task.state !== "done") throw new BridgeError(`${task.key} is ${task.state}; only a done task can be stamped. A real merge closes it by itself.`);

  if (task.merged_sha) {
    if (task.merged_sha.toLowerCase() !== sha) throw new BridgeError(`${task.key} already has merged_sha ${task.merged_sha}; refusing to overwrite it with ${sha}`);
    return { task, changed: [], message_id: null, posted_to: null, notified: null, stamped: false, message: `${task.key} already has merged_sha ${task.merged_sha} (deploy ${task.deploy_state ?? "unknown"}); nothing changed.` };
  }

  stamp(sql, task.id, sha, state ?? null); // bumps version
  taskEvent(sql, task.id, caller, "stamped", { sha, deploy_state: state ?? null, by: caller });
  const change = changeTask(sql, waiters, caller, members, taskByKey(sql, task.key), {
    note: `Merge ${sha} recorded by ${caller} (admin stamp, no GitHub event)${state ? `, deploy ${state}` : ", no deploy state"}. \`revert ${task.key}\` can now find it.`,
  });
  return { ...change, stamped: true, message: `Stamped ${task.key}: merged_sha ${sha}, deploy ${state ?? "none"}.` };
}


