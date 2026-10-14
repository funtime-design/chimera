// The illustrated how-tos (docs/guides/) for every step that sends a person to another site: each exists, has a why
// line and numbered steps, references only images that exist, and is the one copy the terminal prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { GUIDES, GUIDES_DIR, IMAGES_DIR, guideLines, guideSource, parseGuide } from '../bin/guides.mjs';
import { TOKEN_STEPS } from '../bin/setup-engine.mjs';
import { formatPrereqs } from '../bin/setup-detect.mjs';

const repo = path.resolve(GUIDES_DIR, '../..');

test('every guide exists, says why, has numbered steps, and references only images that exist', () => {
  assert.deepEqual(GUIDES.slice().sort(), ['cloudflare-account', 'master-token', 'wrangler-login', 'zero-trust-enable']);
  const referenced = new Set();
  for (const name of GUIDES) {
    const md = guideSource(name);
    const g = parseGuide(md);
    assert.ok(g.title, `${name}: a title`);
    assert.ok(g.why, `${name}: a "Why:" line`);
    assert.ok(g.steps.length >= 3, `${name}: numbered steps`);
    assert.deepEqual(g.steps.map(s => s.n), g.steps.map((_, i) => i + 1), `${name}: numbered 1..n`);
    const refs = [...md.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
    assert.ok(refs.length >= 2, `${name}: illustrated`);
    for (const [, alt, src] of refs) {
      assert.match(src, new RegExp(`^\\.\\./images/${name}-\\d+\\.png$`), `${name}: image path ${src}`);
      assert.ok(alt.length > 20 && alt.endsWith('.'), `${name}: a one-sentence alt text for ${src}`);
      assert.ok(existsSync(path.join(GUIDES_DIR, src)), `${name}: ${src} exists`);
      referenced.add(path.basename(src));
    }
  }
  const readme = readFileSync(path.join(IMAGES_DIR, 'README.md'), 'utf8');
  for (const file of readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png'))) {
    assert.ok(referenced.has(file), `${file} is used by a guide`);
    assert.ok(readme.includes(`\`${file}\``), `${file} is listed in docs/images/README.md`);
    const png = readFileSync(path.join(IMAGES_DIR, file));
    assert.equal(png.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
    assert.ok(png.readUInt32BE(16) >= 640, `${file} is at least 640px wide`);
  }
});

test('one copy: the token steps, the prerequisites fix and the Access pause print the guides', () => {
  assert.deepEqual(TOKEN_STEPS, parseGuide(guideSource('master-token')).steps.map(s => `${s.n}. ${s.text}`));
  const lines = guideLines('master-token', { '<id>': 'acme' });
  assert.match(lines.join('\n'), /^6\. .*`pnpm secrets:mint -- --deployment acme`/m);
  assert.ok(lines.includes('   Screenshot: docs/images/master-token-1.png'));
  for (const file of ['bin/setup-engine.mjs', 'bin/setup.mjs', 'bin/setup-web.mjs', 'bin/setup-web/app.js', '.claude/skills/chimera-setup/SKILL.md']) {
    assert.doesNotMatch(readFileSync(path.join(repo, file), 'utf8'), /Create Custom Token/, `${file}: no second copy of the token steps`);
  }
  const text = formatPrereqs([{ key: 'wrangler', required: true, label: 'wrangler logged in', status: 'missing', detail: 'not logged in', fix: 'run `npx wrangler login`', guide: 'wrangler-login' }]);
  assert.match(text, /Step by step \(docs\/guides\/wrangler-login\.md\):\n  1\. In this folder/);
  assert.match(text, /Screenshot: docs\/images\/wrangler-login-1\.png/);
  assert.match(readFileSync(path.join(repo, 'bin/access-provision.mjs'), 'utf8'), /guideLines\('zero-trust-enable'\)/);
});
