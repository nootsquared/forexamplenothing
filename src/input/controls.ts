import { Vec2, vec, norm, len, clamp } from '../core/math';
import { PlayerInput } from '../sim/player';
import { Keyboard } from './keyboard';
import { pollPad } from './gamepad';

const CHARGE_TIME = 0.85;
const AIM_RATE = 7.0;       // rad/s the J/L sweep steers the aim
const AIM_MAX = 1.31;       // ~75° — you strike across your body, never backward
const AIM_UNLOCK = AIM_MAX * 1.15; // running past this leaves the lock behind

// Merges keyboard + pad into one player's intent, owns kick charge and aim.
// J/L paint the aim on the FIELD: the angle locks in world space and stays
// put while you run — until you steer it again, or turn so far the spot falls
// behind your strikeable cone and the lock lets go.
export class LocalControls {
  private chargeT = 0;
  private wasHeld = false;
  private aimWorld: number | null = null; // the locked field angle
  charge = 0;          // exposed for the charge bar UI
  aimDir: Vec2 | null = null; // resolved world aim while charging — the arrow

  sample(dt: number, kb: Keyboard, facing: Vec2): PlayerInput {
    const pad = pollPad();
    let x = (kb.has('KeyD') || kb.has('ArrowRight') ? 1 : 0) - (kb.has('KeyA') || kb.has('ArrowLeft') ? 1 : 0);
    let y = (kb.has('KeyS') || kb.has('ArrowDown') ? 1 : 0) - (kb.has('KeyW') || kb.has('ArrowUp') ? 1 : 0);
    if (pad && (pad.moveX !== 0 || pad.moveY !== 0)) {
      x = pad.moveX;
      y = pad.moveY;
    }
    const move = len(vec(x, y)) > 1 ? norm(vec(x, y)) : vec(x, y);

    const held = kb.has('Space') || pad?.kick || false;
    const bend = (kb.has('KeyL') ? 1 : 0) - (kb.has('KeyJ') ? 1 : 0) || pad?.bend || 0;
    let kickReleased: { power: number; aimOffset: number } | null = null;
    if (held) {
      this.chargeT = Math.min(CHARGE_TIME, this.chargeT + dt);
      if (bend !== 0) {
        if (this.aimWorld === null) {
          const base = len(move) > 0.25 ? move : facing;
          this.aimWorld = Math.atan2(base.y, base.x);
        }
        this.aimWorld += bend * AIM_RATE * dt;
      }
    } else if (this.wasHeld) {
      kickReleased = {
        power: clamp(this.chargeT / CHARGE_TIME, 0.12, 1),
        aimOffset: this.resolve(move, facing).offset,
      };
      this.chargeT = 0;
    }
    this.wasHeld = held;
    this.charge = held ? this.chargeT / CHARGE_TIME : 0;
    this.aimDir = held ? this.resolve(move, facing).dir : null;

    return {
      move,
      sprint: kb.has('ShiftLeft') || kb.has('ShiftRight') || pad?.sprint || false,
      kickCharging: held,
      kickReleased,
      tackle: kb.has('KeyK') || pad?.tackle || false,
    };
  }

  // The locked field angle as a strike the body can actually make: expressed
  // relative to the current movement line, cone-clamped — and dropped
  // entirely once running has left the spot unreachably behind you
  private resolve(move: Vec2, facing: Vec2): { dir: Vec2; offset: number } {
    const base = len(move) > 0.25 ? norm(move) : facing;
    if (this.aimWorld === null) return { dir: base, offset: 0 };
    const baseAng = Math.atan2(base.y, base.x);
    let rel = this.aimWorld - baseAng;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    if (Math.abs(rel) > AIM_UNLOCK) {
      this.aimWorld = null;
      return { dir: base, offset: 0 };
    }
    const offset = clamp(rel, -AIM_MAX, AIM_MAX);
    const ang = baseAng + offset;
    return { dir: vec(Math.cos(ang), Math.sin(ang)), offset };
  }
}
