// The setup questions, one at a time, for a page that cannot run AskUserQuestion: the same questions, headers and
// option texts as the chimera-setup skill (.claude/skills/chimera-setup/SKILL.md, Q0 to Q9; test/setup-web.test.mjs
// checks the wording against it). nextQuestion() says what to ask next from the detection report and the answers so
// far; answerQuestion() records one answer. The browser page (bin/setup-web.mjs) only renders and posts them.
//
// The draft holds the answers in the answers-file shape (deployment, displayName, origin, admins, members, access,
// accessClientId, accountName) plus a few keys starting with "_" that only steer the questions.
import { ID, PERSON, SIGNIN_EXPLAINED, SIGNIN_OPTIONS, checkAnswers } from './setup-engine.mjs';
import { howToGet, mergeAnswers } from './setup-detect.mjs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const slug = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isOrigin = v => { try { return new URL(v).origin === v && v.startsWith('https://'); } catch { return false; } };
const q = (id, key, group, header, question, options, extra = {}) => ({ id, key, group, header, question, options, ...extra });
const opt = (value, label, description, input) => ({ value, label, description, ...(input ? { input } : {}) });

// "alice alice@example.com" -> { name, email }, or an error sentence.
function person(text, taken) {
  const [name = '', email = '', ...rest] = String(text ?? '').trim().split(/\s+/);
  if (rest.length || !email) return { error: 'type a name and an email, like `bob bob@example.com`' };
  const n = name.toLowerCase();
  if (!PERSON.test(n) || n === 'all') return { error: 'names are lowercase letters, digits or underscore, with no dash' };
  if (taken.includes(n)) return { error: `"${n}" is already used; every person name is used once` };
  if (!EMAIL.test(email)) return { error: 'that email does not look like an email address' };
  return { value: { name: n, email } };
}
const people = draft => [...(draft.admins ?? []), ...(draft.members ?? [])];
// The draft as an answers file: steering keys dropped.
export const answersOf = draft => Object.fromEntries(Object.entries(draft).filter(([k]) => !k.startsWith('_')));

const SIGNIN_DESCRIPTIONS = {
  provision: 'setup makes the login screen, the list of allowed emails and the app through the Cloudflare API; the only manual step is turning Access on once, if it is off.',
  existing: 'for an Access for SaaS app you made yourself; you paste its client id next and its secret into a hidden prompt later.',
};
const CHANGEABLE = [
  ['deployment', 'Name'], ['origin', 'Address'], ['displayName', 'Title'], ['admins', 'Admin'], ['access', 'Sign-in'], ['members', 'People'],
];

// What the summary screen (Q9) lists; also what the page shows above "Yes, set it up".
export function summary(report, draft) {
  const { answers, missing } = mergeAnswers(answersOf(draft), report);
  const problems = [...missing.map(k => `${k}: ${howToGet(report, k)}`), ...(missing.length ? [] : checkAnswers(answers))];
  const who = list => list?.length ? list.map(p => `${p.name} <${p.email}>`).join(', ') : 'none';
  const lines = [
    `Name: ${answers.deployment ?? '?'} (deployments/${answers.deployment ?? '?'}/)`,
    `Address: ${answers.origin ?? '?'}`,
    `Title: ${answers.displayName ?? '?'}`,
    `Admin: ${who(answers.admins)}`,
    `Other people: ${who(answers.members)}`,
    `Sign-in: ${answers.access === 'existing' ? 'your Access app' : answers.access === 'provision' ? 'email code, setup creates it' : 'none (tokens only)'}`,
    `GitHub Actions secrets: ${answers.githubActions ? 'yes' : 'no'}`,
  ];
  return { lines, answers, problems };
}

// The next question, or null when every answer is in and confirmed ("_confirmed"), or the draft was stopped.
export function nextQuestion(report, draft) {
  const f = report.fields;
  if (draft._stopped || draft._confirmed) return null;
  const inProgress = f.setupInProgress?.value ?? [];
  if (inProgress.length && draft._resume === undefined) {
    const id = inProgress[0];
    return q('Q0', 'resume', 'settings', 'Resume', `A setup for ${id} is already half done. Carry on with it?`, [
      ...inProgress.slice(0, 3).map(d => opt(d, `Carry on with ${d}`, `runs \`pnpm run setup -- --deployment ${d} --resume\` and picks up where it stopped.`)),
      opt('new', 'Start a new bridge', `leaves ${inProgress.length > 1 ? 'those' : id} as it is and sets up a different one.`),
    ]);
  }
  const accounts = f.accounts.value ?? [];
  if (f.accountId.source === 'needs-answer' && accounts.length > 1 && !draft.accountName) {
    return q('Q1', 'accountName', 'settings', 'Account', 'Which Cloudflare account should run the bridge?',
      accounts.slice(0, 4).map(a => opt(a.name, a.name, `account ending ****${a.id.slice(-4)}`)));
  }
  if (!draft.deployment) {
    return q('Q2', 'deployment', 'settings', 'Name', 'What short name should this bridge have? It becomes the folder deployments/<name>/.', [
      ...(f.deployment.choices ?? [{ value: f.deployment.value, description: 'suggested' }]).map(c => opt(c.value, c.value, c.description)),
      opt('other', 'Something else', 'type a name with lowercase letters, digits or dashes (choose Other).', 'a short name, like acme'),
    ]);
  }
  if (!draft.origin) {
    const zones = f.zones.value ?? [];
    const you = report.workersSubdomain ?? '<you>';
    const domains = f.zones.source === 'needs-answer'
      ? [opt('domain', 'I have a domain on Cloudflare', 'type it (choose Other); it must show in Cloudflare dashboard > Websites.', 'example.com')]
      : zones.slice(0, 3).map(z => opt(`https://bridge.${z}`, `bridge.${z}`, 'uses a domain already on your Cloudflare account'));
    return q('Q3', 'origin', 'settings', 'Address', 'Where should the bridge live on the web?', [
      ...domains,
      opt('workers.dev', 'No custom domain, use workers.dev', `a free address Cloudflare gives every account, like https://${draft.deployment}-bridge.${you}.workers.dev.`),
    ]);
  }
  if (!draft.displayName) {
    const suggested = draft.deployment === f.deployment.value ? f.displayName.value : `${draft.deployment} bridge`;
    return q('Q4', 'displayName', 'settings', 'Title', 'What should people see as the bridge\'s name?', [
      opt(suggested, suggested, 'the suggested name; you can change it later in bridge.config.json.'),
      opt('other', 'Something else', 'type the name (choose Other).', 'the bridge\'s name'),
    ]);
  }
  if (!draft.admins) {
    const question = 'Who is the admin? An admin opens the status and settings pages and approves risky commands.';
    const found = f.admins.source === 'needs-answer' ? null : f.admins.value?.[0];
    return q('Q5', 'admins', 'settings', 'Admin', question, found
      ? [opt('detected', `Use ${found.email}`, `from \`git config user.email\`; your person name will be ${found.name}.`),
        opt('other', 'Different email', 'type a name and email, like `alice alice@example.com` (choose Other).', 'alice alice@example.com')]
      : [opt('other', 'Type a name and email', 'choose Other; like `alice alice@example.com`.', 'alice alice@example.com'),
        opt('github', 'Use my GitHub email', 'read it with `gh api user --jq .email`.')]);
  }
  if (draft.access === undefined || draft.access === false) {
    return q('Q6', 'access', 'signin', 'Sign-in', 'How should people sign in?', [
      opt('provision', SIGNIN_OPTIONS.provision, SIGNIN_DESCRIPTIONS.provision),
      opt('existing', SIGNIN_OPTIONS.existing, SIGNIN_DESCRIPTIONS.existing),
    ], { description: SIGNIN_EXPLAINED });
  }
  if (draft.access === 'existing' && !draft.accessClientId) {
    return q('Q6.1', 'accessClientId', 'signin', 'Client id', 'Paste your Access app\'s client id. It is in Zero Trust (https://one.dash.cloudflare.com/) > Access controls > Applications > your app > Configure, under the OIDC settings. It is not secret; the client secret goes into a hidden prompt later.', [
      opt('other', 'Paste the client id', 'choose Other and paste it.', 'the client id'),
      opt('provision', 'Create one for me instead', 'switches the answer to `"access": "provision"`.'),
    ]);
  }
  if (!draft._people) {
    return q('Q7', 'members', 'signin', 'People', 'Anyone else who should use the bridge?', [
      opt('none', 'Just me for now', 'you can add people later in bridge.config.json and secrets.json.'),
      opt('add', 'Add people', 'one at a time, a name and sign-in email each.'),
    ]);
  }
  if (draft._people === 'add' && !draft._peopleDone) {
    return q('Q8', 'members', 'signin', 'Person', 'Who should we add? Choose Other and type a name and email, like `bob bob@example.com`.', [
      opt('other', 'Type a name and email', 'choose Other; names are lowercase with no dash, each used once.', 'bob bob@example.com'),
      opt('done', 'That\'s everyone', 'stop adding people.'),
    ], { added: (draft.members ?? []).map(p => p.name) });
  }
  if (draft._changing) {
    return q('Q9.1', 'change', 'signin', 'Change', 'Which answer should change?', CHANGEABLE.map(([k, label]) => opt(k, label, `ask the ${label.toLowerCase()} question again.`)));
  }
  const s = summary(report, draft);
  return q('Q9', 'confirm', 'signin', 'Confirm', 'Set up this bridge?', [
    opt('yes', 'Yes, set it up', 'writes the settings and starts the steps.'),
    opt('change', 'Change something', 'say which answer, then ask that one question again.'),
    opt('stop', 'Stop here', 'nothing is written.'),
  ], { summary: s.lines, problems: s.problems });
}

// Records one answer: { id, value, text }. value is the picked option's value; text is what the person typed into an
// option that takes input. Returns { draft } or { draft, error } (the draft unchanged). run: for `gh api user`.
export async function answerQuestion(report, draft, { id, value, text } = {}, { run } = {}) {
  const current = nextQuestion(report, draft);
  if (!current || current.id !== id) return { draft, error: 'that question is not the one being asked; reload the page' };
  const option = current.options.find(o => o.value === value);
  if (!option) return { draft, error: 'pick one of the options' };
  const typed = String(text ?? '').trim();
  if (option.input && !typed) return { draft, error: 'type the answer in the box first' };
  const d = structuredClone(draft);
  const fail = error => ({ draft, error });
  switch (id) {
    case 'Q0': d._resume = value; break;
    case 'Q1': d.accountName = value; break;
    case 'Q2': {
      const name = option.input ? typed.toLowerCase() : value;
      if (!ID.test(name) || ['all', 'example'].includes(name)) return fail('lowercase letters, digits, dash or underscore; not "all" or "example"');
      d.deployment = name; break;
    }
    case 'Q3': {
      const origin = option.input ? (typed.startsWith('https://') ? typed.replace(/\/+$/, '') : `https://bridge.${typed.replace(/^bridge\./, '')}`) : value;
      if (origin !== 'workers.dev' && !isOrigin(origin)) return fail('a domain like example.com, or an https:// address with no path');
      d.origin = origin; break;
    }
    case 'Q4': d.displayName = option.input ? typed : value; break;
    case 'Q5': {
      if (value === 'detected') { d.admins = structuredClone(report.fields.admins.value); break; }
      if (value === 'github') {
        let email = '';
        try { const r = await run?.('gh', ['api', 'user', '--jq', '.email']); email = r?.code === 0 ? String(r.stdout ?? '').trim() : ''; } catch {}
        if (!EMAIL.test(email)) return fail('gh found no public email on your GitHub account; type a name and email instead');
        const name = slug(email.split('@')[0]);
        if (!PERSON.test(name)) return fail('could not make a person name from that email; type a name and email instead');
        d.admins = [{ name, email }]; break;
      }
      const p = person(typed, (d.members ?? []).map(m => m.name));
      if (p.error) return fail(p.error);
      d.admins = [p.value]; break;
    }
    case 'Q6': d.access = value; break;
    case 'Q6.1':
      if (value === 'provision') { d.access = 'provision'; delete d.accessClientId; break; }
      if (!/^\S+$/.test(typed)) return fail('the client id, no spaces');
      d.accessClientId = typed; break;
    case 'Q7': d._people = value; if (value === 'none') d.members = []; break;
    case 'Q8': {
      if (value === 'done') { d._peopleDone = true; break; }
      const p = person(typed, people(d).map(m => m.name));
      if (p.error) return fail(p.error);
      d.members = [...(d.members ?? []), p.value]; break;
    }
    case 'Q9.1':
      delete d._changing;
      if (value === 'members') { delete d.members; delete d._people; delete d._peopleDone; }
      else if (value === 'access') { delete d.access; delete d.accessClientId; }
      else delete d[value];
      break;
    case 'Q9':
      if (value === 'stop') { d._stopped = true; break; }
      if (value === 'change') { d._changing = true; break; }
      if (current.problems.length) return fail(`fix these first: ${current.problems.join('; ')}`);
      d._confirmed = true; break;
  }
  return { draft: d };
}
