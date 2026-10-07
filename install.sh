#!/usr/bin/env bash
# Install Hermes Pickup (desktop plugin + backend) into ${HERMES_HOME:-$HOME/.hermes}.
# Idempotent: files are copied only when their content differs, and config.yaml is only edited
# when the plugin is not already in plugins.enabled. Every change is printed.
#   HERMES_HOME=/tmp/x ./install.sh      # try it somewhere harmless
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
. "$SRC_DIR/scripts/common.sh"

copy_if_changed() { # src dst label
  local src="$1" dst="$2" label="$3"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "  = $label (unchanged)"
    return
  fi
  local verb="installed"; [ -f "$dst" ] && verb="updated"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  ✓ $verb $label"
}

echo "→ Installing Hermes Pickup into $HERMES_HOME"
warn_if_profile_home

# 1. Desktop UI (hot-reloads). Built in a separate step; skipped until the file exists.
if [ -f "$SRC_DIR/desktop/plugin.js" ]; then
  copy_if_changed "$SRC_DIR/desktop/plugin.js" "$DESKTOP_DEST/plugin.js" "desktop-plugins/$PLUGIN_ID/plugin.js"
else
  echo "  - desktop/plugin.js not present; desktop UI skipped"
fi

# 2. Backend + engine (mounted at the next Hermes Desktop restart)
while IFS='|' read -r src dst; do
  [ -f "$SRC_DIR/$src" ] || { echo "  ✗ missing $src in the package" >&2; exit 1; }
  copy_if_changed "$SRC_DIR/$src" "$PLUGIN_DEST/$dst" "plugins/$PLUGIN_ID/$dst"
done <<EOF
$PLUGIN_FILES
EOF

# 3. Enable in config.yaml (plugins.enabled)
if ! edit_config enable; then
  echo "" >&2
  echo "✗ Files above WERE copied into $HERMES_HOME, but config.yaml was NOT changed, so Hermes will not" >&2
  echo "  load Pickup yet. Enable it by hand (plugins.enabled) and re-run, or run ./uninstall.sh to remove the files." >&2
  exit 2
fi

# 4. Other profiles (workaround for Hermes bug #134712). Asked, never assumed:
#    PICKUP_ALL_PROFILES=1 enables in all without asking, =0 skips; otherwise ask on a terminal, skip if not.
profiles="$(list_profile_configs)"
if [ -n "$profiles" ]; then
  count="$(printf '%s\n' "$profiles" | wc -l | tr -d ' ')"
  echo ""
  echo "This Hermes has $count other profile(s). A known Hermes bug (#134712) can make Hermes Desktop look"
  echo "up plugins in one of them, so Pick up shows \"Plugin not found\" unless it is enabled there too."
  answer="${PICKUP_ALL_PROFILES:-}"
  if [ -z "$answer" ]; then
    if [ -t 0 ]; then
      printf "Also enable hermes-pickup in all %s profiles? Uninstall undoes it. [Y/n] " "$count"
      read -r reply || reply="n"
      case "$reply" in [nN]*) answer=0 ;; *) answer=1 ;; esac
    else
      answer=0
      echo "  - not a terminal: skipped. Re-run with PICKUP_ALL_PROFILES=1 to enable it in every profile."
    fi
  fi
  if [ "$answer" = "1" ]; then
    failed=0
    while IFS='|' read -r name cfg; do
      printf "  [%s] " "$name"
      if ! edit_config enable "$cfg" "$PROFILE_OWNERS_DIR/$name.json"; then
        failed=$((failed + 1))
        echo "  ! could not edit profiles/$name/config.yaml; left unchanged" >&2
      fi
    done <<EOF
$profiles
EOF
    [ "$failed" -eq 0 ] || echo "  ! $failed profile(s) not changed; see above." >&2
  elif [ "$answer" = "0" ]; then
    echo "  - left other profiles unchanged."
  fi
fi

echo ""
echo "Done. Restart Hermes Desktop once so the backend mounts (quit with ⌘Q and reopen)."
echo "Pickup makes no model call until you give consent in the plugin."
echo "Its settings and cards live in $STATE_DIR (kept on uninstall)."
