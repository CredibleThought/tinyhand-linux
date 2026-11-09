// Short "look here" effects played on double-click: an expanding glow ring
// or a small burst of sparks. They draw under the hand, never take input and
// remove themselves when done.
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

const GLOW_MS = 650;
const SPARKLE_MS = 850;
const SPARK_COUNT = 14;

function rgba(hex, alpha) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

// A circle of `diameter` centred on (x, y), scaling about its centre.
function circle(x, y, diameter, style) {
    return new St.Widget({
        reactive: false,
        width: diameter,
        height: diameter,
        x: Math.round(x - diameter / 2),
        y: Math.round(y - diameter / 2),
        pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        style: `border-radius: ${diameter / 2}px; ${style}`,
    });
}

export class Effects {
    constructor() {
        this.actor = new Clutter.Actor({reactive: false});
    }

    /** Play `kind` ('glow' or 'sparkle') at (x, y); `size` is the monitor height. */
    play(kind, x, y, colorHex, size) {
        if (kind === 'glow')
            this._glow(x, y, colorHex, size);
        else if (kind === 'sparkle')
            this._sparkle(x, y, colorHex, size);
    }

    // Moves and scales with a fast start, but stays bright until late in
    // the animation and then fades, so the effect reads clearly.
    _animate(actor, motion, duration) {
        this.actor.add_child(actor);
        actor.ease({...motion, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        actor.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => actor.destroy(),
        });
    }

    _glow(x, y, color, size) {
        const diameter = Math.round(size * 0.14);
        const border = Math.max(4, Math.round(size * 0.006));
        const ring = circle(x, y, diameter,
            `border: ${border}px solid ${rgba(color, 1)}; ` +
            `background-color: ${rgba(color, 0.22)}; ` +
            `box-shadow: 0 0 ${border * 4}px ${border}px ${rgba(color, 0.7)};`);
        ring.set_scale(0.1, 0.1);
        this._animate(ring, {scale_x: 1, scale_y: 1}, GLOW_MS);

        // A bright core that flashes and fades a little faster.
        const coreSize = Math.round(diameter * 0.32);
        const core = circle(x, y, coreSize,
            'background-color: rgba(255, 255, 255, 0.95); ' +
            `box-shadow: 0 0 ${coreSize}px ${Math.round(coreSize / 2)}px ${rgba(color, 0.9)};`);
        core.set_scale(0.5, 0.5);
        this._animate(core, {scale_x: 1.3, scale_y: 1.3}, Math.round(GLOW_MS * 0.55));
    }

    _sparkle(x, y, color, size) {
        const reach = size * 0.11;
        const spark = Math.max(8, Math.round(size * 0.012));
        const offset = Math.random() * Math.PI * 2;
        for (let i = 0; i < SPARK_COUNT; i++) {
            // Evenly spaced with a little jitter, alternating ink colour and white.
            const angle = offset + (i / SPARK_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
            const distance = reach * (0.7 + Math.random() * 0.5);
            const fill = i % 2 ? 'rgba(255, 255, 255, 1)' : rgba(color, 1);
            const dot = circle(x, y, spark,
                `background-color: ${fill}; ` +
                `box-shadow: 0 0 ${spark * 2}px ${Math.round(spark / 2)}px ${rgba(color, 0.9)};`);
            this._animate(dot, {
                translation_x: Math.cos(angle) * distance,
                translation_y: Math.sin(angle) * distance,
                scale_x: 0.45,
                scale_y: 0.45,
            }, Math.round(SPARKLE_MS * (0.85 + Math.random() * 0.3)));
        }

        const flashSize = Math.round(reach * 0.55);
        const flash = circle(x, y, flashSize,
            'background-color: rgba(255, 255, 255, 0.95); ' +
            `box-shadow: 0 0 ${flashSize}px ${Math.round(flashSize / 2)}px ${rgba(color, 0.9)};`);
        flash.set_scale(0.3, 0.3);
        this._animate(flash, {scale_x: 1.1, scale_y: 1.1}, Math.round(SPARKLE_MS * 0.4));
    }

    clear() {
        for (const child of this.actor.get_children()) {
            child.remove_all_transitions();
            child.destroy();
        }
    }

    destroy() {
        this.clear();
        this.actor.destroy();
    }
}
