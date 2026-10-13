# chimera

chimera is an agent bridge: messages between agents and devices, a shared task backlog, a status board, and cloud or Mac sessions started on demand. It runs as one Cloudflare Worker with one Durable Object. MCP clients (Claude Code, claude.ai, Codex, ChatGPT) connect to `/mcp` with OAuth or a bearer token; scripts use the REST API under `/v1/*`. Each deployment serves its own agent guide through `bridge_help` and `/agent-setup.md`, and devices sign in at `/device`.

## Quick start

```sh
pnpm install
pnpm typecheck
pnpm build:responder
devports up web -- pnpm exec wrangler dev
pnpm test:engine
```

That runs the engine locally against the bundled example deployment and the isolated neutral test harness. To run your own bridge, follow [docs/deploying.md](docs/deploying.md): copy the example deployment, push its secrets with `pnpm secrets:push`, generate the Wrangler config, deploy, then run the contract check.

## Deployments are folders

A deployment is one folder, `deployments/<id>/`: a public `bridge.config.json` (name, domain, members, devices, timings, labels, integrations), a `deployment.lock.json` that pins its resource identity, and a gitignored `secrets.json`. This repository ships only `deployments/example/`. Your own folder lives in your fork. Select it with the build-time env `CHIMERA_DEPLOYMENT=<id>` (default `example`); every build, generator, the responder and the tests read the deployment through `bin/selected-deployment.mjs`. One checkout can hold several deployment folders, each with its own Worker, domain and secrets.

## Compatibility names

Some identifiers still carry the engine's original name, goonbridge, because live installations depend on them: `GOONBRIDGE_*` environment variables (accepted alongside `CHIMERA_*`), `Goonbridge-*` request headers (where a deployment's `compatibility.headerPrefix` selects them), the served `/goonbridge-responder.mjs` and `/goonbridge-mcp.mjs` asset paths, and the per-deployment state directory and launchd label a legacy config names. They are aliases, not branding; new deployments use the `CHIMERA` prefix and their own names.

## Development notes

Use the URL printed by `devports` for local clients. `pnpm test:engine` needs no credentials, Cloudflare login or private files. Responder source lives in `bin/responder/`; `pnpm build:responder` rebuilds the committed asset `bin/goonbridge-responder.mjs` after edits. Never run any test suite against production data.

## License

MIT. See [LICENSE](LICENSE).
