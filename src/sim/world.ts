import { vec, len, dist, norm, sub, scale, add, rotate, clamp, angleBetween, signedAngle, perpRight, Vec2 } from '../core/math';
import { Rng } from '../core/rng';
import { GRAVITY, PITCH, SURFACES, Surface } from './constants';
import { Ball } from './ball';
import { PlayerBody, PlayerInput } from './player';
import { SimEvent } from './events';

const KICK_RANGE = 2.0;
const KICK_BUFFER = 0.28;    // released kick fires as soon as the ball is in reach
const BALL_KEEPOUT = 0.52;   // body ring past the ball's DRAWN edge — sprites never interpenetrate
const CONTACT_RANGE = 0.6;   // a real foot's reach — the ball is NEVER played from further
const STEER_RANGE = 1.0;     // toe-stretch reach while veering onto a new line
const COLLECT_RANGE = 1.35;  // the sole-drag around the body on a hard turn reaches further
const CHOP_RANGE = 0.85;     // planting a cut stretches the leg a touch further
const CUSHION_RANGE = 1.0;   // stretching to kill a ball arriving with pace
const MOMENTUM_KEPT = 0.22;  // slice of the ball's old velocity surviving a touch
const FOOT_LANE = 0.16;      // the dominant foot's lane sits this far right of the run line
const KNOCK_CONE = 0.8;      // a touch can redirect at most this far off the run (rad)
const AIM_BEND_MAX = 1.31;   // ~75°: shots angle across the body, never backward
const PLAYER_R = 0.28;       // body radius against goal frames
const BALL_R = 0.13;

export class World {
  ball = new Ball();
  players: PlayerBody[] = [];
  surface: Surface = SURFACES.grass;
  events: SimEvent[] = [];
  score = { left: 0, right: 0 };
  // Who last played the ball — feeds restarts and pass-follow control
  lastTouch: { team: 0 | 1; idx: number } | null = null;
  restartLock = 0; // dead-ball beat after a restart is placed
  // The restart law: the other team gives the dead ball this much space
  restartExclusion = 0;
  // An aiming keeper pins the beat open (capped — nobody stalls a match)
  holdLock = false;
  private holdT = 0;
  private rng = new Rng(20260731);
  private goalScored = false;
  private goalResetT = 0;

  step(dt: number, inputs: PlayerInput[]) {
    this.events.length = 0;
    this.ball.savePrev();
    for (const p of this.players) p.savePrev();

    const ballLive = this.restartLock <= 0;
    this.players.forEach((p, i) => {
      const input = inputs[i] ?? { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      p.update(dt, input, this.events);
      if (!ballLive) return;
      this.handleKick(p, input, dt, i);
      this.resolveLunge(p, i);
      this.handleDribble(p, input, i);
      this.collideBall(p, i);
    });
    this.separateBodies();

    if (ballLive) {
      this.ball.update(dt, this.surface, this.events);
      // Separate again after the ball has moved: every step ENDS with no body
      // overlapping the ball, so you can never run through it
      this.players.forEach((p, i) => this.collideBall(p, i));
    } else {
      this.restartLock -= dt;
      if (this.holdLock && this.restartLock <= 0.05 && this.holdT < 10) {
        this.restartLock = 0.05; // the keeper is still picking his ball out
        this.holdT += dt;
      }
      if (this.restartLock <= 0) {
        this.holdLock = false;
        this.holdT = 0;
        this.restartExclusion = 0;
      }
      // The other team WALKS out of the mandated space — no jumped restarts
      if (this.restartExclusion > 0 && this.lastTouch) {
        for (const p of this.players) {
          if (p.id.team === this.lastTouch.team) continue;
          const away = sub(p.pos, this.ball.pos);
          const d = len(away);
          if (d < this.restartExclusion) {
            const out = d < 1e-6 ? vec(1, 0) : norm(away);
            p.pos = add(p.pos, scale(out, Math.min(12 * dt, this.restartExclusion - d)));
          }
        }
      }
      this.ball.vel = vec();
      this.ball.savePrev();
    }
    this.collideGoalFrames();
    this.handleGoalsAndBounds(dt);
  }

  // Distribution from the keeper's hands: a THROW is flat and true, a PUNT is
  // a towering ball that lands somewhere in a scatter zone — his stats, his odds
  gkLaunch(idx: number, target: Vec2, kind: 'throw' | 'punt', scatter: number) {
    const p = this.players[idx];
    const ang = this.rng.next() * Math.PI * 2;
    const centering = 0.5 + 0.6 * p.stats.control; // higher = misses hug the target
    const r = scatter * Math.pow(this.rng.next(), centering);
    const land = vec(
      clamp(target.x + Math.cos(ang) * r, 1, PITCH.length - 1),
      clamp(target.y + Math.sin(ang) * r, 1, PITCH.width - 1),
    );
    const d = dist(this.ball.pos, land);
    const dir = d > 1e-4 ? norm(sub(land, this.ball.pos)) : vec(p.id.team === 0 ? 1 : -1, 0);
    if (kind === 'throw') {
      this.ball.vel = scale(dir, clamp(9 + d * 0.42, 9, 24));
      this.ball.vz = 0.5;
    } else {
      const vz = 13.5; // a real punt HANGS — and can reach the far box
      const hang = (2 * vz) / GRAVITY;
      this.ball.vel = scale(dir, clamp((d / hang) * 1.04, 8, 75)); // 1.04 pays the air drag
      this.ball.vz = vz;
      this.ball.deadenOnLand = true; // it drops and sits, not skids into touch
    }
    this.ball.z = 1.1;
    this.ball.spin = 0;
    this.restartLock = 0;
    this.holdLock = false;
    this.holdT = 0;
    this.restartExclusion = 0;
    p.kickCooldown = 0.5;
    p.touchCooldown = 0.6;
    this.lastTouch = { team: p.id.team, idx };
    this.events.push({ kind: 'kick', x: this.ball.pos.x, y: this.ball.pos.y, power: kind === 'punt' ? 0.9 : 0.4, idx });
  }

  // The player currently in playing contact with the ball, if any
  possessor(): number | null {
    if (this.ball.z > 0.6) return null;
    let best: number | null = null;
    let bestD = 1.0;
    this.players.forEach((p, i) => {
      const d = dist(p.pos, this.ball.pos);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // A lunge in flight wins any ball it reaches — clean by design, no fouls.
  // The poke slips the ball SIDEWAYS past the carrier, never back into their
  // shins: a dispossession changes the play's direction, it doesn't ping-pong.
  private resolveLunge(p: PlayerBody, idx: number) {
    if (p.lungeTimer <= 0 || this.ball.z > (p.id.role === 'GK' ? 1.6 : 0.8)) return;
    if (dist(p.pos, this.ball.pos) > (p.id.role === 'GK' ? 1.15 : 0.8)) return;
    // A keeper's lunge is a SAVE: hands, not feet. The ball dies in the
    // gloves, the game takes a breath, then he picks his distribution.
    if (p.id.role === 'GK') {
      this.ball.vel = vec();
      this.ball.z = 0;
      this.ball.vz = 0;
      this.ball.spin = 0;
      this.ball.savePrev();
      p.lungeTimer = 0;
      p.touchCooldown = 0.2;
      this.restartLock = 0.85;
      this.restartExclusion = 6.5;
      this.lastTouch = { team: p.id.team, idx };
      this.events.push({ kind: 'save', x: this.ball.pos.x, y: this.ball.pos.y });
      return;
    }
    let dir = p.speed() > 0.5 ? norm(p.vel) : p.facing;
    const carrierIdx = this.possessor();
    if (carrierIdx !== null && this.players[carrierIdx].id.team !== p.id.team) {
      const carrier = this.players[carrierIdx];
      const axis = norm(sub(carrier.pos, p.pos));
      const toBall = sub(this.ball.pos, p.pos);
      const side = axis.x * toBall.y - axis.y * toBall.x >= 0 ? 1 : -1;
      dir = norm(add(scale(axis, 0.55), scale(perpRight(axis), side * 0.85)));
    }
    this.ball.vel = add(scale(dir, 6.5), scale(p.vel, 0.2));
    this.ball.spin = 0;
    p.lungeTimer = 0;       // won it — no recovery penalty
    p.touchCooldown = 0.15; // and the ball is instantly yours to run onto
    if (carrierIdx !== null && this.players[carrierIdx].id.team !== p.id.team) {
      // Beaten: the old carrier can't just re-tap it back — the win means something
      const carrier = this.players[carrierIdx];
      carrier.touchCooldown = Math.max(carrier.touchCooldown, 0.5);
      carrier.playLock = Math.max(carrier.playLock, 0.5);
    }
    this.lastTouch = { team: p.id.team, idx };
    this.events.push({ kind: 'steal', x: this.ball.pos.x, y: this.ball.pos.y });
  }

  // Bodies shoulder each other aside instead of stacking — 22 solid players
  private separateBodies() {
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        const away = sub(b.pos, a.pos);
        const d = len(away);
        if (d > 0.5 || d < 1e-6) continue;
        const push = scale(norm(away), (0.5 - d) / 2);
        a.pos = sub(a.pos, push);
        b.pos = add(b.pos, push);
      }
    }
  }

  private handleKick(p: PlayerBody, input: PlayerInput, dt: number, idx: number) {
    if (input.kickReleased) {
      p.pendingKick = {
        power: input.kickReleased.power,
        bend: input.kickReleased.aimOffset ?? 0,
        aimAt: input.kickReleased.aimAt,
        ttl: KICK_BUFFER,
      };
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
    const bend = clamp(p.pendingKick.bend, -AIM_BEND_MAX, AIM_BEND_MAX);
    const at = p.pendingKick.aimAt;
    p.pendingKick = null;
    // The stick IS the sight: hold any direction and the shot goes exactly
    // there. J/L bend the aim off that line — strike across the body without
    // breaking stride, and the cut across the ball CURLS its flight. A mouse
    // kick names a field POINT instead, and the ball leaves toward it.
    const toAt = at ? sub(at, this.ball.pos) : null;
    const aim = toAt && len(toAt) > 0.5
      ? norm(toAt)
      : rotate(len(input.move) > 0.25 ? norm(input.move) : p.facing, bend);
    // The honesty mechanic: harder shots wobble more — no guaranteed lasers
    const error = this.rng.gauss() * (0.015 + 0.05 * power);
    const dir = rotate(aim, error);

    // Driven, not ballooned: capped pace and a low arc that stays playable
    const speed = 10 + 14 * power;
    this.ball.deadenOnLand = false; // a fresh strike overrides any punt drop
    this.ball.vel = scale(dir, speed);
    this.ball.spin = bend * (0.5 + 0.5 * power) * 0.62;
    this.ball.vz = power > 0.4 ? (power - 0.4) * 7.5 : 0.4;
    this.ball.z = Math.max(this.ball.z, 0.01);
    p.kickCooldown = 0.4;
    p.touchCooldown = 0.5;
    p.playLock = 0.45;
    this.lastTouch = { team: p.id.team, idx };
    this.events.push({ kind: 'kick', x: this.ball.pos.x, y: this.ball.pos.y, power, idx });
  }

  // Dribbling, built from nothing but real foot-to-ball contacts. Every touch
  // keeps a slice of the ball's momentum and adds push along the run, so
  // redirects ARC the way a ball comes off a boot — never snapping around a
  // pivot, never played from beyond a leg's reach. Between touches: free ball.
  private handleDribble(p: PlayerBody, input: PlayerInput, idx: number) {
    const justCut = p.justCut;
    p.justCut = false;
    if (this.ball.z > 0.6) return;
    const d = dist(p.pos, this.ball.pos);
    const touch = (cooldown: number, sprint = false) => {
      p.touchCooldown = cooldown;
      this.ball.spin = 0; // any touch kills the curl
      this.lastTouch = { team: p.id.team, idx };
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
    const steer = len(input.move) > 0.3 ? norm(input.move) : p.speed() > 0.5 ? norm(p.vel) : p.facing;

    // A ball arriving with pace gets cushioned dead off the boot — dropped
    // into the stride you're STEERING, and released quickly so the very next
    // touch (a turn, a knock-on) comes without a dead beat. The trap is
    // FORGIVING: nearly all arriving pace dies, and the drop follows the
    // direction you're pressing — receive-and-turn is a play, not a coin flip.
    // Steering AGAINST your own stride (the 180 receive) also kills the drift
    // the ball would inherit from your body: it plants at the turn, with you.
    if (closing > 5) {
      const keep = 0.11 - 0.06 * p.stats.control;
      const pv = p.speed();
      const align = pv > 0.5 ? clamp((p.vel.x * steer.x + p.vel.y * steer.y) / pv, -1, 1) : 1;
      this.ball.vel = add(scale(p.vel, 0.62 + 0.38 * align), scale(rel, keep));
      this.ball.vel = add(this.ball.vel, scale(steer, pv > 0.8 ? 1.5 : 0.7));
      return touch(0.1);
    }

    // Turning with the ball: when it sits on the WRONG side of the new
    // direction, a straight knock would cannon it off your own shins and
    // ping-pong forever. Real feet DRAG it around: a stretched sole-roll along
    // the body ring toward the front of the run, then normal touches take over.
    // Only while genuinely steering — an idle body never stirs the ball.
    const behind = d > 1e-6 && (toBall.x * steer.x + toBall.y * steer.y) / d < 0.1;
    if (behind && len(input.move) > 0.3 && d < COLLECT_RANGE && this.ball.speed() < 7.5) {
      // Aim the collect at a spot ahead-BESIDE the run, on the side the ball
      // already leans: its straight path skims the body ring, the roll-around
      // carries it to the front, and the pivot costs a beat of pace — you
      // turn around the ball, you don't outrun your own feet.
      const side = toBall.x * steer.y - toBall.y * steer.x >= 0 ? -1 : 1;
      const collectAt = add(add(p.pos, scale(steer, 0.9)), scale(perpRight(steer), side * 0.4));
      this.ball.vel = add(
        scale(this.ball.vel, 0.15),
        scale(norm(sub(collectAt, this.ball.pos)), Math.max(p.speed(), 3.4) * 0.95 + 1.6),
      );
      p.vel = scale(p.vel, 0.85);
      return touch(0.08);
    }

    const pSpeed = p.speed();
    if (pSpeed > 0.8) {
      // Soft taps at a jog keep it in stride; sprint knocks push it on ahead;
      // charging keeps it tucked under the plant foot for the strike.
      // Taps aim where you're STEERING, not where momentum drags you — press a
      // new direction mid-dribble and the next touch plays it that way, with a
      // stretched toe-poke reach while the ball is drifting off your new line.
      const veering = this.ball.speed() > 0.6 && angleBetween(this.ball.vel, steer) > 0.3;
      if (d > (veering ? STEER_RANGE : CONTACT_RANGE)) return;
      const soft = p.isCharging || p.pendingKick;
      // Touches stay close: the ball works ahead of the boot, never away from it
      const target = pSpeed * (soft ? 0.95 : p.isSprinting ? 1.16 : 1.02) + (soft ? 0.2 : p.isSprinting ? 0.55 : 0.42);
      // Every touch CONVERGES on the dominant-foot lane — a point ahead-right
      // of the run — so a ball caught on the wrong foot or the edge of the
      // boot comes back across in a knock or two instead of bleeding away.
      // The cone cap keeps it a touch, not a tether: turn too hard, still lose it.
      const lane = add(add(p.pos, scale(steer, soft ? 0.8 : p.isSprinting ? 1.5 : 1.1)), scale(perpRight(steer), FOOT_LANE));
      const toLane = sub(lane, this.ball.pos);
      const knock = len(toLane) > 0.05
        ? rotate(steer, clamp(signedAngle(steer, toLane), -KNOCK_CONE, KNOCK_CONE))
        : steer;
      const wobble = this.rng.gauss() * (0.09 - 0.05 * p.stats.control);
      this.ball.vel = add(
        scale(this.ball.vel, MOMENTUM_KEPT),
        scale(rotate(knock, wobble), target * (1 - MOMENTUM_KEPT)),
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
  private collideBall(p: PlayerBody, idx: number) {
    const away = sub(this.ball.pos, p.pos);
    const d = len(away);
    if (d > BALL_KEEPOUT || this.ball.z > 1.5) return;
    this.lastTouch = { team: p.id.team, idx };
    // Dead-centered overlap still resolves — shove it out along the run
    let push = d < 1e-6 ? (p.speed() > 0.1 ? norm(p.vel) : vec(1, 0)) : norm(away);
    // A moving body ROLLS the ball around toward the front of the run instead
    // of shoving it square off the boot — but only while this body may PLAY
    // the ball. Freshly dispossessed or mid-kick-recovery, separation is
    // purely radial: solid, never steering.
    const mayPlay = p.playLock <= 0;
    if (mayPlay && p.speed() > 0.5) push = norm(add(push, scale(norm(p.vel), 0.85)));
    this.ball.pos = add(p.pos, scale(push, BALL_KEEPOUT));
    const radialSpeed = this.ball.vel.x * push.x + this.ball.vel.y * push.y;
    if (radialSpeed < 0) {
      this.ball.vel = add(this.ball.vel, scale(push, -radialSpeed * 1.15));
    }
    // A body plowing into a slow ball knocks it along instead of ghosting it
    const approach = p.vel.x * push.x + p.vel.y * push.y;
    if (mayPlay && approach > 0 && radialSpeed < approach) {
      this.ball.vel = add(this.ball.vel, scale(push, (approach - Math.max(0, radialSpeed)) * 0.55));
    }
  }

  // The goal is FURNITURE: posts ping, side and back netting stop both bodies
  // and ball dead — nothing on the pitch walks or rolls through the rigging.
  // The mouth stays open, so shots score and keepers chase balls in.
  private collideGoalFrames() {
    for (const sgn of [-1, 1]) {
      const lineX = sgn < 0 ? 0 : PITCH.length;
      const backX = lineX + sgn * PITCH.goalDepth;
      const yFar = PITCH.width / 2 - PITCH.goalWidth / 2;
      const yNear = PITCH.width / 2 + PITCH.goalWidth / 2;
      const walls: [Vec2, Vec2][] = [
        [vec(backX, yFar), vec(backX, yNear)], // back net
        [vec(backX, yFar), vec(lineX, yFar)],  // far side net
        [vec(backX, yNear), vec(lineX, yNear)], // near side net
      ];

      for (const p of this.players) {
        for (const [a, b] of walls) this.pushOffWall(p.pos, p.vel, a, b, PLAYER_R, 0);
        for (const post of [vec(lineX, yFar), vec(lineX, yNear)]) {
          this.pushOffWall(p.pos, p.vel, post, post, PLAYER_R + 0.06, 0);
        }
      }
      if (this.ball.z < PITCH.goalHeight) {
        for (const [a, b] of walls) this.pushOffWall(this.ball.pos, this.ball.vel, a, b, BALL_R, 0.3);
        for (const post of [vec(lineX, yFar), vec(lineX, yNear)]) {
          // Off the woodwork! Posts ping instead of absorbing like net cord
          if (this.pushOffWall(this.ball.pos, this.ball.vel, post, post, BALL_R + 0.06, 0.72) && this.ball.speed() > 6) {
            this.events.push({ kind: 'bounce', x: this.ball.pos.x, y: this.ball.pos.y, impact: this.ball.speed() * 0.5 });
          }
        }
      }
    }
  }

  // Circle-vs-segment resolve: shove the body out and cancel (or reflect with
  // `rest`) the velocity component driving into the wall. Returns true on hit.
  private pushOffWall(pos: Vec2, vel: Vec2, a: Vec2, b: Vec2, radius: number, rest: number): boolean {
    const ab = sub(b, a);
    const abLen2 = ab.x * ab.x + ab.y * ab.y;
    const t = abLen2 < 1e-9 ? 0 : clamp(((pos.x - a.x) * ab.x + (pos.y - a.y) * ab.y) / abLen2, 0, 1);
    const closest = add(a, scale(ab, t));
    const away = sub(pos, closest);
    const d = len(away);
    if (d >= radius) return false;
    const n = d < 1e-6 ? vec(0, 1) : norm(away);
    pos.x = closest.x + n.x * radius;
    pos.y = closest.y + n.y * radius;
    const into = vel.x * n.x + vel.y * n.y;
    if (into < 0) {
      vel.x -= n.x * into * (1 + rest);
      vel.y -= n.y * into * (1 + rest);
    }
    return true;
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
      // The net rigging catches it; the ball just dies in there, then restart
      b.vel = scale(b.vel, 0.82);
      this.goalResetT -= dt;
      if (this.goalResetT <= 0 && b.speed() < 2) this.resetAfterGoal();
      return;
    }

    // Fast arcade restarts — the ball never bounces off invisible walls
    if (b.pos.y < -0.2) return this.awardRestart(vec(clamp(b.pos.x, 1, PITCH.length - 1), 0.3), this.throwInTeam(), 'throwin');
    if (b.pos.y > PITCH.width + 0.2) return this.awardRestart(vec(clamp(b.pos.x, 1, PITCH.length - 1), PITCH.width - 0.3), this.throwInTeam(), 'throwin');
    if (!inMouth && (b.pos.x < -0.25 || b.pos.x > PITCH.length + 0.25)) {
      const leftEnd = b.pos.x < 0;
      const defender: 0 | 1 = leftEnd ? 0 : 1;
      if (this.lastTouch && this.lastTouch.team === defender) {
        // Corner for the attackers, from the corner arc they earned
        const cx = leftEnd ? 0.4 : PITCH.length - 0.4;
        const cy = b.pos.y < PITCH.width / 2 ? 0.4 : PITCH.width - 0.4;
        return this.awardRestart(vec(cx, cy), defender === 0 ? 1 : 0, 'corner');
      }
      // Goal kick: the keeper plays out from the edge of the box
      return this.awardRestart(vec(leftEnd ? 5.5 : PITCH.length - 5.5, PITCH.width / 2), defender, 'goalkick');
    }
  }

  private throwInTeam(): 0 | 1 {
    return this.lastTouch ? (this.lastTouch.team === 0 ? 1 : 0) : 0;
  }

  // Place the ball dead, set the right taker walking onto it (the KEEPER for
  // goal kicks), and give the moment a broadcast beat before play resumes
  private awardRestart(spot: Vec2, team: 0 | 1, restart: 'throwin' | 'corner' | 'goalkick') {
    let taker = -1;
    let bestD = Infinity;
    this.players.forEach((p, i) => {
      if (p.id.team !== team) return;
      const isGK = p.id.role === 'GK';
      if (restart === 'goalkick' ? !isGK : isGK) return;
      const d = dist(p.pos, spot);
      if (d < bestD) { bestD = d; taker = i; }
    });
    this.ball.pos = vec(spot.x, spot.y);
    this.ball.vel = vec();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.ball.savePrev();
    if (taker >= 0) {
      const p = this.players[taker];
      const inward = norm(sub(vec(PITCH.length / 2, PITCH.width / 2), spot));
      // Near the spot, not ON it — the taker walks the last steps during the beat
      p.pos = sub(vec(spot.x, spot.y), scale(inward, 1.6));
      p.vel = vec();
      p.facing = inward;
      p.savePrev();
    }
    this.restartLock = 1.25;
    this.restartExclusion = restart === 'goalkick' ? 11 : 6.5;
    this.lastTouch = taker >= 0 ? { team, idx: taker } : null;
    this.events.push({ kind: 'restart', taker, team, restart });
  }

  private resetAfterGoal() {
    this.goalScored = false;
    this.ball.pos = vec(PITCH.length / 2, PITCH.width / 2);
    this.ball.vel = vec();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.ball.savePrev();
    // Everyone jogs back to their kickoff spots — a match, not a scramble
    for (const p of this.players) {
      p.pos = vec(p.home.x, p.home.y);
      p.vel = vec();
      p.facing = vec(p.id.team === 0 ? 1 : -1, 0);
      p.stamina = Math.max(p.stamina, 0.6);
      p.savePrev();
    }
    this.lastTouch = null;
    this.restartLock = 1.1; // a kickoff beat before the next chapter
    this.events.push({ kind: 'kickoff' });
  }
}
