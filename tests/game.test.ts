import { describe, it, expect } from 'vitest';
import { vec } from '../src/core/math';
import { createMatch, advanceMatch } from '../src/match';
import { createDraft, aiPickIndex, pick, pickAcademy, needsOf, canPick, QUOTA, SQUAD_SIZE, quickSplit, toSquad } from '../src/data/draft';
import { priceOf, TOP_50 } from '../src/data/players';
import { FORMATIONS } from '../src/data/formations';
import { Role } from '../src/data/formations';

const DT = 1 / 60;

describe('the match clock', () => {
  it('runs two halves with a kickoff at the break and a whistle at the end', () => {
    const match = createMatch({ halfLength: 4 });
    let sawHalf = false;
    let sawFulltime = false;
    for (let t = 0; t < 60 * 9 && !match.finished; t++) {
      advanceMatch(match, DT);
      for (const e of match.world.events) {
        if (e.kind === 'half') {
          sawHalf = true;
          // the break resets everyone to the center-spot ceremony
          expect(match.world.ball.pos.x).toBeCloseTo(52.5, 0);
          expect(match.half).toBe(2);
        }
        if (e.kind === 'fulltime') sawFulltime = true;
      }
    }
    expect(sawHalf).toBe(true);
    expect(sawFulltime).toBe(true);
    expect(match.finished).toBe(true);
    expect(match.stats.possession[0] + match.stats.possession[1]).toBeGreaterThan(60);
  });

  it('a goal is credited to the last touch', () => {
    const match = createMatch();
    const world = match.world;
    world.lastTouch = { team: 0, idx: 9 };
    world.ball.pos = vec(104.5, 34);
    world.ball.vel = vec(15, 0);
    let scorer = -1;
    for (let t = 0; t < 30 && scorer < 0; t++) {
      advanceMatch(match, DT);
      const goal = world.events.find((e) => e.kind === 'goal');
      if (goal && goal.kind === 'goal') scorer = goal.scorer;
    }
    expect(scorer).toBe(9);
    expect(match.stats.goals[9]).toBe(1);
  });
});

describe('the draft', () => {
  it('prices double every six overall', () => {
    expect(priceOf(68) / priceOf(62)).toBeCloseTo(2, 1);
    expect(priceOf(94)).toBeGreaterThan(30);
    expect(priceOf(62)).toBeLessThan(1);
  });

  it('a full AI-vs-AI snake draft leaves both sides a legal, paid-for XI', () => {
    const draft = createDraft(0);
    while (draft.turn < draft.order.length) {
      const i = aiPickIndex(draft);
      if (i >= 0) {
        pick(draft, i);
      } else {
        const side = draft.sides[draft.order[draft.turn]];
        const needs = needsOf(side);
        const role = (Object.keys(needs) as Role[]).find((r) => needs[r] > 0)!;
        pickAcademy(draft, role);
      }
    }
    for (const side of draft.sides) {
      expect(side.picks.length).toBe(SQUAD_SIZE);
      expect(side.budget).toBeGreaterThanOrEqual(0);
      const needs = needsOf(side);
      (Object.keys(QUOTA) as Role[]).forEach((r) => expect(needs[r]).toBe(0));
    }
    // snake order means the two spends stay in the same league
    const spend = draft.sides.map((s) => 100 - s.budget);
    expect(Math.abs(spend[0] - spend[1])).toBeLessThan(45);
  });

  it('canPick always leaves enough budget to finish the squad', () => {
    const draft = createDraft(0);
    const side = draft.sides[0];
    side.budget = 40;
    const star = TOP_50[0]; // 36M+ superstar
    expect(canPick(side, star)).toBe(false); // 10 slots left would go unpaid
  });

  it('quick match deals the stars into two full XIs that field on any shape', () => {
    const [a, b] = quickSplit();
    expect(a.length).toBe(SQUAD_SIZE);
    expect(b.length).toBe(SQUAD_SIZE);
    const squad = toSquad(a, FORMATIONS['3-5-2']);
    expect(squad.length).toBe(11);
    expect(squad[0].role).toBe('GK');
    expect(new Set(squad.map((p) => p.name)).size).toBe(11);
  });
});
