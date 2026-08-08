import { describe, it, expect } from 'vitest';
import { vec, dist } from '../src/core/math';
import { PITCH } from '../src/sim/constants';
import { createMatch, advanceMatch, Match } from '../src/match';
import { CORNER_JOBS } from '../src/ai/blackboard';

const DT = 1 / 60;
const LONG_SIM = 30_000;

// The box, and the box plus the D the late runner hangs in
const inside = (p: { pos: { x: number; y: number } }, goalX: number, deep: number) =>
  Math.abs(p.pos.x - goalX) < deep && Math.abs(p.pos.y - PITCH.width / 2) < 20.16;

// Roll the ball over team 0's goal line off a team 0 boot: the referee gives
// team 1 the corner, exactly as a real deflection would — with team 1 already
// camped in the final third, which is the only way a side ever earns one
const winACorner = (): Match => {
  const match = createMatch();
  for (let i = 0; i < 120; i++) advanceMatch(match, DT); // let the kickoff settle
  const world = match.world;
  for (const p of world.players) {
    if (p.id.team === 1 && p.id.role !== 'GK') p.pos = vec(Math.min(p.pos.x, 34), p.pos.y);
  }
  const defender = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'DF');
  world.lastTouch = { team: 0, idx: defender };
  world.ball.pos = vec(-0.4, 20);
  world.ball.vel = vec(-2, 0);
  world.ball.z = 0;
  advanceMatch(match, DT);
  advanceMatch(match, DT); // the sheets read the whistle a tick later
  return match;
};

describe('the corner', () => {
  it('deals every job in the box, to distinct men, on both sheets', () => {
    const match = winACorner();
    const call = match.teamBrains[1].corner;
    expect(call).not.toBeNull();
    expect(call!.team).toBe(1);
    expect(match.teamBrains[0].corner).not.toBeNull(); // the defenders know too
    const men = CORNER_JOBS.map((j) => call!.men[j]);
    expect(new Set(men).size).toBe(men.length);
    for (const i of men) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).not.toBe(call!.taker);
      expect(match.world.players[i].id.team).toBe(1);
      expect(match.world.players[i].id.role).not.toBe('GK');
    }
  }, LONG_SIM);

  it('fills the box with attackers and drags the markers back with them', () => {
    const match = winACorner();
    const goalX = match.world.goalXOf(1);
    let attackersIn = 0;
    let defendersIn = 0;
    for (let t = 0; t < 60 * 6; t++) {
      advanceMatch(match, DT);
      if (!match.teamBrains[1].corner) break;
      const count = (team: 0 | 1, deep: number) =>
        match.world.players.filter((p) => p.id.team === team && p.id.role !== 'GK' && inside(p, goalX, deep)).length;
      attackersIn = Math.max(attackersIn, count(1, 21));
      defendersIn = Math.max(defendersIn, count(0, 16.5));
    }
    expect(attackersIn).toBeGreaterThanOrEqual(4); // near post, far post, the spot, the top
    expect(defendersIn).toBeGreaterThanOrEqual(4);
    // and the keeper is on his line, not sweeping out toward the flag
    const gk = match.world.players.find((p) => p.id.team === 0 && p.id.role === 'GK')!;
    expect(Math.abs(gk.pos.x - goalX)).toBeLessThan(4);
  }, LONG_SIM);

  it('is actually delivered into the box, and never deadlocks', () => {
    const match = winACorner();
    const goalX = match.world.goalXOf(1);
    let struck = false;
    for (let t = 0; t < 60 * 8; t++) {
      advanceMatch(match, DT);
      if (match.world.events.some((e) => e.kind === 'kick' && dist(vec(e.x, e.y), vec(goalX, 0.4)) < 6)) struck = true;
    }
    expect(struck).toBe(true);
    // the shape is spent: nobody is still standing in the box waiting
    expect(match.teamBrains[1].corner).toBeNull();
    expect(match.teamBrains[0].corner).toBeNull();
  }, LONG_SIM);
});
