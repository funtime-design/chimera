import type { Task, TaskInput } from "./schema";
import { personFor, personOf } from "./roster";
import { isCloud, OPEN_STATES, type Actor } from "./state";
import { BridgeError } from "./validate";
import type { CallerPermissions } from "./trust";

// Who may change which fields of a task (T-60). The state machine (state.ts) already decides which states each actor may
// set; this decides the other fields, by where the caller stands to the task's owner:
//   owner (the person or one of their non-cloud devices) and the bridge: anything.
//   the owner's household (in practice their cloud sessions): edit, but never the owner, and the assignee stays in the
//     household. A cloud session never changes the title or brief either: it proposes a scope change in a note (T-15).
//   the claimant from outside the household: state, branch, pr_url, labels, notes.
//   anyone else: claim a ready task that is unassigned or assigned to them, add a note; once holding it, the claimant's
//     rights (so review/blocked on a task assigned to them).
// Every refusal says who may do it. A device's own toggles (hub/trust.ts, set on /docs/settings) adjust this: may_edit_tasks
// off leaves it only what anyone outside the household may do; on lets a cloud session change the title and brief too.
// A full label replace is allowed too (it needs expected_version): add/remove reaches the same set anyway.
const CLAIMANT_FIELDS = ["state", "branch", "pr_url", "labels", "add_labels", "remove_labels", "note"];

export function assertAllowed(task: Task, caller: string, roles: Actor[], input: TaskInput, members: string[], perms: CallerPermissions = { editTasks: null, actAsPerson: null }): void {
  if (roles.includes("owner") || roles.includes("github") || roles.includes("system")) return;
  const person = (name: string | null) => (name ? personOf(name, members) ?? name : null);
  const o = task.owner;
  const fields = (Object.keys(input) as (keyof TaskInput)[])
    .filter((f) => f !== "expected_version" && input[f] !== undefined && input[f] !== (task as Record<string, unknown>)[f]);
  const state = input.state?.trim().toLowerCase();
  const claiming = state === "claim" || state === "claimed";
  const fail = (why: string) => { throw new BridgeError(why); };
  // Which epic a task belongs to, and whether it is one, are the owner's calls only (T-53, epicEdit says the same).
  const epic = fields.filter((f) => f === "parent" || f === "kind");
  if (epic.length) fail(`only ${o} (or one of their non-cloud devices) sets the ${epic.join(" and ")} of ${task.key}`);

  if (person(caller) === o && perms.editTasks === false) {
    const other = fields.filter((f) => !(f === "note" || f === "state" || (f === "assignee" && claiming && input.assignee === caller)));
    if (other.length) fail(`${caller} may not edit tasks (may_edit_tasks is off for it on the settings page): it may add notes, claim and report on ${task.key}. ${other.join(", ")} is for ${o} or another of their devices.`);
  }
  if (person(caller) === o && perms.editTasks !== false && perms.actAsPerson !== false) {
    if (isCloud(caller) && perms.editTasks !== true && fields.some((f) => f === "title" || f === "brief")) {
      fail(`a cloud session never changes the title or brief of ${task.key}: propose it in a note (task_update note) and ${o} decides`);
    }
    // Naming the same person (or one of their devices) again is not an owner change.
    if (fields.includes("owner") && personFor(input.owner!, members) !== o) fail(`only ${o} (or one of their non-cloud devices) changes the owner of ${task.key}`);
    if (fields.includes("assignee") && input.assignee !== null && person(input.assignee!) !== o) {
      fail(`the assignee stays in ${o}'s household when ${caller} sets it; ${o} may assign ${task.key} outside it`);
    }
    return;
  }
  if (roles.includes("claimant")) {
    const other = fields.filter((f) => !CLAIMANT_FIELDS.includes(f) && !(f === "assignee" && input.assignee === caller));
    if (other.length) fail(`${caller} holds the claim on ${task.key}: it may set state, branch, pr_url, labels and notes. ${other.join(", ")} is for ${o}'s household; ask ${o} with bridge_send.`);
    return;
  }
  const mine = task.assignee !== null && person(task.assignee) === person(caller);
  // A closed task gets the state machine's own answer (the owner reopens it first).
  if (claiming && OPEN_STATES.includes(task.state) && (task.state !== "ready" || (task.assignee !== null && !mine))) {
    fail(`${caller} is outside ${o}'s household: it may claim only a ready task that is unassigned or assigned to it, and ${task.key} is ${task.state}${task.assignee ? ` with ${task.assignee}` : ""}. ${o}'s household may hand it over.`);
  }
  // Which states it may then set is the state machine's call (state.ts): as claimant, review or blocked among them.
  const other = fields.filter((f) => !(f === "note" || f === "state" || (f === "assignee" && claiming && input.assignee === caller)));
  if (other.length) fail(`${caller} is outside ${o}'s household, so it cannot change ${other.join(", ")} on ${task.key}: ${o}'s household may (ask ${o} with bridge_send). Outside it you may claim a ready task that is unassigned or yours, add a note, and once you hold it set its state (review, blocked, ...).`);
}
