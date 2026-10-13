import { clientSettings, servedScript } from "./harness/client.mjs";
import { GITHUB_OWNER, OWNER, SESSION_HEADER, PRODUCT, escapeRegex } from "./harness/roles.mjs";
// GET /v1/cloud-config serves the private cloud-session-config repo (a fake GitHub stands in), and cloud-setup.sh installs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base, ownerCloudToken, rest, useFakeGitHub } from "./helpers.mjs";

const github = useFakeGitHub();
const skip = !github && "no GITHUB_CONFIG_API_URL in .dev.vars";
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

const hookCommand = 'node "$HOME/.claude/hooks/approval.mjs"';
const bundle = (version, allow, hook = "// approval hook v" + version + "\n") => ({
  "README.md": "# cloud-session-config\n",
  VERSION: `${version}\n`,
  "settings.json": JSON.stringify({
    permissions: { allow },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookCommand, timeout: 60 }] }] },
  }, null, 2) + "\n",
  "hooks/approval.mjs": hook,
  "cloud-agents.md": `# Boot v${version}\n`,
});

test("cloud-config serves the repo at a ref with sha256s, a 304 for an unchanged commit, and clean errors", { skip }, async () => {
  const files = bundle(1, ["Bash(pnpm test:*)"], "// hook\n" + "x".repeat(200) + "\n");
  const commit = github.commit("main", files);
  assert.equal((await rest("not-a-token", "GET", "/v1/cloud-config")).status, 401);

  const res = await fetch(new URL("/v1/cloud-config", base), { headers: { Authorization: `Bearer ${ownerCloudToken}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("ETag"), `"${commit}"`);
  const body = await res.json();
  assert.equal(body.repo, `${GITHUB_OWNER}/cloud-session-config`);
  assert.equal(body.ref, "main");
  assert.equal(body.commit, commit);
  assert.equal(body.version, "1");
  assert.deepEqual(body.files, files, "every file, byte for byte (base64 with line breaks decoded)");
  for (const [path, content] of Object.entries(files)) assert.equal(body.sha256[path], sha256(content), path);

  const reads = github.state.blobReads;
  const again = await fetch(new URL("/v1/cloud-config", base), { headers: { Authorization: `Bearer ${ownerCloudToken}`, "If-None-Match": `"${commit}"` } });
  assert.equal(again.status, 304);
  assert.equal((await rest(ownerCloudToken, "GET", "/v1/cloud-config")).status, 200);
  assert.equal(github.state.blobReads, reads, "a commit already served is not read from GitHub again");

  const branch = github.commit("claude/try", bundle(2, ["Bash(ls)"]));
  const tried = await rest(ownerCloudToken, "GET", "/v1/cloud-config?ref=claude/try");
  assert.equal(tried.status, 200);
  assert.equal(tried.body.commit, branch);
  assert.equal(tried.body.ref, "claude/try");
  assert.equal(tried.body.version, "2");

  assert.deepEqual(await rest(ownerCloudToken, "GET", "/v1/cloud-config?ref=nope"), { status: 404, body: { error: "no ref nope" }, more: 0 });
  assert.equal((await rest(ownerCloudToken, "GET", "/v1/cloud-config?ref=a%20b")).status, 400);
  const revoked = await rest(ownerCloudToken, "GET", "/v1/cloud-config?ref=pat-revoked");
  assert.equal(revoked.status, 503);
  assert.match(revoked.body.error, /GitHub 401 \(GITHUB_CONFIG_PAT expired or revoked\?\)/);
  github.commit("claude/huge", { ...files, "big.bin": "x".repeat(600 * 1024) });
  assert.equal((await rest(ownerCloudToken, "GET", "/v1/cloud-config?ref=claude/huge")).status, 413);
});

test("cloud-setup.sh installs the bundle at user scope, merges settings, and keeps what it cannot verify", { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), "goonbridge-cloud-config-"));
  const claude = join(home, ".claude");
  mkdirSync(claude);
  const userHook = { matcher: "Edit", hooks: [{ type: "command", command: "echo mine" }] };
  writeFileSync(join(claude, "CLAUDE.md"), "my own note\n");
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [userHook] } }));
  const script = join(home, "cloud-setup.sh");
  writeFileSync(script, servedScript("cloud-setup.sh"));
  // Async: the fake GitHub answers from this process, so a blocking exec would starve it.
  const setup = async (env = {}) => (await promisify(execFile)("sh", [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, BRIDGE_CONFIG: join(claude, "bridge.json"), GOONBRIDGE_URL: base, GOONBRIDGE_TOKEN: ownerCloudToken, CLOUDFLARE_API_TOKEN: "test", CLOUDFLARE_ACCOUNT_ID: "test", OP_SERVICE_ACCOUNT_TOKEN: "", CLOUD_CONFIG_REF: "", ...env },
  })).stdout;
  const settings = () => JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
  const hookFile = join(claude, "hooks", "approval.mjs");

  // 1. First boot installs v1.
  github.commit("main", bundle(1, ["Bash(pnpm test:*)", "Bash(wrangler deploy:*)"]));
  let out = await setup();
  assert.match(out, /cloud-config v1 ok \([0-9a-f]{7}, was vnone\)/);
  assert.equal(readFileSync(hookFile, "utf8"), "// approval hook v1\n");
  let s = settings();
  assert.equal(s.model, "opus", "the rest of the user's settings stay");
  for (const rule of ["Bash(ls)", "Bash(pnpm test:*)", "Bash(wrangler deploy:*)", "mcp__claude-code-remote__create_session"]) assert.ok(s.permissions.allow.includes(rule), rule);
  assert.deepEqual(s.hooks.PreToolUse.map((h) => h.hooks[0].command), ["echo mine", hookCommand]);
  assert.deepEqual(JSON.parse(readFileSync(join(claude, "bridge.json"), "utf8")), { ...clientSettings, url: base });
  const record = JSON.parse(readFileSync(join(claude, "cloud-config.json"), "utf8"));
  assert.equal(record.version, "1");
  assert.deepEqual(record.installed, { [hookFile]: sha256("// approval hook v1\n"), [join(claude, "cloud-agents.md")]: sha256("# Boot v1\n") });
  assert.ok(!existsSync(join(claude, "hooks", "README.md")) && !existsSync(join(claude, "VERSION")), "only settings, hooks and the boot file are installed");
  assert.equal(readFileSync(join(claude, "cloud-agents.md"), "utf8"), "# Boot v1\n");
  // The entry point: the user's own CLAUDE.md lines stay, and one pointer block is added, nothing inlined.
  const md = () => readFileSync(join(claude, "CLAUDE.md"), "utf8");
  assert.match(md(), new RegExp(String.raw`^my own note\n<!-- ${escapeRegex(PRODUCT)}-cloud:begin[^\n]*-->\nCloud session: read ~\/\.claude\/cloud-agents\.md for the boot sequence; bridge mechanics: call bridge_help\.\n<!-- ${escapeRegex(PRODUCT)}-cloud:end -->\n$`));

  // 2. Unchanged: one 304, nothing rewritten, and the hook is not added twice.
  out = await setup();
  assert.match(out, /cloud-config v1 ok \(unchanged\)/);
  assert.equal(settings().hooks.PreToolUse.length, 2);
  assert.equal(md().split(`${PRODUCT}-cloud:begin`).length, 2, "the pointer block is not added twice");

  // 3. v2 drops one rule, adds another and changes the hook: the dropped rule goes, the user's own stay.
  github.commit("main", bundle(2, ["Bash(pnpm test:*)", "Bash(pnpm typecheck)"], "// approval hook v2\n"));
  out = await setup();
  assert.match(out, /cloud-config v2 ok \([0-9a-f]{7}, was v1\)/);
  s = settings();
  assert.ok(!s.permissions.allow.includes("Bash(wrangler deploy:*)"), "a rule the bundle dropped is removed");
  assert.ok(s.permissions.allow.includes("Bash(pnpm typecheck)") && s.permissions.allow.includes("Bash(ls)"));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(readFileSync(hookFile, "utf8"), "// approval hook v2\n");

  // 4. An edited hook file or a removed hook entry is not "unchanged": the same commit is installed again.
  writeFileSync(hookFile, "// tampered\n");
  out = await setup();
  assert.match(out, /cloud-config v2 ok \([0-9a-f]{7}, was v2\)/);
  assert.equal(readFileSync(hookFile, "utf8"), "// approval hook v2\n");
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ ...settings(), hooks: { PreToolUse: [userHook] } }));
  assert.match(await setup(), /cloud-config v2 ok \([0-9a-f]{7}, was v2\)/);
  assert.equal(settings().hooks.PreToolUse.length, 2);

  // 5. The bridge cannot read the repo: what is installed stays, and the reason is printed.
  out = await setup({ CLOUD_CONFIG_REF: "pat-revoked" });
  assert.match(out, /cloud-config: kept v2 \(HTTP 503: config repo unreachable: GitHub 401/);
  assert.equal(readFileSync(hookFile, "utf8"), "// approval hook v2\n");
  out = await setup({ GOONBRIDGE_URL: "http://localhost:9" });
  assert.match(out, /cloud-config: kept v2 \(HTTP 000/);
});
