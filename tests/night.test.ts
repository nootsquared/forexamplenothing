import { describe, it, expect } from 'vitest';
import { vec } from '../src/core/math';
import { PITCH } from '../src/sim/constants';
import { saveChance } from '../src/sim/world';
import { createMatch, advanceMatch } from '../src/match';
import { POOL } from '../src/data/pool';
import { PLAYER_POOL, rarityOf } from '../src/data/players';
import { FORMATIONS, STYLES, formationsOf, formationsOfSize } from '../src/data/formations';
import { toSquadOrdered, quickSplit } from '../src/data/draft';

const DT = 1 / 60;
// Minutes of simulated football take real seconds; vitest's 5s default is a
// stopwatch on the machine's mood, not on the code
const LONG_SIM = 30_000;

describe('the save contest', () => {
  it('pace beats hands: faster and wider strikes are harder to hold', () => {
    expect(saveChance(8, 0.2, 0.8)).toBeGreaterThan(0.9);   // a slow ball at the chest is routine
    expect(saveChance(24, 0.2, 0.8)).toBeLessThan(saveChance(14, 0.2, 0.8)); // pace hurts
    expect(saveChance(18, 0.9, 0.8)).toBeLessThan(saveChance(18, 0.2, 0.8)); // the stretch hurts
    expect(saveChance(24, 0.95, 0.6)).toBeGreaterThanOrEqual(0.05); // never a guarantee either way
    expect(saveChance(6, 0.1, 0.9)).toBeLessThanOrEqual(0.985);
    expect(saveChance(20, 0.5, 0.9)).toBeGreaterThan(saveChance(20, 0.5, 0.6)); // elite hands matter
  });
});

describe('the world cup class', () => {
  it('is exactly the pool the draft was promised', () => {
    expect(POOL.length).toBe(203);
    const byRole = { GK: 0, DF: 0, MF: 0, FW: 0 };
    const names = new Set<string>();
    for (const [name, role, ovr, pace, agility, control, power, number] of POOL) {
      byRole[role]++;
      names.add(name);
      expect(name).toMatch(/^[A-Z ]{1,11}$/);
      expect(ovr).toBeGreaterThanOrEqual(62);
      expect(ovr).toBeLessThanOrEqual(94);
      for (const v of [pace, agility, control, power]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(number).toBeGreaterThanOrEqual(1);
      expect(number).toBeLessThanOrEqual(26);
    }
    expect(names.size).toBe(203); // nobody signed twice
    expect(byRole).toEqual({ GK: 19, DF: 44, MF: 70, FW: 70 });
  });

  it('every rarity band is stocked for every role, so the reel always glitters', () => {
    for (const role of ['GK', 'DF', 'MF', 'FW'] as const) {
      for (const band of ['legend', 'epic', 'rare', 'common'] as const) {
        const stocked = PLAYER_POOL.filter((p) => p.role === role && rarityOf(p.ovr) === band);
        expect(stocked.length, `${role} ${band}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps the balance caps: nobody but the chosen few touches the ceiling', () => {
    const pace1 = PLAYER_POOL.filter((p) => p.stats.sprintSpeed >= 5.9 + 0.999 * 2.3);
    expect(pace1.map((p) => p.name)).toEqual(['MBAPPE']);
    const power1 = PLAYER_POOL.filter((p) => p.stats.power >= 0.999);
    expect(power1.map((p) => p.name)).toEqual(['HAALAND']);
  });
});

describe('shapes and shirts', () => {
  it('every size offers every style, and every shape fields its size', () => {
    for (const size of [5, 7, 11]) {
      for (const style of STYLES) {
        expect(formationsOf(size, style).length).toBeGreaterThanOrEqual(1);
      }
      for (const id of formationsOfSize(size)) {
        expect(FORMATIONS[id].slots.length).toBe(size);
        expect(FORMATIONS[id].slots[0].role).toBe('GK');
      }
    }
  });

  it('an arranged XI keeps its order and never wears the same shirt twice', () => {
    const [a] = quickSplit();
    const squad = toSquadOrdered(a, FORMATIONS['4-4-2']);
    expect(squad.length).toBe(11);
    squad.forEach((p, i) => {
      expect(p.name).toBe(a[i].name); // slot i IS player i — no reshuffle
      expect(p.role).toBe(FORMATIONS['4-4-2'].slots[i].role);
    });
    expect(new Set(squad.map((p) => p.number)).size).toBe(11);
  });
});

describe('the celebration', () => {
  it('a goal opens the window, the scorers lose their minds, then the spot restart', () => {
    const match = createMatch();
    const world = match.world;
    world.restartLock = 0;
    world.restartExclusion = 0;
    world.lastTouch = { team: 0, idx: 9 };
    world.ball.pos = vec(PITCH.length - 0.5, PITCH.width / 2);
    world.ball.vel = vec(15, 0);
    for (let t = 0; t < 30 && !world.celebration; t++) advanceMatch(match, DT);
    expect(world.celebration).not.toBeNull();
    expect(world.celebration!.team).toBe(0);
    expect(world.celebration!.scorer).toBe(9);
    // the scorer wheels toward the corner flag while the window is open
    const scorer = world.players[9];
    const before = Math.hypot(scorer.pos.x - (PITCH.length - 4), scorer.pos.y - 3);
    for (let t = 0; t < 120; t++) advanceMatch(match, DT);
    const during = Math.hypot(scorer.pos.x - (PITCH.length - 4), scorer.pos.y - 3);
    expect(during).toBeLessThan(before);
    // and the whole thing resolves — party, walk home, fresh kickoff for the conceded
    let sawKickoff = false;
    for (let t = 0; t < 60 * 16; t++) {
      advanceMatch(match, DT);
      if (world.events.some((e) => e.kind === 'kickoff' && e.team === 1)) sawKickoff = true;
    }
    expect(world.celebration).toBeNull();
    expect(world.ceremony).toBe('live');
    expect(sawKickoff).toBe(true);
  }, LONG_SIM);
});
