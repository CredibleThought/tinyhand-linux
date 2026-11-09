#!/usr/bin/env bash
# Remove TinyHand for GNOME and its saved settings.
#
#   curl -fsSL https://raw.githubusercontent.com/CredibleThought/tinyhand-linux/main/uninstall.sh | bash
#
# Everything is inside main(), so a partly downloaded script never runs.

main() {
    set -euo pipefail

    local uuid='tinyhand@tinyhand-linux'
    local settings_path='/org/gnome/shell/extensions/tinyhand/'

    say() { printf '\033[1m%s\033[0m\n' "$*"; }
    fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

    [ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not with sudo."
    command -v gsettings >/dev/null || fail "gsettings not found."

    # Removes the files and, in a running session, unloads it straight away.
    if command -v gnome-extensions >/dev/null; then
        gnome-extensions uninstall "$uuid" 2>/dev/null || true
    fi
    # In case the shell was not running to do it.
    rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

    remove_from_list enabled-extensions "$uuid"
    remove_from_list disabled-extensions "$uuid"

    if command -v dconf >/dev/null; then
        dconf reset -f "$settings_path"
    else
        echo "dconf not found; TinyHand's saved settings were left in place."
    fi

    say "TinyHand is removed."
    echo "If the hand icon is still in the top bar, log out and back in."
}

# Prints a gsettings string list one item per line.
list_items() {
    gsettings get org.gnome.shell "$1" | sed -e 's/^@as //' -e "s/[][',]/ /g" | tr ' ' '\n' | grep -v '^$' || true
}

# Writes lines from stdin back as a gsettings string list.
write_list() {
    local items
    items=$(sed "s/.*/'&'/" | paste -sd, -)
    gsettings set org.gnome.shell "$1" "[$items]"
}

remove_from_list() {
    if list_items "$1" | grep -qxF "$2"; then
        { list_items "$1" | grep -vxF "$2" || true; } | write_list "$1"
    fi
}

main "$@"
