import { Vec2, vec, len, dist, norm, sub, add, scale, clamp, angleBetween, signedAngle, rotate, perpRight } from '../core/math';
import { Rng } from '../core/rng';
import { GRAVITY, PITCH } from '../sim/constants';
import { World } from '../sim/world';
import { PlayerBody, PlayerInput } from '../sim/player';
import { CORNER_TARGETS, CornerCall, TeamBrain, cornerGuard } from './blackboard';
import { KeeperMind } from './keeper';
import { leadTarget, passMargin } from './intercept';
import { RunCtx, RunPlan, cornerBreaking, isCornerJob, pickRun, runCommit, runSprints, runTarget } from './runs';
import { clampPitch, laneOpen, pressureAt, spaceAt } from './space';

// One brain per body. Thinks at ~10Hz (staggered so ~4 brains think per frame),
// steers at 60Hz, and acts ONLY through PlayerInput — the exact interface a
// human uses, so control handoff is seamless and the AI can never cheat.
//
// Tactics are EMERGENT, never scripted: the run engine hands every off-ball
// player one committed IDEA at a time, called passes give every ball in flight
// one owner, released passers burst beyond their marker, and defenders own
// runners by name instead of drifting toward the ball. Nobody re-decides on
// every beat — that lockstep twitch is the whole robot look.
//
// Perception is asymmetric by design: own team is ground truth (plus the
// blackboard), opponents exist only as decaying beliefs from a vision cone —
// blind-side runs genuinely work.

// The cursor and the shell share this team's interception model — one owner
export { leadTarget, passMargin } from './intercept';

const THINK_TICKS = 6;
const VISION_NEAR = 12;   // meters: sensed all around, no cone needed
const VISION_FAR = 40;    // meters: seen only inside the facing cone
const VISION_HALF_ANGLE = 1.92; // ~110° each side
const BELIEF_MAX_AGE = 2.5;
const PARK_BAND = 1.5;    // close enough IS arrived — the deadband that killed the shuffle
const KICK_LEAD = 0.25;   // seconds of windup a pass decision has to see through
const RUN_PACE = 6.5;     // meters a second a runner honestly averages, arriving
const CROSS_PACE = 14;    // ...and what a whipped delivery averages over its whole flight
const CORNER_PATIENCE = 4.2; // seconds a taker waits for the box before taking it short

type Intent =
  | { kind: 'run' }                                              // the committed idea, target recomputed live
  | { kind: 'goto'; target: Vec2; sprint: boolean; band: number } // a one-off spot: restarts, celebrations, carrying
  | { kind: 'chase'; sprint: boolean }                           // live ball pursuit, retargeted every tick
  | { kind: 'receive' }                                          // cut to where the pass and I can MEET
  | { kind: 'mark'; man: number }                                // he is MINE: goal-side and ball-side of him
  | { kind: 'cover'; man: number }                               // stand on the pass that would hurt us
  | { kind: 'stand' };                                           // no legs this beat: the keeper's, the taker's over a dead ball

interface Belief {
  pos: Vec2;
  vel: Vec2;
  age: number;
}

export class Brain {
  private intent: Intent = { kind: 'stand' };
  private kickPlan: { aim: Vec2; power: number; windup: number } | null = null;
  private kickRest = 0; // beat owed to our own last strike before winding up again
  private settleLeft = 0;  // the settle touch: seconds before a fresh ball releases
  private hadBall = false;
  private beliefs = new Map<number, Belief>();
  private oppBuf: Vec2[] = [];  // believed positions, rebuilt in place each perceive
  private mateBuf: Vec2[] = [];
  private thinkIn: number;
  private rng: Rng;
  private t = 0;            // personal clock — wander and desync live here
  private commit = 0;       // seconds the current run is promised for
  private burst = 0;        // give-and-go window after releasing a pass
  private lastPhase = 'loose';
  private wanderSeed: number;
  private daring: number;   // personal appetite for the ambitious run
  private run: RunPlan = 'hold';
  private runFree = 0;      // seconds the offside line stops holding my run back
  private parked = false;   // arrived and standing — the anti-jitter latch
  private escapeT = 0;      // beat before this carrier may plant another cut
  private sizeT = 0;        // the take-on's tell: slowed approach, eyes on the defender
  private driveT = 0;       // ...and the committed burst that follows it
  private coverMan = -1;
  private runCtx: RunCtx | null = null;
  private keeper: KeeperMind | null = null;

  constructor(private idx: number, private bb: TeamBrain) {
    this.thinkIn = idx % THINK_TICKS;
    this.rng = new Rng(0xa11ce + idx * 7919);
    this.wanderSeed = idx * 1.7;
    this.daring = this.rng.next();
  }

  tick(world: World, dt: number): PlayerInput {
    this.t += dt;
    this.escapeT = Math.max(0, this.escapeT - dt);
    // The sizing beat expiring IS the commitment: the burst begins exactly
    // where the hesitation ends, so the tell always means something
    if (this.sizeT > 0 && this.sizeT - dt <= 0) {
      this.driveT = 0.9;
      this.escapeT = Math.max(this.escapeT, 1.4);
    }
    this.sizeT = Math.max(0, this.sizeT - dt);
    this.driveT = Math.max(0, this.driveT - dt);
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
      if (!seen) return;
      // Beliefs are written in place — 22 brains refreshing memories must not
      // hand the collector a fresh object every think
      const known = this.beliefs.get(i);
      if (known) {
        known.pos.x = p.pos.x;
        known.pos.y = p.pos.y;
        known.vel.x = p.vel.x;
        known.vel.y = p.vel.y;
        known.age = 0;
      } else {
        this.beliefs.set(i, { pos: vec(p.pos.x, p.pos.y), vel: vec(p.vel.x, p.vel.y), age: 0 });
      }
    });
    for (const [i, b] of this.beliefs) if (b.age > BELIEF_MAX_AGE) this.beliefs.delete(i);
    this.oppBuf.length = 0;
    for (const [, b] of this.beliefs) this.oppBuf.push(b.pos);
  }

  private believedOpponents(): Vec2[] {
    return this.oppBuf;
  }

  // ---- decision (10Hz) --------------------------------------------------

  private decide(world: World) {
    const me = world.players[this.idx];
    const thinkDt = THINK_TICKS / 60;
    this.commit = Math.max(0, this.commit - thinkDt);
    this.burst = Math.max(0, this.burst - thinkDt);
    this.bb.runPlanOf[this.idx] = 'hold'; // decideRun re-publishes the live idea
    // A fresh RECEPTION starts the settle clock — the head has to come up.
    // Regaining your own dribble knock is not a reception; the clock runs on.
    const mine = this.bb.possessorIdx === this.idx;
    if (mine && !this.hadBall && world.lastTouch?.idx !== this.idx) {
      this.settleLeft = this.bb.profile.settle * (0.7 + this.rng.next() * 0.6);
      if (this.bb.breakT > 0) this.settleLeft *= 0.35; // the break has no time for composure
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
      const goalX = world.goalXOf(c.team);
      const corner = vec(goalX === 0 ? 4 : PITCH.length - 4, 3);
      const hero = world.players[c.scorer]?.id.team === c.team ? c.scorer : -1;
      if (me.id.team !== c.team) {
        this.goto(vec(me.home.x, me.home.y), false, 1.2);
      } else if (this.idx === hero) {
        const arrived = dist(me.pos, corner) < 2.2;
        this.goto(arrived ? add(corner, vec(this.rng.range(-1.6, 1.6), this.rng.range(-1.6, 1.6))) : corner, !arrived, 1.2);
      } else {
        const focus = hero >= 0 ? world.players[hero].pos : corner;
        const near = dist(me.pos, focus) < 40; // the far keeper just applauds from home
        this.goto(
          near ? add(focus, vec(this.rng.range(-2, 2), this.rng.range(-2, 2))) : vec(me.home.x, me.home.y),
          near, 1.2,
        );
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
      this.goto(add(world.ball.pos, scale(out2, world.restartExclusion + 2.5)), false, 1);
      return;
    }
    // A corner is a rehearsed move, not a scramble: our four break into the
    // box on staggered runs while theirs pick them up goal-side. It outranks
    // dead-ball etiquette, and for the defenders it ends at the strike — after
    // that they are plain defenders again.
    const corner = this.bb.corner;
    if (corner && me.id.role !== 'GK' && this.bb.possessorIdx !== this.idx &&
        this.bb.calledReceiver !== this.idx && (corner.team === me.id.team || !corner.struck)) {
      return this.decideCorner(world, me, corner);
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
        this.goto(add(world.ball.pos, scale(out, world.restartExclusion + 2.5)), false, 1);
      } else if (world.lastTouch?.idx === this.idx) {
        this.intent = { kind: 'chase', sprint: false };
      } else {
        // teammates give the taker AIR too — an anchor squeezed onto the dead
        // ball (corners drag the whole elastic shape there) holds 8m off it
        let spot = this.wanderedAnchor();
        const off = sub(spot, world.ball.pos);
        if (len(off) < 8) {
          const out = len(off) > 1e-4 ? norm(off) : norm(sub(this.bb.goalWeDefend(), world.ball.pos));
          spot = add(world.ball.pos, scale(out, 8));
        }
        this.goto(spot, false, 1);
      }
      return;
    }

    if (me.id.role === 'GK') return this.decideKeeper(world);
    if (this.bb.possessorIdx === this.idx) return this.decideOnBall(world, me);
    this.kickPlan = null;

    // My name was called — that ball in flight is mine, cut to the meet point
    if (this.bb.calledReceiver === this.idx) {
      this.intent = { kind: 'receive' };
      this.commit = 0;
      return;
    }

    // Unclaimed moving ball headed my way: meet it (only when nobody's named
    // — and never on the training ground, where the ball is the human's alone)
    const toMe = sub(me.pos, world.ball.pos);
    const ballSpeed = world.ball.speed();
    if (!world.practice && this.bb.calledReceiver < 0 && this.bb.phase !== 'defend' && ballSpeed > 4 && len(toMe) < 14 &&
        (world.ball.vel.x * toMe.x + world.ball.vel.y * toMe.y) / (ballSpeed * len(toMe) + 1e-6) > 0.72) {
      this.intent = { kind: 'receive' };
      return;
    }

    if (this.bb.phase === 'defend') return this.decideDefending(world, me);
    if (this.bb.phase === 'loose') {
      if (this.bb.chaserIdxs[0] === this.idx) {
        this.intent = { kind: 'chase', sprint: true };
      } else if (this.bb.chaserIdxs[1] === this.idx) {
        // Second man never doubles the same blade of grass: he takes the
        // goal-side cutoff angle so a missed first challenge isn't fatal
        this.goto(add(world.ball.pos, scale(norm(sub(this.bb.goalWeDefend(), world.ball.pos)), 4)), true, 0.8);
      } else if ((this.bb.markOf[this.idx] ?? -1) >= 0) {
        this.intent = { kind: 'mark', man: this.bb.markOf[this.idx] };
      } else {
        this.decideRun(world, me);
      }
      return;
    }
    this.decideRun(world, me);
  }

  // Pick an IDEA and live with it for a couple of seconds. The commitment is
  // to the run, never to a point on the grass — the target is recomputed at
  // 60Hz, so a promised run tracks the play instead of going stale.
  private decideRun(world: World, me: PlayerBody) {
    if (this.burst > 0) {
      // Just released a pass: go THROUGH, past whoever was marking. The
      // second half of a one-two exists before anyone plans it.
      if (this.run !== 'burst') {
        this.run = 'burst';
        this.commit = runCommit('burst', this.rng);
      }
    } else if (this.commit <= 0 || this.run === 'burst') {
      const next = pickRun(this.runContext(world, me), this.run);
      this.run = next;
      this.commit = runCommit(next, this.rng);
    }
    this.bb.runPlanOf[this.idx] = this.run; // the sheet knows what I'm running
    this.intent = { kind: 'run' };
  }

  // The corner, from whichever side of it I stand on. Attacking: the job the
  // sheet dealt me, run on the box's shared clock. Defending: my man if I have
  // one, the mouth if I don't — and the strikers stay up for the counter.
  private decideCorner(world: World, me: PlayerBody, call: CornerCall) {
    this.commit = 0; // whatever happens next, the old idea died at the whistle
    if (call.team === me.id.team) {
      if (this.idx === call.taker) return this.deliverCorner(world, me, call);
      const job = this.bb.cornerJob(this.idx);
      if (!job) return this.goto(this.wanderedAnchor(), false, PARK_BAND);
      this.run = job;
      this.intent = { kind: 'run' };
      return;
    }
    const man = this.bb.markOf[this.idx] ?? -1;
    if (man >= 0) {
      this.intent = { kind: 'mark', man };
      return;
    }
    if (me.id.role === 'FW') return this.goto(this.wanderedAnchor(), false, PARK_BAND);
    const spot = cornerGuard(call.from, this.spareRank(world, me, call.from));
    this.goto(spot, dist(me.pos, spot) > 10, 0.9);
  }

  // My place in the queue of spare defenders, nearest the flag first. Every
  // one of them counts the same queue off the same ground truth, so no two
  // men ever take the same post.
  private spareRank(world: World, me: PlayerBody, from: Vec2): number {
    const mine = dist(me.pos, from);
    let rank = 0;
    world.players.forEach((p, i) => {
      if (i === this.idx || p.id.team !== me.id.team || p.id.role === 'GK' || p.id.role === 'FW') return;
      if ((this.bb.markOf[i] ?? -1) >= 0) return;
      const d = dist(p.pos, from);
      if (d < mine || (d === mine && i < this.idx)) rank++;
    });
    return rank;
  }

  private decideDefending(world: World, me: PlayerBody) {
    if (this.bb.presserIdx === this.idx) {
      this.intent = { kind: 'chase', sprint: true };
      return;
    }
    if (this.bb.coverIdx === this.idx) {
      // The hunt's second man: the trap closes from two sides or it isn't a
      // trap — cover becomes the goal-side cutoff at a sprint while it burns
      if (this.bb.huntT > 0) {
        this.goto(add(world.ball.pos, scale(norm(sub(this.bb.goalWeDefend(), world.ball.pos)), 3.2)), true, 0.6);
        return;
      }
      this.coverMan = this.pickCoverMan(world);
      this.intent = { kind: 'cover', man: this.coverMan };
      return;
    }
    const man = this.bb.markOf[this.idx] ?? -1;
    if (man >= 0) {
      this.intent = { kind: 'mark', man };
      return;
    }
    // Nobody of mine to pick up: hold the zone with a step INTO the ball line,
    // because the pass they're waiting for is the one to kill before it exists
    const anchor = this.wanderedAnchor();
    const toBall = sub(world.ball.pos, anchor);
    const d = len(toBall);
    const spot = d > 2 ? add(anchor, scale(scale(toBall, 1 / d), 1.2)) : anchor;
    this.goto(spot, dist(me.pos, spot) > 12, PARK_BAND);
  }

  // On the ball: shoot when the lane shows, feed the runs (and feed the human
  // hardest of all), drive at the weak side, lay it off under pressure — and
  // only boot it blind as the last resort
  private decideOnBall(world: World, me: PlayerBody) {
    if (this.kickPlan) return; // committed to the strike
    const corner = this.bb.corner;
    if (corner && !corner.struck && corner.team === me.id.team && corner.taker === this.idx) {
      return this.deliverCorner(world, me, corner);
    }
    const goal = this.bb.goalWeAttack();
    const goalDist = dist(me.pos, goal);
    const opps = this.believedOpponents();
    const pressure = pressureAt(me.pos, opps);
    const myAxis = this.bb.axisOf(me.pos.x);
    const safeAxis = this.bb.offsideSafeAxis();
    const isWinger = me.id.role === 'FW' && Math.abs(me.id.anchor.y - 0.5) > 0.27;
    const called = this.bb.humanRun;

    // In shooting range the head is ALREADY up — nobody receives in the box
    // and stands composing himself while the chance dies. Neither does anyone
    // keep a human waiting when he has genuinely sprinted into space.
    if (goalDist < 21 || (called && called.quality > 0.45)) this.settleLeft = 0;

    // The settle touch: a fresh ball is CARRIED for a beat while the head
    // comes up — unless a presser forces the issue, and a forced release
    // wears extra error (the hurried ball is how pressing gets paid). Sharper
    // brains let go of it sooner.
    const releaseAt = 0.32 + this.bb.profile.settle * 0.3;
    const settling = this.settleLeft > 0 && pressure < releaseAt;
    const rushed = this.settleLeft > 0 && pressure >= releaseAt;

    const central = 1 - Math.abs(me.pos.y - PITCH.width / 2) / (PITCH.width / 2);
    const lane = goalDist < 21 ? laneOpen(me.pos, goal, opps, 7) : 0;
    let shoot = -1;
    if (!settling && goalDist < 21) {
      shoot = (21 - goalDist) * 0.075
        + central * 0.5
        + lane * 0.5                          // a SIGHT of goal, not a prayer
        - pressure * 0.3
        + (goalDist < 13 ? (13 - goalDist) * 0.05 : 0) // point-blank conviction
        + (myAxis > 86 && central > 0.4 ? 0.35 : 0);   // in the box: hit it
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
    // The break plays on thinner margins — a window is worth a risk while
    // their shape is still broken glass
    const gate = this.bb.breakT > 0 ? 0.07 : 0.15;
    if (!settling) {
      for (let i = 0; i < world.players.length; i++) {
        const p = world.players[i];
        if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
        const d = dist(me.pos, p.pos);
        if (d < 4 || d > 48) continue;
        // The flag is a real whistle now: a man who would be beyond the line
        // the moment this ball leaves is not an option, however open he looks
        if (this.bb.axisOf(p.pos.x + p.vel.x * KICK_LEAD) > safeAxis - 0.4) continue;
        const speedWanted = clamp(10 + d * 0.5, 11, 23);
        const meet = leadTarget(me.pos, p.pos, p.vel, speedWanted);
        const margin = passMargin(me.pos, meet, speedWanted, opps);
        if (margin < gate) continue; // a defender gets there first — not my pass
        const progress = (this.bb.axisOf(meet.x) - myAxis) * 0.05;
        const mateWide = Math.abs(p.id.anchor.y - 0.5) > 0.27;
        const marked = spaceAt(p.pos, opps);
        let s = Math.min(margin, 1.4) * 0.9 + marked * 0.1 + progress + this.rng.next() * 0.25;
        const runLead = dist(meet, p.pos);
        if (runLead > 2.5 && spaceAt(meet, opps) > 4) s += 0.35; // the ball INTO the run
        // The assist: if he receives this with goal in range and in sight,
        // that's the pass the whole move was for
        const shotDist = dist(meet, goal);
        if (shotDist < 20) s += (20 - shotDist) * 0.03 + laneOpen(meet, goal, opps, 7) * 0.55;
        if (d < 8) s -= 0.35;                                // micro-passes are a last resort
        if (d > 14 && margin > 0.5) s += 0.3;                // the switch, the cross
        if (d > 26 && margin > 0.55) s += 0.4;               // the RAKING diagonal across the map
        if (marked < 2 && !(pressure > 0.5 && progress < 0)) s -= 0.5; // he's wearing a defender
        // The human's ball, naturally — and when he has CALLED for it by
        // sprinting into space, how badly we want to find him is exactly how
        // good his run is. Good runs get fed fast; hopeful ones don't.
        if (i === this.bb.humanIdx) s += 0.5 + (called && called.idx === i ? called.quality * 1.4 : 0);
        if (me.id.role === 'MF' && p.id.role === 'FW') s += 0.25;      // mids feed the line
        if (isWinger && myAxis > 66 && p.id.role === 'FW' && !mateWide) s += 0.85; // the cutback
        // the relief valve back — but never from shooting range: this close,
        // turning around is how chances die, not how pressure is escaped
        if (pressure > 0.5 && progress < 0 && margin > 0.6 && goalDist > 21) s += 0.45;
        if (s > passScore) { passScore = s; passTo = p; passAim = meet; passSpeed = speedWanted; }
      }
      // THE KILLER BALL: a committed line-runner is asking for the pass his
      // legs are about to make good. Imagine him already at full sprint, lead
      // THAT man, and judge the lane through the same shared model — its turn
      // tax is what makes the ball in behind honest. Thin windows stay
      // refused; a real one outranks every square ball on the pitch.
      const throughGate = this.bb.breakT > 0 ? 0.16 : 0.22;
      for (let i = 0; i < world.players.length; i++) {
        const p = world.players[i];
        if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
        const plan = this.bb.runPlanOf[i];
        const running = plan === 'linebreak' || plan === 'channel' || plan === 'overlap' || plan === 'burst';
        if (!running && i !== this.bb.supportDepthIdx) continue;
        const d = dist(me.pos, p.pos);
        if (d < 8 || d > 42) continue;
        // HE must be onside when the boot lands — project his drift through
        // the windup; the ball itself may lead as far beyond as it likes
        if (this.bb.axisOf(p.pos.x + p.vel.x * KICK_LEAD) > safeAxis - 0.4) continue;
        const goalDir = norm(add(scale(vec(this.bb.attackSign(), 0), 0.72), scale(norm(sub(goal, p.pos)), 0.28)));
        const runVel = scale(goalDir, p.stats.sprintSpeed * 0.95);
        const speed2 = clamp(11 + d * 0.55, 12, 24);
        const meet2 = clampPitch(leadTarget(me.pos, p.pos, runVel, speed2));
        const margin2 = passMargin(me.pos, meet2, speed2, opps);
        if (margin2 < throughGate) continue;
        let s2 = Math.min(margin2, 1.2) * 0.85 + (this.bb.axisOf(meet2.x) - myAxis) * 0.05
          + 0.5 + this.rng.next() * 0.2;
        const shotDist2 = dist(meet2, goal);
        if (shotDist2 < 24) s2 += (24 - shotDist2) * 0.03; // it ends with a sight of goal
        if (i === this.bb.humanIdx) s2 += 0.5;
        if (s2 > passScore) { passScore = s2; passTo = p; passAim = meet2; passSpeed = speed2; }
      }
    }

    // Carry: wingers DRIVE the touchline; everyone else weighs space ahead.
    // Under pressure a sharp brain lets go of it sooner than a soft one.
    const ahead = add(me.pos, scale(vec(this.bb.attackSign(), 0), 6));
    let dribble = 0.85 + spaceAt(ahead, opps) * 0.1
      - pressure * (0.4 + 0.3 * clamp(1 - this.bb.profile.settle, 0, 1))
      + (this.bb.breakT > 0 ? 0.3 : 0); // the break DRIVES — hesitation re-forms their shape
    if (isWinger && myAxis < 74) {
      const laneAhead = spaceAt(add(me.pos, scale(vec(this.bb.attackSign(), 0), 8)), opps);
      if (laneAhead > 4) dribble += 0.55; // the flank is open — take them on
    }
    // In sight of goal you HIT it — nobody walks the ball over the line.
    // But when the lane is SHUT, the drive stays on the table: you carry to
    // OPEN an angle, you don't turn your back on the goal
    if (goalDist < 13) dribble -= (13 - goalDist) * 0.12 * (0.4 + 0.6 * lane);

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
      // The man in front of me has a WEAK side — the one his weight isn't
      // already covering. Run at it. Jockeyed close, plant a cut across him:
      // the same chop the sim pays a dribbler for, and it buys the yard back.
      const threat = this.nearestBelief(me.pos, 6.5);
      if (threat) {
        const gap = dist(me.pos, threat.pos);
        const weak = this.weakSide(me, threat, dir);
        if (gap < 2 && this.escapeT <= 0 && me.speed() > 3.4) {
          this.escapeT = 2.2;
          dir = weak;
        } else if (this.driveT > 0) {
          // committed: THROUGH the side his stance left open, at pace
          dir = norm(add(dir, scale(weak, 1.1)));
        } else if (this.sizeT > 0) {
          // The take-on's tell: half a second of slowed approach, squared up,
          // asking the defender the question. Anyone watching can read it —
          // that readability IS the duel. The burst commits when this expires.
          if (gap > 5.5) this.sizeT = 0; // he backed off; play on
          else {
            this.goto(add(me.pos, scale(norm(dir), 1.5)), false, 0);
            return;
          }
        } else if (gap < 5.2 && gap > 2.2 && me.speed() > 1.8 && this.escapeT <= 0) {
          this.sizeT = 0.4 + this.rng.next() * 0.25;
        } else if (gap < 6) {
          dir = norm(add(dir, scale(weak, clamp((6 - gap) / 6, 0, 1) * 0.9)));
        }
      }
      for (const opp of opps) {
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
      // A committed take-on burst sprints THROUGH the pressure it just baited
      this.goto(add(me.pos, scale(want, turn > 1.1 ? 2.2 : 7)),
        (pressure < 0.3 || this.driveT > 0) && turn < 0.9, 0);
    }
  }

  // The delivery. It goes where the ring says, or — with nobody aiming it —
  // at the post whose runner is arriving best. Either way the boot does not
  // swing until that man's legs can genuinely beat the ball there: a corner
  // hit at an empty six-yard box is a corner wasted.
  private deliverCorner(world: World, me: PlayerBody, call: CornerCall) {
    // He has to be over it before anything else: a taker shoved off the arc
    // walks back onto it instead of aiming from three meters away
    if (dist(me.pos, world.ball.pos) > 1.6) {
      this.intent = { kind: 'chase', sprint: false };
      return;
    }
    const opps = this.believedOpponents();
    // Every man in the box gets asked one question: can your legs beat this
    // ball to that grass? The ring point when somebody aimed it, your own post
    // when nobody did. Whoever answers yes best is who the corner is for.
    let aim: Vec2 | null = null;
    let best = -Infinity;
    for (const job of CORNER_TARGETS) {
      const i = call.men[job];
      if (i < 0 || !cornerBreaking(this.bb, job)) continue; // only a man actually going
      const at = call.aimed ? call.aim : call.marks[job].at;
      const flight = dist(me.pos, at) / CROSS_PACE;
      if (dist(world.players[i].pos, at) / RUN_PACE > flight + KICK_LEAD) continue;
      const s = spaceAt(at, opps) * 0.06 - flight;
      if (s > best) { best = s; aim = at; }
    }
    if (!aim) {
      // Nobody can get on the end of it yet. Standing over it IS the decision —
      // until the referee starts looking over, and then it goes SHORT rather
      // than get hoofed at an empty six-yard box.
      if (call.t < CORNER_PATIENCE) {
        this.intent = { kind: 'stand' };
        return;
      }
      aim = call.men.cornerShort >= 0 ? call.marks.cornerShort.at : call.marks.cornerSpot.at;
    }
    // Weighted by the same sum a pass is: enough on it to arrive, not so much
    // that it clears the stand behind the goal
    const speed = clamp(10 + dist(me.pos, aim) * 0.5, 12, 26);
    this.planKick(norm(sub(aim, me.pos)), clamp((speed - 10) / 14 / (0.75 + 0.25 * me.stats.power), 0.2, 1));
  }

  private decideKeeper(world: World) {
    const me = world.players[this.idx];
    if (this.bb.possessorIdx !== this.idx) {
      this.kickPlan = null;
      this.intent = { kind: 'stand' }; // KeeperMind owns his feet at full 60Hz
      return;
    }
    // Distribution is a DECISION: find the safest open teammate by the same
    // interception model everyone uses; only hoof it when nobody's on
    const opps = this.believedOpponents();
    let best: PlayerBody | null = null;
    let bestScore = 0.45; // below this margin, the hoof is safer
    let bestSpeed = 16;
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      if (p === me || p.id.team !== me.id.team || p.id.role === 'GK') continue;
      const d = dist(me.pos, p.pos);
      if (d < 10 || d > 48) continue;
      const speedWanted = clamp(10 + d * 0.5, 12, 23);
      const margin = passMargin(me.pos, p.pos, speedWanted, opps);
      let s = margin * 0.7 + this.bb.axisOf(p.pos.x) * 0.008;
      if (i === this.bb.humanIdx) s += 0.4; // serve the human
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
  }

  // extraErr piles onto the team's own scatter — hurried balls fly loose
  private planKick(aim: Vec2, power: number, extraErr = 0) {
    if (this.kickRest > 0) return; // still recovering from our own last strike
    const err = this.bb.profile.error + extraErr;
    const dir = err > 0 ? rotate(aim, (this.rng.next() - 0.5) * 0.16 * err) : aim;
    this.kickPlan = { aim: dir, power, windup: Math.max(8, Math.round(10 + power * 26)) };
  }

  private goto(target: Vec2, sprint: boolean, band: number) {
    this.intent = { kind: 'goto', target: clampPitch(target), sprint, band };
  }

  // ---- execution (60Hz) -------------------------------------------------

  private act(world: World, dt: number): PlayerInput {
    const me = world.players[this.idx];
    const input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };

    // A boot that has just struck the ball is not allowed to wind up again on
    // the next tick. When a clearance is blocked and the ball rebounds to the
    // same feet, an ungated brain re-plans instantly and the man machine-guns
    // it — pow, pow, pow — instead of taking a touch and looking up.
    this.kickRest = Math.max(0, this.kickRest - dt);

    // The line only stops holding a run once the ball is genuinely struck —
    // a runner who beats the pass is a flag, not a chance
    this.runFree = Math.max(0, this.runFree - dt);
    if (this.bb.calledReceiver === this.idx) this.runFree = 1.4;
    else if (this.bb.phase === 'attack' && world.ball.vel.x * this.bb.attackSign() > 3.5) {
      this.runFree = Math.max(this.runFree, 0.5);
    }

    if (this.kickPlan) {
      const plan = this.kickPlan;
      // The stick sets the sight. Keepers and dead-ball takers PLANT while
      // they wind up — striding through a windup is how a clearance walks
      // itself to death, and how a corner gets dribbled off its own arc.
      const planted = me.id.role === 'GK' || this.bb.corner?.taker === this.idx;
      input.move = planted ? scale(plan.aim, 0.3) : plan.aim;
      input.kickCharging = true;
      if (dist(me.pos, world.ball.pos) > 2.2) this.kickPlan = null; // lost it mid-windup
      else if (--plan.windup <= 0) {
        input.kickCharging = false;
        input.kickReleased = { power: plan.power, aimOffset: 0 };
        if (plan.power < 0.6) this.burst = 1.4; // pass and GO
        this.kickPlan = null;
        this.kickRest = 0.7; // look up before you swing at it again
      }
      return input;
    }
    // Off the ball the keeper is a state machine, not a utility brain — but
    // the ceremony and the restart law still own him like everyone else
    if (me.id.role === 'GK' && !world.celebration && world.restartLock <= 0) {
      (this.keeper ??= new KeeperMind(this.idx)).steer(world, me, this.bb, dt, input);
      return input;
    }

    let target: Vec2 | null = null;
    let sprint = false;
    let band = PARK_BAND;
    // Everyone off the ball watches the play — at walking pace the sim turns
    // that into shoulders square to the ball, so a man jogging into position
    // sidesteps instead of pirouetting. The carrier's eyes follow his own run.
    let attend: Vec2 | null = this.bb.possessorIdx === this.idx ? null : world.ball.pos;

    switch (this.intent.kind) {
      case 'stand':
        break;
      case 'goto':
        target = this.intent.target;
        sprint = this.intent.sprint;
        band = this.intent.band;
        break;
      case 'run': {
        target = runTarget(this.runContext(world, me), this.run);
        // Offside discipline: the break sits on the last shoulder until the
        // ball is struck, then it goes. Timing is the whole run.
        if (this.run === 'linebreak' && this.runFree <= 0) {
          const holdAt = this.bb.offsideSafeAxis() - 0.6;
          if (this.bb.axisOf(target.x) > holdAt) target = vec(this.bb.xAtAxis(holdAt), target.y);
        }
        // The runner's legs are never gated — he weaves the line at pace so
        // the pass has a RUN to meet. Only the line itself still holds him.
        sprint = runSprints(this.run, this.bb);
        // A corner gives him about five seconds: getting INTO the box is every
        // bit as urgent as the break itself
        if (!sprint && isCornerJob(this.run)) sprint = dist(me.pos, target) > 8;
        break;
      }
      case 'chase': {
        const lead = clamp(dist(me.pos, world.ball.pos) / 9, 0, 0.8);
        target = add(world.ball.pos, scale(world.ball.vel, lead));
        // Contain-first pressing: a soft profile HOLDS a goal-side ring off
        // the carrier instead of diving in — close him down, don't sell out.
        // He still bites if the carrier dribbles into him. The hunt suspends
        // the softness: a committed wave contains nobody.
        const hold = this.bb.huntT > 0 ? 0 : this.bb.profile.pressHold;
        if (hold > 0 && this.bb.phase === 'defend') {
          target = add(target, scale(norm(sub(this.bb.goalWeDefend(), world.ball.pos)), hold));
        }
        sprint = this.intent.sprint;
        band = 0;
        // The press bites INTENTIONALLY: contain the carrier and wait — the
        // lunge is spent on honest prey (a heavy touch, a loose ball) where
        // arriving first still wins it clean. There is no slow squeeze.
        if (this.bb.phase === 'defend' && me.tackleCooldown <= 0) {
          const d = dist(me.pos, world.ball.pos);
          if (world.ballExposed() && d < 1.35) input.tackle = true;
        }
        break;
      }
      case 'receive':
        // Cut to where the pass and I MEET — never trail a ball from behind
        target = this.meetPoint(world, me);
        sprint = true;
        band = 0;
        break;
      case 'mark': {
        const at = this.seenAt(world, this.intent.man);
        target = this.markSpot(world, at, this.intent.man);
        sprint = dist(me.pos, target) > 9;
        band = 0.9;
        // See ball AND man: when the ball is a postcode away, watch the runner
        if (dist(me.pos, world.ball.pos) > 26) attend = at;
        break;
      }
      case 'cover':
        target = this.coverSpot(world, this.intent.man);
        sprint = dist(me.pos, target) > 10;
        band = 0.9;
        break;
    }

    if (target && !input.tackle) {
      const to = sub(target, me.pos);
      const d = len(to);
      // The deadband: close enough IS arrived, and it takes a real move of the
      // shape to un-park him. Chasing millimeters is what looked like twitching.
      if (band <= 0) this.parked = false;
      else if (this.parked) { if (d > band * 1.8) this.parked = false; }
      else if (d < band) this.parked = true;
      if (!this.parked && d > 0.2) {
        input.move = scale(norm(to), d < 1.6 ? clamp(d / 1.6, 0.4, 1) : 1);
        input.sprint = sprint && d > 2.5 && me.stamina > 0.15;
      }
    }

    // Contact coming: shoulder in, legs slow, body between him and the ball —
    // the sim pays that as a real shield. Never during the beat after a cut,
    // where the whole point is getting away.
    if (this.bb.possessorIdx === this.idx && this.escapeT <= 1.6) {
      const threat = this.nearestBelief(me.pos, 1.7);
      if (threat) {
        attend = threat.pos;
        if (len(input.move) > 0.05) {
          input.move = scale(norm(add(input.move, scale(norm(sub(me.pos, threat.pos)), 0.8))), 0.62);
        }
      }
    }
    if (attend) input.attend = attend;
    return input;
  }

  // ---- reads (believed world only) --------------------------------------

  // The run engine's view of the world, filled in place — one object per brain
  // for the life of the match, never one per think
  private runContext(world: World, me: PlayerBody): RunCtx {
    const c = this.runCtx ??= {
      world,
      bb: this.bb,
      me,
      idx: this.idx,
      opps: this.oppBuf,
      anchor: this.bb.anchorOf(this.idx),
      side: me.id.anchor.y < 0.5 ? -1 : 1,
      daring: this.daring,
      rng: this.rng,
      t: this.t,
    };
    c.world = world;
    c.me = me;
    c.anchor = this.wanderedAnchor();
    c.t = this.t;
    return c;
  }

  // The most dangerous BALL, not the most dangerous man: which of theirs can
  // actually be found from here, and how much it would cost us. The incumbent
  // keeps a bonus so the cover man doesn't dance between two lanes.
  private pickCoverMan(world: World): number {
    const ball = world.ball.pos;
    const mates = this.teamPositions(world);
    let best = -1;
    let bestDanger = 0.25;
    for (const [i, b] of this.beliefs) {
      const d = dist(b.pos, ball);
      if (d < 3 || d > 34) continue;
      const margin = passMargin(ball, b.pos, clamp(10 + d * 0.5, 11, 23), mates);
      if (margin < 0) continue;
      const danger = Math.min(margin, 1.2) + (60 - this.bb.axisOf(b.pos.x)) * 0.02 +
        (i === this.coverMan ? 0.35 : 0);
      if (danger > bestDanger) { bestDanger = danger; best = i; }
    }
    return best;
  }

  // Cover is not standing behind the presser hoping: it is standing ON the
  // pass that would actually hurt us, always behind the point of attack
  private coverSpot(world: World, man: number): Vec2 {
    const ball = world.ball.pos;
    const goal = this.bb.goalWeDefend();
    const base = man >= 0
      ? add(ball, scale(sub(this.seenAt(world, man), ball), 0.55))
      : add(ball, scale(norm(sub(goal, ball)), 5));
    const axis = Math.min(this.bb.axisOf(base.x), this.bb.axisOf(ball.x) - 1.5);
    return clampPitch(vec(this.bb.xAtAxis(axis), base.y));
  }

  // Goal-side and ball-side of my man: he never gets it facing forward, and
  // if it comes anyway I am the one who arrives
  private markSpot(world: World, at: Vec2, man: number): Vec2 {
    const lead = add(at, scale(this.seenVel(world, man), 0.25));
    const goalSide = norm(sub(this.bb.goalWeDefend(), lead));
    const toBall = sub(world.ball.pos, lead);
    const ballD = len(toBall);
    // tight when the ball can reach him, a step off it when it can't — and
    // TIGHT everywhere while the hunt burns: the trap has no passengers
    let spot = add(lead, scale(goalSide, this.bb.huntT > 0
      ? clamp(0.6 + ballD * 0.015, 0.6, 1.6)
      : clamp(1.1 + ballD * 0.045, 1.1, 3.2)));
    if (ballD > 2) spot = add(spot, scale(scale(toBall, 1 / ballD), 1.1));
    return clampPitch(spot);
  }

  // Where I believe that man is — my own eyes while they're fresh, the team
  // sheet after that. Eleven mates shouting is how a defender keeps a runner
  // he can't currently see.
  private seenAt(world: World, idx: number): Vec2 {
    const b = this.beliefs.get(idx);
    return b && b.age < 1.2 ? b.pos : world.players[idx].pos;
  }

  private seenVel(world: World, idx: number): Vec2 {
    const b = this.beliefs.get(idx);
    return b && b.age < 1.2 ? b.vel : world.players[idx].vel;
  }

  // The side his weight isn't already covering — and when he's set, whichever
  // side has the air
  private weakSide(me: PlayerBody, threat: Belief, drive: Vec2): Vec2 {
    const right = perpRight(drive);
    const drift = threat.vel.x * right.x + threat.vel.y * right.y;
    if (Math.abs(drift) > 0.8) return scale(right, drift > 0 ? -1 : 1);
    const opps = this.believedOpponents();
    const openRight = spaceAt(add(me.pos, scale(right, 4)), opps);
    const openLeft = spaceAt(sub(me.pos, scale(right, 4)), opps);
    return scale(right, openRight >= openLeft ? 1 : -1);
  }

  // My own team is ground truth: the interceptors on any lane they might try
  private teamPositions(world: World): Vec2[] {
    this.mateBuf.length = 0;
    const team = world.players[this.idx].id.team;
    world.players.forEach((p, i) => {
      if (p.id.team === team && i !== this.idx) this.mateBuf.push(p.pos);
    });
    return this.mateBuf;
  }

  // Roll the ball forward in the head (same friction the pitch applies) and
  // find the earliest point I can beat it to — receiving is an intercept. In
  // the air the pitch has no say, so a cross is met where it LANDS and not
  // where a ball rolling that fast would have died.
  private meetPoint(world: World, me: PlayerBody): Vec2 {
    const b = world.ball;
    let px = b.pos.x;
    let py = b.pos.y;
    let vx = b.vel.x;
    let vy = b.vel.y;
    let z = b.z;
    let vz = b.vz;
    const mySpeed = Math.max(4.5, me.stats.sprintSpeed * 0.9);
    const step = 0.12;
    for (let t = step; t <= 1.8; t += step) {
      if (z > 0.02 || vz > 0.05) {
        vz -= GRAVITY * step;
        z += vz * step;
        if (z <= 0) {
          z = 0;
          vz = -vz * world.surface.bounce;
        }
      } else {
        const sp = Math.hypot(vx, vy);
        if (sp > 0.3) {
          const k = (sp - Math.min(sp, (2.4 + 0.35 * sp) * step)) / sp;
          vx *= k;
          vy *= k;
        }
      }
      px += vx * step;
      py += vy * step;
      if (dist(me.pos, vec(px, py)) / mySpeed <= t) break;
    }
    return clampPitch(vec(px, py));
  }

  // The formation slot plus a slow personal drift. Small on purpose: the
  // deadband should swallow it, so idle men breathe instead of shuffling.
  private wanderedAnchor(): Vec2 {
    const a = this.bb.anchorOf(this.idx);
    return clampPitch(vec(
      a.x + Math.sin(this.t * 0.17 + this.wanderSeed) * 0.55,
      a.y + Math.cos(this.t * 0.21 + this.wanderSeed * 1.3) * 0.55,
    ));
  }

  private nearestBelief(point: Vec2, within: number): Belief | null {
    let best: Belief | null = null;
    let bestD = within;
    for (const [, b] of this.beliefs) {
      const d = dist(b.pos, point);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }
}
