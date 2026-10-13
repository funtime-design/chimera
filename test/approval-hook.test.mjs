import { OWNER, OWNER_CLOUD, OWNER_DEVICE, PRODUCT, ORIGIN, escapeRegex } from "./harness/roles.mjs";
// The PreToolUse approval hook (.claude/hooks/approval.mjs): which commands it stops, and the bridge flow (faked).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The hook has no personal defaults; outside the harness give it the selected deployment's bridge.json projection.
if (!process.env.BRIDGE_CONFIG) {
  const file = join(mkdtempSync(join(tmpdir(), "approval-hook-")), "bridge.json");
  writeFileSync(file, JSON.stringify({ url: ORIGIN, approver: OWNER, product_name: PRODUCT }));
  process.env.BRIDGE_CONFIG = file;
}
const { destructive, decide } = await import("../.claude/hooks/approval.mjs");

test("destructive commands are caught, routine ones pass", () => {
  const onMain = () => "main";
  const onBranch = () => "claude/x";
  const caught = [
    "git push origin main", "git push -u origin main", "git push origin HEAD:main", "git push origin claude/x:refs/heads/master",
    "git push --force origin claude/x", "git push origin claude/x --force", "git push origin claude/x -f",
    "git push --force-with-lease origin claude/x", "git push origin +claude/x", "git push -uf origin claude/x",
    "git push origin --delete claude/x", "git push origin :claude/x", "git push -d origin claude/x",
    "git branch -D claude/x", "git branch -d claude/x", "git branch --delete claude/x",
    "git -C /repo push origin main", "git add . && git commit -m x && git push origin claude/x --force",
    "op item delete abc", "op vault delete v", "op vault create v", "op item rm abc",
    "wrangler delete", `npx wrangler delete ${PRODUCT}`, "wrangler d1 delete db", "wrangler kv namespace delete --namespace-id x",
  ];
  for (const c of caught) assert.ok(destructive(c, onBranch), `caught: ${c}`);
  assert.equal(destructive("git push", onMain), "push to main", "a bare push on main");
  assert.equal(destructive("git push origin HEAD", onMain), "push to main");
  const routine = [
    "git push -u origin claude/x", "git push origin claude/x", "git push", "git commit -m 'delete the old thing'", "git branch",
    "git branch -a", "git status", "op item get x", "op item create --vault v", "op read op://v/i/f", "wrangler deploy",
    "wrangler secret put X", "echo 'git push --force'", "ls -d /tmp",
  ];
  for (const c of routine) assert.equal(destructive(c, onBranch), null, `routine: ${c}`);
});

// A fake bridge holding threads and messages; `as` is who the hook posts as.
function fakeBridge(as = OWNER_CLOUD) {
  const msgs = [];
  const api = (method, path, body) => {
    if (path === "/v1/me") return { member: as };
    if (path.startsWith("/v1/threads?")) {
      return [...new Set(msgs.map((m) => m.thread_id))].map((id) => {
        const first = msgs.find((m) => m.id === id);
        return { thread_id: id, subject: first.subject, started_by: first.sender };
      });
    }
    const t = path.match(/^\/v1\/threads\/(\d+)$/);
    if (t) return msgs.filter((m) => m.thread_id === Number(t[1]));
    if (method === "POST" && path === "/v1/send") return post(as, body);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const post = (sender, body) => {
    const id = msgs.length + 1;
    const thread_id = body.thread_id ?? id;
    const first = msgs.find((m) => m.id === thread_id);
    const m = { id, thread_id, sender, subject: first?.subject ?? body.subject, body: body.body };
    msgs.push(m);
    return m;
  };
  return { api, msgs, reply: (sender, thread_id, body) => post(sender, { thread_id, body }) };
}

test("a destructive command asks the owner, runs once after approve, and asks again next time", () => {
  const b = fakeBridge();
  const cmd = "git push origin --delete claude/approval-test";
  const first = decide(cmd, "branch delete", "/repo", b.api);
  assert.equal(first.decision, "deny");
  assert.match(first.reason, new RegExp(`asked ${escapeRegex(OWNER)} in ${escapeRegex(PRODUCT)} thread 1`));
  assert.equal(b.msgs[0].sender, OWNER_CLOUD);
  assert.ok(b.msgs[0].body.includes(cmd));
  assert.match(decide(cmd, "branch delete", "/repo", b.api).reason, /Still waiting/, "a retry before the answer");
  b.reply(OWNER_DEVICE, 1, "approve");
  assert.equal(decide(cmd, "branch delete", "/repo", b.api).decision, "deny", "a device cannot approve");
  b.reply(OWNER, 1, "Approve");
  b.reply(OWNER, 1, "Approval is posted, retry now.");
  const ok = decide(cmd, "branch delete", "/repo", b.api);
  assert.equal(ok.decision, "allow");
  assert.match(b.msgs.at(-1).body, /^used/);
  const again = decide(cmd, "branch delete", "/repo", b.api);
  assert.equal(again.decision, "deny");
  assert.ok(b.msgs.at(-1).thread_id !== 1, "one use: the next run opens a new request");
});

test("a refusal denies, and an approval never covers a different command", () => {
  const b = fakeBridge();
  decide("op item delete a", "op item delete", "/repo", b.api);
  b.reply(OWNER, 1, "no, keep it");
  const refused = decide("op item delete a", "op item delete", "/repo", b.api);
  assert.equal(refused.decision, "deny");
  assert.match(refused.reason, /refused/);
  decide("wrangler delete", "wrangler delete", "/repo", b.api);
  const t = b.msgs.at(-1).thread_id;
  b.reply(OWNER, t, "approve");
  assert.equal(decide("wrangler delete x", "wrangler delete", "/repo", b.api).decision, "deny");
  assert.equal(decide("wrangler delete", "wrangler delete", "/repo", b.api).decision, "allow");
});
