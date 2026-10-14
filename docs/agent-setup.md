# READ THIS FIRST: before calling any other {{SETUP.connectorName}} tool

{{RULES.startSequence}}

{{RULES.operatingModel}}

## How the owner drives this

{{RULES.ownerWorkflow}}

---

# {{SETUP.connectorName}}: setup for agents

{{SETUP.guideIntroduction}}

## Connect

People never type a token. Every client below except scripts and cloud sessions signs in the same way: a confirm page on the bridge, then Cloudflare Access emails a one-time code to your address, and only emails on the member list get in. Static tokens are for scripts, cloud sessions and the Mac responder only.

- Claude Code (Mac): `claude mcp add --scope user --transport http {{SETUP.connectorName}} {{BASE_URL}}/mcp`, no header. Then `/mcp` -> {{SETUP.connectorName}} -> authenticate: sign in with Cloudflare Access and pick this Mac's device (for example `{{SETUP.exampleDevice}}`) on the confirm page. A configured `Authorization` header turns Claude Code's OAuth sign-in off, so leave it out.
  Each Claude Code window on the Mac is its own child of the device (`{{SETUP.exampleDevice}}-x7k`), like a cloud session, with no session header: the bridge hands out an `Mcp-Session-Id` when the window connects and Claude Code sends it back on every call. Optionally add `--header '{{SETUP.contextHeader}}: ${{{SETUP.envPrefix}}_CONTEXT:-}'` to put a context in the name (`{{SETUP.exampleDevice}}-x7k-<context>`). The responder and other REST clients have no MCP session and stay plain `{{SETUP.exampleDevice}}`.
- A Mac that should answer while nobody is at it: see "Headless device (responder)".
- claude.ai web, phone, routines: add `{{BASE_URL}}/mcp` as a custom connector and sign in.
- Cloud sessions: see "Cloud sessions".
- Scripts: REST under `{{BASE_URL}}/v1` with `Authorization: Bearer <token>`, a static token or an OAuth access token from the sign-in above.
- Your devices and sign-ins: `{{BASE_URL}}/docs/devices` lists them, revokes a sign-in, or forgets a signed-in device.

## Members

{{RULES.members}}

## Messages

{{RULES.messages}}

## Tasks

{{RULES.finishSequence}}

{{RULES.taskRules}}

### Epics

{{RULES.epics}}

{{RULES.epicConversion}}

## The record (one append-only log)

{{RULES.record}}

{{RULES.recordTools}}

## Work threads (no task behind the work)

{{RULES.workThreads}}

## Cloud sessions

{{RULES.cloudStart}}

{{RULES.cloudAddressing}}

{{RULES.liveness}}

{{RULES.heartbeat}}

{{RULES.deadClaims}}

{{RULES.fireFaults}}

{{RULES.warmSessions}}

### Notes to a cloud device

{{RULES.cloudNotes}}

### Setting up a repo and the cloud environment

A repo that cloud sessions work in commits:

- `.mcp.json`: `{{SETUP.connectorName}}`, type http, url `{{BASE_URL}}/mcp`, headers `Authorization: Bearer ${{{SETUP.envPrefix}}_TOKEN:-}`, `{{SETUP.sessionHeader}}: ${CLAUDE_CODE_REMOTE_SESSION_ID:-}` and `{{SETUP.contextHeader}}: <repo name>`. No token in the file.
- `.claude/settings.json`: a `SessionStart` hook, `[ -n "${CLAUDE_CODE_REMOTE:-}" ] && curl -fsSL {{BASE_URL}}/cloud-setup.sh | sh || true`, plus the heartbeat loop and wind-down hooks above.

The cloud environment `{{SETUP.connectorName}}` (claude.ai/code, cloud icon above the message box, gear on the environment):

{{SETUP.guideCloudSetup}}

Standing instructions for a cloud session:

{{RULES.standingInstructions}}

## Watching sessions

{{RULES.watchingSessions}}

## Kill (stop a session)

{{RULES.kill}}

{{RULES.killSteps}}

{{RULES.killSemantics}}

## Firing a routine by name

{{RULES.namedRoutines}}

## Headless device (responder)

`{{SETUP.responderCommand}}` keeps a Mac online as its device and answers each message to that device with one `claude -p` session (no resume between messages). It holds an OAuth grant in `~/{{SETUP.stateDirName}}/grant.json` (mode 0600), never a static token, and the `claude` it starts never sees it.

Sign-in uses a device code, so it works from a phone:
1. On the Mac: `node bin/{{SETUP.responderFile}} login --device <person>-<label>` (from a checkout, or download `{{BASE_URL}}/{{SETUP.responderFile}}`). It prints a code and a link.
2. On the phone: open `{{BASE_URL}}/device`, enter the code (the link fills it in), sign in with Cloudflare Access.
3. The confirm page has the device picked. A new name is registered under your sign-in; another person's name is refused.
4. The Mac polls, swaps the code for the grant and saves it. Then `sh bin/install-responder-macos.sh` runs it under launchd (`--uninstall` removes it).

If the grant is revoked on /docs/devices, the responder stops with "signed out"; run `login` again.

{{RULES.responderMode}}

{{RULES.trust}}

## External skills

{{SETUP.guideExternalSkills}}

## GitHub webhook (tasks follow GitHub)

{{SETUP.guideWebhookSetup}}

{{RULES.githubMatching}}

{{RULES.githubEvents}}

{{RULES.deployPolicy}}

{{RULES.doneMeansMerged}}

{{SETUP.guideBackfill}}

### Manual revert

{{RULES.manualRevert}}

### Admin stamp (backfill a merge the webhook missed)

{{RULES.adminStamp}}