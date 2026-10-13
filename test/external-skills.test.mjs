// T-27: the SessionStart hook that fetches the external `gaps` skill. No network, no worker: a local bare repo stands
// in for compound-loop.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../.claude/hooks/fetch-external-skills.sh", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });

const base = mkdtempSync(join(tmpdir(), "ext-skills-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
const bare = join(base, "upstream.git");
const work = join(base, "work");
const out = join(base, "out");
const scratch = join(base, "scratch"); // TMPDIR for the script: must be empty after each run
mkdirSync(out);
mkdirSync(scratch);
git(base, "init", "-q", "--bare", bare);
git(bare, "config", "uploadpack.allowFilter", "true");
git(base, "init", "-q", "-b", "main", work);
git(work, "config", "user.email", "t@example.com");
git(work, "config", "user.name", "t");

function publish(text) {
  mkdirSync(join(work, "skills/gaps"), { recursive: true });
  writeFileSync(join(work, "skills/gaps/SKILL.md"), text);
  writeFileSync(join(work, "skills/other.md"), "not wanted");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", text);
  git(work, "push", "-q", bare, "main");
}

function run(env) {
  const clean = { ...process.env };
  delete clean.CLAUDE_CODE_REMOTE;
  delete clean.GOONBRIDGE_EXTERNAL_SKILLS;
  delete clean.CLAUDE_PROJECT_DIR;
  return spawnSync("sh", [script], {
    env: {
      ...clean,
      TMPDIR: scratch,
      GOONBRIDGE_EXTERNAL_SKILLS_REPO: `file://${bare}`,
      GOONBRIDGE_EXTERNAL_SKILLS_DIR: out,
      ...env,
    },
    encoding: "utf8",
  });
}

const skill = join(out, "gaps/SKILL.md");
const listAll = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name).slice(dir.length + 1))
    .sort();

test("does nothing unless cloud or opted in", () => {
  publish("MARKER-ONE");
  const r = run({});
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(out), []);
  assert.deepEqual(readdirSync(scratch), []);
});

test("fetches only gaps/SKILL.md and leaves no clone behind", () => {
  const r = run({ GOONBRIDGE_EXTERNAL_SKILLS: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(skill, "utf8"), /MARKER-ONE/);
  assert.deepEqual(listAll(out), ["gaps/SKILL.md"]);
  assert.deepEqual(readdirSync(scratch), []);
});

test("a second run picks up the updated upstream", () => {
  publish("MARKER-TWO");
  const r = run({ CLAUDE_CODE_REMOTE: "true" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(skill, "utf8"), /MARKER-TWO/);
  assert.deepEqual(listAll(out), ["gaps/SKILL.md"]);
});

test("a failed fetch exits 0 and keeps the previous copy", () => {
  const r = run({ GOONBRIDGE_EXTERNAL_SKILLS: "1", GOONBRIDGE_EXTERNAL_SKILLS_REPO: `file://${join(base, "nope.git")}` });
  assert.equal(r.status, 0);
  assert.match(readFileSync(skill, "utf8"), /MARKER-TWO/);
  assert.deepEqual(listAll(out), ["gaps/SKILL.md"]);
  assert.deepEqual(readdirSync(scratch), []);
  assert.ok(!existsSync(`${skill}.tmp`));
});
