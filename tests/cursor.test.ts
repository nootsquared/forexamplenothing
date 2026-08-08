import { describe, it, expect } from 'vitest';
import { createMatch, advanceMatch, Match } from '../src/match';
import { TeamCursor } from '../src/input/cursor';
import { vec } from '../src/core/math';
import { PlayerInput } from '../src/sim/player';

const DT = 1 / 60;
// Minutes of simulated football take real seconds; vitest's 5s default is a
// stopwatch on the machine's mood, not on the code
const LONG_SIM = 30_000;

// One tick exactly as the browser wires it: sim first, cursor after
function tick(match: Match, cursor: TeamCursor) {
  advanceMatch(match, DT);
  cursor.update(match.world, match.teamBrains[0], DT);
}

describe('the possession-first cursor', () => {
  it('our carrier is instantly YOU — and never the keeper — through 45s of play', () => {
    const match = createMatch();
    const cursor = new TeamCursor(0, match.world);
    const strays: string[] = []; // every tick that broke the rule, named once at the end
    for (let t = 0; t < 45 * 60; t++) {
      tick(match, cursor);
      const bb = match.teamBrains[0];
      const me = match.world.players[cursor.idx];
      if (me.id.team !== 0) strays.push(`t${t}: wore the other shirt`);
      if (me.id.role === 'GK') strays.push(`t${t}: wore the keeper`);
      if (bb.phase === 'attack' && bb.possessorIdx !== null &&
          match.world.players[bb.possessorIdx].id.role !== 'GK' && cursor.idx !== bb.possessorIdx) {
        strays.push(`t${t}: carrier ${bb.possessorIdx} was not you`);
      }
    }
    expect(strays.slice(0, 3)).toEqual([]);
  }, LONG_SIM);

  it('off the ball, manual mode never moves you without a cause: possession, your kick, a restart, or E', () => {
    const match = createMatch();
    const cursor = new TeamCursor(0, match.world);
    let sinceMyKick = Infinity;
    for (let t = 0; t < 45 * 60; t++) {
      const before = cursor.idx;
      tick(match, cursor);
      const world = match.world;
      sinceMyKick = world.events.some((e) => e.kind === 'kick' && e.idx === before) ? 0 : sinceMyKick + DT;
      if (cursor.idx !== before) {
        const bb = match.teamBrains[0];
        const causedByPossession = bb.phase === 'attack' && bb.possessorIdx === cursor.idx;
        const causedByTouch = world.lastTouch?.team === 0 && world.lastTouch.idx === cursor.idx;
        const causedByRestart = world.events.some((e) => e.kind === 'restart' && e.team === 0 && e.taker >= 0);
        expect(causedByPossession || causedByTouch || causedByRestart || sinceMyKick < 1.9).toBe(true);
      }
    }
  }, LONG_SIM);

  it('a teammate touching an ARRIVING ball is instantly you — no waiting for the bounce to settle', () => {
    const match = createMatch();
    const cursor = new TeamCursor(0, match.world);
    const world = match.world;
    const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
    const idleAll: Record<number, PlayerInput> = {};
    world.players.forEach((_, i) => { idleAll[i] = idle; });
    const receiver = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'MF');
    world.restartLock = 0;
    // a ball dropping IN from a pass: on target, still airborne when it lands
    world.ball.pos = vec(world.players[receiver].pos.x + 2, world.players[receiver].pos.y);
    world.ball.vel = vec(-6, 0);
    world.ball.z = 0.9;
    world.ball.vz = 2;
    let touched = -1;
    for (let t = 0; t < 120; t++) {
      advanceMatch(match, DT, idleAll);
      cursor.update(world, match.teamBrains[0], DT);
      if (touched < 0 && world.lastTouch?.idx === receiver) touched = t;
      if (touched >= 0 && t >= touched + 4) break; // a four-tick grace, no more
    }
    expect(touched).toBeGreaterThanOrEqual(0);
    expect(cursor.idx).toBe(receiver);
  });

  it('T-mode hands the hunt to you; manual mode makes you press for it', () => {
    const manual = createMatch();
    const manualCursor = new TeamCursor(0, manual.world);
    let manualDefendSwitches = 0;
    let last = manualCursor.idx;
    let sinceKick = Infinity;
    let sinceRestart = Infinity; // restart/kickoff takers are a DESIGNED cause, not a hunter yank
    for (let t = 0; t < 30 * 60; t++) {
      const before = manualCursor.idx;
      tick(manual, manualCursor);
      sinceKick = manual.world.events.some((e) => e.kind === 'kick' && e.idx === before) ? 0 : sinceKick + DT;
      sinceRestart = manual.world.events.some((e) => (e.kind === 'restart' || e.kind === 'kickoff') && e.team === 0)
        ? 0 : sinceRestart + DT;
      if (manual.teamBrains[0].phase === 'defend' && manualCursor.idx !== last &&
          manual.teamBrains[0].possessorIdx !== manualCursor.idx && sinceKick > 1.9 && sinceRestart > 1.9 &&
          manual.world.lastTouch?.idx !== manualCursor.idx) { // possession-first carrier-take is designed
        manualDefendSwitches++;
      }
      last = manualCursor.idx;
    }
    const auto = createMatch();
    const autoCursor = new TeamCursor(0, auto.world);
    autoCursor.autoMode = true;
    let autoSwitches = 0;
    last = autoCursor.idx;
    for (let t = 0; t < 30 * 60; t++) {
      tick(auto, autoCursor);
      if (autoCursor.idx !== last) autoSwitches++;
      last = autoCursor.idx;
    }
    expect(manualDefendSwitches).toBe(0);      // defending never yanks you in manual
    expect(autoSwitches).toBeGreaterThan(3);   // auto mode rides the play
  }, LONG_SIM);

  it('E takes exactly the previewed man, and the preview is empty at your feet', () => {
    const match = createMatch();
    const cursor = new TeamCursor(0, match.world);
    let checkedTake = false;
    for (let t = 0; t < 30 * 60; t++) {
      tick(match, cursor);
      const bb = match.teamBrains[0];
      if (bb.possessorIdx === cursor.idx) expect(cursor.suggested).toBe(-1);
      if (!checkedTake && cursor.suggested >= 0) {
        const promised = cursor.suggested;
        cursor.manualSwitch();
        expect(cursor.idx).toBe(promised);
        checkedTake = true;
      }
    }
    expect(checkedTake).toBe(true);
  }, LONG_SIM);
});

describe('set pieces and the cursor', () => {
  it('a goal kick keeps the cursor OFF the keeper — the distribution sight owns that ball', () => {
    const match = createMatch();
    const world = match.world;
    const cursor = new TeamCursor(0, world);
    world.restartLock = 0;
    world.restartExclusion = 0;
    const shooter = world.players.findIndex((p) => p.id.team === 1 && p.id.role === 'FW');
    world.lastTouch = { team: 1, idx: shooter };
    world.ball.pos = vec(-0.5, 12); // over team 0's byline, wide of the mouth
    world.ball.vel = vec(-6, 0);
    const before = cursor.idx;
    tick(match, cursor);
    expect(world.events.some((e) => e.kind === 'restart' && e.restart === 'goalkick' && e.team === 0)).toBe(true);
    expect(cursor.idx).toBe(before);
    expect(world.players[cursor.idx].id.role).not.toBe('GK');
  });
});

describe('two seats, one team', () => {
  it('two human cursors never collide on the same body, and a worn carrier stays worn', () => {
    const match = createMatch();
    const world = match.world;
    const a = new TeamCursor(0, world);
    const mfIdx = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'MF');
    const b = new TeamCursor(0, world, mfIdx);
    a.claimed = (i) => b.idx === i;
    b.claimed = (i) => a.idx === i;
    b.isCaptain = false; // set pieces stay the captain's
    const idleIn: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
    let collisions = 0;
    for (let t = 0; t < 60 * 30; t++) {
      advanceMatch(match, DT, { [a.idx]: idleIn, [b.idx]: idleIn });
      a.update(world, match.teamBrains[0], DT);
      b.update(world, match.teamBrains[0], DT);
      if (a.idx === b.idx) collisions++;
    }
    expect(collisions).toBe(0);
  }, LONG_SIM);
});
