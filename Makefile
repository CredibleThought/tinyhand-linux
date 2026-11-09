UUID := tinyhand@tinyhand-linux
UPSTREAM ?= ../tinyhand
DIST := dist
ZIP := $(DIST)/$(UUID).shell-extension.zip
SOURCES := $(shell find extension -type f ! -name '*.compiled')

.PHONY: all assets pack install uninstall enable disable nested lint clean

all: pack

# Regenerate extension/assets from an upstream TinyHand checkout (needs Pillow).
assets:
	python3 tools/prepare-assets.py $(UPSTREAM) extension

pack: $(ZIP)

$(ZIP): $(SOURCES)
	@mkdir -p $(DIST)
	@if command -v gnome-extensions >/dev/null; then \
		gnome-extensions pack extension --force --out-dir=$(DIST) \
			--extra-source=lib --extra-source=assets; \
	else \
		echo "gnome-extensions not found; zipping with compiled schemas skipped"; \
		rm -f $@ && cd extension && zip -qr ../$@ . -x '*.compiled'; \
	fi
	@echo "Built $@"

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Log out and back in (Wayland), then run: make enable"

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Run a nested GNOME Shell in a window to test without risking your session.
# GNOME 49+ (Ubuntu 26.04) needs the mutter-dev-bin package for --devkit.
nested: install
	@if gnome-shell --help 2>&1 | grep -q -- --devkit; then \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- gnome-shell --devkit --wayland; \
	else \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- gnome-shell --nested --wayland; \
	fi

lint:
	npm install --no-audit --no-fund && npm run lint

clean:
	rm -rf $(DIST)
