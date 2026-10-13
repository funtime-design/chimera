import bundledJson from './deployment';
import { validateConfig, type BridgeConfig, type SecretRef, type Timing } from './schema';

// Build-time input contains references only. Resolution never reads process.env or performs I/O.
export const bundledConfig = validateConfig(bundledJson);
import { engineLabels, engineTiming } from "./defaults";
export { engineTiming, engineLabels } from "./defaults";
export type RuntimeEnv = Record<string, unknown>;
const text = (env: RuntimeEnv, key: string): string | undefined => typeof env[key] === 'string' ? env[key] as string : undefined;
const positive = (v: string | undefined, fallback: number): number => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
const timingVars: Record<keyof Timing, string> = { claimSeconds: 'CLAIM_SECONDS', claimLeaseSeconds: 'CLAIM_LEASE_SECONDS', bootSeconds: 'BOOT_SECONDS', onlineSeconds: 'ONLINE_SECONDS', statusExpirySeconds: 'STATUS_EXPIRY_SECONDS', deploySeconds: 'DEPLOY_SECONDS' };

// Existing names win even when empty: clearing a binding must not silently enable a config credential.
export function resolveConfig(env: RuntimeEnv = {}, input: unknown = bundledConfig) {
  const c = input === bundledConfig ? bundledConfig : validateConfig(input);
  const prefixes = [...new Set(['GOONBRIDGE', c.compatibility.envPrefix, 'CHIMERA'])];
  const alias = (suffix: string): string | undefined => prefixes.map(p => text(env, `${p}_${suffix}`)).find(v => v !== undefined);
  const secret = (ref?: SecretRef): string | undefined => ref ? text(env, ref.env) : undefined;
  const access = c.access;
  const timing = Object.fromEntries(Object.entries(timingVars).map(([key, suffix]) => [key, positive(alias(suffix), key === 'claimSeconds' && c.compatibility.envPrefix === 'GOONBRIDGE' ? engineTiming.claimSeconds : c.timing[key as keyof Timing])])) as Timing;
  const emails = c.auth.memberEmails;
  const memberEmails = alias('MEMBERS') ?? secret(emails);
  const routines = Object.fromEntries(Object.entries(c.cloud?.routines ?? {}).flatMap(([name, refs]) => {
    const trigger = secret(refs.trigger), token = secret(refs.token);
    return trigger && token ? [[name, { trigger, token }]] : [];
  }));
  const namedRoutines: Record<string, { trigger: string; token: string; allow?: string[] }> = {};
  for (const [name, refs] of Object.entries(c.cloud?.namedRoutines ?? {})) {
    const trigger = secret(refs.trigger), token = secret(refs.token);
    if (trigger && token) namedRoutines[name] = { trigger, token, ...(refs.allow ? { allow: refs.allow } : {}) };
  }
  // Discover aliases as well as old flat names, then resolve each field with the same precedence.
  const routineNames = new Set(Object.keys(namedRoutines));
  for (const key of Object.keys(env)) for (const prefix of prefixes) {
    if (key.startsWith(`${prefix}_ROUTINE_`)) {
      const match = /^([A-Z0-9]+)_(TRIGGER|TOKEN|ALLOW)$/.exec(key.slice(`${prefix}_ROUTINE_`.length));
      if (match) routineNames.add(match[1].toLowerCase());
    }
  }
  for (const name of routineNames) {
    const stem = `ROUTINE_${name.toUpperCase()}`;
    const existing = namedRoutines[name];
    const trigger = (alias(`${stem}_TRIGGER`) ?? existing?.trigger ?? '').trim();
    const token = (alias(`${stem}_TOKEN`) ?? existing?.token ?? '').trim();
    const rawAllow = alias(`${stem}_ALLOW`);
    const allow = rawAllow === undefined ? existing?.allow : rawAllow.trim() ? rawAllow.split(',').map(a => a.trim().toLowerCase()).filter(Boolean) : undefined;
    if (trigger && token) namedRoutines[name] = { trigger, token, ...(allow ? { allow } : {}) };
    else delete namedRoutines[name];
  }
  return {
    ...c,
    deployment: { ...c.deployment, productName: c.deployment.productName ?? 'chimera', origin: alias('URL') || c.deployment.origin },
    timing, labels: c.labels ?? engineLabels,
    auth: { staticTokens: alias('TOKENS') ?? secret(c.auth.staticTokensSecret), memberEmails },
    access: {
      clientId: text(env, 'ACCESS_CLIENT_ID') ?? access?.clientId,
      clientSecret: text(env, 'ACCESS_CLIENT_SECRET') ?? secret(access?.clientSecret),
      authorizationUrl: text(env, 'ACCESS_AUTHORIZATION_URL') ?? access?.authorizationUrl,
      tokenUrl: text(env, 'ACCESS_TOKEN_URL') ?? access?.tokenUrl,
      jwksUrl: text(env, 'ACCESS_JWKS_URL') ?? access?.jwksUrl,
      pages: { issuer: text(env, 'ACCESS_PAGES_ISSUER') ?? access?.pages?.issuer, audience: text(env, 'ACCESS_PAGES_AUD') ?? access?.pages?.audience },
    },
    github: {
      owner: alias('GITHUB_OWNER') || c.github?.owner || '',
      deployWorkflow: alias('DEPLOY_WORKFLOW') || c.github?.deployWorkflow || 'Deploy',
      deployEnvironment: alias('DEPLOY_ENVIRONMENT') || c.github?.deployEnvironment || 'production',
      autoReview: alias('AUTO_REVIEW') !== undefined ? alias('AUTO_REVIEW')!.trim().toLowerCase() !== 'off' : c.github?.autoReview ?? true,
      reviewersMax: positive(alias('REVIEWERS_MAX'), c.github?.reviewersMax ?? 3),
      webhookSecret: alias('GITHUB_WEBHOOK_SECRET') ?? secret(c.github?.webhookSecret),
    },
    cloud: {
      routines: alias('ROUTINES') ?? secret(c.cloud?.routinesSecret) ?? JSON.stringify(routines),
      routinesUrl: alias('ROUTINES_URL'), namedRoutines,
      configRepo: text(env, 'GITHUB_CONFIG_REPO') || c.cloud?.configBundle?.repo || c.cloud?.legacyConfigRepo,
      configRef: c.cloud?.configBundle?.commit ?? 'main',
      configRefPinned: !!c.cloud?.configBundle,
      configPat: text(env, 'GITHUB_CONFIG_PAT') ?? secret(c.cloud?.configBundle?.pat ?? c.cloud?.configPat),
      configApiUrl: text(env, 'GITHUB_CONFIG_API_URL'),
    },
  };
}
export type Config = ReturnType<typeof resolveConfig>;

// Compatibility boundary for existing Worker/auth/DO consumers. Bindings retain their original objects;
// unknown legacy inputs are preserved, including future GOONBRIDGE_* options. Never mutate Cloudflare's env.
export function runtimeEnv<T extends RuntimeEnv>(env: T, input: unknown = bundledConfig): T & Record<string, unknown> {
  const c = resolveConfig(env, input);
  const out: RuntimeEnv = { ...env };
  for (const prefix of ['CHIMERA', c.compatibility.envPrefix]) for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(`${prefix}_`) && !Object.hasOwn(env, `GOONBRIDGE_${key.slice(prefix.length + 1)}`)) out[`GOONBRIDGE_${key.slice(prefix.length + 1)}`] = value;
  }
  Object.assign(out, {
    GOONBRIDGE_TOKENS: c.auth.staticTokens, GOONBRIDGE_MEMBERS: c.auth.memberEmails,
    ACCESS_CLIENT_ID: c.access.clientId, ACCESS_CLIENT_SECRET: c.access.clientSecret,
    ACCESS_AUTHORIZATION_URL: c.access.authorizationUrl, ACCESS_TOKEN_URL: c.access.tokenUrl, ACCESS_JWKS_URL: c.access.jwksUrl,
    ACCESS_PAGES_ISSUER: c.access.pages.issuer, ACCESS_PAGES_AUD: c.access.pages.audience,
    GOONBRIDGE_GITHUB_OWNER: c.github.owner, GOONBRIDGE_DEPLOY_WORKFLOW: c.github.deployWorkflow,
    GOONBRIDGE_DEPLOY_ENVIRONMENT: c.github.deployEnvironment, GOONBRIDGE_AUTO_REVIEW: c.github.autoReview ? 'on' : 'off',
    GOONBRIDGE_REVIEWERS_MAX: String(c.github.reviewersMax), GOONBRIDGE_GITHUB_WEBHOOK_SECRET: c.github.webhookSecret,
    GOONBRIDGE_ROUTINES: c.cloud.routines, GOONBRIDGE_ROUTINES_URL: c.cloud.routinesUrl,
    GITHUB_CONFIG_REPO: c.cloud.configRepo, GITHUB_CONFIG_PAT: c.cloud.configPat, GITHUB_CONFIG_API_URL: c.cloud.configApiUrl,
  });
  for (const [key, suffix] of Object.entries(timingVars)) out[`GOONBRIDGE_${suffix}`] = String(c.timing[key as keyof Timing]);
  for (const [name, r] of Object.entries(c.cloud.namedRoutines)) {
    const stem = `GOONBRIDGE_ROUTINE_${name.toUpperCase()}`;
    out[`${stem}_TRIGGER`] = r.trigger; out[`${stem}_TOKEN`] = r.token; out[`${stem}_ALLOW`] = r.allow?.join(',');
  }
  return out as T & Record<string, unknown>;
}
