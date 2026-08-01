import { Vec2, vec, len, dist, norm, sub, add, scale, clamp, angleBetween, signedAngle, rotate } from '../core/math';
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
const OPP_EST_SPEED = 6.8; // how fast everyone assumes an opponent can run
const OPP_REACTION = 0.25; // seconds before that opponent gets moving

type Intent =
  | { kind: 'hold' }
  | { kind: 'goto'; target: Vec2; sprint: boolean }
  | { kind: 'chase'; sprint: boolean }   // live ball pursuit, retargeted every tick
  | { kind: 'receive'; sprint: boolean } // cut to where the pass and I can MEET
  | { kind: 'cover' }                    // live goal-side screen behind the press
  | { kind: 'keeper' };                  // live arc positioning

interface Belief {
  pos: Vec2;
  age: number;
}

// Where do the ball and a moving receiver actually MEET? Solves the classic
// intercept: receiver keeps running his line, the ball leaves now at
// ballSpeed — aim at the meeting point, not at where he's standing.
export function leadTarget(from: Vec2, receiverPos: Vec2, receiverVel: Vec2, ballSpeed: number): Vec2 {
  const R = sub(receiverPos, from);
  const a = receiverVel.x * receiverVel.x + receiverVel.y * receiverVel.y - ballSpeed * ballSpeed;
  const b = 2 * (R.x * receiverVel.x + R.y * receiverVel.y);
  const c = R.x * R.x + R.y * R.y;
  let t: number | null = null;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r1 = (-b - Math.sqrt(disc)) / (2 * a);
      const r2 = (-b + Math.sqrt(disc)) / (2 * a);
      t = r1 > 0.05 ? r1 : r2 > 0.05 ? r2 : null;
    }
  }
  const tt = clamp(t ?? len(R) / ballSpeed, 0.05, 1.6);
  return add(receiverPos, scale(receiverVel, tt));
}

// Seconds of margin the fastest known defender leaves on a pass along
// from→to at ballSpeed: positive = it arrives first, negative = cut out.
// This is every player's mental model of "can THAT guy get there before my
// ball does" — pure, shared, and testable.
export function passMargin(from: Vec2, to: Vec2, ballSpeed: number, opponents: Vec2[]): number {
  const ab = sub(to, from);
  const L = len(ab);
  if (L < 1e-4) return 9;
  const dir = scale(ab, 1 / L);
  let worst = 9;
  for (const opp of opponents) {
    const along = clamp((opp.x - from.x) * dir.x + (opp.y - from.y) * dir.y, 1, L - 0.4);
    const point = add(from, scale(dir, along));
    const ballT = along / ballSpeed;
    const oppT = dist(opp, point) / OPP_EST_SPEED + OPP_REACTION;
    worst = Math.min(worst, oppT - ballT);
  }
  return worst;
}

export class Brain {
  private intent: Intent = { kind: 'hold' };
  private kickPlan: { aim: Vec2; power: number; windup: number } | null = null;
  private settleLeft = 0;  // the settle touch: seconds before a fresh ball releases
  private hadBall = false;
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
    // A fresh RECEPTION starts the settle clock — the head has to come up.
    // Regaining your own dribble knock is not a reception; the clock runs on.
    const mine = this.bb.possessorIdx === this.idx;
    if (mine && !this.hadBall && world.lastTouch?.idx !== this.idx) {
      this.settleLeft = this.bb.profile.settle * (0.7 + this.rng.next() * 0.6);
    } else if (mine) {
      this.settleLeft = Math.max(0, this.settleLeft - thinkDt);
    }
    this.hadBall = mine;
    if (this.bb.phase !== this.lastPhase) {
      this.commit = 0; // the game changed — every promise is off
      this.lastPhase = this.bb.phase;
    }

    // A goal owns everybody: the scorer wheels away for the corner flag, his
    // side sprints to mob him, and the conceded walk their thoughts home
    if (world.celebration) {
      this.kickPlan = null;
      const c = world.celebration;
      const goalX = c.team === 0 ? PITCH.length : 0;
      const corner = vec(goalX === 0 ? 4 : PITCH.length - 4, 3);
      const hero = world.players[c.scorer]?.id.team === c.team ? c.scorer : -1;
      if (me.id.team !== c.team) {
        this.intent = { kind: 'goto', target: vec(me.home.x, me.home.y), sprint: false };
      } else if (this.idx === hero) {
        const arrived = dist(me.pos, corner) < 2.2;
        this.intent = {
          kind: 'goto',
          target: arrived ? add(corner, vec(this.rng.range(-1.6, 1.6), this.rng.range(-1.6, 1.6))) : corner,
          sprint: !arrived,
        };
      } else {
        const focus = hero >= 0 ? world.players[hero].pos : corner;
        const near = dist(me.pos, focus) < 40; // the far keeper just applauds from home
        this.intent = near
          ? { kind: 'goto', target: add(focus, vec(this.rng.range(-2, 2), this.rng.range(-2, 2))), sprint: true }
          : { kind: 'goto', target: vec(me.home.x, me.home.y), sprint: false };
      }
      return;
    }

    // Restart law: while THEIR taker owns a dead or unplayed ball, give it
    // the mandated space — nobody jumps a kickoff or a goal kick
    if (world.restartExclusion > 0 && world.lastTouch && world.lastTouch.team !== me.id.team &&
        dist(me.pos, world.ball.pos) < world.restartExclusion + 1.5) {
      this.kickPlan = null;
      const away2 = sub(me.pos, world.ball.pos);
      const out2 = len(away2) > 1e-4 ? norm(away2) : norm(sub(this.bb.goalWeDefend(), world.ball.pos));
      this.intent = {
        kind: 'goto',
        target: this.clampPitch(add(world.ball.pos, scale(out2, world.restartExclusion + 2.5))),
        sprint: false,
      };
      return;
    }
    // Dead-ball etiquette: the taker walks on, everyone else holds shape —
    // and the OTHER team gives the ball its mandated space. Nobody jumps a
    // goal kick off the keeper's laces.
    if (world.restartLock > 0) {
      this.kickPlan = null;
      const theirs = world.lastTouch && world.lastTouch.team !== me.id.team;
      if (theirs && dist(me.pos, world.ball.pos) < world.restartExclusion + 1.5) {
        const away = sub(me.pos, world.ball.pos);
        const out = len(away) > 1e-4 ? norm(away) : norm(sub(this.bb.goalWeDefend(), world.ball.pos));
        this.intent = {
          kind: 'goto',
          target: this.clampPitch(add(world.ball.pos, scale(out, world.restartExclusion + 2.5))),
          sprint: false,
        };
      } else {
        this.intent = world.lastTouch?.idx === this.idx
          ? { kind: 'chase', sprint: false }
          : { kind: 'goto', target: this.wanderedAnchor(), sprint: false };
      }
      return;
    }

    if (me.id.role === 'GK') return this.decideKeeper(world);
    if (this.bb.possessorIdx === this.idx) return this.decideOnBall(world, me);
    this.kickPlan = null;

    // My name was called — that ball in flight is mine, cut to the meet point
    if (this.bb.calledReceiver === this.idx) {
      this.intent = { kind: 'receive', sprint: true };
      this.commit = 0;
      return;
    }

    // Unclaimed moving ball headed my way: meet it (only when nobody's named)
    const toMe = sub(me.pos, world.ball.pos);
    const ballSpeed = world.ball.speed();
    if (this.bb.calledReceiver < 0 && this.bb.phase !== 'defend' && ballSpeed > 4 && len(toMe) < 14 &&
        (world.ball.vel.x * toMe.x + world.ball.vel.y * toMe.y) / (ballSpeed * len(toMe) + 1e-6) > 0.72) {
      this.intent = { kind: 'receive', sprint: true };
      return;
    }

    if (this.bb.phase === 'defend') return this.decideDefending(me);
    if (this.bb.phase === 'loose') {
      if (this.bb.chaserIdxs[0] === this.idx) {
        this.intent = { kind: 'chase', sprint: true };
      } else if (this.bb.chaserIdxs[1] === this.idx) {
        // Second man never doubles the same blade of grass: he takes the
        // goal-side cutoff angle so a missed first challenge isn't fatal
        const cutoff = add(world.ball.pos, scale(norm(sub(this.bb.goalWeDefend(), world.ball.pos)), 4));
        this.intent = { kind: 'goto', target: this.clampPitch(cutoff), sprint: true };
      } else {
        this.intent = { kind: 'goto', target: this.wanderedAnchor(), sprint: false };
      }
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

    const carrier = this.bb.possessorIdx !== null ? world.players[this.bb.possessorIdx] : null;
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
      if (nearestMate < 7) s -= (7 - nearestMate) * 0.6; // spread out — bunching kills plays
      // A run beyond the second-last defender is a flag, not a run
      if (this.bb.phase === 'attack' && this.bb.axisOf(target.x) > this.bb.offsideAxis - 0.4) s -= 2.5;
      if (carrier && carrier !== me) {
        // The carrier needs AIR, not company: never crowd him, and if I'm
        // already on top of him, runs that open the gap score higher
        const dTarget = dist(target, carrier.pos);
        if (dTarget < 6) s -= (6 - dTarget) * 0.55;
        const dNow = dist(me.pos, carrier.pos);
        if (dNow < 6) s += (dTarget - dNow) * 0.07;
      }
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

    // The settle touch: a fresh ball is CARRIED for a beat while the head
    // comes up — unless a presser forces the issue, and a forced release
    // wears extra error (the hurried ball is how pressing gets paid)
    const settling = this.settleLeft > 0 && pressure < 0.55;
    const rushed = this.settleLeft > 0 && pressure >= 0.55;

    const central = 1 - Math.abs(me.pos.y - PITCH.width / 2) / (PITCH.width / 2);
    let shoot = -1;
    if (!settling && goalDist < 21) {
      shoot = (21 - goalDist) * 0.075
        + central * 0.5
        + this.shotLane(me.pos, goal) * 0.5   // a SIGHT of goal, not a prayer
        - pressure * 0.3
        + (myAxis > 86 && central > 0.4 ? 0.35 : 0); // in the box: hit it
    }

    // Every option is judged by INTERCEPTION: can any defender I know about
    // beat this ball to its line, at the speed I believe he can run? No pass
    // is ever aimed at a cut-out lane — possession is the objective. And the
    // ball is played to where a runner WILL be, weighted toward the pass that
    // hands someone a sight of goal: every chain wants to end in the net.
    let passScore = -Infinity;
    let passTo: PlayerBody | null = null;
    let passAim: Vec2 | null = null;
    let passSpeed = 14;
    const opps = this.believedOpponents();
    for (const p of settling ? [] : world.players) {
      if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
      const d = dist(me.pos, p.pos);
      if (d < 4 || d > 48) continue;
      const speedWanted = clamp(10 + d * 0.5, 11, 23);
      const meet = leadTarget(me.pos, p.pos, p.vel, speedWanted);
      const margin = passMargin(me.pos, meet, speedWanted, opps);
      if (margin < 0.15) continue; // a defender gets there first — not my pass
      const progress = (this.bb.axisOf(meet.x) - myAxis) * 0.05;
      const mateWide = Math.abs(p.id.anchor.y - 0.5) > 0.27;
      const marked = this.spaceAt(p.pos);
      let s = Math.min(margin, 1.4) * 0.9 + marked * 0.1 + progress + this.rng.next() * 0.25;
      const runLead = dist(meet, p.pos);
      if (runLead > 2.5 && this.spaceAt(meet) > 4) s += 0.35; // the ball INTO the run
      // The assist: if he receives this with goal in range and in sight,
      // that's the pass the whole move was for
      const shotDist = dist(meet, goal);
      if (shotDist < 20) s += (20 - shotDist) * 0.03 + this.shotLane(meet, goal) * 0.55;
      if (d < 8) s -= 0.35;                                // micro-passes are a last resort
      if (d > 14 && margin > 0.5) s += 0.3;                // the switch, the cross
      if (d > 26 && margin > 0.55) s += 0.4;               // the RAKING diagonal across the map
      if (marked < 2 && !(pressure > 0.5 && progress < 0)) s -= 0.5; // he's wearing a defender
      if (world.players.indexOf(p) === this.bb.humanIdx) s += 0.5;   // the human's ball, naturally
      if (me.id.role === 'MF' && p.id.role === 'FW') s += 0.25;      // mids feed the line
      if (isWinger && myAxis > 66 && p.id.role === 'FW' && !mateWide) s += 0.85; // the cutback
      if (pressure > 0.5 && progress < 0 && margin > 0.6) s += 0.45; // the relief valve back
      if (s > passScore) { passScore = s; passTo = p; passAim = meet; passSpeed = speedWanted; }
    }

    // Carry: wingers DRIVE the touchline; everyone else weighs space ahead
    const ahead = add(me.pos, scale(vec(this.bb.attackSign(), 0), 6));
    let dribble = 0.85 + this.spaceAt(ahead) * 0.1 - pressure * 0.55;
    if (isWinger && myAxis < 74) {
      const laneAhead = this.spaceAt(add(me.pos, scale(vec(this.bb.attackSign(), 0), 8)));
      if (laneAhead > 4) dribble += 0.55; // the flank is open — take them on
    }
    // In sight of goal you HIT it — nobody walks the ball over the line
    if (goalDist < 13) dribble -= (13 - goalDist) * 0.12;

    if (myAxis < 16 && pressure > 0.8) {
      const sideY = me.pos.y < PITCH.width / 2 ? 8 : PITCH.width - 8;
      this.planKick(norm(add(scale(vec(this.bb.attackSign(), 0), 24), vec(0, sideY - me.pos.y))), 0.85);
      return;
    }

    if (shoot > 0.72 && shoot >= passScore && shoot >= dribble) {
      // A shot is a SHOT: full-blooded, hit to beat the keeper, not to reach him
      const aimPoint = vec(goal.x, goal.y + (this.rng.next() - 0.5) * 4.5);
      this.planKick(norm(sub(aimPoint, me.pos)), clamp(0.78 + goalDist * 0.012, 0.78, 1), rushed ? 1.1 : 0);
    } else if (passTo && passAim && passScore > dribble) {
      const power = clamp((passSpeed - 10) / 14 / (0.75 + 0.25 * me.stats.power), 0.13, 0.95);
      this.planKick(norm(sub(passAim, me.pos)), power, rushed ? 1.1 : 0);
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
      // A big turn with the ball is a PLANT, not an orbit: brake hard into a
      // close pivot point and commit to the new line — the body's cut and the
      // ball's drag-around make it a tight sub-second turn. Never carve a
      // circle a defender can chase you around.
      const want = norm(dir);
      const turn = Math.abs(signedAngle(me.facing, want));
      this.intent = {
        kind: 'goto',
        target: this.clampPitch(add(me.pos, scale(want, turn > 1.1 ? 2.2 : 7))),
        sprint: pressure < 0.3 && turn < 0.7,
      };
    }
  }

  private decideKeeper(world: World) {
    const me = world.players[this.idx];
    if (this.bb.possessorIdx === this.idx) {
      // Distribution is a DECISION: find the safest open teammate by the same
      // interception model everyone uses; only hoof it when nobody's on
      const opps = this.believedOpponents();
      let best: PlayerBody | null = null;
      let bestScore = 0.45; // below this margin, the hoof is safer
      let bestSpeed = 16;
      for (const p of world.players) {
        if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
        const d = dist(me.pos, p.pos);
        if (d < 10 || d > 48) continue;
        const speedWanted = clamp(10 + d * 0.5, 12, 23);
        const margin = passMargin(me.pos, p.pos, speedWanted, opps);
        let s = margin * 0.7 + this.bb.axisOf(p.pos.x) * 0.008;
        if (world.players.indexOf(p) === this.bb.humanIdx) s += 0.4; // serve the human
        if (margin > 0.5 && s > bestScore) { bestScore = s; best = p; bestSpeed = speedWanted; }
      }
      if (best) {
        const lead = leadTarget(me.pos, best.pos, best.vel, bestSpeed);
        this.planKick(norm(sub(lead, me.pos)), clamp((bestSpeed - 10) / 14 / (0.75 + 0.25 * me.stats.power), 0.3, 0.95));
      } else {
        const sideY = world.ball.pos.y < PITCH.width / 2 ? 12 : PITCH.width - 12;
        this.planKick(norm(add(scale(vec(this.bb.attackSign(), 0), 30), vec(0, sideY - me.pos.y))), 0.9);
      }
      // A keeper CLEARS: short windup, no wandering off with the ball
      if (this.kickPlan) this.kickPlan.windup = Math.min(this.kickPlan.windup, 16);
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

  // extraErr piles onto the team's own scatter — hurried balls fly loose
  private planKick(aim: Vec2, power: number, extraErr = 0) {
    const err = this.bb.profile.error + extraErr;
    const dir = err > 0 ? rotate(aim, (this.rng.next() - 0.5) * 0.16 * err) : aim;
    this.kickPlan = { aim: dir, power, windup: Math.max(8, Math.round(10 + power * 26)) };
  }

  // ---- execution (60Hz) -------------------------------------------------

  private act(world: World, _dt: number): PlayerInput {
    const me = world.players[this.idx];
    const input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null, tackle: false };

    if (this.kickPlan) {
      const plan = this.kickPlan;
      // The stick sets the sight. Keepers PLANT while they wind up — striding
      // through a windup is how a clearance walks itself to death.
      input.move = me.id.role === 'GK' ? scale(plan.aim, 0.3) : plan.aim;
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
        // Contain-first pressing: a soft profile HOLDS a goal-side ring off
        // the carrier instead of diving in — close him down, don't sell out.
        // He still bites if the carrier dribbles into him.
        const hold = this.bb.profile.pressHold;
        if (hold > 0 && this.bb.phase === 'defend') {
          target = add(target, scale(norm(sub(this.bb.goalWeDefend(), world.ball.pos)), hold));
        }
        sprint = this.intent.sprint;
        // The press bites: lunge when the carrier's ball is in reach
        if (this.bb.phase === 'defend' && dist(me.pos, world.ball.pos) < 1.35 && me.tackleCooldown <= 0) {
          input.tackle = true;
        }
        break;
      }
      case 'receive': {
        // Cut to where the pass and I MEET — never trail a ball from behind
        target = this.meetPoint(world, me);
        sprint = this.intent.sprint;
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
        const patrol = PITCH.goalWidth / 2 - 0.4; // the keeper works the full mouth
        target.y = clamp(target.y, PITCH.width / 2 - patrol, PITCH.width / 2 + patrol);
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

  // Roll the ball forward in the head (same friction the pitch applies) and
  // find the earliest point I can beat it to — receiving is an intercept
  private meetPoint(world: World, me: PlayerBody): Vec2 {
    const b = world.ball;
    let px = b.pos.x;
    let py = b.pos.y;
    let vx = b.vel.x;
    let vy = b.vel.y;
    const mySpeed = Math.max(4.5, me.stats.sprintSpeed * 0.9);
    const step = 0.12;
    for (let t = step; t <= 1.8; t += step) {
      const sp = Math.hypot(vx, vy);
      if (sp > 0.3) {
        const k = (sp - Math.min(sp, (2.4 + 0.35 * sp) * step)) / sp;
        vx *= k;
        vy *= k;
        px += vx * step;
        py += vy * step;
      }
      if (dist(me.pos, vec(px, py)) / mySpeed <= t) break;
    }
    return this.clampPitch(vec(px, py));
  }

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
  // Shot sight: like laneOpen, but blockers living in the keeper's zone don't
  // count — the keeper is never a reason NOT to shoot, beating him is the game
  private shotLane(from: Vec2, goal: Vec2): number {
    const ab = sub(goal, from);
    const abLen = len(ab);
    if (abLen < 1e-4) return 1;
    let worst = 1;
    for (const opp of this.believedOpponents()) {
      if (dist(opp, goal) < 7) continue;
      const t = clamp(((opp.x - from.x) * ab.x + (opp.y - from.y) * ab.y) / (abLen * abLen), 0.05, 0.95);
      const perp = dist(opp, add(from, scale(ab, t)));
      if (perp < 2.2) worst = Math.min(worst, perp / 2.2);
    }
    return worst;
  }

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
