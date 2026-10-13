---
name: chimera-setup
description: Use when the user asks to set up, stand up, finish setting up, or check the setup of a chimera bridge (a deployment under deployments/<id>/) — "set up my bridge", "resume the bridge setup", "is my bridge set up". Drives `pnpm run setup` non-interactively with an answers file, resumes it, and reads /docs/status.
---

# Set up a chimera bridge

`bin/setup.mjs` does the work; you collect the answers only a person can give, run it, and report. It records each step in `.chimera-setup/<id>.json` (ignored by git), so it can always be resumed. Use `pnpm run setup`, never `pnpm setup` (that is pnpm's own command and edits the shell profile).

## 1. Ask the person (only they know these)

- **Deployment id**: folder name under `deployments/`, lowercase, e.g. `acme`. Not `example`.
- **Display name** of the bridge.
- **Origin**: the HTTPS address it will live at, e.g. `https://bridge.example.com` (a domain in their Cloudflare account).
- **Cloudflare account ID** (32 hex characters, from the dashboard).
- **Worker name** (default `<id>-bridge`).
- **Admins** and **members**: person names (lowercase, no dash, each used once) and each person's sign-in email. Admins open `/docs/status` and `/docs/settings`, and approve destructive commands.
- **Cloudflare Access**: is it in front of the bridge? If yes, the Access group id, if they want setup to add the emails through the API.

Never ask for tokens or API keys in chat. The person fills those into `deployments/<id>/secrets.json` themselves.

## 2. Write the answers file and run setup

Write the answers to a file outside the repo (it holds emails and the account ID), then run:

```sh
pnpm run setup -- --answers /path/to/answers.json
```

```json
{
  "deployment": "acme",
  "displayName": "Acme bridge",
  "origin": "https://bridge.example.com",
  "accountId": "0123456789abcdef0123456789abcdef",
  "workerName": "acme-bridge",
  "admins": [{ "name": "alice", "email": "alice@example.com" }],
  "members": [{ "name": "bob", "email": "bob@example.com" }],
  "access": { "enabled": true, "groupId": "<Access group id, optional>" }
}
```

Delete the answers file once the config step is done. Exit codes: **0** done; **2** waiting for the person; **1** error (the message says what to fix; it never contains a secret).

## 3. When it pauses (exit 2)

- **Secrets to fill**: it lists key names (e.g. `GOONBRIDGE_TOKENS.alice`, `CLOUDFLARE_API_TOKEN`). Tell the person to fill them in `deployments/<id>/secrets.json` (tokens: 24+ random characters, e.g. `openssl rand -hex 24`; the Cloudflare token must be able to deploy this Worker). Or have them run `pnpm secrets:mint -- --deployment <id>` in their own terminal: it generates the member tokens and mints the deploy token from one minter token (asked masked), or `pnpm secrets:fill -- --deployment <id>` for values they already hold. Never ask for a token in chat.
- **Confirmation**: pushing secrets and deploying change live systems. Show the person the dry-run list it printed, get a yes, then resume with `--yes`.

```sh
pnpm run setup -- --deployment <id> --resume          # continue; stops before push/deploy
pnpm run setup -- --deployment <id> --resume --yes    # after the person said yes
```

Re-running when everything is done prints the status and exits 0.

## 4. Cloudflare Access

If Access is on, each person must also be in the Access group. Setup prints "add <email> to the Access group" per person (step status `manual`), or does it through the API when `CLOUDFLARE_ACCESS_TOKEN` (a token that can edit Access groups) is set in the environment and the answers name `access.groupId`. The person sets that token; you never print it.

## 5. Check the live bridge

After deploy, an admin's token or Access sign-in reads `GET <origin>/docs/status`:

```json
{ "deployment": "acme", "version": { "engine": "0.1.0", "schema": 2, "build": "..." }, "members": 2, "devices_registered": 0, "last_contract_check": "2026-10-13T...", "access": true }
```

`last_contract_check` null means the post-deploy check has not run against this Worker: `pnpm contract:check -- --deployment <id>`.

## What changes later, and where

- People, admins, names, domain, timings and labels: edit `deployments/<id>/bridge.config.json` (emails and tokens in `secrets.json`), then `pnpm secrets:push` and redeploy. There is no in-app user registration.
- Devices and per-device permissions: an admin on `<origin>/docs/settings`.
