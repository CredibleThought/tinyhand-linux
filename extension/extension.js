// TinyHand for GNOME Shell.
//
// How it fits together while the pointer is on:
//  - `catcher` is an invisible, reactive actor over the monitor (below the
//    top bar). On Wayland, input over a reactive shell actor goes to the
//    shell instead of the window underneath, so clicks become taps and
//    nothing underneath gets clicked. Keyboard focus is untouched.
//  - The toolbar sits above the catcher as its own reactive chrome.
//  - `visual` holds the ink and the hand. It is not reactive and sits on top
//    of everything, so the hand is drawn over the top bar and the toolbar.
//  - The system cursor is hidden; a frame clock timeline polls the pointer
//    and aims the hand at it.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Arm} from './lib/arm.js';
import {Effects} from './lib/effects.js';
import {Ink} from './lib/ink.js';
import {Toolbar} from './lib/toolbar.js';
import {CLICK_EFFECTS, INK_CHOICES, LASER, SHAPES, loadHands} from './lib/hands.js';

const IDLE_AFTER_US = 500 * 1000;
const IDLE_POLL_MS = 50;
const DRAW_THRESHOLD = 4;
const REVEAL_ON_START_MS = 3000;
const REVEAL_ON_MONITOR_MS = 1500;
// After a scroll, how long the catcher stays out of the way so that the
// rest of the scroll gesture goes straight to the window underneath.
const SCROLL_PASS_MS = 600;
// How long to wait for the catcher to stop being picked before replaying.
const SCROLL_REPLAY_DELAY_MS = 20;
// A virtual device takes pointer-motion units: 10 per wheel step.
const SCROLL_UNITS_PER_STEP = 10;

// How far apart, in pixels, the two clicks of a double-click may land.
const DOUBLE_CLICK_DISTANCE = 12;

const BUTTONS_MASK = Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;

const INTERACT_MASKS = {
    alt: Clutter.ModifierType.MOD1_MASK,
    super: Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK,
    ctrl: Clutter.ModifierType.CONTROL_MASK,
    off: 0,
};

// GNOME 50 dropped X11 and with it the affectsInputRegion parameter; on
// older versions it keeps clicks on the actor in an X11 session.
function addReactiveChrome(actor) {
    try {
        Main.layoutManager.addTopChrome(actor, {affectsInputRegion: true});
    } catch {
        // addTopChrome() parents the actor before it rejects the parameter.
        actor.get_parent()?.remove_child(actor);
        Main.layoutManager.addTopChrome(actor);
    }
}

// Hides the system cursor while it is over TinyHand's own actors.
//
// GNOME 48+ lets each actor choose its cursor, so the catcher and toolbar
// just use an invisible one; apps and the top bar keep their own cursor.
// Hiding it globally with the cursor tracker instead stops clicks reaching
// the shell on GNOME 50, so that is only a fallback for older versions.
class CursorHider {
    constructor(actors) {
        this._hidden = false;
        this.perActor = typeof actors[0].set_cursor_type === 'function';
        if (this.perActor) {
            for (const actor of actors)
                actor.set_cursor_type(Clutter.CursorType.NONE);
            return;
        }
        this._tracker = global.backend.get_cursor_tracker();
    }

    set hidden(hidden) {
        if (this.perActor || hidden === this._hidden)
            return;
        this._hidden = hidden;
        // GNOME 47 replaced set_pointer_visible() with a counted inhibitor.
        if (this._tracker.inhibit_cursor_visibility) {
            if (hidden)
                this._tracker.inhibit_cursor_visibility();
            else
                this._tracker.uninhibit_cursor_visibility();
        } else {
            this._tracker.set_pointer_visible(!hidden);
        }
    }
}

class TapSound {
    constructor(assetsDir) {
        this._dir = assetsDir;
        this._player = global.display.get_sound_player();
        this.enabled = true;
        this.choice = 'thock';
    }

    play() {
        if (!this.enabled)
            return;
        const path = GLib.build_filenamev([this._dir, 'sounds', `tap_${this.choice}.wav`]);
        this._player.play_from_file(Gio.File.new_for_path(path), 'TinyHand tap', null);
    }
}

class Controller {
    constructor(extension, onActiveChanged) {
        this._ext = extension;
        this._onActiveChanged = onActiveChanged;
        this._settings = extension.getSettings();
        const assetsDir = GLib.build_filenamev([extension.path, 'assets']);
        this.hands = loadHands(extension.path);
        this._handsById = new Map(this.hands.map(h => [h.id, h]));

        this.active = false;
        this._monitor = null;
        this._down = null;
        this._normal = false;
        this._revealUntil = 0;
        this._lastTime = 0;
        this._lastPointer = null;
        this._stillSince = 0;
        this._idlePollId = 0;
        this._scrollPassUntil = 0;
        this._scrollDevice = null;
        this._scrollTimeouts = new Set();

        this._sound = new TapSound(assetsDir);
        this._arm = new Arm(assetsDir);
        this._ink = new Ink();
        this._effects = new Effects();
        this._lastClick = null;
        this._mouseSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'});

        this._visual = new Clutter.Actor({reactive: false, visible: false});
        this._visual.add_child(this._ink.actor);
        this._visual.add_child(this._effects.actor);
        this._visual.add_child(this._arm.actor);

        this._catcher = new St.Widget({reactive: true, visible: false});
        this._catcher.connect('button-press-event', (_a, event) => this._onPress(event));
        this._catcher.connect('button-release-event', () => this._onRelease());
        this._catcher.connect('motion-event', (_a, event) => {
            if (this._down)
                this._drag(...event.get_coords(), event.get_state());
            return Clutter.EVENT_PROPAGATE;
        });
        this._catcher.connect('scroll-event', (_a, event) => this._onScroll(event));

        this._toolbar = new Toolbar({
            hands: this.hands,
            assetsDir,
            onPick: id => this._settings.set_string('pointer-style', id),
            onInk: id => this._settings.set_string('ink-choice', id),
            onShape: id => this._settings.set_string('draw-shape', id),
            onToggleSound: () => this._settings.set_boolean(this._soundKey, !this._settings.get_boolean(this._soundKey)),
            onExit: () => this.deactivate(),
        });

        addReactiveChrome(this._catcher);
        for (const actor of this._toolbar.actors)
            addReactiveChrome(actor);
        this._cursor = new CursorHider([this._catcher, ...this._toolbar.actors]);
        Main.layoutManager.uiGroup.add_child(this._visual);

        this._timeline = new Clutter.Timeline({actor: this._visual, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this._monitor = null;
        });
        this._settingsId = this._settings.connect('changed', (_s, key) => this._applySetting(key));
        for (const key of ['pointer-style', 'pointer-size', 'show-shadow', 'tap-sound', 'pinned-styles', 'draw-shape'])
            this._applySetting(key);

        Main.wm.addKeybinding('toggle-pointer', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
        Main.wm.addKeybinding('clear-ink', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.clearInk());
    }

    get style() {
        const id = this._settings.get_string('pointer-style');
        return id === LASER.id || this._handsById.has(id) ? id : 'lavender';
    }

    get _soundKey() {
        return this.style === LASER.id ? 'laser-sound' : 'hand-sound';
    }

    get soundOn() {
        return this._settings.get_boolean(this._soundKey);
    }

    set soundOn(on) {
        this._settings.set_boolean(this._soundKey, on);
    }

    get clickEffect() {
        const id = this._settings.get_string('double-click-effect');
        return CLICK_EFFECTS.some(([e]) => e === id) ? id : 'glow';
    }

    get shape() {
        const id = this._settings.get_string('draw-shape');
        return SHAPES.some(([s]) => s === id) ? id : 'pen';
    }

    _inkColor() {
        const choice = INK_CHOICES.find(c => c.id === this._settings.get_string('ink-choice'));
        if (choice?.color)
            return choice.color;
        const id = this.style;
        return id === LASER.id ? LASER.ink : this._handsById.get(id).ink;
    }

    _applySetting(key) {
        switch (key) {
        case 'pointer-style': {
            const id = this.style;
            this._arm.setStyle(id === LASER.id ? null : this._handsById.get(id));
            this._toolbar.select(id);
            this._syncInk();
            this._syncSound();
            this._onActiveChanged?.();
            break;
        }
        case 'pointer-size':
            this._arm.sizeFrac = this._settings.get_double('pointer-size');
            break;
        case 'show-shadow':
            this._arm.showShadow = this._settings.get_boolean('show-shadow');
            break;
        case 'ink-choice':
            this._syncInk();
            break;
        case 'tap-sound':
            this._sound.choice = this._settings.get_string('tap-sound');
            break;
        case 'hand-sound':
        case 'laser-sound':
            this._syncSound();
            break;
        case 'double-click-effect':
            this._onActiveChanged?.();
            break;
        case 'draw-shape':
            this._toolbar.setShape(this.shape);
            this._onActiveChanged?.();
            break;
        case 'pinned-styles':
            this._toolbar.setPinned(this._settings.get_strv('pinned-styles'));
            break;
        }
        this._wake();
    }

    _syncInk() {
        this._toolbar.setInk(this._inkColor(), this._settings.get_string('ink-choice'));
    }

    _syncSound() {
        this._sound.enabled = this.soundOn;
        this._toolbar.setSoundOn(this.soundOn);
        this._onActiveChanged?.();
    }

    toggle() {
        if (this.active)
            this.deactivate();
        else
            this.activate();
    }

    activate() {
        if (this.active)
            return;
        this.active = true;
        this._monitor = null;
        this._normal = false;
        this._lastTime = 0;
        this._arm.reset();
        this._arm.pointerHidden = false;

        // Keep our layers on top of anything added since we started.
        const ui = Main.layoutManager.uiGroup;
        ui.set_child_above_sibling(this._catcher, null);
        for (const actor of this._toolbar.actors)
            ui.set_child_above_sibling(actor, null);
        ui.set_child_above_sibling(this._visual, null);

        this._visual.show();
        this._catcher.show();
        this._cursor.hidden = true;
        this._revealUntil = GLib.get_monotonic_time() + REVEAL_ON_START_MS * 1000;
        this._stillSince = GLib.get_monotonic_time();

        Main.wm.addKeybinding('exit-pointer', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this.deactivate());

        this._tick();
        this._timeline.start();
        this._showHintOnce();
        this._onActiveChanged?.();
    }

    deactivate() {
        if (!this.active)
            return;
        this.active = false;
        this._timeline.stop();
        this._stopIdlePoll();
        Main.wm.removeKeybinding('exit-pointer');

        this._down = null;
        this._arm.held = false;
        this._cancelScrollPass();
        this._lastClick = null;
        this._effects.clear();
        this._ink.clear();
        this._toolbar.hide();
        this._catcher.hide();
        this._visual.hide();
        this._cursor.hidden = false;
        this._onActiveChanged?.();
    }

    clearInk() {
        this._ink.clear();
    }

    _showHintOnce() {
        if (this._settings.get_boolean('hint-shown'))
            return;
        this._settings.set_boolean('hint-shown', true);
        const key = this._settings.get_string('interact-key');
        const parts = ['Click to tap', 'drag to draw'];
        if (key !== 'off')
            parts.push(`hold ${key[0].toUpperCase()}${key.slice(1)} to click for real`);
        parts.push('Esc to exit');
        Main.notify('TinyHand is on', `${parts.join(', ')}.`);
    }

    _monitorAt(x, y) {
        for (const m of Main.layoutManager.monitors) {
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return m;
        }
        return Main.layoutManager.primaryMonitor;
    }

    _useMonitor(m) {
        const moving = this._monitor !== null;
        this._monitor = m;
        if (moving) {
            this._release();
            this._revealUntil = GLib.get_monotonic_time() + REVEAL_ON_MONITOR_MS * 1000;
        }
        this._ink.clear();
        this._arm.reset();
        this._visual.set_position(m.x, m.y);
        this._visual.set_size(m.width, m.height);
        this._ink.setSize(m.width, m.height);

        // Leave the top bar usable, like the macOS menu bar.
        const panelBox = Main.layoutManager.panelBox;
        const top = m.index === Main.layoutManager.primaryIndex && panelBox.visible ? panelBox.height : 0;
        this._panelBottom = m.y + top;
        this._catcher.set_position(m.x, m.y + top);
        this._catcher.set_size(m.width, m.height - top);
        this._toolbar.place(m);
    }

    _onPress(event) {
        const [x, y] = event.get_coords();
        this._arm.press();
        this._arm.held = true;
        this._sound.play();
        this._toolbar.closeTrays();
        this._down = {x, y, button: event.get_button()};
        if (this._isDoubleClick(event, x, y))
            this._playClickEffect(x, y);
        this._wake();
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        this._release();
        this._wake();
        return Clutter.EVENT_STOP;
    }

    _isDoubleClick(event, x, y) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
            this._lastClick = null;
            return false;
        }
        const time = event.get_time();
        const last = this._lastClick;
        const double = last !== null &&
            time - last.time <= this._mouseSettings.get_int('double-click') &&
            Math.hypot(x - last.x, y - last.y) <= DOUBLE_CLICK_DISTANCE;
        // A third click starts a new pair rather than playing again.
        this._lastClick = double ? null : {time, x, y};
        return double;
    }

    _playClickEffect(x, y) {
        const m = this._monitor;
        const kind = this._settings.get_string('double-click-effect');
        if (!m || kind === 'off')
            return;
        this._effects.play(kind, x - m.x, y - m.y, this._inkColor(), m.height);
    }

    // Wayland has no way to pass an event on to the window underneath, so
    // step aside for a moment and replay the scroll with a virtual pointer.
    // Scrolls that follow within SCROLL_PASS_MS go to the window directly.
    _onScroll(event) {
        if (this._down || this._ink.isDrawing)
            return Clutter.EVENT_STOP;
        // Clutter pairs each scroll with an emulated one; replaying the real
        // one recreates both.
        if (event.get_flags() & Clutter.EventFlags.POINTER_EMULATED)
            return Clutter.EVENT_STOP;

        this._scrollPassUntil = GLib.get_monotonic_time() + SCROLL_PASS_MS * 1000;
        this._catcher.hide();
        this._wake();

        const direction = event.get_scroll_direction();
        const source = event.get_scroll_source();
        let replay;
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const finish = event.get_scroll_finish_flags();
            replay = dev => dev.notify_scroll_continuous(Clutter.CURRENT_TIME,
                dx * SCROLL_UNITS_PER_STEP, dy * SCROLL_UNITS_PER_STEP, source, finish);
        } else {
            replay = dev => dev.notify_discrete_scroll(Clutter.CURRENT_TIME, direction, source);
        }

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_REPLAY_DELAY_MS, () => {
            this._scrollTimeouts.delete(id);
            if (this.active) {
                this._scrollDevice ??= Clutter.get_default_backend().get_default_seat()
                    .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
                replay(this._scrollDevice);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._scrollTimeouts.add(id);
        return Clutter.EVENT_STOP;
    }

    _cancelScrollPass() {
        for (const id of this._scrollTimeouts)
            GLib.source_remove(id);
        this._scrollTimeouts.clear();
        this._scrollPassUntil = 0;
    }

    _release() {
        this._down = null;
        this._arm.held = false;
        this._ink.end(this._settings.get_double('fade-seconds'));
    }

    _drag(x, y, mods) {
        const down = this._down;
        const m = this._monitor;
        if (!down || !m || down.button !== Clutter.BUTTON_PRIMARY)
            return;
        if (!this._ink.isDrawing) {
            if (Math.hypot(x - down.x, y - down.y) < DRAW_THRESHOLD)
                return;
            const width = Math.max(3, m.height * 0.0055);
            this._ink.begin(down.x - m.x, down.y - m.y, width, this._inkColor(), this.shape);
        }
        // Shift makes circles, squares and 45° arrows.
        this._ink.extend(x - m.x, y - m.y, (mods & Clutter.ModifierType.SHIFT_MASK) !== 0);
    }

    _tick() {
        if (!this.active)
            return;
        const now = GLib.get_monotonic_time();
        const dt = this._lastTime ? Math.min(0.1, (now - this._lastTime) / 1e6) : 1 / 60;
        this._lastTime = now;

        const [px, py, mods] = global.get_pointer();
        const m = this._monitorAt(px, py);
        if (m !== this._monitor)
            this._useMonitor(m);

        const pointerKey = `${px},${py},${mods}`;
        if (pointerKey !== this._lastPointer) {
            this._lastPointer = pointerKey;
            this._stillSince = now;
        }

        const drawing = this._ink.isDrawing;
        const interactMask = INTERACT_MASKS[this._settings.get_string('interact-key')] ?? 0;
        const interacting = interactMask !== 0 && (mods & interactMask) !== 0;
        // A menu, dialog or other shell grab is active: show the real cursor.
        this._lastGrabbed = global.stage.get_grab_actor() !== null;
        const grabbed = this._lastGrabbed && !this._down;
        // Over the top bar the real cursor shows, so hide the hand there.
        const overPanel = this._cursor.perActor && py < this._panelBottom && !this._down;
        const normal = !drawing && (interacting || grabbed || overPanel);
        if (normal !== this._normal) {
            this._normal = normal;
            this._arm.pointerHidden = normal;
            this._cursor.hidden = !normal;
        }
        const scrolling = now < this._scrollPassUntil;
        this._catcher.visible = drawing || this._down !== null ||
            (!interacting && !scrolling && !Main.overview.visible);

        const near = this._toolbar.isNear(px, py);
        this._toolbar.setRevealed(!drawing && (near || now < this._revealUntil || this._toolbar.trayOpen));

        this._arm.aim(px - m.x, py - m.y, m.width, m.height, dt);

        if (this._down) {
            if ((mods & BUTTONS_MASK) === 0)
                this._release();
            else
                this._drag(px, py, mods);
        }

        const busy = this._down !== null || drawing || this._arm.isSettling || scrolling ||
            now - this._stillSince < IDLE_AFTER_US || now < this._revealUntil;
        if (!busy)
            this._goIdle();
    }

    // When nothing moves, stop the per-frame timeline so the compositor can
    // rest, and poll cheaply until the pointer or modifiers change.
    _goIdle() {
        this._timeline.stop();
        this._stopIdlePoll();
        this._idlePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDLE_POLL_MS, () => {
            const [px, py, mods] = global.get_pointer();
            const grabbed = global.stage.get_grab_actor() !== null;
            if (`${px},${py},${mods}` === this._lastPointer && grabbed === this._lastGrabbed)
                return GLib.SOURCE_CONTINUE;
            this._idlePollId = 0;
            this._wake();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopIdlePoll() {
        if (this._idlePollId) {
            GLib.source_remove(this._idlePollId);
            this._idlePollId = 0;
        }
    }

    _wake() {
        if (!this.active)
            return;
        this._stillSince = GLib.get_monotonic_time();
        this._stopIdlePoll();
        if (!this._timeline.is_playing()) {
            this._lastTime = 0;
            this._timeline.start();
        }
    }

    destroy() {
        this.deactivate();
        Main.wm.removeKeybinding('toggle-pointer');
        Main.wm.removeKeybinding('clear-ink');
        this._settings.disconnect(this._settingsId);
        Main.layoutManager.disconnect(this._monitorsId);
        this._timeline.stop();
        this._timeline = null;
        this._scrollDevice = null;
        Main.layoutManager.removeChrome(this._catcher);
        for (const actor of this._toolbar.actors)
            Main.layoutManager.removeChrome(actor);
        this._toolbar.destroy();
        this._catcher.destroy();
        this._arm.destroy();
        this._ink.destroy();
        this._effects.destroy();
        this._visual.destroy();
        this._settings = null;
    }
}

const Indicator = GObject.registerClass(
class TinyHandIndicator extends PanelMenu.Button {
    _init(extension, controller) {
        super._init(0.0, 'TinyHand');
        this._controller = controller;
        const icon = name => Gio.icon_new_for_string(
            GLib.build_filenamev([extension.path, 'assets', 'icons', `tinyhand-${name}-symbolic.svg`]));
        this._iconOn = icon('menubar-on');
        this._iconOff = icon('menubar-off');
        this._icon = new St.Icon({gicon: this._iconOff, style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._activeItem = new PopupMenu.PopupSwitchMenuItem('Pointer', false);
        this._activeItem.connect('toggled', (_item, on) => (on ? controller.activate() : controller.deactivate()));
        this.menu.addMenuItem(this._activeItem);
        this.menu.addAction('Clear drawing', () => controller.clearInk());

        this._styleMenu = new PopupMenu.PopupSubMenuMenuItem('Hand');
        this._styleItems = new Map();
        for (const {id, title} of [...controller.hands, LASER]) {
            const item = this._styleMenu.menu.addAction(title, () =>
                extension.getSettings().set_string('pointer-style', id));
            this._styleItems.set(id, item);
        }
        this.menu.addMenuItem(this._styleMenu);

        this._shapeMenu = new PopupMenu.PopupSubMenuMenuItem('Draw');
        this._shapeItems = new Map();
        for (const [id, title] of SHAPES) {
            const item = this._shapeMenu.menu.addAction(title, () =>
                extension.getSettings().set_string('draw-shape', id));
            this._shapeItems.set(id, item);
        }
        this.menu.addMenuItem(this._shapeMenu);

        this._effectMenu = new PopupMenu.PopupSubMenuMenuItem('Double-click');
        this._effectItems = new Map();
        for (const [id, title] of CLICK_EFFECTS) {
            const item = this._effectMenu.menu.addAction(title, () =>
                extension.getSettings().set_string('double-click-effect', id));
            this._effectItems.set(id, item);
        }
        this.menu.addMenuItem(this._effectMenu);

        this._soundItem = new PopupMenu.PopupSwitchMenuItem('Tap sound', controller.soundOn);
        this._soundItem.connect('toggled', (_item, on) => {
            controller.soundOn = on;
        });
        this.menu.addMenuItem(this._soundItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => extension.openPreferences());
        this.menu.addAction('Quit TinyHand', () => {
            Main.notify('TinyHand is off', 'Turn it back on in the Extensions app.');
            // Disabling destroys this menu, so let the click finish first.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                Main.extensionManager.disableExtension(extension.uuid);
                return GLib.SOURCE_REMOVE;
            });
        });
        this.sync();
    }

    // Left click toggles the pointer; any other click opens the menu.
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this.menu.close();
            this._controller.toggle();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    sync() {
        const c = this._controller;
        this._icon.gicon = c.active ? this._iconOn : this._iconOff;
        this._activeItem.setToggleState(c.active);
        this._soundItem.setToggleState(c.soundOn);
        const style = c.style;
        for (const [id, item] of this._styleItems)
            item.setOrnament(id === style ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        const current = id => (id === LASER.id ? LASER : c.hands.find(h => h.id === id));
        this._styleMenu.label.text = `Hand: ${current(style).title}`;
        const shape = c.shape;
        for (const [id, item] of this._shapeItems)
            item.setOrnament(id === shape ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this._shapeMenu.label.text = `Draw: ${SHAPES.find(([id]) => id === shape)[1]}`;
        const effect = c.clickEffect;
        for (const [id, item] of this._effectItems)
            item.setOrnament(id === effect ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this._effectMenu.label.text = `Double-click: ${CLICK_EFFECTS.find(([id]) => id === effect)[1]}`;
    }
});

export default class TinyHandExtension extends Extension {
    enable() {
        this._controller = new Controller(this, () => this._indicator?.sync());
        this._indicator = new Indicator(this, this._controller);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._controller?.destroy();
        this._controller = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
