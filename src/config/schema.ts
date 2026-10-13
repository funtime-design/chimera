import schema from '../../config/bridge.config.schema.json';

export type SecretRef = { env: string };
export type Member = { name: string; kind: 'person' | 'device' | 'service'; person?: string };
export type Timing = { claimSeconds: number; claimLeaseSeconds: number; bootSeconds: number; onlineSeconds: number; statusExpirySeconds: number; deploySeconds: number };
export type Labels = { ciRed: string; branchGone: string; deployFailed: string; reReview: string; revert: string; exempt: string[] };
export type Presentation = Partial<Record<'owner' | 'ownerDisplayName' | 'ownerDisplayText' | 'ownerPossessive' | 'ownerSubject' | 'ownerObject' | 'exampleDevice' | 'exampleSecondDevice' | 'exampleCloud' | 'exampleSession' | 'exampleRepo' | 'examplePeer' | 'responderCommand' | 'guideIntroduction' | 'guideCloudSetup' | 'guideExternalSkills' | 'guideWebhookSetup' | 'guideBackfill' | 'guideTokenStorage' | 'guideRoutineSecrets', string>>;
export type BridgeConfig = {
  $schema?: string;
  schemaVersion: 1;
  deployment: { id: string; displayName: string; origin: string; productName?: string };
  cloudflare: { workerName: string; oauthKvId?: string; workersDev: boolean; previewUrls: boolean; observability: boolean };
  identity: { hubClass: 'Hub'; hubBinding: 'HUB'; hubKey: 'main' };
  members: Member[];
  auth: { memberEmails?: SecretRef; staticTokensSecret: SecretRef };
  access?: { clientId?: string; clientSecret?: SecretRef; authorizationUrl?: string; tokenUrl?: string; jwksUrl?: string; pages?: { issuer: string; audience: string } };
  timing: Timing;
  github?: { owner: string; deployWorkflow: string; autoReview: boolean; webhookSecret?: SecretRef; deployEnvironment?: string; reviewersMax?: number };
  cloud?: {
    routines?: Record<string, { trigger: SecretRef; token: SecretRef }>;
    routinesSecret?: SecretRef;
    namedRoutines?: Record<string, { trigger: SecretRef; token: SecretRef; allow?: string[] }>;
    configBundle?: { repo: string; commit: string; pat: SecretRef };
    // Explicit migration escape hatch: existing deployment tracks main; new bundles must pin a commit.
    legacyConfigRepo?: string;
    configPat?: SecretRef;
  };
  clients: { connectorName: string; launchdLabel: string; stateDirName: string };
  hooks: { approver: string; protectedBranches: string[]; enabled: string[]; externalSkills: { repo: string; commit: string; path: string }[]; branchPrefix?: string };
  compatibility: { envPrefix: 'GOONBRIDGE' | 'CHIMERA'; headerPrefix: string; assetNames: { connector: string; responder: string } };
  presentation?: Presentation;
  labels?: Labels;
};

// This small interpreter implements exactly the JSON Schema vocabulary used by the shipped schema.
// Editors and runtime share constraints. Never include a rejected value in diagnostics: it may be a secret.
export type Rule = { minProperties?: number; patternProperties?: Record<string, Rule>; type?: string; const?: unknown; enum?: unknown[]; not?: Rule; anyOf?: Rule[]; minLength?: number; pattern?: string; format?: string; exclusiveMinimum?: number; properties?: Record<string, Rule>; required?: string[]; additionalProperties?: boolean | Rule; propertyNames?: Rule; items?: Rule };
export function check(value: unknown, rule: Rule, path: string): void {
  const fail = (why: string): never => { throw new Error(`${path}: ${why}`); };
  if ('const' in rule && value !== rule.const) fail(`must be ${rule.const}`);
  if (rule.enum && !rule.enum.includes(value)) fail(`must be one of ${rule.enum.join(', ')}`);
  if (rule.not && value === rule.not.const) fail('reserved name');
  if (rule.anyOf) {
    for (const branch of rule.anyOf) { try { check(value, branch, path); return; } catch {} }
    fail('must be an env reference or an email-to-member map');
  }
  if (rule.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
    const record = value as Record<string, unknown>;
    if (rule.minProperties && Object.keys(record).length < rule.minProperties) fail('must not be empty');
    for (const key of rule.required ?? []) if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(record)) {
      // Map keys can be private email addresses; never echo them in validation errors.
      const field = rule.properties && !path.startsWith('secrets') ? `${path}.${key}` : `${path} entry`;
      if (rule.propertyNames) check(key, rule.propertyNames, `${path} key`);
      if (rule.properties && Object.hasOwn(rule.properties, key)) check(child, rule.properties[key], field);
      else if (Object.entries(rule.patternProperties ?? {}).some(([pattern, childRule]) => {
        if (!new RegExp(pattern).test(key)) return false;
        check(child, childRule, field); return true;
      })) { /* matched a named secret family */ }
      else if (rule.additionalProperties === false) throw new Error(`${field}: unknown field`);
      else if (typeof rule.additionalProperties === 'object') check(child, rule.additionalProperties, field);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array');
    (value as unknown[]).forEach((v, i) => check(v, rule.items!, `${path}[${i}]`));
  } else if (rule.type === 'string') {
    if (typeof value !== 'string') fail('must be a string');
    const s = value as string;
    if (rule.minLength && s.length < rule.minLength) fail('must not be empty');
    if (rule.pattern && !new RegExp(rule.pattern).test(s)) fail(rule.format?.startsWith('https-') ? 'must be an HTTPS URL (origin must not include a path)' : `must match pattern ${rule.pattern}`);
    if (rule.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail('must be an email address');
    if (rule.format?.startsWith('https-')) {
      let url: URL;
      try { url = new URL(s); } catch { return fail('must be an HTTPS URL'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail('must be an HTTPS URL without credentials');
      if (rule.format === 'https-origin' && s !== url.origin) fail('must be an HTTPS origin without path, query or fragment');
    }
  } else if (rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum)) fail('must be positive finite seconds');
  } else if (rule.type === 'boolean' && typeof value !== 'boolean') fail('must be a boolean');
}

export function validateConfig(value: unknown): BridgeConfig {
  check(value, schema as Rule, 'config');
  const config = value as BridgeConfig;
  const names = new Set(config.members.map(m => m.name));
  if (names.size !== config.members.length) throw new Error('config.members: duplicate member name');
  for (const m of config.members) {
    if (m.kind === 'device' && (!m.person || !config.members.some(p => p.name === m.person && p.kind === 'person') || !m.name.startsWith(`${m.person}-`))) {
      throw new Error('config.members: devices need an existing person and their name prefix');
    }
    if (m.kind !== 'device' && m.person) throw new Error('config.members: only devices may have a person');
  }
  if (config.labels) {
    const values = [config.labels.ciRed, config.labels.branchGone, config.labels.deployFailed, config.labels.reReview, config.labels.revert, ...config.labels.exempt];
    if (new Set(values).size !== values.length) throw new Error('config.labels: policy labels must be distinct');
  }
  if (config.members.length) {
    for (const person of Object.keys(config.cloud?.routines ?? {})) if (!config.members.some(m => m.name === person && m.kind === 'person')) throw new Error('config.cloud.routines: key must name a person in members');
    for (const routine of Object.values(config.cloud?.namedRoutines ?? {})) for (const member of routine.allow ?? []) if (!names.has(member)) throw new Error('config.cloud.namedRoutines.allow: member must exist in members');
  }
  if (config.cloud?.configBundle && config.cloud.legacyConfigRepo) throw new Error('config.cloud: choose pinned configBundle or legacyConfigRepo');
  return config;
}
