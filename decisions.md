# Decisions

## 2026-10-14 Setup: Access is off unless the answer is clearly yes
A missing `access` key, `false`, `"no"` or the "No, token sign-in only" label all mean no Access; `"yes"`/`true` turn it on; anything else is refused. Rejected: keeping `access` a required answer, which made agents guess a value. The real "gunwa" run wrote `access: true` because the person picked a reworded "Yes, use Access" option after asking what the question meant; the skill now re-asks with the same options word for word.

## 2026-10-14 Setup: first-run deployment id is <name>-test
On a first run, or when a live Worker or `.private/deployments/<name>` shows the name in use, detection offers `<name>-test` first. The plain name is the owner's live bridge id and GOONBRIDGE_TOKENS key, so a throwaway must not take it. The plain name stays a choice.

## 2026-10-14 Sign-in: Access is required for people; setup creates it
The bridge has no sign-in of its own: with ACCESS_* unset, /authorize answers "Sign-in is not set up" and only static tokens work. So the sign-in question offers only "setup creates Access" (`"provision"`) or "use my Access app" (`"existing"`); `false` stays for script-only bridges in an answers file. Rejected: a "token sign-in only" option for people (it never let a person sign in) and a bridge-only email login (not in the code).

## 2026-10-14 access:provision uses a reusable Access policy
New Access applications cannot take legacy app-scoped policies (POST /access/apps/{id}/policies), so the provisioner creates a reusable policy (POST /access/policies, include the group) and passes its id in the app's `policies` on create. The SaaS app's client secret is returned only on create; a lost one is regenerated in the dashboard and entered with secrets:fill.
