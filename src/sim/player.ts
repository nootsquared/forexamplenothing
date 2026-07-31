import { Vec2, vec, len, norm, scale, expDecayVec, angleBetween, clamp } from '../core/math';
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
  kickReleased: { power: number } | null;
}

export class PlayerBody {
  vel: Vec2 = vec();
  facing: Vec2 = vec(1, 0);
  home: Vec2; // kickoff spot; play returns here after every goal
  stamina = 1;
  touchCooldown = 0;
  kickCooldown = 0;
  // Released kick waiting for the ball to come into reach
  pendingKick: { power: number; ttl: number } | null = null;
  private cutTimer = 0;
  isSprinting = false;
  isCharging = false;
  prev = { x: 0, y: 0 };

  constructor(public pos: Vec2, public stats: PlayerStats) {
    this.home = vec(pos.x, pos.y);
    this.prev = { x: pos.x, y: pos.y };
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

    const staminaFactor = 0.8 + 0.2 * this.stamina;
    let maxSpeed = (this.isSprinting ? this.stats.sprintSpeed : this.stats.topSpeed) * staminaFactor;
    if (this.isCharging) maxSpeed *= 0.92; // you can dribble into a shot; barely a tax

    // A hard cut plants the foot: brief speed cost, big visual payoff
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    if (wantDir && this.speed() > 4.2 && this.cutTimer === 0 && angleBetween(this.vel, wantDir) > 1.15) {
      this.cutTimer = 0.35;
      const planted = norm(this.vel);
      this.vel = scale(this.vel, 0.6);
      events.push({ kind: 'cut', x: this.pos.x, y: this.pos.y, dx: planted.x, dy: planted.y });
    }

    const desired = wantDir ? scale(wantDir, maxSpeed * moveLen) : vec();
    const turning = wantDir ? angleBetween(this.vel, wantDir) : 0;
    // Agility governs how fast you can bend your run; stopping is always quick
    const rate = wantDir
      ? this.stats.accel * (turning > 0.6 ? 0.55 + 0.45 * this.stats.agility : 1)
      : this.stats.accel * 1.6;
    this.vel = expDecayVec(this.vel, desired, rate, dt);

    if (wantDir) this.facing = wantDir;
    else if (this.speed() > 0.6) this.facing = norm(this.vel);

    this.stamina = clamp(
      this.stamina + (this.isSprinting ? -0.11 : this.speed() < 2 ? 0.07 : 0.035) * dt,
      0,
      1,
    );
    this.touchCooldown = Math.max(0, this.touchCooldown - dt);
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
  }
}
