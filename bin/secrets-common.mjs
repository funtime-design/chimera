// Shared by secrets:mint, secrets:fill and setup: the redactor, the masked terminal prompt, the list of secrets.json keys
// (with the schema's one-line descriptions) and a safe writer. Nothing here ever puts a value into a message.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, readJson, validation } from './deployment.mjs';

// Every printed line goes through redact(); hide() registers a value (strings of 4+ characters, or every string inside).
export function makeRedactor() {
  const hidden = new Set();
  const hide = value => {
    if (typeof value === 'string') { if (value.length >= 4) hidden.add(value); }
    else if (value && typeof value === 'object') for (const child of Object.values(value)) hide(child);
  };
  const redact = text => [...hidden].sort((x, y) => y.length - x.length).reduce((t, v) => t.split(v).join('[redacted]'), String(text));
  return { hide, redact };
}
// Every secret in a secrets file, minus member names and the email map (those are printed on purpose by setup).
export function hideSecrets(hide, secrets) {
  for (const [key, value] of Object.entries(secrets ?? {})) if (!['$schema', 'contractToken', 'GOONBRIDGE_MEMBERS'].includes(key)) hide(value);
}

// A line from the terminal. mask: echo stars. Raw mode, so the value never reaches shell history or a transcript.
export function terminalAsk(prompt, { mask = false } = {}) {
  return new Promise(resolve => {
    const input = process.stdin, out = process.stderr; let value = '';
    out.write(prompt); input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const done = () => { input.setRawMode(false); input.pause(); input.off('data', onData); out.write('\n'); resolve(value.trim()); };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') { input.setRawMode(false); out.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); out.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        value += ch; out.write(mask ? '*' : ch);
      }
    };
    input.on('data', onData);
  });
}

export const isPlaceholder = value => typeof value === 'string' ? value.includes('REPLACE_ME') || value.startsWith('FAKE_')
  : !!value && typeof value === 'object' && Object.values(value).some(isPlaceholder);
export const getKey = (s, key) => key === 'cloudflare.accountId' ? s?.cloudflare?.accountId : s?.[key];
export function setKey(s, key, value) {
  if (key === 'cloudflare.accountId') { if (value === undefined) delete s.cloudflare; else s.cloudflare = { ...(s.cloudflare ?? {}), accountId: value }; }
  else if (value === undefined) delete s[key]; else s[key] = value;
}
// A real value: present and not a setup placeholder.
export const hasValue = (s, key) => { const v = getKey(s, key); return v !== undefined && !isPlaceholder(v); };

const ORDER = ['GOONBRIDGE_TOKENS', 'cloudflare.accountId', 'CLOUDFLARE_API_TOKEN', 'contractToken', 'GOONBRIDGE_GITHUB_WEBHOOK_SECRET',
  'ACCESS_CLIENT_SECRET', 'GOONBRIDGE_MEMBERS', 'GOONBRIDGE_ROUTINES', 'GITHUB_CONFIG_PAT'];
// The keys a deployment can hold, in a fixed order. needed: the schema requires it or this config references it.
export async function secretFields(config) {
  const schema = await readJson(path.join(projectRoot, 'config/secrets.schema.json'));
  const routineRule = Object.values(schema.patternProperties)[0];
  const cloud = config.cloud ?? {};
  const byConfig = {
    GOONBRIDGE_GITHUB_WEBHOOK_SECRET: !!config.github?.webhookSecret,
    ACCESS_CLIENT_SECRET: !!config.access?.clientSecret,
    GOONBRIDGE_MEMBERS: !!config.auth?.memberEmails,
    GOONBRIDGE_ROUTINES: !!(cloud.routinesSecret || Object.keys(cloud.routines ?? {}).length),
    GITHUB_CONFIG_PAT: !!(cloud.configBundle?.pat ?? cloud.configPat),
  };
  const fields = ORDER.map(key => {
    const rule = key === 'cloudflare.accountId' ? schema.properties.cloudflare.properties.accountId : schema.properties[key];
    return { key, rule, description: rule.description, json: rule.type === 'object', secret: key !== 'contractToken',
      env: key === 'cloudflare.accountId' ? 'CLOUDFLARE_ACCOUNT_ID' : key, needed: schema.required.includes(key.split('.')[0]) || !!byConfig[key] };
  });
  for (const name of Object.keys(cloud.namedRoutines ?? {})) for (const part of ['TRIGGER', 'TOKEN']) {
    const key = `GOONBRIDGE_ROUTINE_${name.toUpperCase()}_${part}`;
    fields.push({ key, rule: routineRule, description: routineRule.description, json: false, secret: true, env: key, needed: true });
  }
  return fields;
}

// Parse and check one value against its schema rule. Messages name the key, never the value.
export async function parseField(field, text, sofar = {}) {
  let value = text;
  if (field.json) {
    try { value = JSON.parse(text); } catch { throw new Error(`${field.key}: not valid JSON (value not shown)`); }
  }
  if (field.key === 'GOONBRIDGE_TOKENS' && value && typeof value === 'object' && !Array.isArray(value)) {
    const tokens = Object.values(value);
    if (tokens.some(v => typeof v !== 'string' || v.trim().length < 24)) throw new Error('GOONBRIDGE_TOKENS: every token must be 24+ characters');
    if (new Set(tokens).size !== tokens.length) throw new Error('GOONBRIDGE_TOKENS: tokens must be distinct');
  }
  if (field.key === 'contractToken') {
    const tokens = getKey(sofar, 'GOONBRIDGE_TOKENS') ?? {};
    if (Object.values(tokens).includes(value)) throw new Error('contractToken: that is a token; give the member NAME whose token the check uses');
    if (Object.keys(tokens).length && !Object.hasOwn(tokens, value)) throw new Error('contractToken: must name a member in GOONBRIDGE_TOKENS');
  }
  const { check } = await validation();
  try { check(value, field.rule, `secrets.${field.key}`); } catch (error) {
    throw new Error(`${error.message.replace(/^secrets\./, '')}${field.key === 'cloudflare.accountId' ? ' (32 hex characters)' : ''}`);
  }
  return value;
}

// Read an existing secrets.json, or null. Invalid JSON is reported without its contents.
export async function readSecrets(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch { throw new Error('secrets.json is not valid JSON (contents not shown)'); }
}
// Write with mode 0600 (also tightening an existing file first), keys in the example's order.
export async function writeSecrets(file, secrets) {
  const example = await readJson(path.join(projectRoot, 'deployments/example/secrets.example.json'));
  const ordered = { $schema: example.$schema };
  for (const key of [...Object.keys(example), ...Object.keys(secrets)]) if (key !== '$schema' && Object.hasOwn(secrets, key)) ordered[key] = secrets[key];
  await chmod(file, 0o600).catch(() => {});
  await writeFile(file, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
