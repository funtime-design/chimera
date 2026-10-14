# Decisions

## 2026-10-14 Setup: Access is off unless the answer is clearly yes
A missing `access` key, `false`, `"no"` or the "No, token sign-in only" label all mean no Access; `"yes"`/`true` turn it on; anything else is refused. Rejected: keeping `access` a required answer, which made agents guess a value. The real "gunwa" run wrote `access: true` because the person picked a reworded "Yes, use Access" option after asking what the question meant; the skill now re-asks with the same options word for word.

## 2026-10-14 Setup: first-run deployment id is <name>-test
On a first run, or when a live Worker or `.private/deployments/<name>` shows the name in use, detection offers `<name>-test` first. The plain name is the owner's live bridge id and GOONBRIDGE_TOKENS key, so a throwaway must not take it. The plain name stays a choice.
