// The floating toolbar at the bottom of the screen. Port of Toolbar.swift.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {INK_CHOICES, LASER, RED, SHAPES} from './hands.js';
import {traceStroke} from './ink.js';

const BOTTOM_MARGIN = 24;
const TRAY_GAP = 8;
const TRAY_COLUMNS = 10;
const NEAR_X = 80;
const NEAR_ABOVE = 90;
const NEAR_PAD = 10;

function box(vertical, params) {
    const b = new St.BoxLayout(params);
    // GNOME 48 replaced `vertical` with `orientation`.
    if ('orientation' in b)
        b.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    else
        b.vertical = vertical;
    return b;
}

function dot(color) {
    const style = color
        ? `background-color: ${color};`
        : 'background-gradient-direction: horizontal; ' +
          `background-gradient-start: ${RED}; background-gradient-end: #0A84FF;`;
    return new St.Widget({style_class: 'tinyhand-dot', style});
}

// A small sample of each shape, drawn with the same code as the real ink.
const SHAPE_SAMPLES = {
    pen: {kind: 'pen', points: [[3, 14], [6, 8], [9, 11], [12, 6], [15, 10], [17, 5]]},
    ellipse: {kind: 'ellipse', start: [2, 5], end: [18, 15]},
    rectangle: {kind: 'rectangle', start: [3, 5], end: [17, 15]},
    arrow: {kind: 'arrow', start: [3, 17], end: [17, 3]},
};
const SHAPE_ICON_SIZE = 20;

function shapeIcon(kind) {
    const area = new St.DrawingArea({width: SHAPE_ICON_SIZE, height: SHAPE_ICON_SIZE});
    area.kind = kind;
    area.connect('repaint', a => {
        const cr = a.get_context();
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(2);
        traceStroke(cr, {...SHAPE_SAMPLES[a.kind], width: 1.5, constrain: false});
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

function setSelected(button, selected) {
    if (selected)
        button.add_style_class_name('selected');
    else
        button.remove_style_class_name('selected');
}

function rect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {x, y, w, h};
}

export class Toolbar {
    constructor({hands, assetsDir, onPick, onInk, onShape, onToggleSound, onExit}) {
        this._hands = hands;
        this._dir = assetsDir;
        this._onPick = onPick;
        this._onInk = onInk;
        this._styleButtons = [];
        this._pinned = [];
        this._current = null;
        this.revealed = false;

        this.bar = box(false, {style_class: 'tinyhand-toolbar', reactive: true, visible: false, opacity: 0});
        this._pinnedBox = box(false, {style_class: 'tinyhand-row'});
        this._moreButton = this._button(
            new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 20}),
            () => this._toggleTray(this.handTray));
        this._inkDot = dot(RED);
        this._inkButton = this._button(this._inkDot, () => this._toggleTray(this.inkTray));
        this._shapeIcon = shapeIcon('ellipse');
        this._shapeButton = this._button(this._shapeIcon, () => this._toggleTray(this.shapeTray));
        this._soundIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic', icon_size: 20});
        const sound = this._button(this._soundIcon, () => onToggleSound());
        const exit = this._button(new St.Icon({icon_name: 'window-close-symbolic', icon_size: 20}), () => onExit());

        this.bar.add_child(this._pinnedBox);
        this.bar.add_child(this._moreButton);
        this.bar.add_child(new St.Widget({style_class: 'tinyhand-separator'}));
        this.bar.add_child(this._shapeButton);
        this.bar.add_child(this._inkButton);
        this.bar.add_child(sound);
        this.bar.add_child(exit);

        this.handTray = box(true, {style_class: 'tinyhand-tray', reactive: true, visible: false});
        const all = [...hands.map(h => h.id), LASER.id];
        for (let i = 0; i < all.length; i += TRAY_COLUMNS) {
            const row = box(false, {style_class: 'tinyhand-row'});
            for (const id of all.slice(i, i + TRAY_COLUMNS))
                row.add_child(this._styleButton(id));
            this.handTray.add_child(row);
        }

        this.inkTray = box(false, {style_class: 'tinyhand-tray', reactive: true, visible: false});
        this._swatches = INK_CHOICES.map(choice => {
            const b = this._button(dot(choice.color), () => {
                this.closeTrays();
                this._onInk(choice.id);
            });
            this.inkTray.add_child(b);
            return {id: choice.id, button: b};
        });

        this.shapeTray = box(false, {style_class: 'tinyhand-tray', reactive: true, visible: false});
        this._shapeButtons = SHAPES.map(([id, title]) => {
            const b = this._button(shapeIcon(id), () => {
                this.closeTrays();
                onShape(id);
            });
            b.accessible_name = title;
            this.shapeTray.add_child(b);
            return {id, button: b};
        });

        // Which toolbar button opens each tray.
        this._trays = new Map([
            [this.handTray, this._moreButton],
            [this.inkTray, this._inkButton],
            [this.shapeTray, this._shapeButton],
        ]);
    }

    /** Every actor that must be added to the stage as reactive chrome. */
    get actors() {
        return [this.bar, this.handTray, this.inkTray, this.shapeTray];
    }

    get trayOpen() {
        return [...this._trays.keys()].some(tray => tray.visible);
    }

    _button(child, onClick) {
        const b = new St.Button({style_class: 'tinyhand-button', child, can_focus: false, reactive: true});
        b.connect('clicked', onClick);
        return b;
    }

    _styleButton(id) {
        let icon;
        if (id === LASER.id) {
            icon = dot(RED);
        } else {
            const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'hands', `${id}_thumb.png`]));
            icon = new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: 32});
        }
        const button = this._button(icon, () => {
            this.closeTrays();
            this._onPick(id);
        });
        this._styleButtons.push({id, button});
        button.connect('destroy', () => {
            this._styleButtons = this._styleButtons.filter(e => e.button !== button);
        });
        return button;
    }

    setPinned(ids) {
        const known = new Set([...this._hands.map(h => h.id), LASER.id]);
        this._pinned = ids.filter(id => known.has(id));
        this._pinnedBox.destroy_all_children();
        for (const id of this._pinned)
            this._pinnedBox.add_child(this._styleButton(id));
        if (this._current)
            this.select(this._current);
    }

    select(id) {
        this._current = id;
        for (const e of this._styleButtons) {
            if (e.id === id)
                e.button.add_style_class_name('selected');
            else
                e.button.remove_style_class_name('selected');
        }
        if (this._pinned.includes(id))
            this._moreButton.remove_style_class_name('selected');
        else
            this._moreButton.add_style_class_name('selected');
    }

    setInk(colorHex, choiceId) {
        this._inkDot.style = `background-color: ${colorHex};`;
        for (const s of this._swatches)
            setSelected(s.button, s.id === choiceId);
    }

    setShape(id) {
        this._shapeIcon.kind = id;
        this._shapeIcon.queue_repaint();
        for (const s of this._shapeButtons)
            setSelected(s.button, s.id === id);
    }

    setSoundOn(on) {
        this._soundIcon.icon_name = on ? 'audio-volume-high-symbolic' : 'audio-volume-muted-symbolic';
    }

    /** Centre the toolbar along the bottom edge of the monitor. */
    place(monitor) {
        this._monitor = monitor;
        const [, w] = this.bar.get_preferred_width(-1);
        const [, h] = this.bar.get_preferred_height(w);
        this._barX = Math.round(monitor.x + (monitor.width - w) / 2);
        this._barY = Math.round(monitor.y + monitor.height - h - BOTTOM_MARGIN);
        this.bar.set_position(this._barX, this._barY);
        for (const tray of this._trays.keys())
            this._placeTray(tray);
    }

    _placeTray(tray) {
        if (!this._monitor)
            return;
        const m = this._monitor;
        const [, w] = tray.get_preferred_width(-1);
        const [, h] = tray.get_preferred_height(w);
        tray.set_position(Math.round(m.x + (m.width - w) / 2), this._barY - h - TRAY_GAP);
    }

    _toggleTray(tray) {
        const open = !tray.visible;
        this.closeTrays();
        if (!open)
            return;
        this._placeTray(tray);
        tray.opacity = 0;
        tray.show();
        tray.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._trays.get(tray).add_style_pseudo_class('checked');
    }

    closeTrays() {
        for (const [tray, button] of this._trays) {
            tray.hide();
            button.remove_style_pseudo_class('checked');
        }
    }

    setRevealed(revealed) {
        if (revealed === this.revealed)
            return;
        this.revealed = revealed;
        if (revealed) {
            this.bar.show();
            this.bar.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        this.closeTrays();
        this.bar.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this.revealed)
                    this.bar.hide();
            },
        });
    }

    /** True when (x, y) is close enough to the toolbar that it should show. */
    isNear(x, y) {
        if (this._barX === undefined)
            return false;
        const [w, h] = this.bar.get_size();
        const inBand = x >= this._barX - NEAR_X && x <= this._barX + w + NEAR_X &&
            y >= this._barY - NEAR_ABOVE - NEAR_PAD && y <= this._barY + h + NEAR_PAD;
        if (inBand)
            return true;
        for (const tray of this._trays.keys()) {
            if (!tray.visible)
                continue;
            const r = rect(tray);
            if (x >= r.x - NEAR_PAD && x <= r.x + r.w + NEAR_PAD && y >= r.y - NEAR_PAD && y <= r.y + r.h + NEAR_PAD)
                return true;
        }
        return false;
    }

    hide() {
        this.revealed = false;
        this.closeTrays();
        this.bar.remove_all_transitions();
        this.bar.opacity = 0;
        this.bar.hide();
    }

    destroy() {
        for (const a of this.actors)
            a.destroy();
    }
}
