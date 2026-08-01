import { Vec2, vec, len, dist, norm, sub, add, scale, clamp, angleBetween } from '../core/math';
import { Rng } from '../core/rng';
import { PITCH } from '../sim/constants';
import { World } from '../sim/world';
import { PlayerBody, PlayerInput } from '../sim/player';
import { TeamBrain } from './blackboard';

// One brain per body. Thinks at ~10Hz (staggered so ~4 brains think per frame),
// steers at 60Hz, and acts ONLY through PlayerInput — the exact interface a
// human uses, so control handoff is seamless and the AI can never cheat.
//
// Tactics are EMERGENT, never scripted: called passes give every ball in
// flight one owner, released passers burst beyond their marker (one-twos
// happen by themselves), wingers drive the chalk and cut it back, strikers
// shoot when the lane shows and lay off when it doesn't, and committed runs
// with personal wander kill the robot-lockstep look.
//
// Perception is asymmetric by design: own team is ground truth (plus the
// blackboard), opponents exist only as decaying beliefs from a vision cone —
// blind-side runs genuinely work.

const THINK_TICKS = 6;
const VISION_NEAR = 12;   // meters: sensed all around, no cone needed
const VISION_FAR = 40;    // meters: seen only inside the facing cone
const VISION_HALF_ANGLE = 1.92; // ~110° each side
const BELIEF_MAX_AGE = 2.5;
const LANE_REJECT = 0.3;  // passes through lanes more blocked than this are refused

type Intent =
  | { kind: 'hold' }
  | { kind: 'goto'; target: Vec2; sprint: boolean }
  | { kind: 'chase'; sprint: boolean }   // live ball pursuit, retargeted every tick
  | { kind: 'cover' }                    // live goal-side screen behind the press
  | { kind: 'keeper' };                  // live arc positioning

interface Belief {
  pos: Vec2;
  age: number;
}

export class Brain {
  private intent: Intent = { kind: 'hold' };
  private kickPlan: { aim: Vec2; power: number; windup: number } | null = null;
  private beliefs = new Map<number, Belief>();
  private thinkIn: number;
  private rng: Rng;
  private t = 0;          // personal clock — wander and desync live here
  private commit = 0;     // seconds the current run is promised for
  private burst = 0;      // give-and-go window after releasing a pass
  private lastPhase = 'loose';
  private wanderSeed: number;

  constructor(private idx: number, private bb: TeamBrain) {
    this.thinkIn = idx % THINK_TICKS;
    this.rng = new Rng(0xa11ce + idx * 7919);
    this.wanderSeed = idx * 1.7;
  }

  tick(world: World, dt: number): PlayerInput {
    this.t += dt;
    if (--this.thinkIn <= 0) {
      this.thinkIn = THINK_TICKS;
      this.perceive(world, THINK_TICKS / 60);
      this.decide(world);
    }
    return this.act(world, dt);
  }

  // ---- perception -------------------------------------------------------

  private perceive(world: World, elapsed: number) {
    const me = world.players[this.idx];
    for (const [, b] of this.beliefs) b.age += elapsed;
    world.players.forEach((p, i) => {
      if (p.id.team === me.id.team) return;
      const d = dist(me.pos, p.pos);
      const seen = d < VISION_NEAR ||
        (d < VISION_FAR && angleBetween(me.facing, sub(p.pos, me.pos)) < VISION_HALF_ANGLE);
      if (seen) this.beliefs.set(i, { pos: vec(p.pos.x, p.pos.y), age: 0 });
    });
    for (const [i, b] of this.beliefs) if (b.age > BELIEF_MAX_AGE) this.beliefs.delete(i);
  }

  private believedOpponents(): Vec2[] {
    const out: Vec2[] = [];
    for (const [, b] of this.beliefs) out.push(b.pos);
    return out;
  }

  // ---- decision (10Hz) --------------------------------------------------

  private decide(world: World) {
    const me = world.players[this.idx];
    const thinkDt = THINK_TICKS / 60;
    this.commit = Math.max(0, this.commit - thinkDt);
    this.burst = Math.max(0, this.burst - thinkDt);
    if (this.bb.phase !== this.lastPhase) {
      this.commit = 0; // the game changed — every promise is off
      this.lastPhase = this.bb.phase;
    }

    // Dead-ball etiquette: the taker walks on, everyone else holds shape
    if (world.restartLock > 0) {
      this.kickPlan = null;
      this.intent = world.lastTouch?.idx === this.idx
        ? { kind: 'chase', sprint: false }
        : { kind: 'goto', target: this.wanderedAnchor(), sprint: false };
      return;
    }

    if (me.id.role === 'GK') return this.decideKeeper(world);
    if (this.bb.possessorIdx === this.idx) return this.decideOnBall(world, me);
    this.kickPlan = null;

    // My name was called — that ball in flight is mine, attack it
    if (this.bb.calledReceiver === this.idx) {
      this.intent = { kind: 'chase', sprint: true };
      this.commit = 0;
      return;
    }

    // Unclaimed moving ball headed my way: meet it (only when nobody's named)
    const toMe = sub(me.pos, world.ball.pos);
    const ballSpeed = world.ball.speed();
    if (this.bb.calledReceiver < 0 && this.bb.phase !== 'defend' && ballSpeed > 4 && len(toMe) < 14 &&
        (world.ball.vel.x * toMe.x + world.ball.vel.y * toMe.y) / (ballSpeed * len(toMe) + 1e-6) > 0.72) {
      this.intent = { kind: 'chase', sprint: true };
      return;
    }

    if (this.bb.phase === 'defend') return this.decideDefending(me);
    if (this.bb.phase === 'loose') {
      this.intent = this.bb.chaserIdxs.includes(this.idx)
        ? { kind: 'chase', sprint: true }
        : { kind: 'goto', target: this.wanderedAnchor(), sprint: false };
      return;
    }
    this.decideAttackingRun(world, me);
  }

  // Candidate runs scored on space + passability + progress + role bias.
  // Once picked, a run is COMMITTED for a second or two — eleven players
  // re-deciding in lockstep every beat is what reads as robotic.
  private decideAttackingRun(world: World, me: PlayerBody) {
    if (this.commit > 0 && this.intent.kind === 'goto' && dist(me.pos, this.intent.target) > 1.2) return;

    const fwd = vec(this.bb.attackSign(), 0);
    const anchor = this.bb.anchorOf(this.idx);
    const ball = world.ball.pos;
    const goal = this.bb.goalWeAttack();

    // Just released a pass: go THROUGH, past whoever was marking — the
    // second half of a one-two exists before anyone plans it
    if (this.burst > 0) {
      let dir = fwd;
      const marker = this.nearestBelieved(me.pos, 5);
      if (marker) dir = norm(add(fwd, scale(norm(sub(me.pos, marker)), 0.7)));
      this.intent = { kind: 'goto', target: this.clampPitch(add(me.pos, scale(dir, 9))), sprint: true };
      this.commit = 1.2;
      return;
    }

    const isWinger = me.id.role === 'FW' && Math.abs(me.id.anchor.y - 0.5) > 0.27;
    const candidates: { p: Vec2; bonus: number }[] = [{ p: this.wanderedAnchor(), bonus: 0 }];
    if (me.id.role !== 'DF') {
      candidates.push({ p: add(me.pos, add(scale(fwd, 11), vec(0, (goal.y - me.pos.y) * 0.35))), bonus: 0.1 }); // through
      candidates.push({ p: vec(ball.x + fwd.x * 13, (ball.y + anchor.y) / 2), bonus: 0 });                      // channel
      candidates.push({ p: add(anchor, scale(fwd, -6)), bonus: 0 });                                            // drop
      candidates.push({ p: add(ball, add(scale(fwd, 7), vec(0, anchor.y > ball.y ? 6 : -6))), bonus: 0 });      // support
      if (isWinger) {
        // Hold the chalk high: width is the winger's whole job
        const wideY = me.id.anchor.y < 0.5 ? 3.5 : PITCH.width - 3.5;
        candidates.push({ p: vec(clamp(ball.x + fwd.x * 9, 4, PITCH.length - 4), wideY), bonus: 0.7 });
      }
    } else {
      candidates.push({ p: add(anchor, scale(fwd, 4)), bonus: 0 });
    }

    let best = anchor;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const target = this.clampPitch(c.p);
      let s = c.bonus
        + this.spaceAt(target) * 1.0
        + this.laneOpen(ball, target) * 1.3
        + this.bb.axisOf(target.x) * (me.id.role === 'FW' ? 0.09 : me.id.role === 'MF' ? 0.05 : 0.015)
        + this.rng.next() * 0.4; // dither so 11 brains never lockstep
      const nearestMate = this.nearestTeammateDist(world, target);
      if (nearestMate < 6) s -= (6 - nearestMate) * 0.5; // spread out — bunching kills plays
      if (s > bestScore) { bestScore = s; best = target; }
    }
    // Sprint is a decision, not a default: strikers stretch, the rest jog into shape
    const far = dist(me.pos, best) > 10;
    this.intent = { kind: 'goto', target: best, sprint: far && (me.id.role === 'FW' || this.rng.next() < 0.25) };
    this.commit = 0.9 + this.rng.next() * 1.2;
  }

  private decideDefending(me: PlayerBody) {
    if (this.bb.presserIdx === this.idx) {
      this.intent = { kind: 'chase', sprint: true };
      return;
    }
    if (this.bb.coverIdx === this.idx) {
      this.intent = { kind: 'cover' };
      return;
    }
    // Zonal anchor, warped goal-side of the nearest believed threat in my zone
    const anchor = this.wanderedAnchor();
    let target = anchor;
    let bestD = 8;
    for (const opp of this.believedOpponents()) {
      const d = dist(opp, anchor);
      if (d < bestD) {
        bestD = d;
        target = add(opp, scale(norm(sub(this.bb.goalWeDefend(), opp)), 1.4));
      }
    }
    this.intent = { kind: 'goto', target, sprint: dist(me.pos, target) > 12 };
  }

  // On the ball: shoot when the lane shows, feed the runs, drive the flank,
  // lay it off under pressure — and only boot it blind as the last resort
  private decideOnBall(world: World, me: PlayerBody) {
    if (this.kickPlan) return; // committed to the strike
    const goal = this.bb.goalWeAttack();
    const goalDist = dist(me.pos, goal);
    const pressure = this.pressureAt(me.pos);
    const myAxis = this.bb.axisOf(me.pos.x);
    const isWinger = me.id.role === 'FW' && Math.abs(me.id.anchor.y - 0.5) > 0.27;

    const central = 1 - Math.abs(me.pos.y - PITCH.width / 2) / (PITCH.width / 2);
    let shoot = -1;
    if (goalDist < 21) {
      shoot = (21 - goalDist) * 0.09
        + central * 0.5
        + this.laneOpen(me.pos, goal) * 0.5   // a SIGHT of goal, not a prayer
        - pressure * 0.3
        + (myAxis > 86 && central > 0.4 ? 0.35 : 0); // in the box: hit it
    }

    let passScore = -Infinity;
    let passTo: PlayerBody | null = null;
    for (const p of world.players) {
      if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
      const d = dist(me.pos, p.pos);
      if (d < 4 || d > 32) continue;
      const lane = this.laneOpen(me.pos, p.pos);
      if (lane < LANE_REJECT) continue; // never pass INTO a body you can see
      const progress = (this.bb.axisOf(p.pos.x) - myAxis) * 0.05;
      const mateWide = Math.abs(p.id.anchor.y - 0.5) > 0.27;
      let s = lane * 1.7 + this.spaceAt(p.pos) * 0.12 + progress - d * 0.012 + this.rng.next() * 0.25;
      if (me.id.role === 'MF' && p.id.role === 'FW') s += 0.25;               // mids feed the line
      if (isWinger && myAxis > 66 && p.id.role === 'FW' && !mateWide) s += 0.85; // the cutback to the striker
      if (pressure > 0.5 && progress < 0 && lane > 0.7) s += 0.45;            // the relief valve back
      if (s > passScore) { passScore = s; passTo = p; }
    }

    // Carry: wingers DRIVE the touchline; everyone else weighs space ahead
    const ahead = add(me.pos, scale(vec(this.bb.attackSign(), 0), 6));
    let dribble = 0.85 + this.spaceAt(ahead) * 0.1 - pressure * 0.55;
    if (isWinger && myAxis < 74) {
      const laneAhead = this.spaceAt(add(me.pos, scale(vec(this.bb.attackSign(), 0), 8)));
      if (laneAhead > 4) dribble += 0.55; // the flank is open — take them on
    }

    if (myAxis < 16 && pressure > 0.8) {
      const sideY = me.pos.y < PITCH.width / 2 ? 8 : PITCH.width - 8;
      this.planKick(norm(add(scale(vec(this.bb.attackSign(), 0), 24), vec(0, sideY - me.pos.y))), 0.85);
      return;
    }

    if (shoot > 0.55 && shoot >= passScore && shoot >= dribble) {
      const aimPoint = vec(goal.x, goal.y + (this.rng.next() - 0.5) * 4.5);
      this.planKick(norm(sub(aimPoint, me.pos)), clamp(0.62 + goalDist * 0.018, 0.62, 1));
    } else if (passTo && passScore > dribble) {
      const d = dist(me.pos, passTo.pos);
      const lead = add(passTo.pos, scale(passTo.vel, d / 15));
      const speedWanted = clamp(9.5 + d * 0.42, 10.5, 20);
      const power = clamp((speedWanted - 10) / 13 / (0.75 + 0.25 * me.stats.power), 0.13, 0.72);
      this.planKick(norm(sub(lead, me.pos)), power);
    } else {
      // Dribbling lane: goalward pull, believed defenders push back — wingers
      // bend theirs along the chalk instead of cutting inside early
      let dir = norm(sub(goal, me.pos));
      if (isWinger && myAxis < 74) {
        const wideY = me.id.anchor.y < 0.5 ? 4 : PITCH.width - 4;
        dir = norm(add(scale(vec(this.bb.attackSign(), 0), 1), vec(0, (wideY - me.pos.y) * 0.06)));
      }
      for (const opp of this.believedOpponents()) {
        const away = sub(me.pos, opp);
        const d = len(away);
        if (d < 6 && d > 1e-4) dir = add(dir, scale(norm(away), (6 - d) * 0.22));
      }
      this.intent = { kind: 'goto', target: this.clampPitch(add(me.pos, scale(norm(dir), 7))), sprint: pressure < 0.3 };
    }
  }

  private decideKeeper(world: World) {
    const me = world.players[this.idx];
    if (this.bb.possessorIdx === this.idx) {
      // Distribute: hoof it toward a sideline upfield
      const sideY = world.ball.pos.y < PITCH.width / 2 ? 12 : PITCH.width - 12;
      this.planKick(norm(add(scale(vec(this.bb.attackSign(), 0), 30), vec(0, sideY - me.pos.y))), 0.9);
      return;
    }
    this.kickPlan = null;
    const ball = world.ball.pos;
    const nearMyGoal = dist(ball, this.bb.goalWeDefend()) < 10;
    const slowBall = world.ball.speed() < 6.5;
    this.intent = nearMyGoal && slowBall && this.bb.phase !== 'attack'
      ? { kind: 'chase', sprint: true }
      : { kind: 'keeper' };
  }

  private planKick(aim: Vec2, power: number) {
    this.kickPlan = { aim, power, windup: Math.max(8, Math.round(10 + power * 26)) };
  }

  // ---- execution (60Hz) -------------------------------------------------

  private act(world: World, _dt: number): PlayerInput {
    const me = world.players[this.idx];
    const input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null, tackle: false };

    if (this.kickPlan) {
      const plan = this.kickPlan;
      input.move = plan.aim;
      input.kickCharging = true;
      if (dist(me.pos, world.ball.pos) > 2.2) this.kickPlan = null; // lost it mid-windup
      else if (--plan.windup <= 0) {
        input.kickCharging = false;
        input.kickReleased = { power: plan.power, aimOffset: 0 };
        if (plan.power < 0.6) this.burst = 1.4; // pass and GO
        this.kickPlan = null;
      }
      return input;
    }

    let target: Vec2 | null = null;
    let sprint = false;
    switch (this.intent.kind) {
      case 'goto':
        target = this.intent.target;
        sprint = this.intent.sprint;
        break;
      case 'chase': {
        const lead = clamp(dist(me.pos, world.ball.pos) / 9, 0, 0.8);
        target = add(world.ball.pos, scale(world.ball.vel, lead));
        sprint = this.intent.sprint;
        // The press bites: lunge when the carrier's ball is in reach
        if (this.bb.phase === 'defend' && dist(me.pos, world.ball.pos) < 1.35 && me.tackleCooldown <= 0) {
          input.tackle = true;
        }
        break;
      }
      case 'cover': {
        const presser = world.players[this.bb.presserIdx];
        const base = presser ? presser.pos : world.ball.pos;
        target = add(base, scale(norm(sub(this.bb.goalWeDefend(), base)), 5));
        break;
      }
      case 'keeper': {
        const goal = this.bb.goalWeDefend();
        const toBall = norm(sub(world.ball.pos, goal));
        target = add(goal, scale(toBall, 0.9 + Math.min(2.2, dist(goal, world.ball.pos) * 0.08)));
        target.y = clamp(target.y, PITCH.width / 2 - 3, PITCH.width / 2 + 3);
        target.x = clamp(target.x, 0.4, PITCH.length - 0.4);
        break;
      }
    }

    // Shot-stopping runs at full 60Hz — a dive can't wait for the next think
    if (me.id.role === 'GK') this.keeperReflexes(world, me, input);

    if (target && !input.tackle) {
      const to = sub(target, me.pos);
      const d = len(to);
      if (d > 0.25) {
        const steer = d < 1.2 ? scale(norm(to), clamp(d / 1.2, 0.35, 1)) : norm(to);
        if (len(input.move) < 0.05) input.move = steer;
        input.sprint = input.sprint || (sprint && d > 2.5 && me.stamina > 0.15);
      }
    }
    return input;
  }

  // Read the shot, attack the line of flight, and DIVE when it's in reach
  private keeperReflexes(world: World, me: PlayerBody, input: PlayerInput) {
    const b = world.ball;
    const speed = b.speed();
    if (speed < 8.5) return;
    const myGoal = this.bb.goalWeDefend();
    const toGoal = sub(myGoal, b.pos);
    const closing = (b.vel.x * toGoal.x + b.vel.y * toGoal.y) / (speed * (len(toGoal) + 1e-6));
    if (closing < 0.55 || dist(b.pos, myGoal) > 16) return;
    // Perpendicular foot of me on the shot line: the point to attack
    const dirHat = norm(b.vel);
    const rel = sub(me.pos, b.pos);
    const along = Math.max(0.5, rel.x * dirHat.x + rel.y * dirHat.y);
    const intercept = add(b.pos, scale(dirHat, along));
    input.move = norm(sub(intercept, me.pos));
    input.sprint = true;
    if (dist(me.pos, intercept) < 1.5 && dist(me.pos, b.pos) < 3.2 && me.tackleCooldown <= 0) {
      input.tackle = true; // the dive
    }
  }

  // ---- scoring helpers (believed world only) ----------------------------

  // The formation slot plus a slow personal drift — no two players idle alike
  private wanderedAnchor(): Vec2 {
    const a = this.bb.anchorOf(this.idx);
    return this.clampPitch(vec(
      a.x + Math.sin(this.t * 0.23 + this.wanderSeed) * 1.4,
      a.y + Math.cos(this.t * 0.31 + this.wanderSeed * 1.3) * 1.4,
    ));
  }

  private clampPitch(p: Vec2): Vec2 {
    return vec(clamp(p.x, 1.5, PITCH.length - 1.5), clamp(p.y, 1.5, PITCH.width - 1.5));
  }

  private nearestBelieved(point: Vec2, within: number): Vec2 | null {
    let best: Vec2 | null = null;
    let bestD = within;
    for (const opp of this.believedOpponents()) {
      const d = dist(opp, point);
      if (d < bestD) { bestD = d; best = opp; }
    }
    return best;
  }

  private spaceAt(point: Vec2): number {
    let nearest = 10;
    for (const opp of this.believedOpponents()) nearest = Math.min(nearest, dist(opp, point));
    return nearest;
  }

  private pressureAt(point: Vec2): number {
    let p = 0;
    for (const opp of this.believedOpponents()) {
      const d = dist(opp, point);
      if (d < 4.5) p = Math.max(p, 1 - d / 4.5);
    }
    return p;
  }

  // 1 when no believed opponent sits near the segment a→b, →0 as one blocks it
  private laneOpen(a: Vec2, b: Vec2): number {
    const ab = sub(b, a);
    const abLen = len(ab);
    if (abLen < 1e-4) return 1;
    let worst = 1;
    for (const opp of this.believedOpponents()) {
      const t = clamp(((opp.x - a.x) * ab.x + (opp.y - a.y) * ab.y) / (abLen * abLen), 0.05, 0.95);
      const perp = dist(opp, add(a, scale(ab, t)));
      if (perp < 2.2) worst = Math.min(worst, perp / 2.2);
    }
    return worst;
  }

  private nearestTeammateDist(world: World, point: Vec2): number {
    let nearest = 40;
    world.players.forEach((p, i) => {
      if (i === this.idx || p.id.team !== world.players[this.idx].id.team) return;
      nearest = Math.min(nearest, dist(p.pos, point));
    });
    return nearest;
  }
}
