#!/bin/sh
# Setup for a configured Claude cloud environment.
# Runs twice per session on purpose: from the environment's setup script (installs only; the variables are not there
# yet) and from the repo's SessionStart hook (writes the values, with the variables). One line in both:
#   curl -fsSL https://example.com/cloud-setup.sh | sh
# Every value comes from bridge.json, the environment or the defaults the Worker fills in from the selected deployment.
# The environment holds the bridge token (<ENV_PREFIX>_TOKEN; .mcp.json sends it to the bridge) and the Cloudflare
# values, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Optional: CHIMERA_SECRET_CMD, a shell command that prints the
# secret named by its first argument, read only for a Cloudflare value the environment lacks. Install its tool in the
# environment's setup script. Example (1Password CLI, items named after the variable):
#   CHIMERA_SECRET_CMD='op read "op://<vault>/$1/credential"'
# Safe to run again. Nothing here is secret.
set -eu
bridge_defaults='{}' # supplied by the Worker
bridge_config="${BRIDGE_CONFIG:-$HOME/.claude/bridge.json}"
bridge_value() {
  value=$(jq -r --arg key "$1" '.[$key] // empty' "$bridge_config" 2>/dev/null || true)
  [ -n "$value" ] || value=$(printf '%s' "$bridge_defaults" | jq -r --arg key "$1" '.[$key] // empty' 2>/dev/null || true)
  printf '%s' "$value"
}

envfile="" # set once bridge.json names the product (below)
say() { printf 'cloud-setup: %s\n' "$1"; }
has() { command -v "$1" >/dev/null 2>&1; }
sudo_cmd() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# Tools: jq and wrangler. A secret store's CLI, if CHIMERA_SECRET_CMD needs one, is the environment's to install.
has jq || { sudo_cmd apt-get update -qq >/dev/null && sudo_cmd apt-get install -y -qq jq >/dev/null; } || say "jq install failed"
has wrangler || { has npm && npm install -g wrangler --silent >/dev/null 2>&1 && say "installed wrangler"; } || true

# Claude Code user settings: tools every cloud session may use without a prompt, whatever repo it opened.
# Merged into ~/.claude/settings.json; whatever else is there stays.
settings="$HOME/.claude/settings.json"
allow='["mcp__claude-code-remote__create_session"]'
if has jq; then
  mkdir -p "$(dirname "$settings")"
  [ -s "$settings" ] || echo '{}' > "$settings"
  if jq --argjson add "$allow" '.permissions.allow = (((.permissions.allow // []) + $add) | unique)' "$settings" > "$settings.tmp"; then
    mv "$settings.tmp" "$settings" && say "allowed in $settings: $(echo "$allow" | jq -r 'join(", ")')"
  else
    rm -f "$settings.tmp"; say "$settings is not valid JSON; left it alone"
  fi
else
  say "no jq; skipped the Claude Code settings"
fi

# Cloudflare values: from the environment, else from the configured secret command (CHIMERA_SECRET_CMD), if any.
secret() { [ -n "${CHIMERA_SECRET_CMD:-}" ] && sh -c "$CHIMERA_SECRET_CMD" chimera-secret "$1" 2>/dev/null || true; }
cf_token="${CLOUDFLARE_API_TOKEN:-}"
cf_account="${CLOUDFLARE_ACCOUNT_ID:-}"
[ -n "$cf_token" ] || cf_token="$(secret CLOUDFLARE_API_TOKEN)"
[ -n "$cf_account" ] || cf_account="$(secret CLOUDFLARE_ACCOUNT_ID)"

# Endpoint and reference names only; secret values remain in the runtime environment.
bridge="${GOONBRIDGE_URL:-${CHIMERA_URL:-$(bridge_value url)}}"
[ -n "$bridge" ] || { say "no bridge URL: set CHIMERA_URL (or GOONBRIDGE_URL), or download this script from your bridge"; exit 1; }
bridge_token_env="$(bridge_value token_env)"
bridge_token="${GOONBRIDGE_TOKEN:-${CHIMERA_TOKEN:-$(printenv "$bridge_token_env" 2>/dev/null || true)}}"
# Approvers: a comma-separated env override, else bridge.json/defaults `approvers` (or the old single `approver`).
bridge_approvers="${GOONBRIDGE_APPROVERS:-${CHIMERA_APPROVERS:-${GOONBRIDGE_APPROVER:-${CHIMERA_APPROVER:-}}}}"
bridge_session_header="$(bridge_value session_header)"
bridge_context_header="$(bridge_value context_header)"
if has jq; then
  mkdir -p "$(dirname "$bridge_config")"
  existing=$(cat "$bridge_config" 2>/dev/null || printf '{}')
  printf '%s' "$existing" | jq -e 'type == "object"' >/dev/null 2>&1 || existing='{}'
  jq -n --argjson defaults "$bridge_defaults" --argjson existing "$existing" \
    --arg url "$bridge" --arg token_env "$bridge_token_env" --arg approvers "$bridge_approvers" \
    --arg session_header "$bridge_session_header" --arg context_header "$bridge_context_header" '
    ($defaults + $existing) as $base
    | (if $approvers != "" then ($approvers | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "")))
       else ($base.approvers // (if $base.approver then [$base.approver] else [] end)) end) as $approver_list
    | $base + {url: $url, token_env: $token_env, approvers: $approver_list, session_header: $session_header, context_header: $context_header}
    | {url, token_env, approvers, session_header, context_header, product_name, env_prefix, connector_name,
       launchd_label, responder_name, cloud_config_ref, state_dir_name, protected_branches, enabled_hooks, external_skills, branch_prefix}' > "$bridge_config.tmp"
  mv "$bridge_config.tmp" "$bridge_config"
fi

# Values for later shells: a file every shell sources, named after the product.
product="$(bridge_value product_name | tr -cd 'A-Za-z0-9._-')"
envfile="$HOME/.config/${product:-chimera}/env"
mkdir -p "$(dirname "$envfile")"; chmod 700 "$(dirname "$envfile")"
umask 077
{
  quoted_bridge=$(printf '%s' "$bridge" | sed "s/'/'\"'\"'/g")
  printf "export GOONBRIDGE_URL='%s'\n" "$quoted_bridge"
  [ -n "$cf_token" ] && [ "$cf_token" != PENDING ] && echo "export CLOUDFLARE_API_TOKEN='$cf_token'"
  [ -n "$cf_account" ] && echo "export CLOUDFLARE_ACCOUNT_ID='$cf_account'"
} > "$envfile"
for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"; do
  grep -qsF "$envfile" "$rc" || printf '\n[ -f "%s" ] && . "%s"\n' "$envfile" "$envfile" >> "$rc"
done

# Claude Code bundle (settings fragment, hooks, VERSION) from the deployment's private cloud config repo. The bridge serves it
# (GET /v1/cloud-config; the Worker holds the read-only GitHub token), so this session never holds a GitHub credential.
# Installed at user scope: hooks copied to ~/.claude/hooks, the settings fragment merged into ~/.claude/settings.json
# (what the previous bundle added is taken out first, everything else stays). The working repo is never touched.
# ~/.claude/cloud-config.json records the install; next boot an intact, unchanged install is one 304.
# CLOUD_CONFIG_REF=<branch> installs a branch of the config repo instead of main, to try a change before merging it.
claude_dir="$HOME/.claude"
record="$claude_dir/cloud-config.json"

# Every installed hook file still has its recorded sha256, and the settings still hold every entry the bundle added.
config_intact() {
  [ -s "$record" ] && [ -s "$settings" ] || return 1
  jq -r '.installed // {} | to_entries[] | "\(.value)  \(.key)"' "$record" | sha256sum -c --status - 2>/dev/null || return 1
  jq -e -n --slurpfile rec "$record" --slurpfile cur "$settings" '
    $rec[0].settings as $f | $cur[0] as $c
    | ([($f.permissions // {}) | to_entries[] | .key as $k | .value[] | . as $v | any(($c.permissions[$k] // [])[]; . == $v)] | all)
      and ([($f.hooks // {}) | to_entries[] | .key as $e | .value[] | . as $h | any(($c.hooks[$e] // [])[]; . == $h)] | all)' >/dev/null 2>&1
}

cloud_config() {
  [ -n "${bridge_token:-}" ] || { say "cloud-config: no ${bridge_token_env:-bridge token}, skipped"; return 0; }
  has jq || { say "cloud-config: no jq, skipped"; return 0; }
  mkdir -p "$claude_dir/hooks"
  [ -s "$settings" ] || echo '{}' > "$settings"
  # The approval hook is bridge-agnostic: this says which bridge it asks and who approves.
  # bridge.json was written above, even when the config-bundle download is skipped.
  have="$(jq -r '.version // empty' "$record" 2>/dev/null || true)"
  work="$(mktemp -d)"
  set -- -sS -m 20 -o "$work/body" -w '%{http_code}' -H "Authorization: Bearer $bridge_token"
  config_intact && set -- "$@" -H "If-None-Match: \"$(jq -r .commit "$record")\""
  config_ref="$(bridge_value cloud_config_ref)"
  case "$config_ref" in ""|main) config_ref="${CLOUD_CONFIG_REF:-main}" ;; esac
  code="$(curl "$@" "$bridge/v1/cloud-config?ref=${config_ref}" 2>"$work/err")" || code=000
  if [ "$code" = 304 ]; then say "cloud-config v$have ok (unchanged)"; rm -rf "$work"; return 0; fi
  if [ "$code" != 200 ]; then
    why="$(jq -r '.error // empty' "$work/body" 2>/dev/null || true)"
    say "cloud-config: kept v${have:-none} (HTTP $code${why:+: $why}$( [ "$code" = 000 ] && printf ': %s' "$(head -c 200 "$work/err")"))"
    rm -rf "$work"; return 0
  fi
  # Stage every file this installs and check it against the manifest before anything in ~/.claude changes.
  mkdir -p "$work/stage/hooks"
  for p in settings.json $(jq -r '.files | keys[] | select(startswith("hooks/") or . == "cloud-agents.md")' "$work/body"); do
    case "$p" in settings.json|cloud-agents.md|hooks/*) ;; *) continue ;; esac
    printf '%s' "$p" | grep -Eq '^(settings\.json|cloud-agents\.md|hooks/[A-Za-z0-9._-]+)$' || { say "cloud-config FAILED: bad path $p; kept v${have:-none}"; rm -rf "$work"; return 0; }
    jq -j --arg p "$p" '.files[$p] // empty' "$work/body" > "$work/stage/$p"
    want="$(jq -r --arg p "$p" '.sha256[$p] // empty' "$work/body")"
    got="$(sha256sum "$work/stage/$p" | cut -d' ' -f1)"
    [ -n "$want" ] && [ "$got" = "$want" ] || { say "cloud-config FAILED: $p does not match its sha256; kept v${have:-none}"; rm -rf "$work"; return 0; }
  done
  [ -s "$work/stage/settings.json" ] && jq -e 'type == "object"' "$work/stage/settings.json" >/dev/null 2>&1 \
    || { say "cloud-config FAILED: the bundle has no settings.json object; kept v${have:-none}"; rm -rf "$work"; return 0; }
  # Merge: take out what the previous bundle added, then add this one. Hook entries are replaced whole.
  jq -n '{}' > "$work/old.json"
  [ -s "$record" ] && jq '.settings // {}' "$record" > "$work/old.json" 2>/dev/null || true
  if ! jq --slurpfile f "$work/stage/settings.json" --slurpfile o "$work/old.json" '
      $f[0] as $f | $o[0] as $o
      | .permissions = (reduce ((($f.permissions // {}) + ($o.permissions // {})) | keys[]) as $k ((.permissions // {});
          .[$k] = ((((.[$k] // []) - ($o.permissions[$k] // [])) + ($f.permissions[$k] // [])) | unique)))
      | .hooks = (reduce ((($f.hooks // {}) + ($o.hooks // {})) | keys[]) as $e ((.hooks // {});
          .[$e] = (((.[$e] // []) - ($o.hooks[$e] // [])) + ($f.hooks[$e] // []))) | with_entries(select(.value | length > 0)))
      | if .hooks == {} then del(.hooks) else . end' "$settings" > "$work/settings.json"; then
    say "cloud-config FAILED: $settings is not valid JSON; kept v${have:-none}"; rm -rf "$work"; return 0
  fi
  for f in "$work"/stage/hooks/*; do [ -e "$f" ] && cp "$f" "$claude_dir/hooks/" && chmod 755 "$claude_dir/hooks/$(basename "$f")"; done
  [ -e "$work/stage/cloud-agents.md" ] && cp "$work/stage/cloud-agents.md" "$claude_dir/cloud-agents.md"
  mv "$work/settings.json" "$settings"
  installed="$( { for f in "$work"/stage/hooks/*; do [ -e "$f" ] && printf '%s\t%s\n' "$claude_dir/hooks/$(basename "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"; done
      [ -e "$work/stage/cloud-agents.md" ] && printf '%s\t%s\n' "$claude_dir/cloud-agents.md" "$(sha256sum "$work/stage/cloud-agents.md" | cut -d' ' -f1)"; true; } \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add // {}')"
  jq --argjson installed "$installed" --slurpfile s "$work/stage/settings.json" \
    '{repo, ref, commit, version, installed: $installed, settings: $s[0], at: (now | todate)}' "$work/body" > "$record"
  rm -rf "$work"
  if config_intact; then say "cloud-config v$(jq -r .version "$record") ok ($(jq -r '.commit[0:7]' "$record"), was v${have:-none})"
  else say "cloud-config v$(jq -r .version "$record") FAILED: installed files do not verify"; fi
}
cloud_config

# The entry point: user-level CLAUDE.md loads in every session, so it carries only pointers (the boot file, then
# bridge_help for bridge mechanics). Rewritten between its markers on every run; the user's own lines stay.
pointer_block() {
  [ -s "$claude_dir/cloud-agents.md" ] || return 0
  md="$claude_dir/CLAUDE.md"
  marker="$(bridge_value connector_name)"
  marker="${marker:-chimera}-cloud"
  { [ -f "$md" ] && awk -v begin="<!-- $marker:begin" -v end="<!-- $marker:end" 'index($0,begin)==1{skip=1} !skip{print} index($0,end)==1{skip=0}' "$md"; true; } > "$md.new"
  { cat "$md.new"
    printf '%s\n' "<!-- $marker:begin (managed by cloud-setup.sh) -->" \
      'Cloud session: read ~/.claude/cloud-agents.md for the boot sequence; bridge mechanics: call bridge_help.' \
      "<!-- $marker:end -->"; } > "$md"
  rm -f "$md.new"
}
pointer_block

if [ -n "$cf_token" ] && [ "$cf_token" != PENDING ]; then say "Cloudflare token present for account ${cf_account:-?}"; else say "no Cloudflare token: set CLOUDFLARE_API_TOKEN in the environment"; fi
[ -n "${bridge_token:-}" ] && say "${bridge_token_env:-bridge token} set (.mcp.json sends it to $bridge)" || say "${bridge_token_env:-the bridge token} is not set: the bridge will not connect"
say "done; values are in $envfile, sourced by new shells (or run: . $envfile)"
