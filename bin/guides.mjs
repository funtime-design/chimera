// The illustrated how-tos for every setup step that sends a person to another site (docs/guides/<name>.md, screenshots
// in docs/images/). They are the one copy of those steps: --token-steps, the secrets pause, the prerequisites fix and
// the "Access is not turned on" pause print them from here, and the browser page renders the same files inline.
//
// A guide is: "# Title", a "Why: ..." line, then a numbered list; an indented ![alt](../images/<name>-N.png) after a
// step is that step's screenshot. Nothing else is parsed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUIDES_DIR = fileURLToPath(new URL('../docs/guides/', import.meta.url));
export const IMAGES_DIR = fileURLToPath(new URL('../docs/images/', import.meta.url));
export const GUIDES = ['cloudflare-account', 'wrangler-login', 'master-token', 'zero-trust-enable'];
export const IMAGE_NAME = /^[a-z0-9-]+\.png$/;

export function guideSource(name) {
  if (!GUIDES.includes(name)) throw new Error(`no guide "${name}"`);
  return readFileSync(path.join(GUIDES_DIR, `${name}.md`), 'utf8');
}

// { title, why, steps: [{ n, text, images: [{ alt, src }] }] }; src is the path from the repo root (docs/images/...).
export function parseGuide(markdown) {
  const guide = { title: '', why: '', steps: [] };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = raw.match(/^#\s+(.+)$/))) guide.title = m[1].trim();
    else if ((m = line.match(/^Why:\s*(.+)$/))) guide.why = m[1];
    else if ((m = raw.match(/^(\d+)\.\s+(.+)$/))) guide.steps.push({ n: Number(m[1]), text: m[2].trim(), images: [] });
    else if ((m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)) && guide.steps.length) guide.steps.at(-1).images.push({ alt: m[1], src: path.posix.join('docs/guides', m[2]) });
  }
  return guide;
}

// Replacements such as { '<id>': 'acme' }, applied to the text of a guide.
export const fillIn = (text, subs = {}) => Object.entries(subs).reduce((t, [from, to]) => t.split(from).join(to), text);

// The terminal form: "N. step" lines, each screenshot as an indented path to open.
export function guideLines(name, subs = {}) {
  const guide = parseGuide(fillIn(guideSource(name), subs));
  return guide.steps.flatMap(s => [`${s.n}. ${s.text}`, ...s.images.map(i => `   Screenshot: ${i.src}`)]);
}
// The heading a show block puts above guideLines(); the page replaces everything indented under it with the guide.
export const guideHeading = name => `Step by step (docs/guides/${name}.md):`;
