# Deploying chimera

Your deployment folder lives in `deployments/<id>/` in your private fork; the public repo ships only `example`. A fork is the public engine plus that folder (and its ignored `secrets.json`). Nothing in the engine assumes any particular deployment is present or absent: every tool reads the deployment named by the build-time env `CHIMERA_DEPLOYMENT` (default `example`) through one loader, `bin/selected-deployment.mjs`. Upgrade the engine by pulling an exact release tag; keep your deployment configuration and resource identity.

To work on your own deployment locally, export `CHIMERA_DEPLOYMENT=<id>`. `wrangler dev` (its build step), `pnpm build:responder` and `pnpm gen:wrangler` point `src/config/deployment.ts` at `deployments/<id>/`; the responder, client defaults, generated client files and the test harness read the same folder. Commands that take `--deployment` default to it too.

## Set up with `pnpm run setup`

`pnpm run setup` (bin/setup.mjs; not `pnpm setup`, which is pnpm's own command) stands up a deployment from a short questionnaire and then runs every step below in order. On a terminal it asks; an agent passes the answers as a file (the `chimera-setup` skill in `.claude/skills/` shows the format):

```sh
pnpm run setup                                         # interactive
pnpm run setup -- --answers answers.json               # non-interactive
pnpm run setup -- --deployment <id> --resume [--yes]   # continue where it stopped
```

It asks for the deployment id, display name, origin, Cloudflare account ID, Worker name, admins and members (person names: lowercase, no dash, each used once) and each person's sign-in email, and whether Cloudflare Access guards the bridge. It writes `deployments/<id>/bridge.config.json` and `deployment.lock.json` (commit both), and creates the ignored `secrets.json` holding the emails and account ID, with placeholders for the tokens. With a minter token at hand (`CHIMERA_TOKEN_MINTER`, or asked masked on a terminal) it then runs `secrets:mint` to fill them; otherwise it stops and lists what to fill. Then: validate, generate (Wrangler config, client files, responder), `secrets:push` (dry run, then the real push after a yes), `wrangler deploy` (after a yes), and the contract check. Each step prints what it does, runs, verifies and records done/todo in `.chimera-setup/<id>.json` (ignored). `--yes` answers the two confirmations for a non-interactive run. Exit 0 is done; exit 2 means it waits for a person (fill the listed `secrets.json` keys, or confirm); exit 1 is an error. A finished setup re-run prints its status and exits 0. No secret value is ever printed.

### Bridge roles

People live only in config and secrets: `members` (kind `person`) in `bridge.config.json`, their emails and tokens in `secrets.json`. `admins` (people) open the admin pages; `hooks.approvers` (people) approve destructive commands from the approval hook, and any one of them may answer. The old single `hooks.approver` is still read as a one-name list; set one key, never both, and there is no personal fallback. Adding a person = add them to `members` (and `admins` if they should be one), add their email and token to `secrets.json`, run `pnpm secrets:push`, redeploy, and, with Cloudflare Access, add them to the Access group too.

### Cloudflare Access

With Access in front of the bridge (an Access for SaaS app for sign-in, and the self-hosted app over `/docs`), the app allows one Access group, a fixed email list. A new person must be in that group as well as in config: Zero Trust > Access > Access groups, add the email. `pnpm run setup` prints this step per person, or adds the emails through the Cloudflare API when `CLOUDFLARE_ACCESS_TOKEN` (an API token that can edit Access groups) is set and the answers name `access.groupId`. Without Access the bridge runs token-only: members use their static tokens (a bearer token also opens the `/docs` pages); the browser and device sign-ins need Access.

### Admin pages

`/docs/status` (JSON) and `/docs/settings` sit behind the same sign-in as every `/docs` page and answer admins only. Status reports what the Worker can see: version, deployment id, number of people, registered devices, the last passed contract check (`contract:check` records it) and whether Access is configured. Settings is device-centric: each person's devices, forget a signed-in device, per-device permission toggles (`may_run_full`: who besides its person may run it in full mode, the T-41 trust; `may_edit_tasks`: off for notes and claims only, on to let a cloud session change title and brief; `may_act_as_person`: off so the device no longer counts as its person), and connected agents. Every permission change is recorded as an event. Bridge-level values are shown read-only: edit them in `bridge.config.json` and redeploy.

## Create a deployment

1. Fork the engine and check out the release tag you intend to run. Install Node 22.18+ and pnpm 10, then run `pnpm install --frozen-lockfile`.
2. Copy `deployments/example/` to `deployments/<id>/`. Set `deployment.id` to that directory name, choose a Worker name and HTTPS origin, and customize members, integrations and presentation in `bridge.config.json`. The product name is `deployment.productName` (defaults to `chimera`).
3. Update `deployment.lock.json` to match the chosen Worker name and origin. Preserve `Hub`, `HUB`, `main`, the migration lineage beginning at `v1`, and `OAUTH_KV`. For an existing deployment preserve its actual KV namespace ID too. Before the next production deployment, an admin MUST discover the existing live OAuth KV namespace ID in the correct Cloudflare account, then record that same ID in `cloudflare.oauthKvId` and `deployment.lock.json` together. The current legacy lock has `oauthKvId: null`; it is not proof of live namespace identity. Do not create a replacement namespace. Discovery is an admin step requiring account access; this offline stage deliberately does not perform R1.
4. Copy `secrets.example.json` to `secrets.json` inside your deployment directory and replace every fake value locally. Remove optional integration fields and their config references when you do not use that integration. Never commit this file. Keep account IDs, member emails and credentials out of `bridge.config.json`.

The secrets schema is `config/secrets.schema.json`. `GOONBRIDGE_TOKENS` maps **member name to token** in this file; the push script converts it to the existing token-to-member runtime JSON. Tokens must be at least 24 characters and distinct. `GOONBRIDGE_MEMBERS` is an email-to-member map. Routine maps contain trigger/token pairs; named routines use `GOONBRIDGE_ROUTINE_<NAME>_TRIGGER` and `_TOKEN`. Allowed members for named routines belong in the public config. Cloudflare account ID is `cloudflare.accountId`; `CLOUDFLARE_API_TOKEN` is deploy-only. Required `contractToken` names a member key in `GOONBRIDGE_TOKENS` (for example, `"contractToken": "alice"`); its existing token becomes the Actions contract bearer, without duplicating the token value in the file.

Known secret slots can use custom `{ "env": "NAME" }` references. The script populates those names alongside the existing legacy env names. Every configured reference must resolve from the secrets file before any upload starts. Per-person `cloud.routines` references resolve from `GOONBRIDGE_ROUTINES`; named routine references resolve from the corresponding uppercase named pair. Reference collisions with different values fail.

## Mint or fill secrets.json

`pnpm secrets:mint -- --deployment <id> [--dry-run] [--yes] [--rotate-all]` fills `secrets.json` from one master credential, the minter: a Cloudflare account API token whose only permission is "API Tokens: Edit" (create it by hand once and keep it in a password manager; Cloudflare's OAuth logins cannot mint tokens). It is read from `CHIMERA_TOKEN_MINTER` or asked masked, and never stored.

- Generated locally (32 random bytes, base64url): one token per member in `bridge.config.json`, `GOONBRIDGE_GITHUB_WEBHOOK_SECRET`; `contractToken` is set to the first admin.
- Minted: `CLOUDFLARE_API_TOKEN`, "Workers Editor" scoped to this Worker (the whole account if the API refuses that scope), 90-day expiry, named `github-actions-<worker>-deploy`. It prints the `az keyvault secret set-attributes ... --expires <date>` line to record that expiry.
- Issued elsewhere (account ID, `ACCESS_CLIENT_SECRET`, `GOONBRIDGE_MEMBERS`, routines, `GITHUB_CONFIG_PAT`): asked masked with a one-line note on where each comes from (the `description` in `config/secrets.schema.json`), or read from an env var of the same name (`CLOUDFLARE_ACCOUNT_ID` for the account ID). Enter or an unset variable skips one and nothing is written for it; the config decides which are needed, and `secrets:push` refuses until those are present.

A re-run rotates everything it generates or mints (y/N on a terminal, `--yes` otherwise) and keeps values issued elsewhere unless `--rotate-all`; revoke the previous deploy token in Cloudflare afterwards. `--dry-run` prints each key name and its source (generated, minted, env, prompted, kept, skipped) and mints and writes nothing.

`pnpm secrets:fill -- --deployment <id> [--only KEY,KEY] [--from-env]` is for values you already hold. For each key it prints what the value is and where it comes from, asks masked (or reads an env var of the same name with `--from-env`), keeps a value already in the file by default, and re-asks on a value of the wrong shape (with `--from-env` it fails instead, naming the key).

Both write `deployments/<id>/secrets.json` with mode 0600, refuse a tracked or unignored file, print key names only (never a value, including on errors), and on a terminal offer `secrets:push --dry-run`.

## Move secrets and deploy

From the repository root, with `gh` authenticated to your fork:

```sh
pnpm secrets:push -- --deployment <id> --dry-run
pnpm secrets:push -- --deployment <id>
```

**this is how you move secrets without saving them to git**. The script requires `git check-ignore` to match `secrets.json`, refuses tracked files and symlinks, validates the schemas and all references, and prints only names and actions. Dry-run performs local validation but invokes neither Wrangler nor gh. Actual uploads pass values on stdin. Wrangler uses the account ID and API token from the secrets file through its process environment, so upload targets the same account as deployment. Runtime secrets go to the Worker; `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and the selected member token as `BRIDGE_CONTRACT_TOKEN` go to Actions. A failure stops the upload; after fixing it, rerun the script (already-set values can be set again).

Record every key that has an expiry date in a secret store that knows the date, so someone is warned before it lapses. With Azure Key Vault, for example:

```sh
az keyvault secret set-attributes --vault-name "$KEY_VAULT_NAME" --name "$SECRET_NAME" --expires "2027-10-11T00:00:00Z"
```

Use the key’s real expiry date in place of the example. This tooling does not upload to any secret store.

Set the repository variable `DEPLOYMENT` to your directory ID. The included workflow is skipped while it is unset, so the public repo and forks without a deployment never run it. **Run `pnpm secrets:push -- --deployment <id>` before enabling the first deploy or landing the workflow**, with `contractToken` set in the ignored secrets file. This provisions the required `BRIDGE_CONTRACT_TOKEN` Actions secret. Never put its value in workflow YAML or a shell command argument. The workflow refuses before deployment if it is absent.

The `Deploy` workflow installs dependencies, typechecks, validates config and lock, generates Wrangler config, rebuilds the selected responder, deploys, and checks the live contract. It runs on main pushes or manual dispatch. Set up a custom domain/zone and the API token permissions for your own account before deploying.

For a manual deployment from a trusted shell with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` already exported by your secret manager:

```sh
pnpm typecheck
pnpm validate:deployment -- --deployment <id>
pnpm gen:wrangler -- --deployment <id>
pnpm build:responder
pnpm exec wrangler deploy -c .generated/wrangler.<id>.jsonc
pnpm contract:check -- --deployment <id> --redeploy-on-stale
```

Generation reads the account ID only from `CLOUDFLARE_ACCOUNT_ID`, never from public config. It deterministically writes account-bearing `.generated/wrangler.<id>.jsonc`, requiring that path to be ignored, untracked and not a symlink. It leaves committed `wrangler.jsonc` account-free for local development. Generation also points `src/config/deployment.ts` at the deployment (through `bin/selected-deployment.mjs`) and regenerates `.mcp.json` and `.claude/settings.json` (MCP URL, headers, context, connector permission, setup URL and enabled hook entries). Forks MUST run generation for their deployment before opening Claude clients. Both Worker and responder use that selected JSON; rebuild the responder after selection.

The local contract command reads the `contractToken` member’s token from your guarded secrets file, or accepts `BRIDGE_CONTRACT_TOKEN` from the environment. It checks authenticated `/v1/me`, the `errors` and `work_threads` arrays in `/v1/faults`, MCP `task_report` and `bridge_faults`, and `/v1/version`. The version response contains `worker` and `hub`, each with engine version, Hub schema contract version and Cloudflare build ID. Hub values come from the running Hub itself. Build IDs detect old Hub code even when package versions match. A legacy Hub without the RPC reports `hub: null`.

With `--redeploy-on-stale`, a Worker/Hub mismatch triggers exactly one additional deployment and a full recheck. Persistent skew fails. Authentication, malformed responses and missing tools fail without redeploying. This handles long polls keeping an old Durable Object alive after its Worker has been replaced.

## Upgrade to a tagged release

Fetch and review the exact upstream tag you want, integrate it into your fork, then install with the frozen lockfile and run the offline checks below. Keep your deployment folder and secrets file. Review any changes to the schema or identity lock before deploying; a lock mismatch is a hard error, never an automatic reset. If an intentional resource migration is necessary, update its lock in the same reviewed change and arrange the data migration first. Simply changing a Worker name, Hub identity, origin or KV namespace is not an upgrade.

```sh
pnpm typecheck
node --test test/deployment.test.mjs test/contract-check.test.mjs
pnpm validate:deployment -- --deployment <id>
```

Run the engine integration suite in its isolated test environment before releasing. Do not point it at live deployment data. After upgrading, use the same generation, deployment and contract-check steps above.

## Client policy and compatibility

`compatibility.envPrefix` supports exactly `GOONBRIDGE` and `CHIMERA`. Legacy `GOONBRIDGE_*` overrides keep precedence. For the legacy prefix, absent/empty/invalid/nonpositive claim duration falls back to 900 seconds; generated deployment vars still explicitly set the configured `timing.claimSeconds`. Other deployment timing defaults remain configurable.

`hooks.enabled: []` disables optional hook work; `externalSkills: []` disables all external-skill downloads; there is no personal fallback. Each listed skill is installed under the directory named by its path's parent (use distinct names). Existing clients without policy retain legacy hook activation; update installed `bridge.json` and hooks together. The setup bootstrap remains in SessionStart so it can install that configuration.

`pnpm build:responder` writes the configured checkout filename and the legacy asset alias. The installer uses the configured responder asset basename. A legacy deployment keeps `goonbridge-responder.mjs`, its launchd label and `~/.goonbridge` through its config; other deployments use their configured filename and state directory. The committed asset is always `bin/goonbridge-responder.mjs` (the served alias); the configured checkout copy is ignored and rebuilt by `pnpm build:responder`. The bundled responder's defaults come from the selected deployment even without a local `bridge.json`. The checkout installer loads the same public projection through `bin/client-defaults.mjs`; a detached installer with neither supplied defaults nor local config refuses to guess a deployment. Both legacy asset URLs remain served aliases.

Remaining legacy runtime text is intentionally recorded for a later wording change: `bin/goonbridge-mcp.mjs` diagnostics and the `src/cloudconfig.ts` User-Agent. The installer's Login Items launcher and the cloud env file (`~/.config/<product>/env`) are named after `deployment.productName`. These are distinct from supported env/header/asset aliases and persisted device or install identities; do not rename those identities as branding cleanup.

T-66's state invariant applies to transitions of existing tasks through `transition()`; initial task creation still inserts its initial state directly (the existing follow-up). Other task changes use `writeTask()`. This stage changes neither path, event writes, liveness signals nor notice acknowledgement semantics.

## Cloud environments

`/cloud-setup.sh` (served with the selected deployment's public defaults filled in) reads every value from `~/.claude/bridge.json`, the environment, or those defaults; it has no built-in deployment. The environment holds `<ENV_PREFIX>_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If you keep the Cloudflare values in a secret store instead, set `CHIMERA_SECRET_CMD` to a shell command that prints the secret named by its first argument, and install that store's CLI in the environment's setup script. For example, with the 1Password CLI and items named after the variable:

```sh
CHIMERA_SECRET_CMD='op read "op://<vault>/$1/credential"'
```

The Claude Code hooks (`.claude/hooks/`) likewise have no personal fallbacks: without a bridge URL they do nothing, and the approval hook refuses destructive commands until a bridge URL and at least one approver (`hooks.approvers`) are configured.

## Maintainers' notes

The maintainers' decision log (`docs/decisions.md`) and plans (`plan/`) are private: the public repository is cut as a fresh history from a `git archive` snapshot that excludes them, operational notes, `.git/` and every ignored private input (`.private/`, private `deployments/<id>/` folders, `secrets.json`, `.dev.vars`). Owner-mode test baselines live in `.private/fixtures/<id>/`; the tests that need them skip when they are absent.
