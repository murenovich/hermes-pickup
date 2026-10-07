#!/usr/bin/env bash
# Remove Hermes Pickup from ${HERMES_HOME:-$HOME/.hermes}. Deletes only the files install.sh put
# there and the plugins.enabled entry. Settings, consent and cached cards in $HERMES_HOME/pickup
# are kept (delete that folder yourself to forget them).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
. "$SRC_DIR/scripts/common.sh"

remove_file() { # path label
  if [ -f "$1" ]; then
    rm -f "$1"
    echo "  ✓ removed $2"
  fi
}

echo "→ Uninstalling Hermes Pickup from $HERMES_HOME"

# Config first: if it cannot be edited, stop with everything still installed and consistent.
if [ -f "$CONFIG" ]; then
  if ! edit_config disable; then
    echo "" >&2
    echo "✗ config.yaml was NOT changed and no files were removed. Remove '$PLUGIN_ID' from plugins.enabled" >&2
    echo "  by hand, then re-run ./uninstall.sh." >&2
    exit 2
  fi
else
  echo "  = no config.yaml; nothing to edit"
fi

# Profiles the installer enabled (bug #134712 workaround): undo exactly those edits, keyed by owner record.
if [ -d "$PROFILE_OWNERS_DIR" ]; then
  for owner in "$PROFILE_OWNERS_DIR"/*.json; do
    [ -f "$owner" ] || continue
    name="$(basename "$owner" .json)"
    cfg="$HERMES_HOME/profiles/$name/config.yaml"
    if [ ! -f "$cfg" ]; then
      rm -f "$owner"; echo "  = profile $name no longer exists"
      continue
    fi
    printf "  [%s] " "$name"
    if edit_config disable "$cfg" "$owner"; then
      rm -f "$owner"
    else
      echo "  ! could not edit profiles/$name/config.yaml (record kept, re-run later); or remove '$PLUGIN_ID' from its plugins.enabled by hand" >&2
    fi
  done
  rmdir "$PROFILE_OWNERS_DIR" 2>/dev/null || true
fi

remove_file "$DESKTOP_DEST/plugin.js" "desktop-plugins/$PLUGIN_ID/plugin.js"
remove_file "$OWNER_FILE" "plugins/$PLUGIN_ID/.config-owned.json"
while IFS='|' read -r _ dst; do
  remove_file "$PLUGIN_DEST/$dst" "plugins/$PLUGIN_ID/$dst"
done <<EOF
$PLUGIN_FILES
EOF
# Python writes bytecode next to the backend when Hermes imports it: remove only those .pyc files.
for cache in "$PLUGIN_DEST/dashboard/__pycache__" "$PLUGIN_DEST/__pycache__"; do
  if [ -d "$cache" ]; then
    for pyc in "$cache"/*.pyc; do
      if [ -f "$pyc" ]; then rm -f "$pyc"; fi
    done
    if rmdir "$cache" 2>/dev/null; then
      echo "  ✓ removed ${cache#"$HERMES_HOME"/} (bytecode cache)"
    else
      echo "  ! kept ${cache#"$HERMES_HOME"/} (contains files other than .pyc)"
    fi
  fi
done
rmdir "$PLUGIN_DEST/dashboard" "$PLUGIN_DEST" "$DESKTOP_DEST" 2>/dev/null || true

echo ""
if [ -d "$STATE_DIR" ]; then
  echo "Kept your data in $STATE_DIR (settings, consent, cached cards)."
fi
echo "Restart Hermes Desktop to unmount the backend."
