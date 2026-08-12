import { Vec2, vec, add, clamp, dist, norm, scale, sub } from '../core/math';
import { Rng } from '../core/rng';
import { PITCH } from '../sim/constants';
import { kickAccuracy } from '../sim/tuning';
import { PlayerBody } from '../sim/player';
import { World } from '../sim/world';
import { CornerJob, TeamBrain } from './blackboard';
import { passMargin } from './intercept';
import { clampPitch, laneOpen, spaceAt } from './space';

// THE RUN ENGINE. Off the ball, a player picks an IDEA — break the line,
// attack the near post, overlap outside the carrier, check to feet, drift
// wide and stretch them — and lives with it for a couple of seconds. The plan
// is the idea, never a point on the grass: the target is recomputed live, so
// a committed run tracks the play instead of steering at a place the ball
// left ages ago. Re-deciding every beat is exactly what reads as robotic.
//
// A corner switches the same engine into SET-PIECE mode: the ideas stop being
// auctioned and start being dealt, and each one runs on the clock the whole
// box shares — so a delivery has something to be timed to.

export type RunKind =
  | 'hold'       // your slot in the breathing shape — holding it is a job too
  | 'check'      // come short at a safe angle, give him the easy out
  | 'channel'    // the half-space ahead of the ball
  | 'driftWide'  // pull a marker off the middle
  | 'overlap'    // outside the carrier, on the chalk, past him
  | 'linebreak'  // sit on the last shoulder and go when the ball goes
  | 'nearPost'   // attack the front of the six
  | 'farPost'    // the other end of the cutback
  | 'burst';     // the second half of a one-two, after my own pass

// A run is either one the man chose or one the set piece dealt him
export type RunPlan = RunKind | CornerJob;

const CORNER_SET = 1.9;    // seconds the box takes to arrange itself before anyone moves
const CORNER_CYCLE = 3.2;  // ...and then it keeps re-making its runs, forever
const CORNER_BREAK = 1.5;  // how long one break lasts before he resets and waits again
// Each job goes on its own beat, so four men never arrive as one wall. The two
// who hold their mark (the late one, the short one) simply never leave it.
const CORNER_DELAY: Record<CornerJob, number> = {
  cornerNear: 0,
  cornerFar: 0.45,
  cornerSpot: 0.85,
  cornerTop: 1.15,
  cornerShort: 0,
};

// Everything a run needs to know, filled in place each think — the engine
// allocates nothing per tick beyond the target it hands back
export interface RunCtx {
  world: World;
  bb: TeamBrain;
  me: PlayerBody;
  idx: number;
  opps: Vec2[];   // believed opponents, nothing more
  anchor: Vec2;   // his slot in the shape, already wandered
  side: -1 | 1;   // the touchline he lives on
  daring: number; // personal appetite for the ambitious run
  rng: Rng;
  t: number;      // the brain's own clock — the weave lives on it
}

const AUCTION: RunKind[] = ['hold', 'check', 'channel', 'driftWide', 'overlap', 'linebreak', 'nearPost', 'farPost'];

// Was this idea dealt by a set piece, or chosen off the auction?
export function isCornerJob(plan: RunPlan): plan is CornerJob {
  switch (plan) {
    case 'cornerNear':
    case 'cornerFar':
    case 'cornerSpot':
    case 'cornerTop':
    case 'cornerShort':
      return true;
    default:
      return false;
  }
}

// Is he going RIGHT NOW? Each corner job breaks on its own beat and resets
// between breaks, so the box keeps re-making its runs instead of standing
// still — and a struck ball sends everyone at once, whatever beat it caught.
export function cornerBreaking(bb: TeamBrain, job: CornerJob): boolean {
  const call = bb.corner;
  if (!call) return false;
  if (call.struck) return true;
  const wave = call.t - CORNER_SET;
  if (wave <= 0) return false;
  const beat = (wave % CORNER_CYCLE) - CORNER_DELAY[job];
  return beat >= 0 && beat < CORNER_BREAK;
}

// The box on a beat: his launch mark between breaks, his post while he goes
function cornerTarget(c: RunCtx, job: CornerJob): Vec2 {
  const call = c.bb.corner;
  if (!call) return c.anchor;
  const mark = call.marks[job];
  return cornerBreaking(c.bb, job) ? mark.at : mark.launch;
}

// Where this idea puts him RIGHT NOW — every kind reads the live ball, the
// live carrier and the live offside line
export function runTarget(c: RunCtx, plan: RunPlan): Vec2 {
  const { bb, me, world } = c;
  const ball = world.ball.pos;
  const sgn = bb.attackSign();
  const goal = bb.goalWeAttack();
  const mid = PITCH.width / 2;
  const chalk = c.side < 0 ? 4.5 : PITCH.width - 4.5;
  const carrier = carrierOf(c);
  const ballSide = ball.y >= mid ? 1 : -1;
  switch (plan) {
    case 'hold':
      return c.anchor;
    case 'check': {
      const from = carrier ? carrier.pos : ball;
      return clampPitch(vec(from.x - sgn * 6.5, from.y + c.side * 6));
    }
    case 'channel':
      return clampPitch(vec(ball.x + sgn * 12, (c.anchor.y + mid + c.side * 13) / 2));
    case 'driftWide':
      return clampPitch(vec(ball.x + sgn * 3, chalk));
    case 'overlap': {
      const past = Math.max(bb.axisOf((carrier ?? me).pos.x) + 10, bb.axisOf(me.pos.x) + 5);
      return clampPitch(vec(bb.xAtAxis(Math.min(past, bb.offsideSafeAxis() - 1)), chalk));
    }
    case 'linebreak': {
      // The runner HUNTS along the shoulder instead of standing on it: a
      // lateral weave at pace, so he arrives at every window with real
      // velocity — the lead pass has a run to be played into
      const weave = Math.sin(c.t * 2.4 + c.idx * 1.3) * 6.5;
      return clampPitch(vec(bb.xAtAxis(bb.offsideSafeAxis() + 9), c.anchor.y * 0.55 + goal.y * 0.45 + weave));
    }
    case 'nearPost':
      return clampPitch(vec(goal.x - sgn * 5.5, mid + ballSide * 3.4));
    case 'farPost':
      return clampPitch(vec(goal.x - sgn * 6.5, mid - ballSide * 6.5));
    case 'burst': {
      // Straight through the shoulder of whoever was marking me
      let dir = vec(sgn, 0);
      const marker = nearest(c.opps, me.pos, 5);
      if (marker) dir = norm(add(dir, scale(norm(sub(me.pos, marker)), 0.7)));
      return clampPitch(add(me.pos, scale(dir, 9)));
    }
    case 'cornerNear':
    case 'cornerFar':
    case 'cornerSpot':
    case 'cornerTop':
    case 'cornerShort':
      return cornerTarget(c, plan);
  }
}

// Runs that are worth burning legs on — the rest are walked into, and a corner
// job burns them only on his beat
export function runSprints(plan: RunPlan, bb: TeamBrain): boolean {
  switch (plan) {
    case 'cornerNear':
    case 'cornerFar':
    case 'cornerSpot':
    case 'cornerTop':
    case 'cornerShort':
      return cornerBreaking(bb, plan);
    default:
      // The break burns legs it would normally save; the scramble sprints even
      // the men whose whole job is standing in the right place
      if (bb.breakT > 0 && plan === 'channel') return true;
      if (bb.scrambleT > 0 && plan === 'hold') return true;
      return plan === 'linebreak' || plan === 'burst' || plan === 'overlap' ||
        plan === 'nearPost' || plan === 'farPost';
  }
}

// Seconds a chosen run is promised for. Long enough to read as intent, short
// enough that a dead idea doesn't outlive the move.
export function runCommit(kind: RunKind, rng: Rng): number {
  return kind === 'burst' ? 1.2 : 2 + rng.next() * 2;
}

// The auction. The incumbent run carries a bonus — hysteresis, so nobody
// abandons a good idea over a coin flip.
export function pickRun(c: RunCtx, current: RunPlan): RunKind {
  let best: RunKind = 'hold';
  let bestScore = -Infinity;
  for (const kind of AUCTION) {
    if (!allowed(c, kind)) continue;
    let s = score(c, kind, runTarget(c, kind));
    if (kind === current) s += 0.55;
    if (s > bestScore) { bestScore = s; best = kind; }
  }
  return best;
}

// Which ideas are even on the table for this body, in this phase, this zone
function allowed(c: RunCtx, kind: RunKind): boolean {
  const { bb, me, world } = c;
  const ballAxis = bb.axisOf(world.ball.pos.x);
  const wide = Math.abs(me.id.anchor.y - 0.5) > 0.27;
  const boxed = ballAxis > 64;
  switch (kind) {
    case 'hold': return true;
    case 'check': return !!carrierOf(c);
    case 'channel': return me.id.role !== 'DF';
    case 'driftWide': return wide;
    case 'overlap': return wide && ballAxis > 40 && (world.ball.pos.y >= PITCH.width / 2 ? 1 : -1) === c.side;
    case 'linebreak': return me.id.role !== 'DF' && ballAxis > 30;
    case 'nearPost': return me.id.role !== 'DF' && boxed;
    case 'farPost': return me.id.role !== 'DF' && boxed && Math.abs(world.ball.pos.y - PITCH.width / 2) > 9;
    case 'burst': return false; // owned by the brain's give-and-go window
  }
}

// Space at the end of it, a lane that survives, a carrier who can actually
// hit it, ground gained — and room for everyone else's idea too
function score(c: RunCtx, kind: RunKind, target: Vec2): number {
  const { bb, me, world, opps } = c;
  const carrier = carrierOf(c);
  const from = carrier ? carrier.pos : world.ball.pos;
  const d = dist(from, target);
  const speed = clamp(10 + d * 0.5, 11, 23);
  const deliver = carrier ? kickAccuracy(carrier.stats, 0, d) : 0.4;
  let s = roleFit(c, kind)
    + spaceAt(target, opps) * 0.12
    + clamp(passMargin(from, target, speed, opps), -1, 1.4) * 0.75
    + deliver * 0.5
    + laneOpen(from, target, opps) * 0.5
    + (bb.axisOf(target.x) - bb.axisOf(me.pos.x)) * 0.035
    + c.rng.next() * 0.35; // dither, so eleven brains never lockstep
  // The break wants VERTICAL ideas while the window burns — holding shape is
  // how a counter dies of politeness
  if (bb.breakT > 0) {
    if (kind === 'linebreak' || kind === 'channel' || kind === 'overlap') s += 1.0;
    if (kind === 'hold') s -= 0.7;
  }
  // Nobody stands on a teammate, and the carrier needs air, not company
  const mate = nearestTeammate(c, target);
  if (mate < 9) s -= (9 - mate) * 0.25;
  if (carrier) {
    const gap = dist(target, carrier.pos);
    if (gap < 7.5) s -= (7.5 - gap) * 0.35;
  }
  // The human's run is HIS. Nobody parks in the space he called for.
  const called = bb.humanRun;
  if (called && called.idx !== c.idx) {
    const near = dist(target, called.at);
    if (near < 9) s -= (9 - near) * 0.25;
  }
  // Beyond the line is a flag, not a run — only the timed break lives there,
  // and the brain holds even that one until the ball is struck
  if (kind !== 'linebreak' && bb.axisOf(target.x) > bb.offsideSafeAxis() - 0.5) s -= 2.5;
  return s;
}

// Who OWNS which idea: a striker's line-break is a fullback's overlap is a
// midfielder's check. The elected support jobs outrank taste.
function roleFit(c: RunCtx, kind: RunKind): number {
  const role = c.me.id.role;
  const wide = Math.abs(c.me.id.anchor.y - 0.5) > 0.27;
  if (c.bb.supportNearIdx === c.idx && kind === 'check') return 1.6;
  if (c.bb.supportDepthIdx === c.idx && kind === 'linebreak') return 1.5;
  switch (kind) {
    case 'hold': return role === 'DF' ? 0.9 : 0.35;
    case 'check': return role === 'MF' ? 0.6 : 0.25;
    case 'channel': return role === 'MF' ? 0.55 : role === 'FW' ? 0.45 : 0.1;
    case 'driftWide': return 0.7;
    case 'overlap': return role === 'DF' ? 0.9 : 0.4;
    case 'linebreak': return (role === 'FW' ? 0.85 : role === 'MF' ? 0.4 : 0) + c.daring * 0.3;
    case 'nearPost': return role === 'FW' ? 0.8 : 0.35;
    case 'farPost': return wide || role === 'FW' ? 0.75 : 0.3;
    case 'burst': return 0;
  }
}

function carrierOf(c: RunCtx): PlayerBody | null {
  const i = c.bb.possessorIdx;
  return i !== null && i !== c.idx ? c.world.players[i] : null;
}

function nearestTeammate(c: RunCtx, point: Vec2): number {
  let nearest = 40;
  c.world.players.forEach((p, i) => {
    if (i === c.idx || p.id.team !== c.me.id.team) return;
    nearest = Math.min(nearest, dist(p.pos, point));
  });
  return nearest;
}

function nearest(points: Vec2[], to: Vec2, within: number): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = within;
  for (const p of points) {
    const d = dist(p, to);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
