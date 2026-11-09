import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CLICK_EFFECTS, INK_CHOICES, INTERACT_KEYS, LASER, SHAPES, TAP_SOUNDS, loadHands} from './lib/hands.js';

/** A combo row bound to a string setting; items are [id, title] pairs. */
function comboRow(settings, key, title, subtitle, items) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(items.map(i => i[1]))});
    const sync = () => {
        const i = items.findIndex(item => item[0] === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    row.connect('notify::selected', () => {
        const value = items[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step, digits) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function shortcutRow(settings, key, title) {
    const label = () => settings.get_strv(key).map(accel => {
        const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
        return ok ? Gtk.accelerator_get_label(keyval, mods) : accel;
    }).join(', ') || 'Disabled';
    const row = new Adw.ActionRow({title, subtitle: label()});
    const id = settings.connect(`changed::${key}`, () => {
        row.subtitle = label();
    });
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

export default class TinyHandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        const hands = [...loadHands(this.path), LASER];
        const page = new Adw.PreferencesPage();
        window.add(page);

        const pointer = new Adw.PreferencesGroup({title: 'Pointer'});
        pointer.add(comboRow(s, 'pointer-style', 'Hand', null, hands.map(h => [h.id, h.title])));
        pointer.add(spinRow(s, 'pointer-size', 'Size', 'Hand length as a share of the screen height',
            0.08, 0.20, 0.01, 2));
        pointer.add(switchRow(s, 'show-shadow', 'Shadow', 'Turn off if the hand feels slow in a VM'));
        page.add(pointer);

        const drawing = new Adw.PreferencesGroup({title: 'Drawing'});
        drawing.add(comboRow(s, 'draw-shape', 'Drag to draw', 'Hold Shift for circles, squares and straight arrows',
            SHAPES));
        drawing.add(spinRow(s, 'fade-seconds', 'Fade after', 'Seconds; 0 keeps drawings until you clear them',
            0, 60, 0.5, 1));
        drawing.add(comboRow(s, 'ink-choice', 'Ink colour', null, INK_CHOICES.map(c => [c.id, c.title])));
        drawing.add(comboRow(s, 'double-click-effect', 'Double-click effect', 'Uses the ink colour',
            CLICK_EFFECTS));
        page.add(drawing);

        const sound = new Adw.PreferencesGroup({
            title: 'Sound',
            description: 'Uses GNOME event sounds; turn on Settings › Sound › Alert Sound if you hear nothing.',
        });
        sound.add(comboRow(s, 'tap-sound', 'Tap sound', null, TAP_SOUNDS));
        sound.add(switchRow(s, 'hand-sound', 'Sound with hands', null));
        sound.add(switchRow(s, 'laser-sound', 'Sound with the laser dot', null));
        page.add(sound);

        const controls = new Adw.PreferencesGroup({
            title: 'Controls',
            description: 'Change shortcuts with: gsettings --schemadir ~/.local/share/gnome-shell/extensions/' +
                `${this.uuid}/schemas set org.gnome.shell.extensions.tinyhand toggle-pointer "['<Control><Alt>h']"`,
        });
        controls.add(comboRow(s, 'interact-key', 'Click-through key', 'Hold it to click apps for real',
            INTERACT_KEYS));
        controls.add(shortcutRow(s, 'toggle-pointer', 'Turn the pointer on or off'));
        controls.add(shortcutRow(s, 'clear-ink', 'Clear the drawing'));
        controls.add(shortcutRow(s, 'exit-pointer', 'Clear everything and turn off'));
        page.add(controls);
    }
}
