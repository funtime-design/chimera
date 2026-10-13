// The chimera-setup skill is a step script: prerequisites, detect, then one AskUserQuestion per turn with 2-4 options.
// This guards its shape so it never slides back into a numbered list of questions or "fill it in yourself".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skill = await readFile(new URL('../.claude/skills/chimera-setup/SKILL.md', import.meta.url), 'utf8');
const blocks = skill.split(/^### /m).slice(1).filter(b => /^Q\d+\b/.test(b));

test('the skill starts with the prerequisites check and detection before any question', () => {
  const prereqs = skill.indexOf('pnpm run setup -- --prereqs'), detect = skill.indexOf('pnpm run setup -- --detect'), first = skill.indexOf('### Q1');
  assert.ok(prereqs > 0 && detect > prereqs && first > detect, 'order: --prereqs, --detect, then Q1');
  assert.match(skill, /AskUserQuestion/);
  assert.match(skill, /one question per turn/i);
});

test('every question block uses AskUserQuestion and names 2 to 4 options, each with a description', () => {
  assert.ok(blocks.length >= 8, `expected at least 8 question blocks, got ${blocks.length}`);
  for (const block of blocks) {
    const title = block.split('\n')[0];
    assert.match(block, /AskUserQuestion/, `${title}: uses AskUserQuestion`);
    const after = block.slice(block.indexOf('Options:'));
    assert.ok(block.includes('Options:'), `${title}: has Options:`);
    const options = after.split('\n').filter(l => /^- \*\*.+\*\*: \S/.test(l));
    assert.ok(options.length >= 2 && options.length <= 4, `${title}: 2-4 options, got ${options.length}`);
  }
});

test('the prescribed questions are all there', () => {
  const titles = blocks.map(b => b.split('\n')[0].toLowerCase()).join('\n');
  for (const topic of ['deployment', 'domain', 'display name', 'admin', 'access', 'people', 'confirm', 'master token']) assert.ok(titles.includes(topic), topic);
  assert.match(skill, /No, token sign-in only \(simplest\)/);
  assert.match(skill, /Yes, it is already in front of this domain/);
  assert.match(skill, /https:\/\/dash\.cloudflare\.com\/profile\/api-tokens/);
  assert.match(skill, /API Tokens: Edit/);
  assert.match(skill, /pnpm secrets:mint -- --deployment/);
  assert.match(skill, /npx wrangler login/);
});

test('banned: a numbered list with more than 3 question lines in a row, a 32-hex ask, or "fill it yourself"', () => {
  let run = 0;
  for (const line of skill.split('\n')) {
    run = /^\s*\d+[.)]\s/.test(line) && line.includes('?') ? run + 1 : 0;
    assert.ok(run <= 3, `numbered list of questions near: ${line}`);
  }
  for (const line of skill.split('\n').filter(l => /32-character|32 hex|32-hex/.test(l))) assert.match(line, /[Nn]ever ask/, `asks for a 32-hex value: ${line}`);
  assert.doesNotMatch(skill, /fill (them|those|it) (in|into)[^\n]*yourself/i);
  assert.doesNotMatch(skill, /The person fills those into/);
  assert.match(skill, /[Nn]ever ask for (a|the) token in (the )?chat/);
});
