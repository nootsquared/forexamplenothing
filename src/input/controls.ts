import { vec, norm, len, clamp } from '../core/math';
import { PlayerInput } from '../sim/player';
import { Keyboard } from './keyboard';
import { pollPad } from './gamepad';

const CHARGE_TIME = 0.85;
const AIM_RATE = 3.0;       // rad/s the J/L sweep bends the aim
const AIM_MAX = 1.31;       // ~75° — you strike across your body, never backward

// Merges keyboard + pad into one player's intent, owns kick charge and aim
export class LocalControls {
  private chargeT = 0;
  private wasHeld = false;
  charge = 0;     // exposed for the charge bar UI
  aimOffset = 0;  // exposed for the aim arrow — J/L bend off the stick line

  sample(dt: number, kb: Keyboard): PlayerInput {
    const pad = pollPad();
    let x = (kb.has('KeyD') || kb.has('ArrowRight') ? 1 : 0) - (kb.has('KeyA') || kb.has('ArrowLeft') ? 1 : 0);
    let y = (kb.has('KeyS') || kb.has('ArrowDown') ? 1 : 0) - (kb.has('KeyW') || kb.has('ArrowUp') ? 1 : 0);
    if (pad && (pad.moveX !== 0 || pad.moveY !== 0)) {
      x = pad.moveX;
      y = pad.moveY;
    }
    const move = len(vec(x, y)) > 1 ? norm(vec(x, y)) : vec(x, y);

    const held = kb.has('Space') || pad?.kick || false;
    let kickReleased: { power: number; aimOffset: number } | null = null;
    if (held) {
      if (!this.wasHeld) this.aimOffset = 0; // every charge starts aimed dead ahead
      this.chargeT = Math.min(CHARGE_TIME, this.chargeT + dt);
      const bend = (kb.has('KeyL') ? 1 : 0) - (kb.has('KeyJ') ? 1 : 0) || pad?.bend || 0;
      this.aimOffset = clamp(this.aimOffset + bend * AIM_RATE * dt, -AIM_MAX, AIM_MAX);
    } else if (this.wasHeld) {
      kickReleased = { power: clamp(this.chargeT / CHARGE_TIME, 0.12, 1), aimOffset: this.aimOffset };
      this.chargeT = 0;
    }
    this.wasHeld = held;
    this.charge = held ? this.chargeT / CHARGE_TIME : 0;

    return {
      move,
      sprint: kb.has('ShiftLeft') || kb.has('ShiftRight') || pad?.sprint || false,
      kickCharging: held,
      kickReleased,
    };
  }
}
