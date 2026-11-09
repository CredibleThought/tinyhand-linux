# TinyHand for GNOME

A tiny hand on a stick that points at things on your screen. This is a port of
[TinyHand for macOS](https://github.com/nilbuild/tinyhand) to a GNOME Shell
extension, so it works on Ubuntu's default Wayland session.

Supports GNOME Shell 46 to 50 (Ubuntu 24.04 to 26.04), on x86-64 and ARM64 —
including Ubuntu running in Parallels on an Apple Silicon Mac.

## Why an extension?

On GNOME Wayland, a normal app can't draw above every window, follow the
pointer across the screen or stop clicks reaching the app underneath. Only
code running inside GNOME Shell can, so TinyHand runs there.

## Install

On the Ubuntu machine:

```bash
sudo apt install gnome-shell-extension-prefs make zip
git clone <this repo> tinyhand-linux && cd tinyhand-linux
make install
```

Log out and back in (Wayland only loads new extensions at login), then:

```bash
make enable
```

A hand icon appears in the top bar.

## Use

| | |
|---|---|
| Click the top-bar icon, or **Ctrl+Alt+H** | Turn the pointer on or off |
| Right-click the top-bar icon | Menu: pick a hand, mute, clear, settings |
| Click | Tap (nothing underneath gets clicked) |
| Hold and drag | Draw the current shape: ellipse, rectangle, arrow or freehand pen |
| Hold **Shift** while dragging | Circle, square, or an arrow snapped to 45° |
| Hold **Alt** and click | Click the app underneath for real |
| **Ctrl+Alt+X** | Clear the drawing |
| **Esc** | Clear everything and turn the pointer off |
| Top-bar menu › **Quit TinyHand** | Turn the extension off and remove its icon (turn it back on in the Extensions app, or with `make enable`) |

While the pointer is on, move to the bottom of the screen to show the toolbar.
It has your pinned hands, a grid of all 36 hands and the laser dot, the shape
to draw, ink colour, sound and exit. The top bar stays clickable.

Settings (size, shadow, shape, fade time, ink colour, tap sound, click-through key)
are in the Extensions app, or from the top-bar menu.

## Differences from the macOS app

- **Scrolling** is blocked while the pointer is on. Hold Alt to scroll an app.
- **Shapes** are new: the macOS app only draws freehand.
- **Sound** uses GNOME's event sounds. If taps are silent, turn on
  *Settings › Sound › Alert Sound*.
- **Shortcuts** can only be changed with `gsettings` for now. The command is
  shown in the extension's settings.
- Not ported yet: custom hand images, the welcome window, launch at login (not
  needed: extensions start with the session) and self-update.

## Testing safely

A bug in an extension can crash GNOME Shell, and on Wayland that logs you out.
Test changes in a nested shell that runs in a window:

```bash
make nested
```

On GNOME 49 and later (Ubuntu 26.04) nested mode uses mutter's devkit viewer,
which may be in a separate package (`apt search mutter-dev`).
Shell errors show in the terminal, or with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Development

- `extension/extension.js` — controller, top-bar indicator, input and shortcuts
- `extension/lib/arm.js` — hand-on-a-stick geometry and the laser dot
- `extension/lib/ink.js` — drawing and fading
- `extension/lib/toolbar.js` — the bottom toolbar and its trays
- `extension/prefs.js` — settings window
- `tools/prepare-assets.py` — builds `extension/assets` from an upstream
  TinyHand checkout: slices each hand into hand and rod images, measures the
  geometry into `hands.json` and makes toolbar thumbnails

```bash
make assets UPSTREAM=../tinyhand   # regenerate assets (needs python3-pil)
make lint                          # eslint (needs node)
make pack                          # build dist/*.zip
```

## License

MIT. See [LICENSE](LICENSE). Hand images, sounds and icons are from the
original TinyHand.
