#!/bin/sh
. "$(dirname "$0")/bridge-config.sh"
[ "${1:-}" = stop ] || bridge_hook_enabled heartbeat-loop || exit 0
# In-run heartbeat for cloud sessions (T-49). The PostToolUse hook beats only between tool calls, so one tool call longer
# than the claim lease (a long build or test run) looked like a dead session. SessionStart runs `start`: a detached loop
# posts /v1/heartbeat?signal=process every GOONBRIDGE_HEARTBEAT_SECONDS (default 60). That is one signal of several: it
# says the process lives, not that the agent acts, so the bridge counts a session with only this signal as idle (it
# keeps its claims, but no task message is routed to it). The loop exits when Claude Code is gone, when the bridge
# answers 410 (killed), when wind-down.sh runs `stop`, or when no tool has finished for GOONBRIDGE_HEARTBEAT_IDLE_SECONDS
# (default 1800; the PostToolUse hook's stamp file), which bounds how long an idle session keeps its claims. One loop
# per session id; the pid file lives in $TMPDIR. Best effort and quiet: it never fails the session.
[ -n "${CLAUDE_CODE_REMOTE:-}" ] && [ -n "${bridge_token:-}" ] || [ "${1:-}" = stop ] || exit 0
[ "${1:-}" = stop ] || bridge_require_url
id="${CLAUDE_CODE_REMOTE_SESSION_ID:-session}"
pidfile="${TMPDIR:-/tmp}/${bridge_name}-heartbeat-loop-$id.pid"
stamp="${TMPDIR:-/tmp}/${bridge_name}-heartbeat-$id"
running() { [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }

case "${1:-}" in
  start)
    running && exit 0
    # The process to outlive: Claude Code, which ran this hook, possibly through a `sh -c` wrapper.
    owner=$PPID
    case "$(ps -o comm= -p "$owner" 2>/dev/null)" in
      *sh) owner=$(ps -o ppid= -p "$owner" | tr -d ' ') ;;
    esac
    nohup sh "$0" run "$owner" </dev/null >/dev/null 2>&1 &
    echo $! > "$pidfile"
    ;;
  run)
    owner=$2
    started=$(date +%s)
    context=$(basename "${CLAUDE_PROJECT_DIR:-$bridge_name}")
    while kill -0 "$owner" 2>/dev/null; do
      last=$(cat "$stamp" 2>/dev/null || echo "$started")
      [ $(($(date +%s) - last)) -lt "${GOONBRIDGE_HEARTBEAT_IDLE_SECONDS:-1800}" ] || break
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$bridge_url/v1/heartbeat?signal=process" \
        -H "Authorization: Bearer $bridge_token" \
        -H "${bridge_session_header}: ${CLAUDE_CODE_REMOTE_SESSION_ID:-}" \
        -H "${bridge_context_header}: $context" 2>/dev/null)
      [ "$code" = 410 ] && break
      sleep "${GOONBRIDGE_HEARTBEAT_SECONDS:-60}"
    done
    [ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] && rm -f "$pidfile"
    ;;
  stop)
    running && kill "$(cat "$pidfile")" 2>/dev/null
    rm -f "$pidfile"
    ;;
esac
exit 0
