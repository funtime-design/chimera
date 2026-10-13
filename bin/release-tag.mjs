// pnpm release:tag -- vX.Y.Z: on a clean main, bump package.json, move CHANGELOG Unreleased under the version with
// today's date, commit, and create an annotated tag. It never pushes; it prints the push commands in the order the
// release workflow needs them (main first, so staging deploys that commit; the tag after that deploy passes).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { releaseChangelog } from './changelog.mjs';
import { cli, isMain, projectRoot } from './deployment.mjs';

const core = v => v.split(/[-+]/)[0].split('.').map(Number);
const newer = (a, b) => { const [x, y] = [core(a), core(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

export function releaseTag({ root = projectRoot, version, today = new Date().toISOString().slice(0, 10), log = console.log }) {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(version ?? '');
  if (!match) throw new Error('usage: pnpm release:tag -- vX.Y.Z (a semver version)');
  const next = match[1], tag = `v${next}`;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (git('status', '--porcelain').trim()) throw new Error('working tree is not clean: commit or stash first');
  if (git('branch', '--show-current').trim() !== 'main') throw new Error('release:tag runs on main only: check out main and pull first');
  const tagged = name => { try { git('rev-parse', '-q', '--verify', `refs/tags/${name}`); return true; } catch { return false; } };
  if (tagged(tag)) throw new Error(`tag ${tag} already exists`);
  const pkgFile = path.join(root, 'package.json'), changelogFile = path.join(root, 'CHANGELOG.md');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  // The current version may be tagged once (the first release); otherwise the version must move forward.
  if (!newer(next, pkg.version) && !(next === pkg.version && !tagged(`v${pkg.version}`))) throw new Error(`version ${next} must be newer than package.json ${pkg.version}`);
  const changelog = releaseChangelog(readFileSync(changelogFile, 'utf8'), next, today);
  writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`);
  writeFileSync(changelogFile, changelog);
  git('add', '--', 'package.json', 'CHANGELOG.md');
  git('commit', '-q', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `chimera ${tag}`);
  log(`Committed "Release ${tag}" and tagged ${tag} (nothing pushed). To release:`);
  log('  git push origin main     # this exact commit must be on main: staging deploys it');
  log(`  git push origin ${tag}   # once the Deploy run for this commit has passed; release.yml checks that`);
  return { tag, version: next };
}

if (isMain(import.meta.url)) await cli(async () => {
  const args = process.argv.slice(2).filter(a => a !== '--');
  if (args.length !== 1) throw new Error('usage: pnpm release:tag -- vX.Y.Z');
  releaseTag({ version: args[0] });
});
