import { vec } from './core/math';
import { World } from './sim/world';
import { PlayerBody, PlayerInput } from './sim/player';
import { PITCH } from './sim/constants';
import { FORMATIONS, Formation } from './data/formations';
import { buildSquad, SquadPlayer } from './data/roster';
import { AiProfile, TeamBrain } from './ai/blackboard';
import { Brain } from './ai/brain';

// A full 11v11: bodies, team blackboards, and a brain for every body.
// The browser and the headless tests assemble the exact same match.

export interface MatchConfig {
  homeShape?: string;
  awayShape?: string;
  homeSquad?: SquadPlayer[]; // aligned to the shape's slots; archetypes otherwise
  awaySquad?: SquadPlayer[];
  halfLength?: number;       // seconds per half; 0 = endless kickabout
  kickoffFirst?: 0 | 1;      // the coin toss — deterministic 0 unless told
  awayProfile?: AiProfile;   // how sharp the CPU's brains are (difficulty)
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
  halfLength: number;
  finished: boolean;
  stats: MatchStats;
  kickoffFirst: 0 | 1;
  // a kicked ball waiting to learn whose boot it finds next
  pendingPass: { team: 0 | 1; idx: number } | null;
}

export function createMatch(config: MatchConfig = {}): Match {
  const world = new World();
  const homeShape = FORMATIONS[config.homeShape ?? '4-3-3'];
  const awayShape = FORMATIONS[config.awayShape ?? '4-4-2'];
  const homeSquad = config.homeSquad ?? buildSquad(homeShape, 101);
  const awaySquad = config.awaySquad ?? buildSquad(awayShape, 202);
  fieldTeam(world, 0, homeShape, homeSquad);
  fieldTeam(world, 1, awayShape, awaySquad);
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
    names: [...homeSquad.map((s) => s.name), ...awaySquad.map((s) => s.name)],
    half: 1,
    clock: 0,
    halfLength: config.halfLength ?? 0,
    kickoffFirst: config.kickoffFirst ?? 0,
    finished: false,
    stats: {
      possession: [0, 0], kicks: [0, 0], shots: [0, 0], onTarget: [0, 0],
      passes: [0, 0], passesGood: [0, 0], tacklesWon: [0, 0], saves: [0, 0],
      corners: [0, 0], throwins: [0, 0], goals: {},
    },
    pendingPass: null,
  };
}

// Was that kick a strike at goal, and would it have gone in? Read the ball's
// actual flight the tick it leaves — the ledger judges what really happened.
function classifyKick(world: World, idx: number): { shot: boolean; onTarget: boolean } {
  const team = world.players[idx].id.team;
  const goalX = team === 0 ? PITCH.length : 0;
  const v = world.ball.vel;
  const toward = team === 0 ? v.x > 3 : v.x < -3;
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
  for (const key of Object.keys(overrides)) {
    const i = Number(key);
    const p = match.world.players[i];
    if (p) match.teamBrains[p.id.team].humanIdx = i;
  }
  match.teamBrains[0].update(match.world, dt);
  match.teamBrains[1].update(match.world, dt);
  const inputs = match.world.players.map((_, i) => overrides[i] ?? match.brains[i].tick(match.world, dt));
  match.world.step(dt, inputs);

  // The clock: two halves, a break at the turn, a whistle at the end
  if (match.halfLength > 0 && !match.finished) {
    match.clock += dt;
    if (match.clock >= match.halfLength) {
      if (match.half === 1) {
        match.half = 2;
        match.clock = 0;
        // the other side opens the second half
        match.world.kickoffTeam = match.kickoffFirst === 0 ? 1 : 0;
        match.world.kickoffReset();
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
