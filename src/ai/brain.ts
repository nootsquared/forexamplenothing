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
// Perception is asymmetric by design: own team is ground truth (plus the
// blackboard), opponents exist only as decaying beliefs from a vision cone —
// blind-side runs genuinely work.

const THINK_TICKS = 6;
const VISION_NEAR = 12;   // meters: sensed all around, no cone needed
const VISION_FAR = 40;    // meters: seen only inside the facing cone
const VISION_HALF_ANGLE = 1.92; // ~110° each side
const BELIEF_MAX_AGE = 2.5;

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

  constructor(private idx: number, private bb: TeamBrain) {
    this.thinkIn = idx % THINK_TICKS;
    this.rng = new Rng(0xa11ce + idx * 7919);
  }

  tick(world: World, dt: number): PlayerInput {
    if (--this.thinkIn <= 0) {
      this.thinkIn = THINK_TICKS;
      this.perceive(world, (THINK_TICKS / 60));
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
    if (me.id.role === 'GK') return this.decideKeeper(world);
    if (this.bb.possessorIdx === this.idx) return this.decideOnBall(world, me);
    this.kickPlan = null;

    // A pass is arriving — go meet it before planning anything fancier
    const toMe = sub(me.pos, world.ball.pos);
    const ballSpeed = world.ball.speed();
    if (this.bb.phase !== 'defend' && ballSpeed > 4 && len(toMe) < 14 &&
        (world.ball.vel.x * toMe.x + world.ball.vel.y * toMe.y) / (ballSpeed * len(toMe) + 1e-6) > 0.72) {
      this.intent = { kind: 'chase', sprint: true };
      return;
    }

    if (this.bb.phase === 'defend') return this.decideDefending(me);
    if (this.bb.phase === 'loose') {
      this.intent = this.bb.chaserIdxs.includes(this.idx)
        ? { kind: 'chase', sprint: true }
        : { kind: 'goto', target: this.bb.anchorOf(this.idx), sprint: false };
      return;
    }
    this.decideAttackingRun(world, me);
  }

  // Candidate runs scored on space + passability + progress + role bias.
  // Templates, not pathfinding: through balls, channel runs, drops, support.
  private decideAttackingRun(world: World, me: PlayerBody) {
    const fwd = scale(vec(this.bb.attackSign(), 0), 1);
    const anchor = this.bb.anchorOf(this.idx);
    const ball = world.ball.pos;
    const goal = this.bb.goalWeAttack();
    const candidates: Vec2[] = [anchor];
    if (me.id.role !== 'DF') {
      candidates.push(add(me.pos, add(scale(fwd, 11), vec(0, (goal.y - me.pos.y) * 0.35))));       // through
      candidates.push(vec(ball.x + fwd.x * 13, (ball.y + anchor.y) / 2));                          // channel
      candidates.push(add(anchor, scale(fwd, -6)));                                                // drop into the pocket
      candidates.push(add(ball, add(scale(fwd, 7), vec(0, anchor.y > ball.y ? 6 : -6))));          // support angle
    } else {
      candidates.push(add(anchor, scale(fwd, 4)));
    }

    let best = anchor;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const target = vec(clamp(c.x, 1.5, PITCH.length - 1.5), clamp(c.y, 1.5, PITCH.width - 1.5));
      let s = this.spaceAt(target) * 1.0
        + this.laneOpen(ball, target) * 1.3
        + this.bb.axisOf(target.x) * (me.id.role === 'FW' ? 0.09 : me.id.role === 'MF' ? 0.05 : 0.015)
        + this.rng.next() * 0.4; // dither so 11 brains never lockstep
      const nearestMate = this.nearestTeammateDist(world, target);
      if (nearestMate < 6) s -= (6 - nearestMate) * 0.35; // don't bunch
      if (s > bestScore) { bestScore = s; best = target; }
    }
    this.intent = { kind: 'goto', target: best, sprint: dist(me.pos, best) > 10 };
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
    const anchor = this.bb.anchorOf(this.idx);
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

  private decideOnBall(world: World, me: PlayerBody) {
    if (this.kickPlan) return; // committed to the strike
    const goal = this.bb.goalWeAttack();
    const goalDist = dist(me.pos, goal);
    const pressure = this.pressureAt(me.pos);

    // Shoot?
    const central = 1 - Math.abs(me.pos.y - PITCH.width / 2) / (PITCH.width / 2);
    const shoot = goalDist < 21 ? (21 - goalDist) * 0.09 + central * 0.55 - pressure * 0.35 : -1;

    // Best pass?
    let passScore = -Infinity;
    let passTo: PlayerBody | null = null;
    for (const p of world.players) {
      if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
      const d = dist(me.pos, p.pos);
      if (d < 4 || d > 32) continue;
      const progress = (this.bb.axisOf(p.pos.x) - this.bb.axisOf(me.pos.x)) * 0.045;
      const s = this.laneOpen(me.pos, p.pos) * 1.6 + this.spaceAt(p.pos) * 0.12 + progress
        - d * 0.012 + this.rng.next() * 0.25;
      if (s > passScore) { passScore = s; passTo = p; }
    }

    // Dribble on?
    const ahead = add(me.pos, scale(vec(this.bb.attackSign(), 0), 6));
    const dribble = 0.9 + this.spaceAt(ahead) * 0.1 - pressure * 0.5;

    // Under the cosh near our own goal: just clear it long
    if (this.bb.axisOf(me.pos.x) < 16 && pressure > 0.8) {
      const sideY = me.pos.y < PITCH.width / 2 ? 8 : PITCH.width - 8;
      this.planKick(norm(add(scale(vec(this.bb.attackSign(), 0), 24), vec(0, sideY - me.pos.y))), 0.85);
      return;
    }

    if (shoot > 0.5 && shoot >= passScore && shoot >= dribble) {
      const aimPoint = vec(goal.x, goal.y + (this.rng.next() - 0.5) * 4.5);
      this.planKick(norm(sub(aimPoint, me.pos)), clamp(0.62 + goalDist * 0.018, 0.62, 1));
    } else if (passTo && passScore > dribble) {
      const d = dist(me.pos, passTo.pos);
      const lead = add(passTo.pos, scale(passTo.vel, d / 15));
      const speedWanted = clamp(9.5 + d * 0.42, 10.5, 20);
      const power = clamp((speedWanted - 10) / 13 / (0.75 + 0.25 * me.stats.power), 0.13, 0.72);
      this.planKick(norm(sub(lead, me.pos)), power);
    } else {
      // Carry: goalward pull, believed defenders push back — a dribbling lane
      let dir = norm(sub(goal, me.pos));
      for (const opp of this.believedOpponents()) {
        const away = sub(me.pos, opp);
        const d = len(away);
        if (d < 6 && d > 1e-4) dir = add(dir, scale(norm(away), (6 - d) * 0.22));
      }
      this.intent = { kind: 'goto', target: add(me.pos, scale(norm(dir), 7)), sprint: pressure < 0.35 };
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
        const oppHasIt = this.bb.phase === 'defend';
        if (oppHasIt && dist(me.pos, world.ball.pos) < 1.35 && me.tackleCooldown <= 0) input.tackle = true;
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

    if (target) {
      const to = sub(target, me.pos);
      const d = len(to);
      if (d > 0.25) {
        input.move = d < 1.2 ? scale(norm(to), clamp(d / 1.2, 0.35, 1)) : norm(to);
        input.sprint = sprint && d > 2.5 && me.stamina > 0.15;
      }
    }
    return input;
  }

  // ---- scoring helpers (believed world only) ----------------------------

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
