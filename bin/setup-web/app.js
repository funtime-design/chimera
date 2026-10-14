// The setup page. It only renders what /api/state says and posts answers and Run clicks; every step runs in the
// engine on the server. Text is always set with textContent (never innerHTML), so nothing from the server is parsed
// as markup. The session key from the URL goes in a header on every call.
const key = new URLSearchParams(location.search).get('t') ?? '';
const SHOW = '--- show this ---', SHOW_END = '--- end ---';
const main = document.getElementById('main');
let timer = null, lastScreen = '';

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-setup-token': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `the setup server answered ${res.status}`);
  return data;
}

// Elements. h('p.muted', 'text') or h('button.primary', { onclick }, 'Next').
function h(tag, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    if (kid instanceof Node) el.append(kid);
    else if (typeof kid === 'object') for (const [k, v] of Object.entries(kid)) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k in el && k !== 'list') el[k] = v; else el.setAttribute(k, v); }
    else el.append(String(kid));
  }
  return el;
}
// `code` spans and https:// links inside plain text.
function rich(text) {
  const out = [];
  String(text ?? '').split(/(`[^`]+`|https:\/\/[^\s)>,]+[^\s)>,.])/).forEach(part => {
    if (!part) return;
    if (part.startsWith('`') && part.endsWith('`')) out.push(h('code', part.slice(1, -1)));
    else if (part.startsWith('https://')) out.push(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part));
    else out.push(part);
  });
  return out;
}
// A how-to guide (docs/guides/<name>.md), rendered inline: headings, numbered steps, screenshots, `code`, links.
function guideBlock(name) {
  const box = h('section.guide', { 'aria-label': 'How to, step by step' }, h('p.muted', 'Loading the how-to…'));
  api(`/api/guide/${name}`).then(g => box.replaceChildren(...markdown(g.markdown))).catch(e => box.replaceChildren(h('p.error', e.message)));
  return box;
}
function markdown(md) {
  const out = [];
  let list = null, item = null;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) continue;
    if ((m = raw.match(/^(#{1,3})\s+(.+)$/))) { list = item = null; out.push(h(m[1].length === 1 ? 'h2' : 'h3', ...rich(m[2]))); }
    else if ((m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/))) {
      const fig = h('figure', h('img', { src: `/images/${m[2].split('/').pop()}`, alt: m[1], loading: 'lazy' }), h('figcaption', `Look for: ${m[1]}`));
      if (item) item.append(fig); else out.push(fig);
    } else if ((m = raw.match(/^(\d+)\.\s+(.+)$/))) {
      if (!list) { list = h('ol.guide-steps'); out.push(list); }
      item = h('li', h('p', ...rich(m[2]))); list.append(item);
    } else if (/^\s/.test(raw) && item) item.append(h('p', ...rich(line)));
    else { list = item = null; const text = line.replace(/^Why:\s*/, ''); out.push(h('p', ...rich(text.charAt(0).toUpperCase() + text.slice(1)))); }
  }
  return out;
}
function screen(...kids) {
  clearTimeout(timer); timer = null;
  main.replaceChildren(...kids.flat().filter(Boolean));
  const title = main.querySelector('h1');
  if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
}
const error = () => h('p.error', { role: 'alert' });
const fail = (el, e) => { el.textContent = e.message; };

function rail(view) {
  document.getElementById('title').textContent = view.displayName ? `${view.displayName} setup` : 'Bridge setup';
  document.title = view.displayName ? `${view.displayName} setup` : 'Bridge setup';
  const words = { done: 'done', current: 'current step', todo: 'to do', skipped: 'not needed' };
  for (const g of view.groups) {
    const li = document.querySelector(`#steps li[data-id="${g.id}"]`);
    if (!li) continue;
    li.dataset.status = g.status;
    li.querySelector('[data-sr]').textContent = ` (${words[g.status]})`;
    if (g.status === 'current') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  }
}

async function load() {
  try { render(await api('/api/state')); }
  catch (e) { screen(h('h1', 'Setup is not reachable'), h('p', e.message), h('p.muted', 'Is `pnpm run setup -- --web` still running in your terminal? Open the exact URL it printed.')); }
}
function render(view) {
  rail(view);
  const s = view.screen;
  const id = JSON.stringify([s.kind, s.question?.id, s.step]);
  const same = id === lastScreen;
  lastScreen = id;
  if (s.kind === 'prereqs') return prereqsScreen();
  if (s.kind === 'question') return questionScreen(s.question);
  if (s.kind === 'writing') return runScreen({ label: 'Writing the settings', title: 'writing bridge.config.json, deployment.lock.json and secrets.json' }, view.run, false);
  if (s.kind === 'secrets') return secretsScreen(s, view.run, same);
  if (s.kind === 'step') return runScreen(s, view.run, true);
  if (s.kind === 'stopped') return stoppedScreen();
  if (s.kind === 'done') return doneScreen(s);
}

async function prereqsScreen() {
  const list = h('ul.checklist');
  const msg = error();
  const next = h('button.primary', { type: 'button', disabled: true, onclick: load }, 'Continue');
  const again = h('button', { type: 'button', onclick: check }, 'Check again');
  const summary = h('p', { 'aria-live': 'polite' }, 'Checking this machine…');
  const guide = h('div');
  screen(h('p.kicker', 'Step 0'), h('h1', 'What this machine needs'), summary, list, h('div.actions', next, again), msg, guide);
  async function check() {
    again.disabled = true; summary.textContent = 'Checking this machine…'; msg.textContent = '';
    try {
      const r = await api('/api/prereqs');
      const marks = { ok: '✓', missing: '✗', unknown: '?', optional: '○' };
      list.replaceChildren(...r.list.map(p => h('li', { 'data-s': p.status },
        h('span.tick', { 'aria-hidden': 'true' }, marks[p.status]),
        h('span', h('span.sr', `${p.status === 'ok' ? 'ok' : p.required ? 'missing' : 'optional'}: `), ...rich(p.label), !p.required && p.status !== 'ok' ? ' (optional)' : ''),
        h('span.detail', ...rich(p.detail)),
        p.status !== 'ok' && p.fix ? h('span.fix', p.required ? 'Fix: ' : 'To add it: ', ...rich(p.fix)) : null)));
      const blocker = r.list.find(p => p.required && p.status === 'missing');
      summary.replaceChildren(...(blocker ? ['Next: ', ...rich(blocker.fix), '. Then press Check again.'] : ['All set: everything required is here.']));
      guide.replaceChildren(...(blocker?.guide ? [guideBlock(blocker.guide)] : []));
      next.disabled = !r.ok;
    } catch (e) { fail(msg, e); }
    again.disabled = false;
  }
  check();
}

function questionScreen(q) {
  const msg = error();
  const name = `q-${q.id}`;
  const inputs = new Map();
  const options = q.options.map((o, i) => {
    const radio = h('input', { type: 'radio', name, value: o.value, id: `${name}-${i}` });
    if (i === 0) radio.checked = true;
    let text = null;
    if (o.input) {
      text = h('input', { type: 'text', id: `${name}-${i}-text`, placeholder: o.input, autocomplete: 'off', spellcheck: false });
      inputs.set(o.value, text);
    }
    const box = text ? h('div.other', { hidden: i !== 0 }, h('label', { htmlFor: text.id }, 'Other: type it here'), text) : null;
    radio.addEventListener('change', () => { for (const el of main.querySelectorAll('.other')) el.hidden = true; if (box) { box.hidden = false; text.focus(); } });
    return h('label.option', { htmlFor: radio.id }, radio, h('span.olabel', ...rich(o.label)), h('span.odesc', ...rich(o.description)), box);
  });
  const next = h('button.primary', { type: 'submit' }, q.id === 'Q9' ? 'Continue' : 'Next');
  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    const value = form.querySelector(`input[name="${name}"]:checked`)?.value;
    next.disabled = true; msg.textContent = '';
    try { render(await api('/api/answer', { id: q.id, value, text: inputs.get(value)?.value ?? '' })); }
    catch (err) { fail(msg, err); next.disabled = false; }
  } },
  h('fieldset', h('legend.sr', q.question), h('div.options', options)),
  h('div.actions', next), msg);
  screen(
    h('p.kicker', q.header),
    h('h1', ...rich(q.question)),
    q.description ? h('p', ...rich(q.description)) : null,
    q.added?.length ? h('p.muted', `Added so far: ${q.added.join(', ')}`) : null,
    q.summary ? h('ul.summary', q.summary.map(line => h('li', line))) : null,
    q.problems?.length ? h('div.note.bad', h('p', 'Fix these before setting up:'), h('ul', q.problems.map(p => h('li', ...rich(p))))) : null,
    form,
  );
}

// The log of an engine run: show blocks (text meant for the person) stand out.
function logLines(pre, lines) {
  let inShow = false, block = null;
  for (const line of lines) {
    if (line === SHOW) { inShow = true; block = h('span.show'); pre.append(block); continue; }
    if (line === SHOW_END) { inShow = false; continue; }
    (inShow ? block : pre).append(`${line}\n`);
  }
  pre.scrollTop = pre.scrollHeight;
}

// A pause block as paragraphs; the terminal copy of a guide (its heading and the lines indented under it) becomes the
// rendered guide with its screenshots.
function pauseText(text, guide) {
  const out = [];
  let skip = -1;
  for (const line of text.split('\n')) {
    const indent = line.match(/^\s*/)[0].length;
    if (skip >= 0 && indent > skip) continue;
    skip = -1;
    if (guide && /Step by step \(docs\/guides\/[a-z-]+\.md\):$/.test(line)) {
      skip = indent;
      const before = line.trim().replace(/\s*Step by step \(docs\/guides\/[a-z-]+\.md\):$/, '');
      if (before) out.push(h('p', ...rich(before)));
      out.push(guideBlock(guide));
      continue;
    }
    out.push(h('p', ...rich(line.trim())));
  }
  return out;
}

function runScreen(step, run, canRun) {
  const mine = run && run.step === step.step ? run : null;
  const previous = run && !mine && run.done && step.step ? run : null;
  const pre = h('pre.log', { 'aria-live': 'polite', hidden: !mine });
  const result = h('p.result', { 'aria-live': 'polite' });
  const pause = h('div.note.warn', { hidden: true });
  const msg = error();
  const go = h('button.primary', { type: 'button' }, mine?.done && mine.code !== 0 ? 'Retry' : 'Run');
  const confirmBox = step.confirm ? h('div.note.warn', { hidden: true },
    h('p', h('strong', step.confirm)),
    h('div.actions', h('button.primary', { type: 'button', onclick: () => start(true) }, 'Yes, go ahead'), h('button', { type: 'button', onclick: () => { confirmBox.hidden = true; go.hidden = false; } }, 'Cancel'))) : null;
  go.addEventListener('click', () => { if (confirmBox) { confirmBox.hidden = false; go.hidden = true; } else start(false); });
  screen(
    h('p.kicker', step.position ?? 'Settings'),
    h('h1', step.label),
    h('p.muted', `What it does: ${step.title}.`),
    previous ? h('p.muted', `Before this: ${previous.result ?? 'done'}`) : null,
    canRun ? h('div.actions', go) : null, confirmBox, pre, result, pause, msg,
  );
  let since = 0;
  const show = r => {
    pre.hidden = false;
    logLines(pre, r.lines); since += r.lines.length;
    if (!r.done) return;
    result.dataset.code = r.code;
    result.textContent = r.code === 1 ? `Failed: ${[...pre.textContent.trim().split('\n')].reverse().find(l => l.startsWith('setup: '))?.slice(7) ?? 'see the output above'}` : r.result ?? (r.code === 0 ? 'Result: done' : '');
    if (r.code === 2 && r.pause) { pause.hidden = false; pause.replaceChildren(h('p', h('strong', 'Waiting for you')), ...pauseText(r.pause, r.guide)); }
    go.hidden = false; go.disabled = false; go.textContent = r.code === 0 ? 'Run' : 'Retry';
  };
  async function poll() {
    try {
      const r = await api(`/api/run?since=${since}`);
      if (!r) return;
      show(r);
      if (!r.done) { timer = setTimeout(poll, 500); return; }
      if (r.code === 0) timer = setTimeout(load, 600);
      else if (!canRun) timer = setTimeout(load, 600);
    } catch (e) { fail(msg, e); }
  }
  async function start(confirm) {
    if (confirmBox) confirmBox.hidden = true;
    go.hidden = false; go.disabled = true; msg.textContent = '';
    pre.replaceChildren(); since = 0; result.textContent = ''; pause.hidden = true;
    try { show(await api(`/api/run/${step.step}`, { confirm })); timer = setTimeout(poll, 300); }
    catch (e) { fail(msg, e); go.disabled = false; }
  }
  if (mine) { pre.hidden = false; if (!mine.done) go.disabled = true; poll(); }
  else if (!canRun && run) { since = 0; poll(); }
}

function secretsScreen(s, run, same) {
  if (same && main.querySelector('[data-screen="secrets"]')) { timer = setTimeout(load, 2000); return; }
  const copy = h('button', { type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(s.command); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; }
  } }, 'Copy');
  const earlier = run?.step === 'secrets' && run.lines.length ? h('details', h('summary', 'Output of writing the settings'), (() => { const pre = h('pre.log'); logLines(pre, run.lines); return pre; })()) : null;
  screen(
    h('p.kicker', 'Secrets', { 'data-screen': 'secrets' }),
    h('h1', 'Create the tokens in your own terminal'),
    h('p', 'This page never asks for a token. One master token, made once in the Cloudflare dashboard, makes all the others.'),
    guideBlock(s.guide),
    h('h2', 'Run this in your terminal'),
    h('p.muted', 'In this folder. It asks for the master token at a hidden prompt (typing stays hidden) and makes every other token.'),
    h('div.command', h('code', s.command), copy),
    h('p.muted', 'Already hold the values? ', h('code', s.fill), ' enters them instead.'),
    h('p.waiting', { role: 'status' }, h('span.pulse', { 'aria-hidden': 'true' }), 'Waiting for secrets.json. This page moves on by itself when the tokens are there.'),
    earlier,
  );
  timer = setTimeout(load, 2000);
}

function stoppedScreen() {
  const msg = error();
  screen(h('h1', 'Stopped. Nothing was written.'), h('p', 'You can close this tab and stop setup with Ctrl-C in the terminal, or start the questions again.'),
    h('div.actions', h('button.primary', { type: 'button', onclick: async () => { try { render(await api('/api/answer', { reset: true })); } catch (e) { fail(msg, e); } } }, 'Start again')), msg);
}
function doneScreen(s) {
  screen(h('p.kicker', 'Done'), h('h1', 'Your bridge is set up'),
    s.origin ? h('p', 'It is live at ', ...rich(s.origin), '.') : null,
    h('p', 'Every step is done. You can close this tab and stop setup with Ctrl-C in the terminal.'),
    h('p.muted', 'People, admins and names change later in bridge.config.json; devices and permissions on the bridge\'s /docs/settings page.'));
}

if (!key) screen(h('h1', 'Open the link from your terminal'), h('p', 'This page needs the one-time key in the URL that `pnpm run setup -- --web` printed.'));
else load();
