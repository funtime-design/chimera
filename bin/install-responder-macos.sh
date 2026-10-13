#!/bin/sh
# Installs (or with --uninstall removes) the bridge responder as a launchd LaunchAgent for this user.
# Sign the device in first: node bin/goonbridge-responder.mjs login --device <person>-<label>
set -eu

bridge_defaults='{}' # supplied by the Worker
script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ "$bridge_defaults" = '{}' ] && [ -f "$script_dir/client-defaults.mjs" ]; then
  bridge_defaults="$(node "$script_dir/client-defaults.mjs")"
fi
bridge_config="${BRIDGE_CONFIG:-$HOME/.claude/bridge.json}"
bridge_value() {
  node -e 'try { let c = JSON.parse(process.argv[3]); try { c = {...c, ...JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))}; } catch {} const v = c[process.argv[2]]; if (typeof v === "string") process.stdout.write(v); } catch {}' "$bridge_config" "$1" "$bridge_defaults" 2>/dev/null || true
}
label="${GOONBRIDGE_LAUNCHD_LABEL:-${CHIMERA_LAUNCHD_LABEL:-$(bridge_value launchd_label)}}"
: "${label:?deployment launchd label missing; download the installer from your bridge}"
state_name="$(bridge_value state_dir_name)"
: "${state_name:?deployment state directory missing}"
responder_name="$(bridge_value responder_name)"
: "${responder_name:?deployment responder filename missing}"
plist="$HOME/Library/LaunchAgents/$label.plist"
state="${GOONBRIDGE_STATE_DIR:-${CHIMERA_STATE_DIR:-$HOME/$state_name}}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed $label. $state (grant, log) is left in place."
  exit 0
fi

url="${GOONBRIDGE_URL:-${CHIMERA_URL:-$(bridge_value url)}}"
: "${url:?deployment URL missing}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
node_bin="$(command -v node || true)"
claude_bin="${GOONBRIDGE_CLAUDE_BIN:-$(command -v claude || true)}"
git_bin="$(command -v git || echo /usr/bin/git)"
[ -n "$node_bin" ] || { echo "node not found on PATH; install Node 22 or newer" >&2; exit 1; }
[ -n "$claude_bin" ] || { echo "claude not found on PATH; install Claude Code and sign in" >&2; exit 1; }
[ -f "$script_dir/$responder_name" ] || { echo "missing $script_dir/$responder_name" >&2; exit 1; }
[ -s "$state/grant.json" ] || { echo "sign this Mac in first: node $script_dir/$responder_name login --device <person>-<label>" >&2; exit 1; }
chmod 700 "$state"
chmod 600 "$state/grant.json"
# The daemon runs its own copy, so a branch switch in the checkout never swaps the file under it.
responder="$state/$responder_name"
cp "$script_dir/$responder_name" "$responder"
# launchd's first argument is what System Settings > Login Items shows, so the daemon starts through a tiny executable
# named after the product (product_name) rather than "node" (which would list as "node", like every bash -c agent lists as "bash").
launcher_name="$(bridge_value product_name | tr -cd 'A-Za-z0-9._-')"
launcher="$state/${launcher_name:-chimera}"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$node_bin" "$responder" > "$launcher"
chmod 755 "$launcher"

path="$(dirname "$node_bin"):$(dirname "$claude_bin"):$(dirname "$git_bin"):/usr/bin:/bin:/usr/sbin:/sbin"
repos_root="${GOONBRIDGE_REPOS_ROOT:-$HOME/Repo}"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
env_entry() { printf '    <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"; }

mkdir -p "$(dirname "$plist")"
{
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$launcher")</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$HOME")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$state/responder.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$state/responder.out.log")</string>
  <key>EnvironmentVariables</key>
  <dict>
PLIST
  env_entry PATH "$path"
  env_entry HOME "$HOME"
  env_entry GOONBRIDGE_URL "$url"
  env_entry GOONBRIDGE_REPOS_ROOT "$repos_root"
  env_entry GOONBRIDGE_CLAUDE_BIN "$claude_bin"
  env_entry GOONBRIDGE_STATE_DIR "$state"
  if [ -n "${GOONBRIDGE_DEFAULT_REPO:-}" ]; then env_entry GOONBRIDGE_DEFAULT_REPO "$GOONBRIDGE_DEFAULT_REPO"; fi
  if [ -n "${GOONBRIDGE_RESPONDER_MODEL:-}" ]; then env_entry GOONBRIDGE_RESPONDER_MODEL "$GOONBRIDGE_RESPONDER_MODEL"; fi
  if [ -n "${GOONBRIDGE_RESPONDER_TIMEOUT_SECONDS:-}" ]; then env_entry GOONBRIDGE_RESPONDER_TIMEOUT_SECONDS "$GOONBRIDGE_RESPONDER_TIMEOUT_SECONDS"; fi
  cat <<PLIST
  </dict>
</dict>
</plist>
PLIST
} > "$plist"
chmod 644 "$plist"

# bootout returns before the job is gone; bootstrap right after it fails with I/O error 5.
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
  sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed $label. Log: $state/responder.log"
