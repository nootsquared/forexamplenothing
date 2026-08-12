import { Vec2, vec, len, norm, scale, add, sub, rotate, signedAngle, expDecayVec, angleBetween, clamp } from '../core/math';
import { SimEvent } from './events';

// The strafe is a LOOK, never a physics input: a jog is still walking pace, so
// the eyes stay on the ball that far up — but the legs always obey the keys.
const ATTEND_PACE = 1.05;
const FACE_TURN = 7;        // rad/s — a full about-face takes ~0.45s, never a snap
const FACE_DEADBAND = 0.07; // the eyes stop hunting once they are basically there
const ATTEND_NEAR = 1.6;    // a ball at your own feet never yanks the shoulders

// The plant: past this much of a turn the foot goes down and the run is
// re-pointed. CUT_BITE is what a full about-face costs — everything short of
// that pays a share, so weight is a curve you feel, not a wall you hit.
const CUT_ANGLE = 1.15;
const CUT_BITE = 0.62;

// Stats are the ONLY thing that differs between players — no personality sliders.
// Positions are exclusive by construction: a role's off-stats are authored so
// far below another role's floor that no gold defender ever subs for a striker.
export interface PlayerStats {
  topSpeed: number;    // m/s jogging cap
  sprintSpeed: number; // m/s sprint cap
  accel: number;       // responsiveness, higher = snappier
  agility: number;     // 0..1, sharpness of direction changes
  control: number;     // 0..1, dribble touch tightness
  power: number;       // 0..1, kick strength ceiling
  shoot: number;       // 0..1, the cone when the mouth is the target
  pass: number;        // 0..1, short-delivery accuracy
  longBall: number;    // 0..1, how far accuracy survives the raking ball
  defend: number;      // 0..1, the steal trade (the clamp reads this)
  phys: number;        // 0..1, strength in the shoulder duel
  reflex: number;      // GK 0..1, reaction beat before the dive
  dive: number;        // GK 0..1, reach of the leap
  handling: number;    // GK 0..1, catch versus spill
}

export interface PlayerInput {
  move: Vec2;          // unit-ish intent
  sprint: boolean;
  kickCharging: boolean;
  // aimOffset: radians of J/L bend applied off the stick line at release.
  // aimAt: a field POINT to strike toward (mouse passing) — overrides the stick line.
  kickReleased: { power: number; aimOffset?: number; aimAt?: Vec2 } | null;
  tackle?: boolean;    // lunge-poke at the ball — win it clean or eat the recovery
  attend?: Vec2;       // where the body FACES at walking pace (ball, mark) — sprint overrides
  dive?: { dirY: -1 | 1; height: 0 | 1 }; // keeper only: commit the leap the brain chose
  // The takeover blend: a freshly switched-into body whose hands are still
  // idle keeps doing what its brain was doing — the mark held, the jockey
  // kept. Any real input takes over instantly; kicks are never inherited.
  assist?: boolean;
}

// Which side a body plays for and where it lives in the team's shape
export interface PlayerIdentity {
  team: 0 | 1;         // 0 attacks +x, 1 attacks -x
  role: 'GK' | 'DF' | 'MF' | 'FW';
  anchor: Vec2;        // formation slot, normalized (x: own goal→opponent, y: 0..1)
  number: number;
}

export class PlayerBody {
  vel: Vec2 = vec();
  facing: Vec2 = vec(1, 0);
  // Where the shoulders point for the eye only — never read by the sim
  look: Vec2 = vec(1, 0);
  home: Vec2; // kickoff spot; play returns here after every goal
  stamina = 1;
  touchCooldown = 0;
  kickCooldown = 0;
  // Just received a ball from someone else: for this beat the first touches
  // obey the CURRENT stick, not the arrival momentum — tap-and-turn is a play
  freshTouch = 0;
  // Just kicked or just dispossessed: the body is solid but can't STEER the
  // ball — no bulldozing your own shot, no instantly re-tapping a lost duel
  playLock = 0;
  // Released kick waiting for the ball to come into reach
  pendingKick: { power: number; bend: number; aimAt?: Vec2; ttl: number } | null = null;
  // Set for one tick when a cut plants — the foot can chop the ball with it
  justCut = false;
  cutDir: Vec2 = vec(1, 0);
  private cutTimer = 0;
  // Tackle: a committed lunge window, then either the ball or the recovery
  lungeTimer = 0;
  tackleCooldown = 0;
  recoverTimer = 0;
  // Keeper only, committed by the world: the beat spent in the air, where the
  // leap is a decision you live with — no steering, no second thoughts
  diveTimer = 0;
  diveHeight: 0 | 1 = 0;
  // A shoulder charge is a challenge, not a rhythm — one roll per contact
  bargeCooldown = 0;
  isSprinting = false;
  isCharging = false;
  // The world's verdict that this body is running WITH the ball right now —
  // and the oldest truth in football: the man with the ball is the slower man
  carrying = false;
  prev = { x: 0, y: 0 };
  id: PlayerIdentity;

  constructor(public pos: Vec2, public stats: PlayerStats, id?: PlayerIdentity) {
    this.home = vec(pos.x, pos.y);
    this.prev = { x: pos.x, y: pos.y };
    this.id = id ?? { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 0 };
  }

  savePrev() {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
  }

  speed(): number {
    return len(this.vel);
  }

  update(dt: number, input: PlayerInput, events: SimEvent[]) {
    const moveLen = clamp(len(input.move), 0, 1);
    const wantDir = moveLen > 0.05 ? norm(input.move) : null;
    this.isSprinting = input.sprint && moveLen > 0.4 && this.stamina > 0.05;
    this.isCharging = input.kickCharging;

    // A lunge that expires without winning the ball becomes the recovery
    if (this.lungeTimer > 0 && this.lungeTimer <= dt) this.recoverTimer = 0.5;
    this.lungeTimer = Math.max(0, this.lungeTimer - dt);
    this.tackleCooldown = Math.max(0, this.tackleCooldown - dt);
    this.recoverTimer = Math.max(0, this.recoverTimer - dt);
    this.bargeCooldown = Math.max(0, this.bargeCooldown - dt);
    this.diveTimer = Math.max(0, this.diveTimer - dt);
    const airborne = this.diveTimer > 0;
    // The lunge: a committed burst toward the point of attack. Miss and the
    // recovery leaves you beaten — tackling is a bet, not a spam button.
    if (input.tackle && this.tackleCooldown <= 0 && this.lungeTimer <= 0 && this.recoverTimer <= 0) {
      const dir = wantDir ?? this.facing;
      this.lungeTimer = 0.24;
      this.tackleCooldown = 0.9;
      this.vel = add(scale(this.vel, 0.4), scale(dir, 6.2));
      events.push({ kind: 'tackle', x: this.pos.x, y: this.pos.y });
    }

    const staminaFactor = 0.8 + 0.2 * this.stamina;
    let maxSpeed = (this.isSprinting ? this.stats.sprintSpeed : this.stats.topSpeed) * staminaFactor;
    if (this.isCharging) maxSpeed *= 0.92; // you can dribble into a shot; barely a tax
    // Nobody outruns the field WITH the ball: sprinting while it rides your
    // boot is taxed, so a chasing defender genuinely reels a carrier in. Touch
    // decides the trade — better feet keep more of the pace.
    if (this.carrying && this.isSprinting) maxSpeed *= 0.84 + 0.05 * this.stats.control;
    if (this.recoverTimer > 0) maxSpeed *= 0.45; // beaten after a whiffed lunge

    // A hard cut plants the foot, and the plant costs exactly as much as the
    // turn asks for: a shoulder-drop barely registers, a full reversal takes
    // nearly everything. No cliff at the threshold — the toll is the angle.
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    const turning = wantDir ? angleBetween(this.vel, wantDir) : 0;
    // A man off the ground has no foot to plant with — the leap is a decision
    // he lives with all the way to the grass
    if (wantDir && !airborne && this.speed() > 4.2 && this.cutTimer === 0 && turning > CUT_ANGLE) {
      this.cutTimer = 0.35;
      const planted = norm(this.vel);
      this.vel = scale(this.vel, 1 - CUT_BITE * clamp((turning - CUT_ANGLE) / (Math.PI - CUT_ANGLE), 0, 1));
      this.justCut = true;
      this.cutDir = wantDir;
      events.push({ kind: 'cut', x: this.pos.x, y: this.pos.y, dx: planted.x, dy: planted.y });
    }

    const desired = wantDir && !airborne ? scale(wantDir, maxSpeed * moveLen) : vec();
    // Agility governs how fast you can bend your run — smoothly, so a 46°
    // change never feels like a different game to a 44° one. Stopping is
    // always quick. Mid-flight there is no rate at all: the keeper glides
    // exactly where he threw himself.
    const bend = clamp((turning - 0.35) / 1.2, 0, 1);
    const rate = airborne
      ? 0.8
      : wantDir
        ? this.stats.accel * (1 - bend * 0.45 * (1 - this.stats.agility))
        : this.stats.accel * 1.6;
    this.vel = expDecayVec(this.vel, desired, rate, dt);

    // Heading follows the body, not the keys: velocity bends smoothly through
    // turns, so the runner sweeps through every angle instead of snapping
    // between key directions. Standing still, you aim with the stick directly.
    if (this.speed() > 0.6) this.facing = norm(this.vel);
    else if (wantDir) this.facing = wantDir;

    // The eyes are their own thing. At walking pace they hold an ATTEND point
    // — the ball, a mark — so the sprite backpedals and sidesteps with open
    // shoulders instead of turning its back. Sprint and they snap to the run.
    // This is what the SPRITE wears; the feet never answer to it, which is why
    // dribbling a ball at your toes still steers exactly where you point.
    const eyes = input.attend && !this.isSprinting && this.speed() < this.stats.topSpeed * ATTEND_PACE
      ? sub(input.attend, this.pos)
      : null;
    const want = eyes && len(eyes) > ATTEND_NEAR ? norm(eyes) : this.facing;
    const off = signedAngle(this.look, want);
    this.look = Math.abs(off) > FACE_DEADBAND
      ? rotate(this.look, clamp(off, -FACE_TURN * dt, FACE_TURN * dt))
      : want;

    // Sprint is a rhythm, not a one-shot: ~13s of burn from full, and jogging
    // earns it back fast enough that the burst is always in the tank
    this.stamina = clamp(
      this.stamina + (this.isSprinting ? -0.075 : this.speed() < 2 ? 0.16 : 0.08) * dt,
      0,
      1,
    );
    this.touchCooldown = Math.max(0, this.touchCooldown - dt);
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.playLock = Math.max(0, this.playLock - dt);
    this.freshTouch = Math.max(0, this.freshTouch - dt);

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
  }

}
