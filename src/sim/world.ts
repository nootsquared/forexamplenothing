import { vec, len, dist, norm, sub, scale, add, rotate, clamp, angleBetween } from '../core/math';
import { Rng } from '../core/rng';
import { PITCH, SURFACES, Surface } from './constants';
import { Ball } from './ball';
import { PlayerBody, PlayerInput } from './player';
import { SimEvent } from './events';

const KICK_RANGE = 2.0;
const KICK_BUFFER = 0.28; // released kick fires as soon as the ball is in reach
const TOUCH_RANGE = 0.6;  // the foot's reach for a dribble knock
const TURN_RANGE = 1.25;  // longer reach to drag the ball around a turn — covers the knock lead at jog
const TRAP_RANGE = 0.85;  // the foot's reach for killing an incoming ball

export class World {
  ball = new Ball();
  players: PlayerBody[] = [];
  surface: Surface = SURFACES.grass;
  events: SimEvent[] = [];
  score = { left: 0, right: 0 };
  private rng = new Rng(20260731);
  private goalScored = false;
  private goalResetT = 0;

  step(dt: number, inputs: PlayerInput[]) {
    this.events.length = 0;
    this.ball.savePrev();
    for (const p of this.players) p.savePrev();

    this.players.forEach((p, i) => {
      const input = inputs[i] ?? { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      p.update(dt, input, this.events);
      this.handleKick(p, input, dt);
      this.handleDribble(p);
      this.collideBall(p);
    });

    this.ball.update(dt, this.surface, this.events);
    this.handleGoalsAndBounds(dt);
  }

  private handleKick(p: PlayerBody, input: PlayerInput, dt: number) {
    if (input.kickReleased) {
      p.pendingKick = { power: input.kickReleased.power, ttl: KICK_BUFFER };
    }
    if (!p.pendingKick) return;
    p.pendingKick.ttl -= dt;
    if (p.pendingKick.ttl <= 0) {
      p.pendingKick = null;
      return;
    }
    if (p.kickCooldown > 0) return;
    if (dist(p.pos, this.ball.pos) > KICK_RANGE || this.ball.z > 1.2) return;

    const power = clamp(p.pendingKick.power, 0.1, 1) * (0.75 + 0.25 * p.stats.power);
    p.pendingKick = null;
    const aim = len(input.move) > 0.3 ? norm(input.move) : p.facing;
    // The honesty mechanic: harder shots wobble more — no guaranteed lasers
    const error = this.rng.gauss() * (0.015 + 0.05 * power);
    const dir = rotate(aim, error);

    const speed = 11 + 19 * power;
    this.ball.vel = scale(dir, speed);
    this.ball.vz = power > 0.4 ? (power - 0.4) * 12 : 0.5;
    this.ball.z = Math.max(this.ball.z, 0.01);
    p.kickCooldown = 0.4;
    p.touchCooldown = 0.5;
    this.events.push({ kind: 'kick', x: this.ball.pos.x, y: this.ball.pos.y, power });
  }

  // Real dribbling: the foot KNOCKS the ball ahead and it rolls free until the
  // player catches up. Pace decides how far each touch runs — sprinting pushes
  // it further out, charging keeps it tucked for the strike. Never magnetized.
  private handleDribble(p: PlayerBody) {
    if (p.touchCooldown > 0 || this.ball.z > 0.6) return;
    const d = dist(p.pos, this.ball.pos);
    if (d > Math.max(TRAP_RANGE, TURN_RANGE)) return;
    const rel = sub(this.ball.vel, p.vel);
    const toBall = sub(this.ball.pos, p.pos);
    const closing = d > 1e-6 ? -(rel.x * toBall.x + rel.y * toBall.y) / d : 0;

    // First touch: a fast incoming ball is cushioned dead instead of ricocheting
    if (closing > 5 && d < TRAP_RANGE) {
      const keep = 0.18 - 0.1 * p.stats.control;
      this.ball.vel = add(p.vel, scale(rel, keep));
      if (p.speed() > 0.8) this.ball.vel = add(this.ball.vel, scale(p.facing, 1.4)); // drop it into stride
      p.touchCooldown = 0.22;
      this.events.push({ kind: 'touch', x: this.ball.pos.x, y: this.ball.pos.y, sprint: false });
      return;
    }
    const pSpeed = p.speed();
    if (pSpeed > 0.8) {
      const moveDir = norm(p.vel);
      // Off the running lane — sideways after a cut, or rolling the wrong way?
      // The foot reaches further and DRAGS the ball back onto the line ahead,
      // so you carry it through corners instead of watching it escape
      const lateral = Math.abs(moveDir.x * toBall.y - moveDir.y * toBall.x);
      const misaligned = this.ball.speed() > 0.6 && angleBetween(this.ball.vel, moveDir) > 0.55;
      const offLane = lateral > 0.45 || misaligned;
      if (d > (offLane ? TURN_RANGE : TOUCH_RANGE)) return;
      const wobble = this.rng.gauss() * (0.1 - 0.055 * p.stats.control);
      let dir = moveDir;
      let knock = pSpeed * (p.isCharging || p.pendingKick ? 1.04 : p.isSprinting ? 1.32 : 1.16) + 0.7;
      if (offLane) {
        dir = norm(sub(add(p.pos, scale(moveDir, 1.1)), this.ball.pos));
        knock = pSpeed * 1.02 + 0.6;
      }
      this.ball.vel = scale(rotate(dir, wobble), knock);
      p.touchCooldown = offLane ? 0.12 : 0.15;
      this.events.push({ kind: 'touch', x: this.ball.pos.x, y: this.ball.pos.y, sprint: p.isSprinting });
    } else if (d < TOUCH_RANGE && this.ball.speed() > 1.2) {
      // Standing trap: kill most of the pace, let the rest roll off the boot
      this.ball.vel = add(scale(this.ball.vel, 0.28), scale(p.facing, 0.35));
      p.touchCooldown = 0.25;
      this.events.push({ kind: 'touch', x: this.ball.pos.x, y: this.ball.pos.y, sprint: false });
    }
  }

  // The ball never tunnels through a player's feet — a nudge, not a force field
  private collideBall(p: PlayerBody) {
    const away = sub(this.ball.pos, p.pos);
    const d = len(away);
    if (d > 0.3 || this.ball.z > 1.1 || d < 1e-6) return;
    const push = norm(away);
    this.ball.pos = add(p.pos, scale(push, 0.3));
    const radialSpeed = this.ball.vel.x * push.x + this.ball.vel.y * push.y;
    if (radialSpeed < 0) {
      this.ball.vel = add(this.ball.vel, scale(push, -radialSpeed * 1.15));
    }
  }

  private handleGoalsAndBounds(dt: number) {
    const b = this.ball;
    const halfMouth = PITCH.goalWidth / 2;
    const inMouth = Math.abs(b.pos.y - PITCH.width / 2) < halfMouth && b.z < PITCH.goalHeight;

    if (!this.goalScored && inMouth && (b.pos.x < 0 || b.pos.x > PITCH.length)) {
      const side = b.pos.x < 0 ? 'left' : 'right';
      this.score[side === 'left' ? 'right' : 'left']++;
      this.goalScored = true;
      this.goalResetT = 1.5; // a beat to savor it before the spot restart
      this.events.push({ kind: 'goal', side });
      return;
    }

    if (this.goalScored) {
      // Ball dies in the net, then match restarts from the spot
      b.vel = scale(b.vel, 0.82);
      const inLeftNet = b.pos.x < PITCH.length / 2;
      const netBackX = inLeftNet ? -PITCH.goalDepth + 0.15 : PITCH.length + PITCH.goalDepth - 0.15;
      const hitBackNet = inLeftNet ? b.pos.x < netBackX : b.pos.x > netBackX;
      if (hitBackNet) {
        b.pos.x = netBackX;
        b.vel.x *= -0.1;
      }
      this.goalResetT -= dt;
      if (this.goalResetT <= 0 && b.speed() < 2) this.resetAfterGoal();
      return;
    }

    // Temporary training-arena walls until throw-ins land in M2
    const minX = -1.5;
    const maxX = PITCH.length + 1.5;
    const minY = -1.5;
    const maxY = PITCH.width + 1.5;
    if (!inMouth) {
      if (b.pos.x < minX) { b.pos.x = minX; b.vel.x *= -0.55; }
      if (b.pos.x > maxX) { b.pos.x = maxX; b.vel.x *= -0.55; }
    }
    if (b.pos.y < minY) { b.pos.y = minY; b.vel.y *= -0.55; }
    if (b.pos.y > maxY) { b.pos.y = maxY; b.vel.y *= -0.55; }
  }

  private resetAfterGoal() {
    this.goalScored = false;
    this.ball.pos = vec(PITCH.length / 2, PITCH.width / 2);
    this.ball.vel = vec();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.savePrev();
    // Everyone jogs back to their kickoff spots — a match, not a scramble
    for (const p of this.players) {
      p.pos = vec(p.home.x, p.home.y);
      p.vel = vec();
      p.facing = vec(p.home.x <= PITCH.length / 2 ? 1 : -1, 0);
      p.stamina = Math.max(p.stamina, 0.6);
      p.savePrev();
    }
  }
}
