import schema from '../../config/secrets.schema.json';
import { check, validateConfig, type BridgeConfig, type SecretRef, type Rule } from './schema';
export { validateConfig, check } from './schema';
export { clientConfig } from './client';

type Pair = { trigger: string; token: string };
export type Secrets = {
  $schema?: string;
  // Human-editable member -> token; the Worker still receives token -> member.
  GOONBRIDGE_TOKENS: Record<string, string>;
  ACCESS_CLIENT_SECRET?: string;
  GOONBRIDGE_GITHUB_WEBHOOK_SECRET?: string;
  GOONBRIDGE_ROUTINES?: Record<string, Pair>;
  GITHUB_CONFIG_PAT?: string;
  GOONBRIDGE_MEMBERS?: Record<string, string>;
  cloudflare: { accountId: string };
  CLOUDFLARE_API_TOKEN: string;
  contractToken: string;
  [key: `GOONBRIDGE_ROUTINE_${string}`]: string;
};

// Both legacy names and explicit SecretRefs are populated. Conflicting aliases are refused.
export function runtimeSecrets(s: Secrets, c: BridgeConfig): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const put = (name: string | undefined, value: string | undefined) => {
    if (!name || value === undefined) return;
    if (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].includes(name)) throw new Error('secrets: deploy-only value cannot be a runtime reference');
    if (Object.hasOwn(out, name) && out[name] !== value) throw new Error('secrets: conflicting runtime references');
    out[name] = value;
  };
  const slot = (legacy: string, value: string | undefined, ref?: SecretRef) => { put(legacy, value); put(ref?.env, value); };
  slot('GOONBRIDGE_TOKENS', JSON.stringify(Object.fromEntries(Object.entries(s.GOONBRIDGE_TOKENS).map(([member, token]) => [token, member]))), c.auth.staticTokensSecret);
  slot('GOONBRIDGE_MEMBERS', s.GOONBRIDGE_MEMBERS && JSON.stringify(s.GOONBRIDGE_MEMBERS), c.auth.memberEmails);
  slot('ACCESS_CLIENT_SECRET', s.ACCESS_CLIENT_SECRET, c.access?.clientSecret);
  slot('GOONBRIDGE_GITHUB_WEBHOOK_SECRET', s.GOONBRIDGE_GITHUB_WEBHOOK_SECRET, c.github?.webhookSecret);
  slot('GITHUB_CONFIG_PAT', s.GITHUB_CONFIG_PAT, c.cloud?.configBundle?.pat ?? c.cloud?.configPat);
  slot('GOONBRIDGE_ROUTINES', s.GOONBRIDGE_ROUTINES && JSON.stringify(s.GOONBRIDGE_ROUTINES), c.cloud?.routinesSecret);
  for (const [member, refs] of Object.entries(c.cloud?.routines ?? {})) {
    put(refs.trigger.env, s.GOONBRIDGE_ROUTINES?.[member]?.trigger);
    put(refs.token.env, s.GOONBRIDGE_ROUTINES?.[member]?.token);
  }
  for (const [key, value] of Object.entries(s)) if (/^GOONBRIDGE_ROUTINE_[A-Z0-9]+_(TRIGGER|TOKEN)$/.test(key)) put(key, value as string);
  for (const [name, refs] of Object.entries(c.cloud?.namedRoutines ?? {})) {
    put(refs.trigger.env, s[`GOONBRIDGE_ROUTINE_${name.toUpperCase()}_TRIGGER`]);
    put(refs.token.env, s[`GOONBRIDGE_ROUTINE_${name.toUpperCase()}_TOKEN`]);
  }
  return out;
}

export function validateSecrets(value: unknown, config: unknown): Secrets {
  check(value, schema as Rule, 'secrets');
  const s = value as Secrets, c = validateConfig(config);
  if (!Object.hasOwn(s.GOONBRIDGE_TOKENS, s.contractToken)) throw new Error('secrets: contractToken must name an existing token member');
  const tokens = Object.values(s.GOONBRIDGE_TOKENS);
  if (new Set(tokens).size !== tokens.length) throw new Error('secrets: duplicate static token');
  for (const key of Object.keys(s)) {
    const match = /^(GOONBRIDGE_ROUTINE_[A-Z0-9]+)_(TRIGGER|TOKEN)$/.exec(key);
    if (match && (!Object.hasOwn(s, `${match[1]}_TRIGGER`) || !Object.hasOwn(s, `${match[1]}_TOKEN`))) throw new Error('secrets: routine requires trigger/token pair');
  }
  if (c.members.length) {
    const names = new Set(c.members.map(m => m.name));
    for (const member of [...Object.keys(s.GOONBRIDGE_TOKENS), ...Object.values(s.GOONBRIDGE_MEMBERS ?? {})]) if (!names.has(member)) throw new Error('secrets: unknown member');
    for (const person of Object.keys(s.GOONBRIDGE_ROUTINES ?? {})) if (!c.members.some(m => m.name === person && m.kind === 'person')) throw new Error('secrets: routine must name a person');
  }
  const runtime = runtimeSecrets(s, c);
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if ('env' in v && typeof v.env === 'string' && !Object.hasOwn(runtime, v.env)) throw new Error('secrets: unsatisfied config SecretRef');
    for (const child of Object.values(v)) walk(child);
  };
  walk(c);
  return s;
}
