import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHANGELOG = `# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Staging deployment.

## [0.1.0] - 2026-10-01

### Added
- First release.

[Unreleased]: https://github.com/example/chimera/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/example/chimera/releases/tag/v0.1.0
`;

async function repo(t, { branch = 'main', changelog = CHANGELOG } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'chimera-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.com'); git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'chimera', version: '0.1.0', type: 'module' }, null, 2)}\n`);
  await writeFile(path.join(root, 'CHANGELOG.md'), changelog);
  git('add', '.'); git('commit', '-q', '-m', 'initial');
  if (branch !== 'main') git('checkout', '-q', '-b', branch);
  return { root, git };
}
const quiet = { log: () => {}, today: '2026-10-13' };

test('changelog: Unreleased moves under the version heading with the date; the excerpt is that section', async () => {
  const { releaseChangelog, changelogExcerpt } = await import('../bin/changelog.mjs');
  const next = releaseChangelog(CHANGELOG, '0.2.0', '2026-10-13');
  assert.match(next, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-13\n\n### Added\n- Staging deployment\.\n\n## \[0\.1\.0\]/);
  assert.match(next, /\[Unreleased\]: https:\/\/github\.com\/example\/chimera\/compare\/v0\.2\.0\.\.\.HEAD\n\[0\.2\.0\]: https:\/\/github\.com\/example\/chimera\/compare\/v0\.1\.0\.\.\.v0\.2\.0\n\[0\.1\.0\]:/);
  assert.equal(changelogExcerpt(next, '0.2.0'), '## [0.2.0] - 2026-10-13\n\n### Added\n- Staging deployment.\n');
  assert.equal(changelogExcerpt(next, '0.1.0'), '## [0.1.0] - 2026-10-01\n\n### Added\n- First release.\n');
  assert.throws(() => changelogExcerpt(next, '9.9.9'), /no CHANGELOG section/);
  const first = releaseChangelog('# Changelog\n\n## [Unreleased]\n\n- One.\n\n[Unreleased]: https://github.com/example/chimera/commits/main\n', '0.1.0', '2026-10-13');
  assert.match(first, /\[Unreleased\]: https:\/\/github\.com\/example\/chimera\/compare\/v0\.1\.0\.\.\.HEAD\n\[0\.1\.0\]: https:\/\/github\.com\/example\/chimera\/releases\/tag\/v0\.1\.0\n$/);
  assert.throws(() => releaseChangelog(CHANGELOG.replace('### Added\n- Staging deployment.\n\n', ''), '0.2.0', '2026-10-13'), /Unreleased is empty/);
  assert.throws(() => releaseChangelog('# Changelog\n', '0.2.0', '2026-10-13'), /Unreleased/);
});

test('release:tag refuses a dirty tree', async t => {
  const { releaseTag } = await import('../bin/release-tag.mjs');
  const { root, git } = await repo(t);
  await writeFile(path.join(root, 'stray.txt'), 'x');
  assert.throws(() => releaseTag({ root, version: 'v0.2.0', ...quiet }), /working tree is not clean/);
  assert.equal(git('tag').trim(), '');
});

test('release:tag refuses a branch other than main', async t => {
  const { releaseTag } = await import('../bin/release-tag.mjs');
  const { root, git } = await repo(t, { branch: 'feature' });
  assert.throws(() => releaseTag({ root, version: 'v0.2.0', ...quiet }), /on main/);
  assert.equal(git('tag').trim(), '');
});

test('release:tag refuses a bad, old or existing version', async t => {
  const { releaseTag } = await import('../bin/release-tag.mjs');
  const { root, git } = await repo(t);
  git('tag', 'v0.1.0');
  for (const version of ['0.2', 'vX.Y.Z', 'v0.1.0', 'v0.0.9', undefined]) assert.throws(() => releaseTag({ root, version, ...quiet }), /version|already exists/, String(version));
  git('tag', 'v0.3.0');
  assert.throws(() => releaseTag({ root, version: 'v0.3.0', ...quiet }), /already exists/);
});

test('release:tag bumps the version, rewrites CHANGELOG, commits, tags and prints (never runs) the push', async t => {
  const { releaseTag } = await import('../bin/release-tag.mjs');
  const { root, git } = await repo(t);
  const lines = [];
  const result = releaseTag({ root, version: 'v0.2.0', today: '2026-10-13', log: line => lines.push(line) });
  assert.equal(result.tag, 'v0.2.0');
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '0.2.0');
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-13\n/);
  assert.equal(git('status', '--porcelain'), '', 'everything committed');
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Release v0.2.0');
  assert.equal(git('rev-parse', 'v0.2.0^{commit}').trim(), git('rev-parse', 'HEAD').trim());
  assert.equal(git('cat-file', '-t', 'v0.2.0').trim(), 'tag', 'annotated tag');
  assert.equal(git('remote').trim(), '', 'nothing pushed (no remote touched)');
  const out = lines.join('\n');
  assert.match(out, /git push origin main/);
  assert.match(out, /git push origin v0\.2\.0/);
});

test('release:tag may tag the current package.json version once, as the first release', async t => {
  const { releaseTag } = await import('../bin/release-tag.mjs');
  const { root, git } = await repo(t);
  assert.equal(releaseTag({ root, version: 'v0.1.0', ...quiet }).tag, 'v0.1.0');
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '0.1.0');
  assert.equal(git('rev-parse', 'v0.1.0^{commit}').trim(), git('rev-parse', 'HEAD').trim());
});

// The release gate: the latest Deploy run of a commit must have run the staging deploy job, and it must have passed.
function actions(runs, jobs) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    const u = new URL(url);
    const body = u.pathname.endsWith('/runs') ? { workflow_runs: runs } : { jobs: jobs[u.pathname.split('/').at(-2)] ?? [] };
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}
const gate = { repo: 'example/chimera', sha: 'a'.repeat(40), token: 'gh-token', deployment: 'staging' };
const run = (id, status = 'completed') => ({ id, status, created_at: `2026-10-13T0${id}:00:00Z` });

test('release gate passes when the latest Deploy run of the commit deployed staging successfully', async () => {
  const { checkStagingDeploy } = await import('../bin/release-gate.mjs');
  const api = actions([run(2), run(1)], { 2: [{ name: 'preflight', conclusion: 'success' }, { name: 'deploy (staging)', conclusion: 'success' }], 1: [{ name: 'deploy (staging)', conclusion: 'failure' }] });
  const found = await checkStagingDeploy({ ...gate, fetchImpl: api.fetchImpl });
  assert.equal(found.id, 2);
  assert.match(api.calls[0], /\/repos\/example\/chimera\/actions\/workflows\/deploy\.yml\/runs\?/);
  assert.match(api.calls[0], new RegExp(`head_sha=${gate.sha}`));
});

test('release gate fails with no run, a failed or skipped staging deploy, or one still running', async () => {
  const { checkStagingDeploy } = await import('../bin/release-gate.mjs');
  const cases = [
    [[], {}, /no Deploy run/],
    [[run(2), run(1)], { 2: [{ name: 'deploy (staging)', conclusion: 'failure' }], 1: [{ name: 'deploy (staging)', conclusion: 'success' }] }, /failure/],
    [[run(1)], { 1: [{ name: 'preflight', conclusion: 'success' }, { name: 'deploy (staging)', conclusion: 'skipped' }] }, /no staging deploy/],
    [[run(1)], { 1: [{ name: 'deploy (other)', conclusion: 'success' }] }, /no staging deploy/],
    [[run(2, 'in_progress'), run(1)], { 1: [{ name: 'deploy (staging)', conclusion: 'success' }] }, /still running/],
  ];
  for (const [runs, jobs, message] of cases) await assert.rejects(checkStagingDeploy({ ...gate, fetchImpl: actions(runs, jobs).fetchImpl }), message);
  await assert.rejects(checkStagingDeploy({ ...gate, sha: 'main', fetchImpl: actions([], {}).fetchImpl }), /commit SHA/);
  await assert.rejects(checkStagingDeploy({ ...gate, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), e => /404/.test(e.message) && !e.message.includes(gate.token));
});
