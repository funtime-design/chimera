#!/bin/sh
# Fetch each explicitly configured external skill. Errors keep the previous copy; an empty list disables fetching.
. "$(dirname "$0")/bridge-config.sh"
bridge_hook_enabled fetch-external-skills || exit 0
[ -n "${CLAUDE_CODE_REMOTE:-}" ] || [ "${GOONBRIDGE_EXTERNAL_SKILLS:-${CHIMERA_EXTERNAL_SKILLS:-}}" = "1" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)}"
dir="${GOONBRIDGE_EXTERNAL_SKILLS_DIR:-${CHIMERA_EXTERNAL_SKILLS_DIR:-$root/.claude/skills}}"
# An explicit env-only source supports older clients; there is no implicit owner repository.
skills="$(jq -c '.external_skills // []' "$bridge_config" 2>/dev/null)"
if [ -z "$skills" ]; then
  repo="${GOONBRIDGE_EXTERNAL_SKILLS_REPO:-${CHIMERA_EXTERNAL_SKILLS_REPO:-}}"
  [ -n "$repo" ] || exit 0
  skills="$(jq -nc --arg repo "$repo" --arg ref "${GOONBRIDGE_EXTERNAL_SKILLS_REF:-${CHIMERA_EXTERNAL_SKILLS_REF:-main}}" '[{repo:$repo,commit:$ref,path:"skills/gaps/SKILL.md"}]')"
fi
[ "$skills" != '[]' ] || exit 0
tmp=$(mktemp -d "${TMPDIR:-/tmp}/bridge-skills.XXXXXX") || exit 0
trap 'rm -rf "$tmp"' EXIT
export GIT_TERMINAL_PROMPT=0
printf '%s' "$skills" | jq -c '.[]' | while IFS= read -r skill; do
  repo="${GOONBRIDGE_EXTERNAL_SKILLS_REPO:-${CHIMERA_EXTERNAL_SKILLS_REPO:-$(printf '%s' "$skill" | jq -r .repo)}}"
  ref="${GOONBRIDGE_EXTERNAL_SKILLS_REF:-${CHIMERA_EXTERNAL_SKILLS_REF:-$(printf '%s' "$skill" | jq -r .commit)}}"
  skill_path="$(printf '%s' "$skill" | jq -r .path)"
  name="$(basename "$(dirname "$skill_path")")"
  case "$name" in ''|.|..|*[!a-zA-Z0-9_-]*) continue ;; esac
  dest="$dir/$name"
  rm -rf "$tmp/repo"
  mkdir -p "$tmp/repo"
  {
    git -C "$tmp/repo" init -q &&
      git -C "$tmp/repo" remote add origin "$repo" &&
      git -C "$tmp/repo" fetch -q --depth 1 --filter=blob:none origin "$ref" &&
      mkdir -p "$dest" &&
      git -C "$tmp/repo" show "FETCH_HEAD:$skill_path" > "$dest/SKILL.md.tmp" &&
      [ -s "$dest/SKILL.md.tmp" ] && mv -f "$dest/SKILL.md.tmp" "$dest/SKILL.md"
  } >/dev/null 2>&1 || rm -f "$dest/SKILL.md.tmp" 2>/dev/null
 done
exit 0
