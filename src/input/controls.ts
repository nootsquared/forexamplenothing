import { Vec2, vec, norm, len, clamp } from '../core/math';
import { PlayerInput } from '../sim/player';
import { HUMAN_KICK_FLOOR } from '../sim/tuning';
import { Keyboard } from './keyboard';
import { pads } from './gamepad';

const CHARGE_TIME = 0.85;
const AIM_RATE = 7.0;       // rad/s the J/L sweep steers the aim
const AIM_MAX = 1.31;       // ~75° — you strike across your body, never backward
const AIM_UNLOCK = AIM_MAX * 1.15; // running past this leaves the lock behind
const FLICK_ARM = 0.38;     // right-stick throw that starts winding a pass
const FLICK_KEEP = 0.16;    // falling back through this means you let go
const FLICK_SNAP = 0.03;    // a wind of one single frame was a knuckle, not a pass
// Even the softest flick is a real ball; a full throw is a full-blooded hit.
// The curve leans late on purpose: most of the stick buys the SOFT half of the
// range, so a five-yard ball is a thumb away and the full-blooded hit is a
// deliberate act. Same floor, same ceiling — only the road between them moved.
const FLICK_GAMMA = 1.45;
const flickPower = (peak: number) =>
  HUMAN_KICK_FLOOR + Math.pow(clamp((peak - FLICK_ARM) / (1 - FLICK_ARM), 0, 1), FLICK_GAMMA) * (1 - HUMAN_KICK_FLOOR);

// Merges keyboard + pad into one player's intent, owns kick charge and aim.
// J/L paint the aim on the FIELD: the angle locks in world space and stays
// put while you run — until you steer it again, or turn so far the spot falls
// behind your strikeable cone and the lock lets go.
// The right stick is the pad's sling: pushing it winds a pass (angle aims,
// depth is power), the spring-back fires. While A holds a charge instead,
// the stick POINTS the shot and releasing A plays the charged ball.
export class LocalControls {
  private chargeT = 0;
  private wasHeld = false;
  private tackleHeldT = 0;
  private wasTackle = false;
  private aimWorld: number | null = null; // the locked field angle
  private flickPeak = 0;
  private flickT = 0;
  private flickScreenDir: Vec2 | null = null;
  private flickReleased: { dir: Vec2; power: number } | null = null;
  charge = 0;          // exposed for the charge bar UI
  aimDir: Vec2 | null = null; // resolved world aim while charging — the arrow
  flickAim: { dir: Vec2; power: number } | null = null; // live wind-up, field-space, for the arrow

  // aimSquash: the iso y-squash, so stick angles mean what the eye sees
  constructor(private aimSquash = 1) {}

  // A hand direction on the screen, as the field direction it looks like
  private toField(sx: number, sy: number): Vec2 {
    return norm(vec(sx, sy / this.aimSquash));
  }

  sample(dt: number, kb: Keyboard, facing: Vec2): PlayerInput {
    const pad = pads.state;
    let x = (kb.has('KeyD') || kb.has('ArrowRight') ? 1 : 0) - (kb.has('KeyA') || kb.has('ArrowLeft') ? 1 : 0);
    let y = (kb.has('KeyS') || kb.has('ArrowDown') ? 1 : 0) - (kb.has('KeyW') || kb.has('ArrowUp') ? 1 : 0);
    if (pad && (pad.move.x !== 0 || pad.move.y !== 0)) {
      x = pad.move.x;
      y = pad.move.y;
    }
    const move = len(vec(x, y)) > 1 ? norm(vec(x, y)) : vec(x, y);

    // The keyboard kicks with the MOUSE sling only — Space belongs to
    // DEFENDING now (hold = clamp, tap = lunge). The pad's A-charge remains.
    const held = pad?.kick || false;
    const bend = (kb.has('KeyL') ? 1 : 0) - (kb.has('KeyJ') ? 1 : 0);
    const aim = pad?.aim ?? null;
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
      // The stick doesn't sweep — it points. Wherever you hold it, the shot
      // goes, snapped inside the strikeable cone so a wild point still plays
      // the nearest ball the body can hit instead of being ignored.
      if (aim && aim.mag > 0.32) {
        const d = this.toField(aim.x, aim.y);
        const base = len(move) > 0.25 ? norm(move) : facing;
        const baseAng = Math.atan2(base.y, base.x);
        let rel = Math.atan2(d.y, d.x) - baseAng;
        while (rel > Math.PI) rel -= 2 * Math.PI;
        while (rel < -Math.PI) rel += 2 * Math.PI;
        this.aimWorld = baseAng + clamp(rel, -AIM_MAX, AIM_MAX);
      }
      this.dropFlick();
    } else {
      if (this.wasHeld) {
        // The human floor sits at what used to be MEDIUM: even a tap is a real
        // ball — the charge rides the upper half of the range
        kickReleased = {
          power: HUMAN_KICK_FLOOR + clamp(this.chargeT / CHARGE_TIME, 0, 1) * (1 - HUMAN_KICK_FLOOR),
          aimOffset: this.resolve(move, facing).offset,
        };
        this.chargeT = 0;
      }
      const mag = aim?.mag ?? 0;
      if (mag > (this.flickPeak > 0 ? FLICK_KEEP : FLICK_ARM)) {
        // winding: power remembers the deepest throw, and the direction is
        // only trusted near it — the spring-back never steers the ball
        this.flickPeak = Math.max(this.flickPeak, mag);
        this.flickT += dt;
        if (aim && mag >= this.flickPeak * 0.7) this.flickScreenDir = vec(aim.x, aim.y);
        this.flickAim = this.flickScreenDir
          ? { dir: this.toField(this.flickScreenDir.x, this.flickScreenDir.y), power: flickPower(this.flickPeak) }
          : null;
      } else if (this.flickPeak > 0) {
        // let go — the pass fires at the peak throw. A wind that lasted a
        // single frame was a knuckle brushing the stick, and nothing leaves
        // your foot on a knuckle.
        if (this.flickScreenDir && this.flickT >= FLICK_SNAP) {
          this.flickReleased = {
            dir: this.toField(this.flickScreenDir.x, this.flickScreenDir.y),
            power: flickPower(this.flickPeak),
          };
        }
        this.dropFlick();
      }
    }
    this.wasHeld = held;
    this.charge = held ? this.chargeT / CHARGE_TIME : 0;
    this.aimDir = held ? this.resolve(move, facing).dir : null;

    // One button, two verbs: a TAP (quick release) fires the lunge-poke, a
    // HOLD is the clamp — jaws squeezing a carrier's ball for the clean take.
    // SPACE is the defending hand now; K stays as the old habit's alias.
    const tackleHeld = kb.has('Space') || kb.has('KeyK') || pad?.tackle || false;
    let tacklePulse = false;
    if (tackleHeld) {
      this.tackleHeldT += dt;
    } else {
      if (this.wasTackle && this.tackleHeldT < 0.18) tacklePulse = true;
      this.tackleHeldT = 0;
    }
    this.wasTackle = tackleHeld;

    return {
      move,
      sprint: kb.has('ShiftLeft') || kb.has('ShiftRight') || pad?.sprint || false,
      kickCharging: held,
      kickReleased,
      tackle: tacklePulse,
      clamp: tackleHeld,
    };
  }

  // The pass the stick just fired, if any — consumed exactly once
  takeFlick(): { dir: Vec2; power: number } | null {
    const fired = this.flickReleased;
    this.flickReleased = null;
    return fired;
  }

  private dropFlick() {
    this.flickPeak = 0;
    this.flickT = 0;
    this.flickScreenDir = null;
    this.flickAim = null;
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
