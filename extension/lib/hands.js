// Shared catalogue data. Imported by both the shell side and prefs.js, so it
// must only depend on GLib/Gio.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const RED = '#FF291F';

export const LASER = Object.freeze({id: 'laser', title: 'Laser dot', ink: RED});

export const INK_CHOICES = [
    {id: 'match', title: 'Match the pointer', color: null},
    {id: 'red', title: 'Red', color: RED},
    {id: 'orange', title: 'Orange', color: '#FF8A00'},
    {id: 'yellow', title: 'Yellow', color: '#FFCC00'},
    {id: 'green', title: 'Green', color: '#30C25A'},
    {id: 'blue', title: 'Blue', color: '#0A84FF'},
    {id: 'purple', title: 'Purple', color: '#8754F2'},
    {id: 'white', title: 'White', color: '#FFFFFF'},
    {id: 'black', title: 'Black', color: '#1D1D21'},
];

export const TAP_SOUNDS = [
    ['thock', 'Thock'],
    ['click', 'Click'],
    ['pop', 'Pop'],
    ['wood', 'Wood block'],
    ['boop', 'Boop'],
    ['squeak', 'Squeak'],
];

export const SHAPES = [
    ['pen', 'Pen'],
    ['ellipse', 'Ellipse'],
    ['rectangle', 'Rectangle'],
    ['arrow', 'Arrow'],
];

export const CLICK_EFFECTS = [
    ['glow', 'Glow'],
    ['sparkle', 'Sparkle burst'],
    ['off', 'Off'],
];

export const INTERACT_KEYS = [
    ['alt', 'Alt'],
    ['super', 'Super'],
    ['ctrl', 'Ctrl'],
    ['off', 'Off'],
];

/** Reads assets/hands.json, written by tools/prepare-assets.py. */
export function loadHands(extensionDir) {
    const path = GLib.build_filenamev([extensionDir, 'assets', 'hands.json']);
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

export function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
