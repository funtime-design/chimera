---
name: chimera-setup
description: Use when the user asks to set up, stand up, finish setting up, or check the setup of a chimera bridge (a deployment under deployments/<id>/) — "set up my bridge", "resume the bridge setup", "is my bridge set up". Checks prerequisites, detects what it can, asks one question at a time with choices, drives `pnpm run setup`, and reads /docs/status.
---

# Set up a chimera bridge

You are walking a person, possibly a stranger to Cloudflare, through setup. `bin/setup.mjs` does the work. Your job: check what they have, find out everything the machine can tell you, ask only what is left, **one question per turn with the AskUserQuestion tool**, and relay each result in one line.

Use `pnpm run setup`, never `pnpm setup` (that is pnpm's own command and edits the shell profile).

The person may use `pnpm run setup -- --web` instead: the same steps and the same questions, word for word, on a local page in their browser, sharing this flow's state file. If they pick it, give them that one command to run in their own terminal and let the page do the rest.

## What the user must see

The person sees only what you write, never the tool output. So you relay script output that is marked for the user verbatim, never summarised.

- Setup wraps every block meant for the person between a line `--- show this ---` and a line `--- end ---`. Print each such block to the user exactly, as a fenced code block, BEFORE saying anything else about it. Leave out only the two marker lines.
- The prerequisites checklist is always shown in full, every tick and cross, even when everything passes. After it, one line: "All set" or the first fix.
- After each setup step, relay its "Step N of M: ..." line and its "Result: ..." line verbatim, one step per line. Every step, including "already done".
- On a pause (exit 2), the show block holds the "waiting for" line and the exact command or question. Print it verbatim, then ask.
- Every step that sends the person to another site (signing up for Cloudflare, `npx wrangler login`, the master token, turning on Cloudflare Access) has an illustrated guide in docs/guides/; setup prints its numbered steps with "Screenshot: docs/images/..." lines inside the show block. Relay them verbatim, screenshot paths included, so the person can open the pictures.
- An option that shows or explains something (such as "Show me the steps again") prints that text as its own message first, then you ask the same question again.

## Do not

- Do not merge several steps into one sentence.
- Do not say "everything is in place" (or "all good", or similar) without the full checklist above it.
- Do not paraphrase an instruction that contains a URL or a command. Copy it exactly.
- Do not answer a question for the user, or pick an option on their behalf.
- Do not replace a show block with "Ran N shell commands" or a summary of it.

## Wording rules

- Plain language, short sentences. Answer first, detail after.
- Define a term the first time you use it: "a Worker is the Cloudflare service that runs the bridge"; "Cloudflare Access is Cloudflare's free login screen: it emails a one-time code"; "wrangler is Cloudflare's command-line tool".
- Never ask for something detection already found. Never ask for the 32-character account ID when wrangler can supply it.
- Every "go here" is a concrete path or URL, such as "Cloudflare dashboard > Websites" or https://dash.cloudflare.com/profile/api-tokens. Never just "from the dashboard".
- Never put more than one question in a message, and never send a numbered list of questions. One AskUserQuestion per turn, 2 to 4 options, each with a one-line description. The tool adds "Other" for free text by itself.
- Never ask for a token in the chat, and never print a secret value. Tokens go into masked prompts in the person's own terminal.

## Step 0: prerequisites (before any question)

```sh
pnpm run setup -- --prereqs
```

It prints a short checklist inside a show block: a tick or a cross per line, then either "All set" or "Next: <the one fix>". Print the whole block verbatim as a fenced block, even when every line is a tick, then one line: "All set" or the first fix. Exit 2 means something required is missing:

- Tell the person the single fix from the "Next:" line (for example `npx wrangler login`, which opens the browser to sign in to Cloudflare; or `brew install node`).
- Help with the fix if they ask. Then wait for them to say it is done, and run `--prereqs` again. Do not start the questions until it exits 0.

If a tool goes missing later (wrangler, gh), do the same: the single command, wait, run detection again.

## Step 1: detect

```sh
pnpm run setup -- --detect
```

It prints JSON. Each field has `value`, `source` (`detected`, `default` or `needs-answer`) and `howToGet` (one sentence: where to find it, or the command). Account IDs are masked; that is fine, setup reads the real one itself. Ask only about fields that are `needs-answer`, plus the questions below that confirm a suggestion (deployment id, display name, admin, people). Skip a question the person already answered.

If `setupInProgress` lists a deployment, ask Q0 first.

## Step 2: the questions, one per turn

Each block is one AskUserQuestion call (single choice). Put the suggested option first.

### Q0. Resume a setup in progress

Only when `fields.setupInProgress.value` is not empty. AskUserQuestion, header "Resume", question "A setup for <id> is already half done. Carry on with it?"
Options:
- **Carry on with <id>**: runs `pnpm run setup -- --deployment <id> --resume` and picks up where it stopped.
- **Start a new bridge**: leaves <id> as it is and sets up a different one.

### Q1. Cloudflare account

Only when `fields.accountId.source` is `needs-answer` and wrangler sees several accounts (`fields.accounts`). AskUserQuestion, header "Account", question "Which Cloudflare account should run the bridge?"
Options:
- **<account name>**: one option per account in `fields.accounts`, up to four; the description says "account ending ****<last4>".
- **<next account name>**: same.

The answer goes in `accountName`.

### Q2. Deployment id

AskUserQuestion, header "Name", question "What short name should this bridge have? It becomes the folder deployments/<name>/."
Options: in the order of `fields.deployment.choices` (each choice's `value` is the label, its `description` the description).
- **<choices[0].value>**: <choices[0].description>. On a first run, or when the name looks in use (a live Worker, or `.private/deployments/<name>`), this is `<name>-test`: "throwaway for testing; use <name> when you migrate the live bridge".
- **<choices[1].value>**: <choices[1].description> (only when there is a second choice; usually the plain name).
- **Something else**: type a name with lowercase letters, digits or dashes (choose Other).

Never drop the plain name, and never reorder: the test id comes first so a first try does not take the live bridge's id.

### Q3. Domain

AskUserQuestion, header "Address", question "Where should the bridge live on the web?"
Options:
- **bridge.<zone>**: one option per detected domain in `fields.zones` (up to three); "uses a domain already on your Cloudflare account".
- **No custom domain, use workers.dev**: a free address Cloudflare gives every account, like https://<name>-bridge.<you>.workers.dev.

If `fields.zones.source` is `needs-answer` (domains could not be listed), replace the domain options with **I have a domain on Cloudflare** (they type it via Other; it must show in Cloudflare dashboard > Websites). The answer goes in `origin`: `https://bridge.<zone>`, or the word `workers.dev`.

### Q4. Bridge display name

AskUserQuestion, header "Title", question "What should people see as the bridge's name?"
Options:
- **<fields.displayName.value>**: the suggested name; you can change it later in bridge.config.json.
- **Something else**: type the name (choose Other).

### Q5. Admin

AskUserQuestion, header "Admin", question "Who is the admin? An admin opens the status and settings pages and approves risky commands."
Options:
- **Use <git email>**: from `git config user.email`; your person name will be <name>.
- **Different email**: type a name and email, like `alice alice@example.com` (choose Other).

If `fields.admins` is `needs-answer`, the options are **Type a name and email** (choose Other) and **Use my GitHub email** (read it with `gh api user --jq .email`).

### Q6. Cloudflare Access sign-in

People sign in to the bridge only through Cloudflare Access; the bridge has no sign-in of its own. So the question is not whether to use Access, only who creates it. AskUserQuestion, header "Sign-in", question "How should people sign in?", with this description line first, word for word: "Cloudflare Access is Cloudflare's free login screen: it emails a one-time code and lets in only the emails on your list. No tokens for people; tokens are only for scripts and cloud sessions."
Options:
- **Email code via Cloudflare Access (recommended; setup creates it for you)**: setup makes the login screen, the list of allowed emails and the app through the Cloudflare API; the only manual step is turning Access on once, if it is off.
- **I already have an Access app, use it (paste its client id when asked)**: for an Access for SaaS app you made yourself; you paste its client id next and its secret into a hidden prompt later.

The answer goes in `access` as one of two JSON strings: the first option writes `"access": "provision"`, the second `"access": "existing"`. Never the option label, never a boolean. (An answers file may say `"access": false` for a bridge only scripts use; never offer that here, since then no person can sign in.)

If the person asks what this means instead of picking, explain in one or two sentences, then ask Q6 again with the same two options, word for word. Do not reword an option. Echo the answer in Q9 as "Sign-in: email code, setup creates it" or "Sign-in: your Access app".

### Q6.1 Access app client id

Only after "I already have an Access app". AskUserQuestion, header "Client id", question "Paste your Access app's client id. It is in Zero Trust (https://one.dash.cloudflare.com/) > Access controls > Applications > your app > Configure, under the OIDC settings. It is not secret; the client secret goes into a hidden prompt later."
Options:
- **Paste the client id**: choose Other and paste it.
- **Create one for me instead**: switches the answer to `"access": "provision"`.

The client id goes in `accessClientId`. The client secret never goes in chat: `pnpm secrets:fill -- --deployment <id> --only ACCESS_CLIENT_SECRET` asks for it in a masked prompt in the person's own terminal.

### Q7. More people

AskUserQuestion, header "People", question "Anyone else who should use the bridge?"
Options:
- **Just me for now**: you can add people later in bridge.config.json and secrets.json.
- **Add people**: one at a time, a name and sign-in email each.

### Q8. Next person

Only after "Add people", once per person. AskUserQuestion, header "Person", question "Who should we add? Choose Other and type a name and email, like `bob bob@example.com`."
Options:
- **Type a name and email**: choose Other; names are lowercase with no dash, each used once.
- **That's everyone**: stop adding people.

The answers go in `members` as `{ "name", "email" }`.

### Q9. Confirm before anything is written

AskUserQuestion, header "Confirm", with a short summary in the question: name, address, admin, other people, sign-in, and "GitHub Actions secrets: yes/no" from `fields.githubActions`.
Options:
- **Yes, set it up**: writes the settings and starts the steps.
- **Change something**: say which answer, then ask that one question again.
- **Stop here**: nothing is written.

## Step 3: write the answers and run setup

Write only the answers the person gave to a file outside the repo (it holds emails), then run setup. Detection fills the rest (account ID, Worker name, defaults):

```sh
pnpm run setup -- --answers "$TMPDIR/chimera-answers.json"
```

```json
{ "deployment": "acme", "displayName": "Acme bridge", "origin": "https://bridge.example.com",
  "admins": [{ "name": "alice", "email": "alice@example.com" }], "members": [], "access": "provision" }
```

Delete the answers file once step 1 is done. Exit codes: **0** done; **2** waiting for the person; **1** error (the message says what to fix; it never holds a secret). Exit 2 with "needs-answer: a, b" lists exactly the fields still missing, each with where to get it: ask those, one question per turn, and run again.

Setup prints "Step N of M: <what>" and a "Result:" line per step. Relay both lines verbatim for every step, one step after another, never merged; for example:

```
Step 1 of 8: writing the bridge settings (bridge.config.json and deployment.lock.json)
  Result: done
```

On exit 2, print the show block (the "waiting for" line and the exact commands) verbatim before you ask anything.

## Step 4: the tokens

Setup pauses at step 2 (exit 2) until the tokens exist. One master token makes all the others. Ask:

### Q10. Master token

First run `pnpm run setup -- --token-steps` and print its show block verbatim as its own message: the numbered steps and the screenshot paths come from docs/guides/master-token.md, the one copy of them. Then AskUserQuestion, header "Token", question "Create the one master token now? Follow the steps above, then keep the token in your password manager."
Options:
- **I have it, run mint**: I'll paste it into the masked prompt (typing stays hidden).
- **Show me the steps again**: prints the 6 steps, numbered, as their own message.
- **Skip, I'll use existing tokens via secrets:fill**: for tokens you already hold.

Then:

- **Show me the steps again.** Run `pnpm run setup -- --token-steps`. Print its show block (the 6 numbered steps with the dashboard URL) verbatim as its own message, then ask the same question again (re-ask Q10, same options). Never paraphrase the steps.
- **Run mint.** Check for a terminal first: `node -e "process.exit(process.stdin.isTTY ? 0 : 1)"`. With a terminal (exit 0), run `pnpm secrets:mint -- --deployment <id>` there; the person pastes the token into the masked prompt. Without one (exit 1, the usual case in an agent's shell), tell the person the single command to run in their own terminal, in this folder: `pnpm secrets:mint -- --deployment <id>`, and wait until they say it finished.
- **Skip**: the same, with `pnpm secrets:fill -- --deployment <id>`.
- Never ask for a token in chat. Never read secrets.json aloud.
- Then: `pnpm run setup -- --deployment <id> --resume`.

`secrets:mint` against a bridge that is already live replaces every token on it; everyone signs in again.

## Step 5: push and deploy

Setup stops before it changes anything live and prints what it would push. Ask:

### Q11. Push and deploy

AskUserQuestion, header "Go live", question "Setup is ready to send the secrets to Cloudflare and put the bridge online. Go ahead?"
Options:
- **Yes, push and deploy**: runs `pnpm run setup -- --deployment <id> --resume --yes`.
- **Not yet**: nothing changes; resume any time with the same command.

Re-running when everything is done prints the status and exits 0. `--resume` always starts with a done/todo checklist in a show block; print it verbatim.

## Step 6: creating the sign-in (Cloudflare Access)

After the tokens and before anything goes live, setup runs "Step 3 of 8: creating the sign-in (Cloudflare Access)" (`pnpm access:provision -- --deployment <id>`). Relay its lines verbatim, show blocks included.

- **"provision"**: it creates, or finds on a re-run, the One-time PIN login, the Access group "<display name> members" with every person's email, an allow policy for that group, and the app "<display name> sign-in" with the redirect URL `<origin>/callback`. It writes the client id and sign-in URLs into bridge.config.json (commit it) and the client secret into secrets.json. Only names are printed, never emails.
- **"existing"**: it finds the app by `accessClientId` and writes only its URLs. Who may sign in stays in that app's own policy.
- **Access is off for the account** (exit 2): the show block names the one-time step at https://one.dash.cloudflare.com/ (pick a team name and the Free plan). Print it, wait until the person says it is done, then resume.
- **No Access token** (exit 2): `secrets:mint` mints `CLOUDFLARE_ACCESS_TOKEN` when run with `--access-token` (setup's pause message already says so). Print the show block and wait.
- **The app exists but its secret is missing** (exit 2): the show block says how to regenerate it in the dashboard and enter it with `secrets:fill`. Print it and wait.

## Adding people later

Add the person to `members` in bridge.config.json and their email to `GOONBRIDGE_MEMBERS` in secrets.json, then run `pnpm run members:sync -- --deployment <id>` (it adds and removes emails in the Access group and prints names only), `pnpm secrets:push -- --deployment <id>` and redeploy. With `CLOUDFLARE_ACCESS_TOKEN` in GitHub Actions, the deploy workflow runs members:sync by itself.

## Step 7: check the live bridge

An admin's Access sign-in (or a script's token) reads `GET <origin>/docs/status`:

```json
{ "deployment": "acme", "version": { "engine": "0.1.0", "schema": 2, "build": "..." }, "members": 2, "devices_registered": 0, "last_contract_check": "2026-10-13T...", "access": true }
```

`last_contract_check` null means the post-deploy check has not run against this Worker: `pnpm contract:check -- --deployment <id>`.

## What changes later, and where

- People, admins, names, domain, timings and labels: edit `deployments/<id>/bridge.config.json` (emails and tokens in `secrets.json`), then `pnpm run members:sync -- --deployment <id>`, `pnpm secrets:push` and redeploy. There is no in-app user registration.
- Devices and per-device permissions: an admin on `<origin>/docs/settings`.
