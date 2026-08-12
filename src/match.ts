import { vec, dist, clamp, Vec2 } from './core/math';
import { World } from './sim/world';
import { PlayerBody, PlayerInput } from './sim/player';
import { PITCH } from './sim/constants';
import { keeperScatter } from './sim/tuning';
import { FORMATIONS, Formation } from './data/formations';
import { buildSquad, SquadPlayer } from './data/roster';
import { AiProfile, TeamBrain } from './ai/blackboard';
import { Brain } from './ai/brain';

// A full 11v11: bodies, team blackboards, and a brain for every body.
// The browser and the headless tests assemble the exact same match.

// However ragged the half, the referee never hands back more than this
export const MAX_STOPPAGE = 45;

export interface MatchConfig {
  homeShape?: string;
  awayShape?: string;
  homeSquad?: SquadPlayer[]; // aligned to the shape's slots; archetypes otherwise
  awaySquad?: SquadPlayer[];
  halfLength?: number;       // seconds per half; 0 = endless kickabout
  kickoffFirst?: 0 | 1;      // the coin toss — deterministic 0 unless told
  awayProfile?: AiProfile;   // how sharp the CPU's brains are (difficulty)
  practice?: boolean;        // training ground: no away team takes the field
}

export interface MatchStats {
  possession: [number, number]; // ticks holding the ball
  kicks: [number, number];
  shots: [number, number];
  onTarget: [number, number];
  passes: [number, number];
  passesGood: [number, number]; // found a teammate's next touch
  tacklesWon: [number, number];
  saves: [number, number];
  corners: [number, number];
  throwins: [number, number];
  goals: Record<number, number>; // body idx → goals
}

export interface Match {
  world: World;
  teamBrains: [TeamBrain, TeamBrain];
  brains: Brain[];
  names: string[]; // per body — HUD, scorers, the stats screen
  half: 1 | 2;
  clock: number;
  // Dead-ball seconds owed back at the end of this half, and whether the ball
  // has been played yet — the opening beat is ceremony, not time lost
  stoppage: number;
  halfLive: boolean;
  halfLength: number;
  practice: boolean;
  finished: boolean;
  stats: MatchStats;
  kickoffFirst: 0 | 1;
  // a kicked ball waiting to learn whose boot it finds next
  pendingPass: { team: 0 | 1; idx: number } | null;
  // a keeper reading the field before his distribution
  gkHold: { idx: number; t: number };
}

export function createMatch(config: MatchConfig = {}): Match {
  const world = new World();
  const homeShape = FORMATIONS[config.homeShape ?? '4-3-3'];
  const awayShape = FORMATIONS[config.awayShape ?? '4-4-2'];
  const homeSquad = config.homeSquad ?? buildSquad(homeShape, 101);
  const awaySquad = config.awaySquad ?? buildSquad(awayShape, 202);
  world.practice = !!config.practice;
  fieldTeam(world, 0, homeShape, homeSquad);
  if (!config.practice) fieldTeam(world, 1, awayShape, awaySquad);
  const teamBrains: [TeamBrain, TeamBrain] = [new TeamBrain(0), new TeamBrain(1)];
  if (config.awayProfile) teamBrains[1].profile = config.awayProfile;
  const brains = world.players.map((p, i) => new Brain(i, teamBrains[p.id.team]));
  // The opening ceremony: the toss winner's man stands over the ball
  world.kickoffTeam = config.kickoffFirst ?? 0;
  world.kickoffReset();
  return {
    world,
    teamBrains,
    brains,
    names: [...homeSquad.map((s) => s.name), ...(config.practice ? [] : awaySquad.map((s) => s.name))],
    half: 1,
    clock: 0,
    stoppage: 0,
    halfLive: false,
    halfLength: config.halfLength ?? 0,
    practice: !!config.practice,
    kickoffFirst: config.kickoffFirst ?? 0,
    finished: false,
    stats: {
      possession: [0, 0], kicks: [0, 0], shots: [0, 0], onTarget: [0, 0],
      passes: [0, 0], passesGood: [0, 0], tacklesWon: [0, 0], saves: [0, 0],
      corners: [0, 0], throwins: [0, 0], goals: {},
    },
    pendingPass: null,
    gkHold: { idx: -1, t: 0 },
  };
}

// The CPU keeper's eyes: every teammate scored on lane safety (the tightest
// opponent to the throwing line), breathing room at the receiver, and field
// progress — the best man gets the ball, flat and true inside throwing range,
// high and hanging beyond it. Same radii and scatter the human sight uses.
export function pickDistribution(world: World, gkIdx: number): { target: Vec2; kind: 'throw' | 'punt'; scatter: number } {
  const gk = world.players[gkIdx];
  const team = gk.id.team;
  const throwR = 24 + 14 * gk.stats.power;
  const puntR = clamp(60 + 34 * gk.stats.power, 60, 88);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (const p of world.players) {
    if (p.id.team !== team || p.id.role === 'GK') continue;
    const d = dist(gk.pos, p.pos);
    if (d < 6 || d > puntR) continue;
    let lane = 30;
    let room = 30;
    for (const q of world.players) {
      if (q.id.team === team) continue;
      room = Math.min(room, dist(q.pos, p.pos));
      const t = clamp(((q.pos.x - gk.pos.x) * (p.pos.x - gk.pos.x) + (q.pos.y - gk.pos.y) * (p.pos.y - gk.pos.y)) / (d * d), 0, 1);
      lane = Math.min(lane, dist(q.pos, vec(gk.pos.x + (p.pos.x - gk.pos.x) * t, gk.pos.y + (p.pos.y - gk.pos.y) * t)));
    }
    const progress = world.attackSign(team) > 0 ? p.pos.x : PITCH.length - p.pos.x;
    const score = Math.min(lane, 14) * 1.6 + Math.min(room, 12) * 1.4 + progress * 0.35 + (d <= throwR ? 4 : 0);
    if (score > bestScore) { bestScore = score; best = vec(p.pos.x, p.pos.y); }
  }
  // nobody worth finding: hammer it long down the safer flank
  const target = best ?? vec(
    clamp(gk.pos.x + world.attackSign(team) * 42, 4, PITCH.length - 4),
    gk.pos.y < PITCH.width / 2 ? PITCH.width * 0.3 : PITCH.width * 0.7,
  );
  const d = dist(gk.pos, target);
  const kind: 'throw' | 'punt' = d <= throwR ? 'throw' : 'punt';
  return { target, kind, scatter: keeperScatter(kind, d, gk.stats.control) };
}

// Was that kick a strike at goal, and would it have gone in? Read the ball's
// actual flight the tick it leaves — the ledger judges what really happened.
function classifyKick(world: World, idx: number): { shot: boolean; onTarget: boolean } {
  const team = world.players[idx].id.team;
  const goalX = world.goalXOf(team);
  const v = world.ball.vel;
  const toward = world.attackSign(team) > 0 ? v.x > 3 : v.x < -3;
  const distGoal = Math.abs(goalX - world.ball.pos.x);
  if (!toward || distGoal > 38) return { shot: false, onTarget: false };
  const yAtLine = world.ball.pos.y + v.y * (distGoal / Math.abs(v.x));
  const off = Math.abs(yAtLine - PITCH.width / 2);
  return { shot: off < PITCH.goalWidth / 2 + 5, onTarget: off < PITCH.goalWidth / 2 + 0.3 };
}

// One fixed tick: blackboards read the world, brains emit inputs, humans
// override theirs, the sim steps — then the clock and the ledger catch up.
export function advanceMatch(match: Match, dt: number, overrides: Record<number, PlayerInput> = {}) {
  // The sheet knows which body a human is wearing — teammates favor that ball
  match.teamBrains[0].humanIdx = -1;
  match.teamBrains[1].humanIdx = -1;
  match.world.humanIdxs.clear();
  for (const key of Object.keys(overrides)) {
    const i = Number(key);
    const p = match.world.players[i];
    if (!p) continue;
    match.teamBrains[p.id.team].humanIdx = i;
    match.world.humanIdxs.add(i); // the sim dresses these eyes and never walks these legs
  }
  match.teamBrains[0].update(match.world, dt);
  match.teamBrains[1].update(match.world, dt);
  const inputs = match.world.players.map((_, i) => {
    const o = overrides[i];
    if (!o) return match.brains[i].tick(match.world, dt);
    // The takeover blend: switching into a body never drops what it was doing.
    // Idle hands inherit the brain's whole stance (the mark, the jockey, the
    // chase); moving hands still KEEP the brain's clamp, so steering out of a
    // switch never releases jaws mid-duel. Kicks and lunges are decisions,
    // never inherited.
    if (o.assist) {
      const ai = match.brains[i].tick(match.world, dt);
      const idle = Math.hypot(o.move.x, o.move.y) < 0.15 &&
        !o.sprint && !o.kickCharging && !o.kickReleased && !o.tackle && !o.clamp;
      if (idle) return { ...ai, kickCharging: false, kickReleased: null, tackle: false, dive: undefined };
      if (ai.clamp && !o.clamp) return { ...o, clamp: true };
      return o;
    }
    return o;
  });
  // A keeper holding the ball STANDS and reads the field — his brain never
  // walks a charged clearance out of the box (unless a human seat is aiming him)
  const holdingIdx = match.world.holdingGk;
  if (holdingIdx >= 0 && !(holdingIdx in overrides)) {
    inputs[holdingIdx] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
  }
  match.world.step(dt, inputs);

  // ...and after a beat of reading, he DISTRIBUTES: throw or punt to the
  // safest open teammate, exactly like the human sight would
  const holding = match.world.holdingGk;
  if (holding >= 0 && !(holding in overrides)) {
    match.world.holdLock = true; // the beat stays open while he reads
    if (match.gkHold.idx !== holding) match.gkHold = { idx: holding, t: 0 };
    match.gkHold.t += dt;
    if (match.gkHold.t > 1.15) {
      const { target, kind, scatter } = pickDistribution(match.world, holding);
      match.world.gkLaunch(holding, target, kind, scatter);
      match.gkHold = { idx: -1, t: 0 };
    }
  } else if (match.gkHold.idx >= 0) {
    match.gkHold = { idx: -1, t: 0 };
  }

  // The clock: two halves, a break at the turn, a whistle at the end.
  // Every second the ball spends dead — restarts, a goal's whole ceremony — is
  // owed back before the whistle. The referee also holds it while the ball
  // lives in either attacking quarter: a promising move gets up to 30 seconds
  // to resolve.
  if (match.halfLength > 0 && !match.finished) {
    const w = match.world;
    const dead = w.restartLock > 0 || w.ceremony !== 'live' || w.awaitingRestart;
    if (!dead) match.halfLive = true;
    // A half begins when the ball is PLAYED — a kickoff nobody has taken yet is
    // ceremony, not time. After that the clock never stops, but every dead
    // second is owed back before the whistle.
    if (match.halfLive) {
      match.clock += dt;
      if (dead) match.stoppage += dt;
    }
    const full = match.halfLength + Math.min(match.stoppage, MAX_STOPPAGE);
    const bx = w.ball.pos.x;
    const dangerZone = bx < PITCH.length * 0.25 || bx > PITCH.length * 0.75;
    if (match.clock >= full && (!dangerZone || match.clock >= full + 30)) {
      if (match.half === 1) {
        match.half = 2;
        match.clock = 0;
        match.stoppage = 0;
        match.halfLive = false;
        // ends swap at the break — fair light, fair wind — and the other
        // side opens the second half
        match.world.swapSides();
        match.world.kickoffTeam = match.kickoffFirst === 0 ? 1 : 0;
        match.world.kickoffReset();
        // the break breathes: everyone to the spot, then three, two, one…
        match.world.restartLock = 4.6;
        match.world.events.push({ kind: 'half' });
      } else {
        match.finished = true;
        match.world.events.push({ kind: 'fulltime' });
      }
    }
  }

  // The ledger: possession ticks, kicks, shots, passes-found, duels, and who
  // scored — every number a broadcast graphic would want
  const s = match.stats;
  const world = match.world;
  // Broadcast possession: the team that last PLAYED the ball owns the tick
  // (pass flight included), and dead-ball ceremony time counts for nobody
  if (world.restartLock <= 0 && world.lastTouch) s.possession[world.lastTouch.team]++;

  // a waiting pass resolves the moment ANY other boot touches the ball
  const lt = world.lastTouch;
  if (match.pendingPass && lt && lt.idx !== match.pendingPass.idx) {
    if (lt.team === match.pendingPass.team) s.passesGood[lt.team]++;
    match.pendingPass = null;
  }

  for (const e of world.events) {
    if (e.kind === 'kick') {
      const team = world.players[e.idx].id.team;
      s.kicks[team]++;
      const { shot, onTarget } = classifyKick(world, e.idx);
      if (shot) {
        s.shots[team]++;
        if (onTarget) s.onTarget[team]++;
        match.pendingPass = null;
      } else {
        s.passes[team]++;
        match.pendingPass = { team, idx: e.idx };
      }
    }
    if (e.kind === 'steal' && world.lastTouch) s.tacklesWon[world.lastTouch.team]++;
    if ((e.kind === 'save' || e.kind === 'parry') && world.lastTouch) s.saves[world.lastTouch.team]++;
    if (e.kind === 'restart' && e.restart === 'corner') s.corners[e.team]++;
    if (e.kind === 'restart' && e.restart === 'throwin') s.throwins[e.team]++;
    if (e.kind === 'goal' && e.scorer >= 0) s.goals[e.scorer] = (s.goals[e.scorer] ?? 0) + 1;
  }
}

// Kickoff spots: the formation squeezed into its own half
function fieldTeam(world: World, team: 0 | 1, formation: Formation, squad: SquadPlayer[]) {
  formation.slots.forEach((slot, i) => {
    const axis = 2.5 + slot.x * 46; // meters out from our own goal line
    const x = team === 0 ? axis : PITCH.length - axis;
    const y = slot.y * PITCH.width;
    world.players.push(new PlayerBody(vec(x, y), squad[i].stats, {
      team, role: slot.role, anchor: vec(slot.x, slot.y), number: squad[i].number,
    }));
  });
}
