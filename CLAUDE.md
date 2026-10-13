# chimera

Agent bridge on Cloudflare (one Worker, one Durable Object). Read `README.md` for what it is and `docs/deploying.md` for how a deployment is created, pushed and deployed.

## When the user wants a bridge set up
Use the `chimera-setup` skill (`.claude/skills/chimera-setup/SKILL.md`). It drives `pnpm run setup` (never `pnpm setup`: that is pnpm's own command). Ask only the questions the skill lists; the script does the rest and records progress in `.chimera-setup/<id>.json`, so re-running resumes.

## Rules
- A deployment is `deployments/<id>/`. `bridge.config.json` and `deployment.lock.json` are committed; `secrets.json` is gitignored and never committed. The public repo ships `example` only; a private fork adds its own folder.
- Secrets never appear in output, logs, commits or chat. Scripts print key names, not values. `secrets:mint` creates new values from one master credential; `secrets:push` sends them to Cloudflare and GitHub via stdin.
- `secrets:mint` against a deployment that is already live rotates every token on that bridge: existing sessions and the Mac responder must sign in again. Use a throwaway deployment id first when testing.
- Never change a locked identity (Worker name, Hub class/binding/key `main`, migrations, KV binding, origin) in place; the lock refuses it, and changing it loses live data.
- Tests: `pnpm test:engine` is self-contained (neutral roster, own ports, own temp dirs). The owner-mode suite needs a real deployment selected with `CHIMERA_DEPLOYMENT=<id>`.
- Append non-obvious choices to `docs/decisions.md` (private in forks; not shipped publicly).
