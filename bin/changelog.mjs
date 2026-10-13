// CHANGELOG.md (Keep a Changelog): release:tag moves Unreleased under a version heading; the release workflow attaches
// that version's section. `node bin/changelog.mjs excerpt <version>` prints it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cli, isMain, projectRoot } from './deployment.mjs';

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The body of one "## [name]" section: everything up to the next "## " heading or the link references.
function section(text, name) {
  const match = new RegExp(`^## \\[${escape(name)}\\][^\\n]*\\n`, 'm').exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const end = rest.search(/^(## |\[[^\]]+\]: )/m);
  return { start: match.index, headingEnd: start, end: end === -1 ? text.length : start + end, body: (end === -1 ? rest : rest.slice(0, end)) };
}

export function releaseChangelog(text, version, date) {
  const unreleased = section(text, 'Unreleased');
  if (!unreleased) throw new Error('CHANGELOG.md has no ## [Unreleased] section');
  const body = unreleased.body.trim();
  if (!body) throw new Error('CHANGELOG.md Unreleased is empty: list the changes before tagging');
  let next = `${text.slice(0, unreleased.start)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n${text.slice(unreleased.end)}`;
  // Link references, when present: Unreleased compares from the new tag; the new version compares from the previous one.
  const link = /^\[Unreleased\]: (\S+)\/compare\/(\S+)\.\.\.HEAD$/m.exec(next);
  if (link) next = next.replace(link[0], `[Unreleased]: ${link[1]}/compare/v${version}...HEAD\n[${version}]: ${link[1]}/compare/${link[2]}...v${version}`);
  // Before the first release Unreleased links to the commit list; the first version links to its tag.
  const first = /^\[Unreleased\]: (\S+)\/commits\/\S+$/m.exec(next);
  if (first) next = next.replace(first[0], `[Unreleased]: ${first[1]}/compare/v${version}...HEAD\n[${version}]: ${first[1]}/releases/tag/v${version}`);
  return next;
}

export function changelogExcerpt(text, version) {
  const found = section(text, version);
  if (!found) throw new Error(`no CHANGELOG section for ${version}`);
  return `${text.slice(found.start, found.headingEnd)}\n${found.body.trim()}\n`;
}

if (isMain(import.meta.url)) await cli(async () => {
  const [command, version] = process.argv.slice(2).filter(a => a !== '--');
  if (command !== 'excerpt' || !version) throw new Error('usage: node bin/changelog.mjs excerpt <version>');
  process.stdout.write(changelogExcerpt(readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8'), version.replace(/^v/, '')));
});
