import { vec, len, dist, norm, sub, scale, add, rotate, clamp, angleBetween } from '../core/math';
import { Rng } from '../core/rng';
import { PITCH, SURFACES, Surface } from './constants';
import { Ball } from './ball';
import { PlayerBody, PlayerInput } from './player';
import { SimEvent } from './events';

const KICK_RANGE = 2.0;
const KICK_BUFFER = 0.28;   // released kick fires as soon as the ball is in reach
const CONTACT_RANGE = 0.55; // a real foot's reach — the ball is NEVER played from further
const STEER_RANGE = 0.85;   // toe-stretch reach while veering onto a new line
const CHOP_RANGE = 0.8;     // planting a cut stretches the leg a touch further
const CUSHION_RANGE = 0.8;  // stretching to kill a ball arriving with pace
const MOMENTUM_KEPT = 0.22; // slice of the ball's old velocity surviving a touch

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
      this.handleDribble(p, input);
      this.collideBall(p);
    });

    this.ball.update(dt, this.surface, this.events);
    // Separate again after the ball has moved: every step ENDS with no body
    // overlapping the ball, so you can never run through it
    for (const p of this.players) this.collideBall(p);
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
    // The stick IS the sight: hold any direction and the shot goes exactly
    // there, fully omnidirectional — the body only aims when the stick rests
    const aim = len(input.move) > 0.25 ? norm(input.move) : p.facing;
    // The honesty mechanic: harder shots wobble more — no guaranteed lasers
    const error = this.rng.gauss() * (0.015 + 0.05 * power);
    const dir = rotate(aim, error);

    // Driven, not ballooned: capped pace and a low arc that stays playable
    const speed = 10 + 13 * power;
    this.ball.vel = scale(dir, speed);
    this.ball.vz = power > 0.4 ? (power - 0.4) * 7.5 : 0.4;
    this.ball.z = Math.max(this.ball.z, 0.01);
    p.kickCooldown = 0.4;
    p.touchCooldown = 0.5;
    this.events.push({ kind: 'kick', x: this.ball.pos.x, y: this.ball.pos.y, power });
  }

  // Dribbling, built from nothing but real foot-to-ball contacts. Every touch
  // keeps a slice of the ball's momentum and adds push along the run, so
  // redirects ARC the way a ball comes off a boot — never snapping around a
  // pivot, never played from beyond a leg's reach. Between touches: free ball.
  private handleDribble(p: PlayerBody, input: PlayerInput) {
    const justCut = p.justCut;
    p.justCut = false;
    if (this.ball.z > 0.6) return;
    const d = dist(p.pos, this.ball.pos);
    const touch = (cooldown: number, sprint = false) => {
      p.touchCooldown = cooldown;
      this.events.push({ kind: 'touch', x: this.ball.pos.x, y: this.ball.pos.y, sprint });
    };

    // The chop: planting a hard cut with the ball at your feet knocks it
    // ACROSS the body onto the new running line — aimed at where you're going,
    // not just parallel to it, or you'd jog beside a ball you can't reach.
    // The plant foot strikes on its own timing, never blocked by the tap rhythm.
    if (justCut && d < CHOP_RANGE) {
      const ontoLane = norm(sub(add(p.pos, scale(p.cutDir, 1.6)), this.ball.pos));
      this.ball.vel = add(scale(this.ball.vel, MOMENTUM_KEPT), scale(ontoLane, p.speed() * 1.3 + 1.2));
      return touch(0.14);
    }

    if (p.touchCooldown > 0 || d > CUSHION_RANGE) return;

    const rel = sub(this.ball.vel, p.vel);
    const toBall = sub(this.ball.pos, p.pos);
    const closing = d > 1e-6 ? -(rel.x * toBall.x + rel.y * toBall.y) / d : 0;

    // A ball arriving with pace gets cushioned dead off the boot
    if (closing > 5) {
      const keep = 0.2 - 0.1 * p.stats.control;
      this.ball.vel = add(p.vel, scale(rel, keep));
      if (p.speed() > 0.8) this.ball.vel = add(this.ball.vel, scale(p.facing, 1.2)); // drop it into stride
      return touch(0.22);
    }

    const pSpeed = p.speed();
    if (pSpeed > 0.8) {
      // Soft taps at a jog keep it in stride; sprint knocks push it on ahead;
      // charging keeps it tucked under the plant foot for the strike.
      // Taps aim where you're STEERING, not where momentum drags you — press a
      // new direction mid-dribble and the next touch plays it that way, with a
      // stretched toe-poke reach while the ball is drifting off your new line.
      const steer = len(input.move) > 0.3 ? norm(input.move) : norm(p.vel);
      const veering = this.ball.speed() > 0.6 && angleBetween(this.ball.vel, steer) > 0.3;
      if (d > (veering ? STEER_RANGE : CONTACT_RANGE)) return;
      const soft = p.isCharging || p.pendingKick;
      // Touches stay close: the ball works ahead of the boot, never away from it
      const target = pSpeed * (soft ? 0.95 : p.isSprinting ? 1.16 : 1.02) + (soft ? 0.2 : p.isSprinting ? 0.55 : 0.42);
      const wobble = this.rng.gauss() * (0.09 - 0.05 * p.stats.control);
      this.ball.vel = add(
        scale(this.ball.vel, MOMENTUM_KEPT),
        scale(rotate(steer, wobble), target * (1 - MOMENTUM_KEPT)),
      );
      touch(veering ? 0.1 : p.isSprinting ? 0.15 : 0.1, p.isSprinting);
    } else if (d < CONTACT_RANGE && this.ball.speed() > 1.0) {
      // Standing trap: kill most of the pace, let the rest roll off the boot
      this.ball.vel = add(scale(this.ball.vel, 0.25), scale(p.facing, 0.3));
      touch(0.28);
    }
  }

  // Bodies never pass through the ball: the keep-out ring sits just past the
  // ball's drawn edge, so what you see is what you collide with
  private collideBall(p: PlayerBody) {
    const away = sub(this.ball.pos, p.pos);
    let d = len(away);
    if (d > 0.42 || this.ball.z > 1.5) return;
    // Dead-centered overlap still resolves — shove it out along the run
    const push = d < 1e-6 ? (p.speed() > 0.1 ? norm(p.vel) : vec(1, 0)) : norm(away);
    this.ball.pos = add(p.pos, scale(push, 0.42));
    const radialSpeed = this.ball.vel.x * push.x + this.ball.vel.y * push.y;
    if (radialSpeed < 0) {
      this.ball.vel = add(this.ball.vel, scale(push, -radialSpeed * 1.15));
    }
    // A body plowing into a slow ball knocks it along instead of ghosting it
    const approach = p.vel.x * push.x + p.vel.y * push.y;
    if (approach > 0 && radialSpeed < approach) {
      this.ball.vel = add(this.ball.vel, scale(push, (approach - Math.max(0, radialSpeed)) * 0.55));
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
