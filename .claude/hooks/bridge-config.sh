#!/bin/sh
# Shared runtime settings; this file contains no credentials. Never eval a value from bridge.json.
bridge_config="${BRIDGE_CONFIG:-$HOME/.claude/bridge.json}"
bridge_value() { jq -r --arg key "$1" '.[$key] // empty' "$bridge_config" 2>/dev/null || true; }
bridge_url="${GOONBRIDGE_URL:-${CHIMERA_URL:-$(bridge_value url)}}"
# No personal default: a hook that needs the bridge and has no URL says so on stderr and does nothing.
bridge_require_url() {
  [ -n "$bridge_url" ] && return 0
  printf '%s\n' "bridge hook: no bridge URL; set CHIMERA_URL (or GOONBRIDGE_URL), or url in $bridge_config" >&2
  exit 0
}
bridge_token_env="$(bridge_value token_env)"
bridge_token_env="${bridge_token_env:-GOONBRIDGE_TOKEN}"
bridge_token="${GOONBRIDGE_TOKEN:-${CHIMERA_TOKEN:-$(printenv "$bridge_token_env" 2>/dev/null || true)}}"
bridge_session_header="${GOONBRIDGE_SESSION_HEADER:-${CHIMERA_SESSION_HEADER:-$(bridge_value session_header)}}"
bridge_session_header="${bridge_session_header:-Goonbridge-Session}"
bridge_context_header="${GOONBRIDGE_CONTEXT_HEADER:-${CHIMERA_CONTEXT_HEADER:-$(bridge_value context_header)}}"
bridge_context_header="${bridge_context_header:-Goonbridge-Context}"
bridge_name="$(bridge_value product_name)"
bridge_name="${bridge_name:-chimera}"
# Missing policy preserves old installations; an explicit empty list disables every hook.
bridge_hook_enabled() {
  [ ! -f "$bridge_config" ] && return 0
  jq -e --arg name "$1" 'if has("enabled_hooks") then (.enabled_hooks | index($name)) != null else true end' "$bridge_config" >/dev/null 2>&1
}
