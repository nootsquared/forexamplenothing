import { describe, it, expect } from 'vitest';
import { createMatch, advanceMatch, Match } from '../src/match';
import { TeamCursor } from '../src/input/cursor';
import { vec } from '../src/core/math';
import { PlayerInput } from '../src/sim/player';

const DT = 1 / 60;

// One tick exactly as the browser wires it: sim first, cursor after
function tick(match: Match, cursor: TeamCursor) {
  advanceMatch(match, DT);
  cursor.update(match.world, match.teamBrains[0], DT);
}

describe('the possession-first cursor', () => {
  it('our carrier is instantly YOU — and never the keeper — through 45s of play', () => {
    const match = createMatch();
    const cursor = new TeamCursor(0, match.world);
    for (let t = 0; t < 45 * 60; t++) {
      tick(match, cursor);
      const bb = match.teamBrains[0];
      const me = match.world.players[cursor.idx];
      expect(me.id.team).toBe(0);
      expect(me.id.role).not.toBe('GK');
      if (bb.phase === 'attack' && bb.possessorIdx !== null &&
          match.world.players[bb.possessorIdx].id.role !== 'GK') {
        expect(cursor.idx).toBe(bb.possessorIdx);
      }
    }
  });

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
        const causedByRestart = world.events.some((e) => e.kind === 'restart' && e.team === 0 && e.taker >= 0);
        expect(causedByPossession || causedByRestart || sinceMyKick < 1.9).toBe(true);
      }
    }
  });

  it('T-mode hands the hunt to you; manual mode makes you press for it', () => {
    const manual = createMatch();
    const manualCursor = new TeamCursor(0, manual.world);
    let manualDefendSwitches = 0;
    let last = manualCursor.idx;
    let sinceKick = Infinity;
    for (let t = 0; t < 30 * 60; t++) {
      const before = manualCursor.idx;
      tick(manual, manualCursor);
      sinceKick = manual.world.events.some((e) => e.kind === 'kick' && e.idx === before) ? 0 : sinceKick + DT;
      if (manual.teamBrains[0].phase === 'defend' && manualCursor.idx !== last &&
          manual.teamBrains[0].possessorIdx !== manualCursor.idx && sinceKick > 1.9) {
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
  });

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
  });
});
