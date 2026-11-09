// The hand on a stick (or the laser dot). Port of ArmView.swift.
//
// The maths is done in a y-up frame like the original, with the grip held
// below the bottom edge of the screen and leaning right of the cursor. The
// result is applied to Clutter actors, which use a y-down frame, so the
// rotation sign flips.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {RED} from './hands.js';

const MIN_ROD_FRAC = 0.05;
const GRIP_LEAN_FRAC = 0.30;
const GRIP_DEPTH_FRAC = 0.12;
const GRIP_FOLLOW = 0.08;
const LIFT_FRAC = 0.06;
const PRESS_DECAY = 0.82;
// The original constants are per tick of a 120 Hz timer; scale them by
// elapsed time so the feel is the same at any refresh rate.
const TICK_HZ = 120;

function makeBlur(radius) {
    // GNOME renamed the property from sigma to radius; try both.
    for (const prop of ['radius', 'sigma']) {
        try {
            return new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, [prop]: radius});
        } catch {
            // Try the next name.
        }
    }
    return null;
}

/** An actor showing a PNG from disk, stretched to whatever size it is given. */
class ImageActor {
    constructor(path) {
        this.actor = new Clutter.Actor({reactive: false});
        this.actor.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
        this.actor.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The texture cache loads off the main thread and fills in the
        // content of the actor it returns; copy that content to our own actor
        // so nothing the cache does to its actor's size affects ours.
        this._source = St.TextureCache.get_default().load_file_async(
            Gio.File.new_for_path(path), -1, -1, scale, 1);
        const copy = () => {
            if (this._source.content)
                this.actor.set_content(this._source.content);
        };
        this._sourceId = this._source.connect('notify::content', copy);
        copy();
    }

    destroy() {
        this._source.disconnect(this._sourceId);
        this._source.destroy();
        this.actor.destroy();
    }
}

export class Arm {
    constructor(assetsDir) {
        this._dir = assetsDir;
        this.actor = new Clutter.Actor({reactive: false});

        this._group = new Clutter.Actor({reactive: false});
        this._shadow = new Clutter.Clone({source: this._group, reactive: false, opacity: 66});
        const darken = new Clutter.BrightnessContrastEffect();
        darken.set_brightness(-1.0);
        this._shadow.add_effect_with_name('darken', darken);
        const blur = makeBlur(12);
        if (blur)
            this._shadow.add_effect_with_name('blur', blur);
        this.actor.add_child(this._shadow);
        this.actor.add_child(this._group);

        this._laser = new St.Widget({reactive: false});
        this._laserCore = new St.Widget({reactive: false});
        this._laser.add_child(this._laserCore);
        this.actor.add_child(this._laser);

        this._hand = null;
        this._handImage = null;
        this._rodImage = null;

        this.sizeFrac = 0.13;
        this._showShadow = true;
        this.held = false;
        this._press = 0;
        this._gripX = null;
        this._gripTarget = null;
        this._pose = '';
        this._laserR = -1;
        this._hidden = false;
    }

    /** hand: an entry from hands.json, or null for the laser dot. */
    setStyle(hand) {
        this._handImage?.destroy();
        this._rodImage?.destroy();
        this._handImage = this._rodImage = null;
        this._hand = hand;
        this._pose = '';
        this._laserR = -1;
        if (hand) {
            const path = name => GLib.build_filenamev([this._dir, 'hands', `${hand.id}_${name}.png`]);
            this._rodImage = new ImageActor(path('rod'));
            this._handImage = new ImageActor(path('hand'));
            this._group.add_child(this._rodImage.actor);
            this._group.add_child(this._handImage.actor);
            this._group.set_pivot_point(hand.rodX, 1);
            this._shadow.set_pivot_point(hand.rodX, 1);
        }
        this._syncVisibility();
    }

    set showShadow(value) {
        this._showShadow = value;
        this._syncVisibility();
    }

    set pointerHidden(value) {
        this._hidden = value;
        this._syncVisibility();
    }

    _syncVisibility() {
        const hand = !this._hidden && this._hand !== null;
        this._group.visible = hand;
        this._shadow.visible = hand && this._showShadow;
        this._laser.visible = !this._hidden && this._hand === null;
    }

    press() {
        this._press = 1;
    }

    /** True while an animation is still moving even if the pointer is still. */
    get isSettling() {
        if (this._press > 0.002)
            return true;
        if (this._gripX === null || this._gripTarget === null)
            return false;
        return Math.abs(this._gripTarget - this._gripX) > 0.5;
    }

    /** Forget the smoothed grip, e.g. after moving to another monitor. */
    reset() {
        this._gripX = null;
        this._gripTarget = null;
        this._pose = '';
    }

    /**
     * Point at (cx, cy), in coordinates local to a monitor of size W x H.
     * dt is the time since the previous call, in seconds.
     */
    aim(cx, cy, W, H, dt) {
        const steps = dt * TICK_HZ;
        const targetX = Math.min(Math.max(cx + GRIP_LEAN_FRAC * W, W * 0.15), W * 1.05);
        if (this._gripX === null)
            this._gripX = targetX;
        else
            this._gripX += (targetX - this._gripX) * (1 - Math.pow(1 - GRIP_FOLLOW, steps));
        this._gripTarget = targetX;
        if (!this.held)
            this._press *= Math.pow(PRESS_DECAY, steps);

        if (this._hand === null) {
            this._aimLaser(cx, cy, H);
            return;
        }
        const a = this._hand;
        const gx = this._gripX;
        const gyUp = -GRIP_DEPTH_FRAC * H;

        const dx = cx - gx;
        const dy = (H - cy) - gyUp;
        const reach = Math.hypot(dx, dy);
        const aimAngle = Math.atan2(dy, dx);

        const handPts = this.sizeFrac * H * (1 - 0.06 * this._press);
        const s = handPts / (a.wrist - a.handTop);
        const widthPts = s * a.aspect;
        const handTipPts = (a.wrist - a.tip) * s;
        const tipOffX = (a.tipX - a.rodX) * widthPts;

        const along = Math.sqrt(Math.max(0, reach * reach - tipOffX * tipOffX));
        const rodLen = Math.max(MIN_ROD_FRAC * H, along - handTipPts);
        const tipAngle = Math.atan2(rodLen + handTipPts, tipOffX);
        const rotation = aimAngle - tipAngle;
        const lift = LIFT_FRAC * H * (1 - 0.8 * this._press);

        const pose = [rotation * 1000, rodLen, handPts, gx, lift].map(Math.round).join();
        if (pose === this._pose)
            return;
        this._pose = pose;

        const total = rodLen + handPts;
        const x = gx - a.rodX * widthPts;
        const y = H + GRIP_DEPTH_FRAC * H - total;
        const degrees = -rotation * 180 / Math.PI;

        this._handImage.actor.set_position(0, 0);
        this._handImage.actor.set_size(widthPts, handPts);
        this._rodImage.actor.set_position(0, handPts);
        this._rodImage.actor.set_size(widthPts, rodLen);

        this._group.set_size(widthPts, total);
        this._group.set_position(x, y);
        this._group.rotation_angle_z = degrees;

        // The shadow falls down and to the right, and tightens as the hand
        // presses toward the screen.
        this._shadow.set_size(widthPts, total);
        this._shadow.set_position(x + lift * 0.6, y + lift);
        this._shadow.rotation_angle_z = degrees;
        this._shadow.opacity = Math.round(255 * (0.26 + 0.02 * this._press));
    }

    _aimLaser(cx, cy, H) {
        const r = Math.max(4, H * 0.0038 * this.sizeFrac / 0.13) * (1 + 0.2 * this._press);
        const rr = Math.round(r * 2) / 2;
        if (rr !== this._laserR) {
            this._laserR = rr;
            const core = rr * 0.45;
            const glow = rr * (2.2 + this._press);
            this._laser.set_size(2 * rr, 2 * rr);
            this._laser.style = `background-color: ${RED}; border-radius: ${rr}px; ` +
                `box-shadow: 0 0 ${glow.toFixed(1)}px ${(rr * 0.4).toFixed(1)}px rgba(255,41,31,0.85);`;
            this._laserCore.set_size(2 * core, 2 * core);
            this._laserCore.set_position(rr - core, rr - core);
            this._laserCore.style = `background-color: rgba(255,219,209,0.95); border-radius: ${core}px;`;
        }
        this._laser.set_position(Math.round(cx - rr), Math.round(cy - rr));
    }

    destroy() {
        this._handImage?.destroy();
        this._rodImage?.destroy();
        this.actor.destroy();
    }
}
