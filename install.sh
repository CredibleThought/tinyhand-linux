#!/usr/bin/env bash
# Install or update TinyHand for GNOME from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/CredibleThought/tinyhand-linux/main/install.sh | bash
#
# To remove it:
#
#   curl -fsSL https://raw.githubusercontent.com/CredibleThought/tinyhand-linux/main/install.sh | bash -s -- --uninstall
#
# Set TINYHAND_ZIP to a local zip to install that instead of downloading.
#
# Everything is inside main(), so a partly downloaded script never runs.

main() {
    set -euo pipefail

    local uuid='tinyhand@tinyhand-linux'
    local url="https://github.com/CredibleThought/tinyhand-linux/releases/latest/download/${uuid}.shell-extension.zip"
    local min_gnome=46

    say() { printf '\033[1m%s\033[0m\n' "$*"; }
    fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

    [ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not with sudo."
    command -v gnome-extensions >/dev/null || fail "gnome-extensions not found. TinyHand needs the GNOME desktop."
    command -v gsettings >/dev/null || fail "gsettings not found."

    if [ "${1:-}" = "--uninstall" ]; then
        gnome-extensions uninstall "$uuid" 2>/dev/null || true
        remove_from_list enabled-extensions "$uuid"
        say "TinyHand removed. Log out and back in to clear it from the top bar."
        return
    fi

    local version
    version=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
    if [ -n "$version" ] && [ "$version" -lt "$min_gnome" ]; then
        fail "TinyHand needs GNOME ${min_gnome} or later (Ubuntu 24.04+). This system has GNOME ${version}."
    fi

    local tmp zip
    tmp=$(mktemp -d)
    # Expand $tmp now: it is local, so it is gone when the EXIT trap runs.
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT
    if [ -n "${TINYHAND_ZIP:-}" ]; then
        zip=$TINYHAND_ZIP
    else
        zip="$tmp/${uuid}.shell-extension.zip"
        say "Downloading TinyHand..."
        if command -v curl >/dev/null; then
            curl -fsSL -o "$zip" "$url"
        elif command -v wget >/dev/null; then
            wget -q -O "$zip" "$url"
        else
            fail "neither curl nor wget is installed."
        fi
    fi

    say "Installing..."
    gnome-extensions install --force "$zip"

    # GNOME only loads a new extension at the next login, so `gnome-extensions
    # enable` fails until then. Adding it to the enabled list works either way.
    gsettings set org.gnome.shell disable-user-extensions false
    remove_from_list disabled-extensions "$uuid"
    add_to_list enabled-extensions "$uuid"

    say "TinyHand is installed."
    echo "Log out and back in, then click the hand in the top bar or press Ctrl+Alt+H."
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

add_to_list() {
    if ! list_items "$1" | grep -qxF "$2"; then
        { list_items "$1"; echo "$2"; } | write_list "$1"
    fi
}

remove_from_list() {
    if list_items "$1" | grep -qxF "$2"; then
        { list_items "$1" | grep -vxF "$2" || true; } | write_list "$1"
    fi
}

main "$@"
