# Shared by install.sh and uninstall.sh (sourced, not run).

PLUGIN_ID="hermes-pickup"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CONFIG="$HERMES_HOME/config.yaml"
DESKTOP_DEST="$HERMES_HOME/desktop-plugins/$PLUGIN_ID"
PLUGIN_DEST="$HERMES_HOME/plugins/$PLUGIN_ID"
STATE_DIR="$HERMES_HOME/pickup"
# What install changed in config.yaml (just the edited span), so uninstall can undo exactly that.
OWNER_FILE="$PLUGIN_DEST/.config-owned.json"

case "$HERMES_HOME" in
  ""|"/") echo "Refusing to use HERMES_HOME='$HERMES_HOME'" >&2; exit 1 ;;
esac

# Source file -> destination, relative to the repo / plugin dir.
# (source|destination under $PLUGIN_DEST)
PLUGIN_FILES="plugin.yaml|plugin.yaml
__init__.py|__init__.py
LICENSE|LICENSE
dashboard/manifest.json|dashboard/manifest.json
dashboard/plugin_api.py|dashboard/plugin_api.py
core/pickup_core.py|dashboard/pickup_core.py"

# A python that can parse YAML: Hermes's own venv first, then whatever python3 has PyYAML.
find_python() {
  local p
  for p in "${HERMES_PYTHON:-}" "$HERMES_HOME/hermes-agent/venv/bin/python3" \
           "$HOME/.hermes/hermes-agent/venv/bin/python3" "$(command -v python3 || true)"; do
    if [ -n "$p" ] && [ -x "$p" ] && "$p" -I -c 'import yaml' >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# Edit plugins.enabled through the parser-backed helper. Prints its own change message.
edit_config() {
  local action="$1" py
  if ! py="$(find_python)"; then
    echo "  ✗ no python with PyYAML found (looked in Hermes's venv and PATH); config.yaml not touched." >&2
    echo "    ${action} '$PLUGIN_ID' in plugins.enabled of $CONFIG by hand, or set HERMES_PYTHON." >&2
    return 2
  fi
  "$py" -I "$SRC_DIR/scripts/config_edit.py" "$action" "$PLUGIN_ID" "${2:-$CONFIG}" "${3:-$OWNER_FILE}"
}

# Hermes bug #134712: the Desktop backend can drift to a named profile's config after startup and then
# 404 "Plugin not found" for a plugin enabled only in the default profile. Workaround: also enable the
# plugin in every profile. Each profile edit gets its own owner record so uninstall undoes exactly it.
PROFILE_OWNERS_DIR="$PLUGIN_DEST/.config-owned-profiles"

list_profile_configs() { # prints "<name>|<config path>" for each profile under $HERMES_HOME/profiles
  local cfg
  for cfg in "$HERMES_HOME"/profiles/*/config.yaml; do
    [ -f "$cfg" ] || continue
    echo "$(basename "$(dirname "$cfg")")|$cfg"
  done
}

warn_if_profile_home() {
  case "$HERMES_HOME" in
    */profiles/*)
      echo "  ! HERMES_HOME points at a profile folder ($HERMES_HOME), not your main Hermes." >&2
      echo "    This happens when you run the installer from a terminal inside Hermes. To install for" >&2
      echo "    your main Hermes, quit this (Ctrl-C) and run it from a normal Terminal, or set" >&2
      echo "    HERMES_HOME=\$HOME/.hermes. Continuing in 5 seconds." >&2
      sleep 5 ;;
  esac
}
