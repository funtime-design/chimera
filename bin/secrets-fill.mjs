// pnpm secrets:fill: enter values you already hold into deployments/<id>/secrets.json. For new deployments prefer
// secrets:mint, which generates and mints them; fill is for values issued elsewhere or kept from before.
//
//   pnpm secrets:fill -- --deployment <id> [--only KEY,KEY] [--from-env]
//
// For each key (fixed order; the schema's required keys, the ones this config references, and any already present)
// it prints one line saying what the value is and where it comes from, then asks masked on a terminal, or with
// --from-env reads an env var of the same name (cloudflare.accountId: CLOUDFLARE_ACCOUNT_ID). A value already in the
// file is kept by default ("set (keep? Y/n)"; with --from-env, kept unless the env var is given). A bad value is asked
// again on a terminal and fails the run with --from-env, naming the key only. Writes mode 0600, refuses a tracked or
// unignored file, prints key names only, then offers secrets:push --dry-run on a terminal.
import { cli, isMain, loadDeployment, projectRoot, requirePrivateSecrets } from './deployment.mjs';
import { selectedDeploymentId } from './selected-deployment.mjs';
import { getKey, hasValue, hideSecrets, makeRedactor, parseField, readSecrets, secretFields, setKey, terminalAsk, writeSecrets } from './secrets-common.mjs';
import { pushSecrets } from './secrets-push.mjs';

function parseArgs(argv) {
  const o = {};
  const args = argv.filter(a => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deployment') o.deployment = args[++i];
    else if (a === '--only') o.only = String(args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--from-env') o.fromEnv = true;
    else throw new Error('unsupported option; use --deployment <id>, --only KEY,KEY, --from-env');
  }
  return o;
}

export async function fillSecrets({
  root = projectRoot, argv = [], env = process.env, isTTY = !!(process.stdin.isTTY && process.stderr.isTTY), ask,
  out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`),
} = {}) {
  const { hide, redact } = makeRedactor();
  const say = line => out(redact(line)), warn = line => err(redact(line));
  const prompt = ask ?? (isTTY ? terminalAsk : null);
  try {
    const opts = parseArgs(argv);
    const deployment = opts.deployment ?? selectedDeploymentId(env);
    if (!opts.fromEnv && !prompt) throw new Error('not a terminal: pass --from-env to read each key from an env var of the same name');
    const { config } = await loadDeployment({ root, deployment });
    const file = await requirePrivateSecrets(root, deployment, { allowMissing: true });
    const existing = await readSecrets(file) ?? {};
    hideSecrets(hide, existing);
    const fields = await secretFields(config);
    for (const f of fields) hide(env[f.env]);
    const unknown = (opts.only ?? []).filter(k => !fields.some(f => f.key === k));
    if (unknown.length) throw new Error(`--only: unknown key(s) ${unknown.join(', ')}; known: ${fields.map(f => f.key).join(', ')}`);
    const next = structuredClone(existing);
    const done = { set: [], kept: [], skipped: [] };
    for (const f of fields) {
      if (opts.only && !opts.only.includes(f.key)) { if (f.needed || getKey(existing, f.key) !== undefined) done.skipped.push(f.key); continue; }
      if (!opts.only && !f.needed && getKey(existing, f.key) === undefined) continue;
      say(`${f.key}: ${f.description}`);
      const given = opts.fromEnv && typeof env[f.env] === 'string' && env[f.env] !== '';
      if (hasValue(existing, f.key) && !given) {
        if (opts.fromEnv || !/^n/i.test(await prompt('  set (keep? Y/n) ', { mask: false }))) { done.kept.push(f.key); continue; }
      }
      let value;
      if (opts.fromEnv) {
        if (given) { try { value = await parseField(f, env[f.env], next); } catch (e) { throw new Error(`${f.env}: ${e.message}`); } }
      } else {
        for (;;) {
          const text = await prompt(`  ${f.key}${f.needed ? '' : ' (Enter skips)'}: `, { mask: f.secret });
          if (!text) break;
          hide(text);
          try { value = await parseField(f, text, next); break; } catch (e) { warn(`  ${e.message}; try again`); }
        }
      }
      if (value === undefined) { done.skipped.push(f.key); say(`  skipped${f.needed ? ' (still needed before secrets:push)' : ''}`); continue; }
      hide(value);
      setKey(next, f.key, value);
      done.set.push(f.key);
    }
    await writeSecrets(file, next);
    say(`Wrote deployments/${deployment}/secrets.json (mode 0600, ignored by git). Values are not shown.`);
    for (const [what, keys] of Object.entries(done)) say(`  ${what}: ${keys.length ? keys.join(', ') : '(none)'}`);
    if (!opts.fromEnv && prompt && /^y(es)?$/i.test(await prompt('Run secrets:push --dry-run now? [y/N] ', { mask: false }))) {
      await pushSecrets({ root, deployment, dryRun: true, log: line => say(`  ${line}`) });
    }
    return 0;
  } catch (error) {
    warn(`secrets:fill: ${error.message}`);
    return 1;
  }
}

if (isMain(import.meta.url)) await cli(async () => { process.exitCode = await fillSecrets({ argv: process.argv.slice(2) }); });
