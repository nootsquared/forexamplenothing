import { Vec2, vec, len, norm, scale, add, expDecayVec, angleBetween, clamp } from '../core/math';
import { SimEvent } from './events';

// Stats are the ONLY thing that differs between players — no personality sliders
export interface PlayerStats {
  topSpeed: number;    // m/s jogging cap
  sprintSpeed: number; // m/s sprint cap
  accel: number;       // responsiveness, higher = snappier
  agility: number;     // 0..1, sharpness of direction changes
  control: number;     // 0..1, dribble touch tightness
  power: number;       // 0..1, kick strength ceiling
}

export interface PlayerInput {
  move: Vec2;          // unit-ish intent
  sprint: boolean;
  kickCharging: boolean;
  // aimOffset: radians of J/L bend applied off the stick line at release.
  // aimAt: a field POINT to strike toward (mouse passing) — overrides the stick line.
  kickReleased: { power: number; aimOffset?: number; aimAt?: Vec2 } | null;
  tackle?: boolean;    // lunge-poke at the ball — win it clean or eat the recovery
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
  home: Vec2; // kickoff spot; play returns here after every goal
  stamina = 1;
  touchCooldown = 0;
  kickCooldown = 0;
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
  isSprinting = false;
  isCharging = false;
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
    if (this.recoverTimer > 0) maxSpeed *= 0.45; // beaten after a whiffed lunge

    // A hard cut plants the foot: brief speed cost, big visual payoff
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    if (wantDir && this.speed() > 4.2 && this.cutTimer === 0 && angleBetween(this.vel, wantDir) > 1.15) {
      this.cutTimer = 0.35;
      const planted = norm(this.vel);
      this.vel = scale(this.vel, 0.6);
      this.justCut = true;
      this.cutDir = wantDir;
      events.push({ kind: 'cut', x: this.pos.x, y: this.pos.y, dx: planted.x, dy: planted.y });
    }

    const desired = wantDir ? scale(wantDir, maxSpeed * moveLen) : vec();
    const turning = wantDir ? angleBetween(this.vel, wantDir) : 0;
    // Agility governs how fast you can bend your run; stopping is always quick
    const rate = wantDir
      ? this.stats.accel * (turning > 0.6 ? 0.55 + 0.45 * this.stats.agility : 1)
      : this.stats.accel * 1.6;
    this.vel = expDecayVec(this.vel, desired, rate, dt);

    // Heading follows the body, not the keys: velocity bends smoothly through
    // turns, so the runner sweeps through every angle instead of snapping
    // between key directions. Standing still, you aim with the stick directly.
    if (this.speed() > 0.6) this.facing = norm(this.vel);
    else if (wantDir) this.facing = wantDir;

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

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
  }
}
