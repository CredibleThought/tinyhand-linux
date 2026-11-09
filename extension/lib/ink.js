// Drawing on the screen: freehand pen strokes and clean shapes (ellipse,
// rectangle, arrow). The pen is a port of Ink.swift.
//
// The stroke being drawn lives in one full-monitor drawing area. When the
// button comes up it is moved into its own small drawing area sized to its
// bounding box, which can then fade out and be destroyed on its own.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {hexToRgb} from './hands.js';

const FADE_MS = 600;
const MIN_STEP = 1.5;
const SHADOW = {dx: 1, dy: 1.5, alpha: 0.18};
const ARROW_SPREAD = 0.45; // radians either side of the shaft

function quadTo(cr, from, control, to) {
    // Cairo only has cubic curves; raise the quadratic to a cubic.
    cr.curveTo(
        from[0] + 2 / 3 * (control[0] - from[0]), from[1] + 2 / 3 * (control[1] - from[1]),
        to[0] + 2 / 3 * (control[0] - to[0]), to[1] + 2 / 3 * (control[1] - to[1]),
        to[0], to[1]);
}

function tracePen(cr, points) {
    cr.moveTo(...points[0]);
    if (points.length === 1) {
        cr.lineTo(points[0][0] + 0.01, points[0][1]);
        return;
    }
    let current = points[0];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const mid = [(prev[0] + points[i][0]) / 2, (prev[1] + points[i][1]) / 2];
        quadTo(cr, current, prev, mid);
        current = mid;
    }
    cr.lineTo(...points[points.length - 1]);
}

/**
 * Where a shape really ends. With `constrain` (Shift held) ellipses and
 * rectangles become circles and squares, and arrows snap to 45°.
 */
function shapeEnd(kind, start, end, constrain) {
    if (!constrain)
        return end;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (kind === 'arrow') {
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        const len = Math.hypot(dx, dy);
        return [start[0] + len * Math.cos(angle), start[1] + len * Math.sin(angle)];
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [start[0] + (dx < 0 ? -side : side), start[1] + (dy < 0 ? -side : side)];
}

/** The two outer points of an arrowhead pointing at `end`. */
function arrowHead(start, end, width) {
    const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const head = Math.min(Math.max(width * 4, 14), len * 0.4);
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    return [-ARROW_SPREAD, ARROW_SPREAD].map(a => [
        end[0] - head * Math.cos(angle + a),
        end[1] - head * Math.sin(angle + a),
    ]);
}

/** Points that bound the drawn stroke, before line width is added. */
function outline(stroke) {
    if (stroke.kind === 'pen')
        return stroke.points;
    const end = shapeEnd(stroke.kind, stroke.start, stroke.end, stroke.constrain);
    if (stroke.kind === 'arrow')
        return [stroke.start, end, ...arrowHead(stroke.start, end, stroke.width)];
    return [stroke.start, end];
}

/** Adds the stroke's path to `cr`, shifted so (ox, oy) is the origin. */
export function traceStroke(cr, stroke, ox = 0, oy = 0) {
    const at = ([x, y]) => [x - ox, y - oy];
    if (stroke.kind === 'pen') {
        tracePen(cr, stroke.points.map(at));
        return;
    }
    const start = at(stroke.start);
    const end = at(shapeEnd(stroke.kind, stroke.start, stroke.end, stroke.constrain));
    switch (stroke.kind) {
    case 'ellipse': {
        // Scale a unit circle; never scale by zero or cairo's matrix breaks.
        const rx = Math.max(0.5, Math.abs(end[0] - start[0]) / 2);
        const ry = Math.max(0.5, Math.abs(end[1] - start[1]) / 2);
        cr.save();
        cr.translate((start[0] + end[0]) / 2, (start[1] + end[1]) / 2);
        cr.scale(rx, ry);
        cr.newSubPath();
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.closePath();
        cr.restore();
        break;
    }
    case 'rectangle':
        cr.rectangle(Math.min(start[0], end[0]), Math.min(start[1], end[1]),
            Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
        break;
    case 'arrow': {
        const [a, b] = arrowHead(start, end, stroke.width);
        cr.moveTo(...start);
        cr.lineTo(...end);
        cr.moveTo(...a);
        cr.lineTo(...end);
        cr.lineTo(...b);
        break;
    }
    }
}

function paintStroke(area, stroke, ox, oy) {
    const cr = area.get_context();
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineWidth(stroke.width);

    traceStroke(cr, stroke, ox - SHADOW.dx, oy - SHADOW.dy);
    cr.setSourceRGBA(0, 0, 0, SHADOW.alpha);
    cr.stroke();

    traceStroke(cr, stroke, ox, oy);
    cr.setSourceRGBA(...stroke.rgb, 1);
    cr.stroke();
    cr.$dispose();
}

export class Ink {
    constructor() {
        this.actor = new Clutter.Actor({reactive: false});
        this._frozen = new Clutter.Actor({reactive: false});
        this._live = new St.DrawingArea({reactive: false});
        this.actor.add_child(this._frozen);
        this.actor.add_child(this._live);
        this._live.connect('repaint', area => {
            if (this._stroke)
                paintStroke(area, this._stroke, 0, 0);
        });
        this._stroke = null;
        this._timeouts = new Set();
    }

    setSize(width, height) {
        this._live.set_size(width, height);
    }

    get isDrawing() {
        return this._stroke !== null;
    }

    get strokeCount() {
        return this._frozen.get_n_children();
    }

    /** Start a stroke; `kind` is 'pen', 'ellipse', 'rectangle' or 'arrow'. */
    begin(x, y, width, colorHex, kind = 'pen') {
        this._stroke = {kind, width, rgb: hexToRgb(colorHex), constrain: false};
        if (kind === 'pen')
            this._stroke.points = [[x, y]];
        else
            this._stroke.start = this._stroke.end = [x, y];
        this._live.queue_repaint();
    }

    /** Move the stroke's end; `constrain` is true while Shift is held. */
    extend(x, y, constrain = false) {
        const stroke = this._stroke;
        if (!stroke)
            return;
        if (stroke.kind !== 'pen') {
            if (stroke.end[0] === x && stroke.end[1] === y && stroke.constrain === constrain)
                return;
            stroke.end = [x, y];
            stroke.constrain = constrain;
            this._live.queue_repaint();
            return;
        }
        const [lx, ly] = stroke.points[stroke.points.length - 1];
        if (Math.hypot(x - lx, y - ly) < MIN_STEP)
            return;
        stroke.points.push([x, y]);
        this._live.queue_repaint();
    }

    /** Finish the stroke; it fades after fadeSeconds, or stays if that is 0. */
    end(fadeSeconds) {
        const stroke = this._stroke;
        if (!stroke)
            return;
        this._stroke = null;
        this._live.queue_repaint();

        const points = outline(stroke);
        const xs = points.map(p => p[0]);
        const ys = points.map(p => p[1]);
        const pad = Math.ceil(stroke.width / 2 + Math.max(SHADOW.dx, SHADOW.dy) + 2);
        const x0 = Math.floor(Math.min(...xs)) - pad;
        const y0 = Math.floor(Math.min(...ys)) - pad;
        const w = Math.ceil(Math.max(...xs)) + pad - x0;
        const h = Math.ceil(Math.max(...ys)) + pad - y0;

        const area = new St.DrawingArea({reactive: false, x: x0, y: y0, width: w, height: h});
        area.connect('repaint', a => paintStroke(a, stroke, x0, y0));
        this._frozen.add_child(area);

        if (fadeSeconds <= 0)
            return;
        const delay = Math.max(0.5, fadeSeconds);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delay * 1000), () => {
            this._timeouts.delete(id);
            area.ease({
                opacity: 0,
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => area.destroy(),
            });
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    clear() {
        this._stroke = null;
        this._live.queue_repaint();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._frozen.destroy_all_children();
    }

    destroy() {
        this.clear();
        this.actor.destroy();
    }
}
