# Changelog

All notable changes to chimera are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Forks track the release tags, not `main` (see `docs/deploying.md`, "Keeping up with releases").

## [Unreleased]

### Added
- The engine split out of a private deployment into a public repository: one Worker and one Durable Object, with every deployment kept in its own `deployments/<id>/` folder (config, identity lock, ignored secrets) and selected by `CHIMERA_DEPLOYMENT`.
- Setup stage: `pnpm run setup` stands up a deployment from a short questionnaire and resumes where it stopped; admin pages `/docs/status` and `/docs/settings`; bridge `admins` and `hooks.approvers`; the `chimera-setup` skill.
- `pnpm secrets:mint` fills `secrets.json` from one master credential (member tokens, webhook secret, a scoped 90-day deploy token); `pnpm secrets:fill` takes values you already hold.
- `CLAUDE.md` points a fresh agent session at the setup skill and the repository rules.
- Guided setup: `pnpm run setup` starts with a prerequisites checklist (`--prereqs`) and detects the Cloudflare account, domains, workers.dev subdomain and git admin before asking (`--detect`, `bin/setup-detect.mjs`); `--answers` wins and missing answers exit 2 with a needs-answer list; each step prints "Step N of M" and a result, `--resume` a done/todo checklist; a workers.dev address works; without `gh` the GitHub Actions secrets are skipped. The `chimera-setup` skill asks one question per turn with choices (AskUserQuestion) and has the master token minted in a masked prompt instead of asking anyone to fill `secrets.json`.
- Staging and releases: CI runs the neutral suite on every pull request; the public repo's `staging` deployment (workers.dev, neutral members) deploys on every merge to `main` and is smoke-tested; a `vX.Y.Z` tag made by `pnpm release:tag` becomes a GitHub Release once that commit's staging deploy has passed.
- `gen:wrangler` supports a workers.dev origin (no custom-domain route).

[Unreleased]: https://github.com/funtime-design/chimera/commits/main
