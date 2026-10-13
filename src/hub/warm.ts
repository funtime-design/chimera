import { CLOUD_PARENT_LIKE } from "../config/names";
import { WARM_MAX_AGE_MS } from "./settings";
import type { Task } from "./schema";
import { BridgeError } from "./validate";

// Warm-session claims. A cloud session (a child of alice-cloud) is fired for one task, its ANCHOR (the first task it
// ever claimed). It may then claim more tasks without a cold start, but only ones the bridge itself judges related to
// the anchor, from task metadata, never from the agent's own opinion, and only inside these caps. Anything refused is
// left for a session of its own. Every accepted claim is logged like a first one (task_claims), so the board shows
// which session holds what.
export const WARM_MAX_EXTRA = 3; // extra tasks over a session's life, beyond the anchor
export const WARM_MAX_WORKING = 2; // claimed or in progress at once, anchor included
export { WARM_MAX_AGE_MS } from "./settings";

type Row = { task_id: number; claimed_at: number };

// null when `session` may claim `task`, else why not. Called before the claim; the claim itself is one atomic update
// inside the hub (single-threaded), so two sessions reaching for one task cannot both win.
export function warmRefusal(sql: SqlStorage, session: string, task: Task): string | null {
  // A Mac, a person, or a Mac session's child (also a cloud_devices row): no anchor rule. Only children of <person>-cloud.
  if (!sql.exec("SELECT 1 FROM cloud_devices WHERE name = ? AND parent LIKE ?", session, CLOUD_PARENT_LIKE).toArray().length) return null;
  const history = sql.exec<Row>("SELECT task_id, claimed_at FROM task_claims WHERE session = ? ORDER BY id", session).toArray();
  if (history.length === 0) return null; // the anchor claim
  const anchorId = history[0].task_id;
  if (anchorId === task.id) return null; // re-claiming its own anchor
  const anchor = sql.exec<{ owner: string; repo: string | null; labels: string; thread_id: number; key: string }>("SELECT owner, repo, labels, thread_id, key FROM tasks WHERE id = ?", anchorId).toArray()[0];
  if (!anchor) return null;
  const fail = (why: string) => `${task.key} is not related to ${session}'s anchor task ${anchor.key}: ${why}. Leave it for another session.`;

  if (task.claim_session && task.claim_session !== session) return fail(`already held by ${task.claim_session}`);
  if (task.state !== "backlog" && task.state !== "ready") return fail(`it is ${task.state}, not open for claiming`);
  if (task.owner !== anchor.owner) return fail(`different owner (${task.owner}, not ${anchor.owner})`);
  if (!task.repo || !anchor.repo || task.repo.toLowerCase() !== anchor.repo.toLowerCase()) return fail(`different or unset repo (${task.repo ?? "none"}, not ${anchor.repo ?? "none"})`);
  const labels = new Set(parse(anchor.labels));
  if (task.thread_id !== anchor.thread_id && !task.labels.some((l) => labels.has(l))) return fail("no shared label and not in the anchor's thread");

  const extra = new Set(history.map((h) => h.task_id)).size - 1;
  if (extra >= WARM_MAX_EXTRA) return `${session} already took ${extra} extra tasks (cap ${WARM_MAX_EXTRA}). ${task.key} gets its own session.`;
  if (Date.now() - history[0].claimed_at > WARM_MAX_AGE_MS) return `${session} is past ${WARM_MAX_AGE_MS / 3600000}h since its first claim: no more extra tasks. ${task.key} gets its own session.`;
  const working = sql.exec("SELECT 1 FROM tasks WHERE claim_session = ? AND state IN ('claimed', 'in_progress')", session).toArray().length;
  if (working >= WARM_MAX_WORKING) return `${session} already works ${working} tasks (cap ${WARM_MAX_WORKING} at once). Finish one first, or ${task.key} gets its own session.`;
  return null;
}

export function checkWarmClaim(sql: SqlStorage, session: string, task: Task): void {
  const why = warmRefusal(sql, session, task);
  if (why) throw new BridgeError(why);
}

function parse(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
