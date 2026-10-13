#!/bin/sh
. "$(dirname "$0")/bridge-config.sh"
bridge_hook_enabled heartbeat || exit 0
# PostToolUse hook for cloud sessions, the fallback to heartbeat-loop.sh: tell the bridge this session is alive, so the claim it holds stays fresh while
# it works through a long build or test and makes no bridge call. At most once a minute. Best effort and quiet: the
# Worker also counts every bridge call as a heartbeat, so a missed one costs nothing.
[ -n "${CLAUDE_CODE_REMOTE:-}" ] && [ -n "${bridge_token:-}" ] || exit 0
bridge_require_url
stamp="${TMPDIR:-/tmp}/${bridge_name}-heartbeat-${CLAUDE_CODE_REMOTE_SESSION_ID:-session}"
now=$(date +%s)
last=$(cat "$stamp" 2>/dev/null || echo 0)
[ $((now - last)) -ge 60 ] || exit 0
echo "$now" > "$stamp" 2>/dev/null || true
curl -fsS --max-time 5 -X POST "$bridge_url/v1/heartbeat" \
  -H "Authorization: Bearer $bridge_token" \
  -H "${bridge_session_header}: ${CLAUDE_CODE_REMOTE_SESSION_ID:-}" \
  -H "${bridge_context_header}: $(basename "${CLAUDE_PROJECT_DIR:-$bridge_name}")" >/dev/null 2>&1 || true
exit 0
