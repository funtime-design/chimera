// pnpm run setup: stand up a deployment from a short questionnaire, then validate, generate, push secrets, deploy and
// check the live contract. Every step says what it will do, runs, verifies, and records done/todo in the ignored state
// file .chimera-setup/<id>.json, so --resume continues and a finished setup re-run only prints its status.
// (`pnpm setup` is pnpm's own command; use `pnpm run setup`.)
//
//   pnpm run setup [-- --deployment <id>] [--resume] [--answers <file.json>] [--yes]
//   pnpm run setup -- --prereqs     step 0 only: the checklist of what this machine needs
//   pnpm run setup -- --detect      what setup can find out by itself, as JSON (bin/setup-detect.mjs)
//   pnpm run setup -- --token-steps the 6 numbered steps to create the master token in the Cloudflare dashboard
//   pnpm run setup -- --web [--deployment <id>]  the same steps and questions on a local page in the browser (bin/setup-web.mjs)
//
// Text the person must see word for word sits between a "--- show this ---" line and a "--- end ---" line; the
// chimera-setup skill relays those blocks verbatim (prerequisites, pauses, needs-answer lists, status checklists).
//
// A new setup starts with step 0 (prerequisites) and stops on the first missing one. Then it detects what it can
// (Cloudflare account, domains, git email as the first admin, defaults); --answers wins over detection, and on a
// terminal it asks only for the rest. Without a terminal, missing answers exit 2 with a "needs-answer" list.
// Exit 0: done. Exit 2: waiting for a person (a prerequisite, an answer, secrets to mint, the one-time Cloudflare
// Access step, or a confirmation with --yes).
//
// Sign-in: people sign in through Cloudflare Access (an email code); the bridge has no other way for a person to sign
// in, so without Access only static tokens (scripts, cloud sessions) work. The "access" answer says how Access is made:
// "provision" (setup creates the app, group and policy through bin/access-provision.mjs), "existing" (the person
// already has an Access for SaaS app: its client id in "accessClientId", its secret entered with secrets:fill), or
// false (no human sign-in; tokens only). Exit 1: an error. Secret values (tokens, account ID, Access secret) are never printed: every line goes
// through redact(), and child command output is discarded (runCommand).
//
// The steps themselves live in bin/setup-engine.mjs; this file is the terminal around them.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { isMain, projectRoot, runCommand } from './deployment.mjs';
import { makeRedactor } from './secrets-common.mjs';
import { guideLines, guideSource, parseGuide } from './guides.mjs';
import { accessAnswer, capture, detect, formatPrereqs, howToGet, mergeAnswers, prereqs, prereqsOk, publicView } from './setup-detect.mjs';
import { ID, PERSON, Pause, SIGNIN_EXPLAINED, SIGNIN_OPTIONS, accessOf, checkAnswers, exists, onlyState, readState, runSteps, shown, stateFileOf, status } from './setup-engine.mjs';

export { STATE_DIR, Pause, SHOW, SHOW_END, SIGNIN_EXPLAINED, SIGNIN_OPTIONS, TOKEN_STEPS, checkAnswers, configFrom, secretsFrom, unfilled } from './setup-engine.mjs';

export async function setup({
  root = projectRoot, argv = [], env = process.env, isTTY = !!(process.stdin.isTTY && process.stdout.isTTY),
  prompt, run = runCommand, fetchImpl = fetch, detector = ({ answers }) => detect({ root, env, run: capture, answers }), out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`),
} = {}) {
  const { hide, redact } = makeRedactor();
  const say = line => out(redact(line));
  const warn = line => err(redact(line));
  let ask = prompt, rl;
  const question = async q => {
    if (!ask) { rl = createInterface({ input: process.stdin, output: process.stdout }); ask = text => rl.question(text); }
    return String(await ask(q)).trim();
  };
  try {
    const opts = parseArgs(argv);
    if (opts.web) {
      const { startSetupWeb } = await import('./setup-web.mjs');
      await startSetupWeb({ root, deployment: opts.deployment, env, run, fetchImpl, detector, out });
      return new Promise(() => {}); // serves until Ctrl-C
    }
    if (opts.detect) { out(JSON.stringify(publicView(await detector({ answers: {} })), null, 2)); return 0; }
    if (opts.tokenSteps) { say(shown([`${parseGuide(guideSource('master-token')).title} (docs/guides/master-token.md):`, ...guideLines('master-token')].join('\n'))); return 0; }
    if (opts.prereqs) { const list = prereqs(await detector({ answers: {} })); say(shown(formatPrereqs(list))); return prereqsOk(list) ? 0 : 2; }
    let answers = null;
    if (opts.answers) {
      try { answers = JSON.parse(await readFile(path.resolve(opts.answers), 'utf8')); } catch { throw new Error('--answers: file missing or not valid JSON (contents not shown)'); }
    }
    if (answers?.accountId) hide(answers.accountId);
    if (answers) answers.access = accessAnswer(answers.access);
    const id = opts.deployment ?? answers?.deployment ?? (opts.resume ? await onlyState(root) : null);
    if (opts.deployment && answers?.deployment && answers.deployment !== opts.deployment) throw new Error('--deployment and the answers file name different deployments');
    let state = id && ID.test(id) ? await readState(stateFileOf(root, id)) : null;
    if (opts.resume && !state) throw new Error(`nothing to resume${id ? ` for "${id}"` : ''}: run setup without --resume first`);
    const configured = id && ID.test(id) && await exists(path.join(root, 'deployments', id, 'bridge.config.json'));
    if (!state?.steps?.config && !configured) {
      // Step 0, then detection: --answers wins, detection fills the rest, a terminal asks for what is left.
      const given = { ...(answers ?? {}), ...(id ? { deployment: id } : {}) };
      const report = await detector({ answers: given });
      for (const a of report.fields.accounts.value ?? []) hide(a.id);
      const list = prereqs(report);
      say(shown(formatPrereqs(list)));
      if (!prereqsOk(list)) return 2;
      let merged = mergeAnswers(given, report);
      if (isTTY && (!answers || merged.missing.length)) merged = mergeAnswers(await questionnaire(question, say, report, given), report);
      if (merged.missing.length) {
        say(shown([`Setup needs a person to answer these first (needs-answer): ${merged.missing.join(', ')}`,
          ...merged.missing.map(key => `  - ${key}: ${howToGet(report, key)}`),
          'Add them to the answers file and run: pnpm run setup -- --answers <file.json>'].join('\n')));
        return 2;
      }
      answers = merged.answers;
      if (answers.accountId) hide(answers.accountId);
    }
    if (answers) {
      const problems = checkAnswers(answers);
      if (problems.length) throw new Error(`answers need fixing:\n  - ${problems.join('\n  - ')}`);
    }
    const deployment = id ?? answers.deployment;
    state ??= { deployment, access: answers ? accessOf(answers) : null, steps: {} };
    if (answers) state.github = answers.githubActions !== false;
    if (opts.resume) say(shown(status(state, `Where setup stands for ${deployment}:`)));
    if (answers) state.access = accessOf(answers);
    return await runSteps({ root, state, answers, yes: opts.yes, isTTY, question, prompt, releaseTerminal: () => { rl?.close(); rl = null; ask = prompt; },
      run, fetchImpl, env, say, warn, hide });
  } catch (error) {
    if (error instanceof Pause) { say(shown(error.message)); return 2; }
    warn(`setup: ${error.message}`);
    return 1;
  } finally {
    rl?.close();
  }
}

// On a terminal: ask, one thing at a time, only what the answers file did not give, offering what detection found.
async function questionnaire(question, say, report, given) {
  say('A few questions; press Enter to take the suggestion in [brackets]. Emails and the account ID go only into the ignored secrets.json.');
  const f = report.fields;
  const askUntil = async (q, ok, why, fallback) => {
    for (;;) { const v = (await question(fallback ? `${q} [${fallback}]: ` : `${q}: `)) || fallback || ''; if (ok(v)) return v; say(`  ${why}`); }
  };
  const a = { ...given };
  a.deployment ??= await askUntil('Short name for this bridge (becomes the folder deployments/<name>/)', v => ID.test(v) && !['all', 'example'].includes(v), 'lowercase letters, digits, dash or underscore', f.deployment.value);
  a.displayName ??= await askUntil('Name people see for the bridge', v => !!v, 'required', f.displayName.source === 'needs-answer' ? '' : `${a.deployment === f.deployment.value ? f.displayName.value : `${a.deployment} bridge`}`);
  if (!a.origin) {
    const choices = f.origin.choices ?? ['workers.dev'];
    say('Where should the bridge live?');
    choices.forEach((c, i) => say(`  ${i + 1}) ${c === 'workers.dev' ? 'no custom domain: a free workers.dev address' : c}`));
    const v = await askUntil('Pick a number or type an https:// address', v => !!choices[Number(v) - 1] || isOrigin(v) || v === 'workers.dev', 'a number from the list, or an HTTPS address with no path', f.origin.value === 'workers.dev' ? String(choices.indexOf('workers.dev') + 1) : '');
    a.origin = choices[Number(v) - 1] ?? v;
  }
  if (!a.accountId && f.accountId.source === 'needs-answer') {
    a.accountId = await askUntil(`Cloudflare account ID (${f.accountId.howToGet})`, v => /^[a-fA-F0-9]{32}$/.test(v), 'the 32-character account ID');
  }
  a.workerName ??= await askUntil('Worker name (the Cloudflare service that runs the bridge)', v => ID.test(v), 'lowercase letters, digits, dash or underscore', `${a.deployment}-bridge`);
  const people = async (label, min, suggested) => {
    const used = () => [...(a.admins ?? []), ...(a.members ?? [])].map(p => p.name);
    for (;;) {
      const raw = await question(`${label} (person names separated by commas, no dashes)${suggested ? ` [${suggested.map(p => `${p.name} <${p.email}>`).join(', ')}]` : ''}: `);
      if (!raw && suggested) return suggested;
      const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = names.filter(n => !PERSON.test(n) || n === 'all');
      const dup = names.filter((n, i) => names.indexOf(n) !== i || used().includes(n));
      if (bad.length) { say(`  no dashes or other characters in person names: ${bad.join(', ')}`); continue; }
      if (dup.length) { say(`  each person name is used once: ${[...new Set(dup)].join(', ')}`); continue; }
      if (names.length < min) { say('  at least one'); continue; }
      const list = [];
      for (const name of names) list.push({ name, email: await askUntil(`  ${name}'s sign-in email`, v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'an email address') });
      return list;
    }
  };
  a.admins ??= await people('Admins (they open the status and settings pages)', 1, f.admins.source === 'needs-answer' ? null : f.admins.value);
  a.members ??= await people('Other people (blank for none)', 0);
  if (a.access === undefined) {
    say(SIGNIN_EXPLAINED);
    say('How should people sign in?');
    say(`  1) ${SIGNIN_OPTIONS.provision}`);
    say(`  2) ${SIGNIN_OPTIONS.existing}`);
    const v = await askUntil('Pick a number', v => v === '1' || v === '2', '1 or 2', '1');
    a.access = v === '1' ? 'provision' : 'existing';
    if (a.access === 'existing') a.accessClientId ??= await askUntil('  Your Access app\'s client id (Zero Trust > Access controls > Applications > your app > Configure)', v => /^\S+$/.test(v), 'the client id, no spaces');
  }
  return a;
}
const isOrigin = v => { try { return new URL(v).origin === v && v.startsWith('https://'); } catch { return false; } };

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (a === '--answers') o.answers = args[++i];
    else if (a === '--resume') o.resume = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--detect') o.detect = true;
    else if (a === '--prereqs') o.prereqs = true;
    else if (a === '--token-steps') o.tokenSteps = true;
    else if (a === '--web') o.web = true;
    else throw new Error(`unsupported option ${JSON.stringify(a)}; use --deployment <id>, --answers <file.json>, --resume, --yes, --prereqs, --detect, --token-steps, --web`);
  }
  if (o.deployment !== undefined && (!ID.test(o.deployment) || o.deployment === 'all')) throw new Error('invalid --deployment id');
  if ('answers' in o && !o.answers) throw new Error('--answers needs a file');
  return o;
}

if (isMain(import.meta.url)) process.exitCode = await setup({ argv: process.argv.slice(2) });
