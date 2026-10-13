# Engine tests

From a checkout with dependencies installed (`pnpm install --frozen-lockfile`):

```sh
pnpm test:engine
pnpm test:engine --smoke
pnpm test:engine test/cloud-config.test.mjs test/fire-routine.test.mjs
```

The smoke is just `auth.test.mjs`. The complete suite uses Node 22.18+ (including
`node:sqlite`) and the existing shell-test tools: a POSIX shell, git, curl, jq and
sha256sum (GNU coreutils on macOS). Missing shell tools fail the preflight instead
of invoking the cloud installer's system-package installation branches. Windows
users run the existing POSIX shell integration suite under WSL.

No Cloudflare login, owner checkout, `.dev.vars`, `.goonbridge-test` or real service
credentials are needed. The bootstrap bundles the real engine and responder with
the neutral JSON config. It generates eight independent synthetic bearer tokens,
OIDC credentials and webhook/PAT fixtures in memory. The outsider has no household;
Bob's cloud device intentionally has no routine, matching the existing negative
routing tests. Blank/bad-token routines and fake OIDC/GitHub are always available.

Each live test file gets a new Worker, persist directory, home directory, and fake
services on OS-assigned ports (port 0), so files cannot inherit tasks, grants,
JWKS caches or sessions. Test order inside each file is preserved. All artifacts
live under an OS temp `chimera-test-run-*` directory (the engine bundle in its own
subdirectory, since Wrangler watches the bundle's folder); the parent stops only its own process
groups and removes that directory on success, failure, SIGINT or SIGTERM. A hard
SIGKILL cannot run cleanup. Existing unrelated development servers are not used or
stopped. Wrangler runs `--local`; its Node control process refuses non-loopback
connections, including npm update checks. Readiness and per-file timeouts bound
failures. The full suite is slower because it starts a Worker for each live file.

Neutral HTTP JSON/HTML/guide responses are checked for deployment branding without
rewriting them. Executable assets retain compatible identifiers and old asset
URLs. The schema/client/external-skills compatibility files still execute
separately in owner-default mode with an empty temporary home; they need no owner
credentials.

Owner-mode baselines (byte snapshots and role names captured from a private
deployment) live outside the public tree in `.private/fixtures/<id>/`, next to the
private `deployments/<id>/` folder. Tests that need them skip when either is absent,
so the public tree runs them as skips. A private fork's owner flow uses its own
Worker, `.dev.vars` and token file (or `GOONBRIDGE_TEST_TOKENS`):

```sh
CHIMERA_DEPLOYMENT=<id> npx wrangler dev   # the build step selects deployments/<id>
env -u CHIMERA_NEUTRAL CHIMERA_DEPLOYMENT=<id> GOONBRIDGE_URL="${GOONBRIDGE_URL:?set the test Worker URL}" pnpm test
```

Missing-env skips remain supported in owner mode. Neutral mode supplies all those
integrations. SQLite tests can still skip on Node versions without `node:sqlite`;
use the stated Node version to include them. No intentional live integration skips
are added. The Stage 3 implementation was checked offline; the separate runner must
execute the Worker smoke and full neutral suite.
