import { vec, norm, len, clamp } from '../core/math';
import { PlayerInput } from '../sim/player';
import { Keyboard } from './keyboard';
import { pollPad } from './gamepad';

const CHARGE_TIME = 0.85;

// Merges keyboard + pad into one player's intent, owns kick charge timing
export class LocalControls {
  private chargeT = 0;
  private wasHeld = false;
  charge = 0; // exposed for the charge bar UI

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
    let kickReleased: { power: number } | null = null;
    if (held) {
      this.chargeT = Math.min(CHARGE_TIME, this.chargeT + dt);
    } else if (this.wasHeld) {
      kickReleased = { power: clamp(this.chargeT / CHARGE_TIME, 0.12, 1) };
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
