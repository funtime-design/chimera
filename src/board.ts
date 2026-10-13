import { onlineSeconds, personOf, statusExpirySeconds, type StatusRow } from "./hub";
import type { Env } from "./env";

type Roster = { people: string[]; devices: Record<string, string[]> };

export function groupRoster(members: string[]): Roster {
  const people = members.filter((m) => personOf(m, members) === null);
  const devices: Record<string, string[]> = {};
  for (const m of members) {
    const person = personOf(m, members);
    if (person) (devices[person] ??= []).push(m);
  }
  return { people, devices };
}

type BoardEntry = {
  member: string;
  person: string | null;
  online: boolean;
  seen_seconds_ago: number | null;
  state: string | null;
  expired: boolean;
  repo: string | null;
  branch: string | null;
  summary: string | null;
  updated_at: string | null;
  age_seconds: number | null;
};

export type BoardTimes = { onlineSeconds: number; expirySeconds: number };

export function boardTimes(env: Env): BoardTimes {
  return { onlineSeconds: onlineSeconds(env), expirySeconds: statusExpirySeconds(env) };
}

// Every member on the roster. Two separate facts: online (seen by a status post or inbox poll recently) and the
// last posted claim (state, repo, branch, summary), which stands until the member sets idle or it expires.
// An expired claim reads as idle with expired: true, keeping what it said for context.
export function board(members: string[], rows: StatusRow[], times: BoardTimes): BoardEntry[] {
  const now = Date.now();
  const byMember = new Map(rows.map((r) => [r.member, r]));
  return members.map((member) => {
    const r = byMember.get(member);
    const seenAgo = r ? Math.max(0, Math.round((now - r.seen_at) / 1000)) : null;
    const age = r?.updated_at ? Math.max(0, Math.round((now - r.updated_at) / 1000)) : null;
    const expired = !!r?.state && r.state !== "idle" && r.state !== "offline" && age !== null && age > times.expirySeconds;
    return {
      member,
      person: personOf(member, members),
      online: seenAgo !== null && seenAgo <= times.onlineSeconds,
      seen_seconds_ago: seenAgo,
      state: expired ? "idle" : r?.state ?? null,
      expired,
      repo: r?.repo ?? null,
      branch: r?.branch ?? null,
      summary: r?.summary ?? null,
      updated_at: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
      age_seconds: age,
    };
  });
}
