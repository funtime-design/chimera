import { cloudMember } from "../config/names";
import { deploymentDefaults } from "../deployment";
import { buildRevertBrief } from "../rules";
import type { TaskInput, TaskRow as Task } from "./schema";
import { people, personOf } from "./roster";
import { BridgeError } from "./validate";

// Manual revert: the owner says "revert T-12", "revert <PR url>", "revert <merge sha>" or "revert goonbridge to last good",
// and the bridge turns it into a top-priority task for the owner's cloud agent with the exact merge commits to undo.
// The bridge itself holds no GitHub credentials and runs no git; the cloud session does the git work, and the merge it
// pushes redeploys through CI. Nothing here triggers by itself: a human asks, every time.

export type RevertInput = { target: string; repo?: string; reason?: string };
type Merge = { key: string | null; title: string | null; pr_url: string | null; sha: string; deploy_state: string | null; repo: string };

const HEX = /^[0-9a-f]{7,40}$/i;
const lastSegment = (v: string | null) => (v ?? "").trim().toLowerCase().split("/").filter(Boolean).pop() ?? "";

export function revertTask(sql: SqlStorage, caller: string, members: string[], input: RevertInput): TaskInput {
  const person = personOf(caller, members) ?? caller;
  if (!people(members).includes(person)) throw new BridgeError("only a person (or their device) can ask for a revert");
  const target = String(input.target ?? "").trim();
  if (!target) throw new BridgeError('target is required: a task key (T-12), a PR url, a merge SHA, or a repo name for "revert to last good"');
  const { merges, repo, how } = resolve(sql, person, target, input.repo?.trim() || null);
  const why = input.reason?.trim();
  const list = merges.map((m, i) => `${i + 1}. ${m.key ? `${m.key} "${m.title}" · ` : ""}${m.pr_url ? `${m.pr_url} · ` : ""}merge commit ${m.sha} · deploy ${m.deploy_state ?? "unknown"}`).join("\n");
  const brief = buildRevertBrief({ person, how, why, repo, list }, deploymentDefaults);
  const keys = merges.map((m) => m.key).filter(Boolean).join(", ");
  const assignee = members.includes(cloudMember(person)) ? cloudMember(person) : undefined;
  return {
    title: `Revert ${keys || merges.map((m) => m.sha.slice(0, 7)).join(", ")} in ${lastSegment(repo)}`.slice(0, 200),
    brief, owner: person, assignee, repo, priority: 1, labels: [deploymentDefaults.labels.revert], state: "ready",
  };
}

function resolve(sql: SqlStorage, person: string, target: string, repoArg: string | null): { merges: Merge[]; repo: string; how: string } {
  const merged = (where: string, ...params: unknown[]) =>
    sql.exec<Task>(`SELECT * FROM tasks WHERE merged_sha IS NOT NULL AND ${where} ORDER BY merged_at DESC`, ...params).toArray();
  const asMerge = (t: Task): Merge => ({ key: t.key, title: t.title, pr_url: t.pr_url, sha: t.merged_sha!, deploy_state: t.deploy_state, repo: t.repo ?? "" });
  const owned = (t: Task) => {
    if (t.owner !== person) throw new BridgeError(`${t.key} belongs to ${t.owner}; only they can ask to revert it`);
    return t;
  };

  const key = target.match(/^(?:t-?|#)?(\d+)$/i);
  if (key && /^t/i.test(target)) {
    const t = merged("id = ?", Number(key[1]))[0];
    if (!t) throw new BridgeError(`${target} has no recorded merge to trunk. Pass the merge SHA or PR url, with repo.`);
    owned(t);
    return { merges: [asMerge(t)], repo: t.repo ?? repoArg ?? needRepo(), how: `revert ${t.key}` };
  }
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(target)) {
    const url = target.replace(/[?#].*$/, "").replace(/\/$/, "");
    const t = merged("pr_url = ? COLLATE NOCASE", url)[0];
    if (!t) throw new BridgeError(`no merged task is tied to ${url}. Pass the merge SHA with repo instead.`);
    owned(t);
    return { merges: [asMerge(t)], repo: repoArg ?? t.repo ?? url.split("/").slice(3, 5).join("/"), how: `revert ${url}` };
  }
  if (HEX.test(target)) {
    const t = merged("merged_sha LIKE ? COLLATE NOCASE", `${target}%`)[0];
    if (t) {
      owned(t);
      return { merges: [asMerge(t)], repo: t.repo ?? repoArg ?? needRepo(), how: `revert merge ${target}` };
    }
    if (!repoArg) throw new BridgeError("the bridge has no task with that merge SHA; pass repo too");
    return { merges: [{ key: null, title: null, pr_url: null, sha: target, deploy_state: null, repo: repoArg }], repo: repoArg, how: `revert merge ${target}` };
  }
  // A repo (optionally "<repo> to last good"): everything merged after the newest live deploy, else just the newest merge.
  const repoName = lastSegment(repoArg ?? target.replace(/\s+to\s+last\s+good$/i, "").replace(/^repo:/i, ""));
  if (!repoName) throw new BridgeError("name the repo to revert to last good");
  const all = merged("owner = ?", person).filter((t) => lastSegment(t.repo) === repoName);
  if (all.length === 0) throw new BridgeError(`no merged work is recorded for ${repoName}. Pass a PR url or merge SHA.`);
  const goodAt = all.findIndex((t) => t.deploy_state === "live");
  const bad = goodAt === 0 ? [all[0]] : goodAt === -1 ? all : all.slice(0, goodAt);
  const note = goodAt === 0 ? `latest merge ${all[0].key} is live; reverting it to return to the merge before it` : goodAt === -1 ? "no live deploy recorded, reverting all recorded merges" : `${bad.length} merge(s) after the last live deploy (${all[goodAt].key})`;
  return { merges: bad.map(asMerge), repo: all[0].repo ?? repoName, how: `${repoName} to last good: ${note}` };
}

function needRepo(): never {
  throw new BridgeError("that task has no repo; pass repo");
}
