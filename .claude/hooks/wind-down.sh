#!/bin/sh
. "$(dirname "$0")/bridge-config.sh"
bridge_hook_enabled wind-down || exit 0
# SessionEnd hook for cloud sessions: stop the in-run heartbeat loop, then post "offline" for this session's own bridge
# name so the board and the Worker's liveness check stop treating a finished session as live. Best effort and quiet; a
# session killed without running SessionEnd (idle timeout) is covered by the Worker's lease instead.
sh "$(dirname "$0")/heartbeat-loop.sh" stop
[ -n "${CLAUDE_CODE_REMOTE:-}" ] && [ -n "${bridge_token:-}" ] || exit 0
bridge_require_url
curl -fsS --max-time 8 -X POST "$bridge_url/v1/status" \
  -H "Authorization: Bearer $bridge_token" \
  -H "${bridge_session_header}: ${CLAUDE_CODE_REMOTE_SESSION_ID:-}" \
  -H "${bridge_context_header}: $(basename "${CLAUDE_PROJECT_DIR:-$bridge_name}")" \
  -H "Content-Type: application/json" \
  -d '{"state":"offline","summary":"session ended"}' >/dev/null 2>&1 || true
exit 0
