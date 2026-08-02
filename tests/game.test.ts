import { describe, it, expect } from 'vitest';
import { vec, dist } from '../src/core/math';
import { createMatch, advanceMatch } from '../src/match';
import { createDraft, aiPickIndex, pick, pickAcademy, needsOf, canPick, QUOTA, SQUAD_SIZE, quickSplit, toSquad, quotaOfShape } from '../src/data/draft';
import { priceOf, PLAYER_POOL } from '../src/data/players';
import { FORMATIONS } from '../src/data/formations';
import { Role } from '../src/data/formations';
import { PITCH } from '../src/sim/constants';
import { AI_PROFILES, AiProfile, SHARP, TeamBrain } from '../src/ai/blackboard';
import { World } from '../src/sim/world';
import { PlayerBody } from '../src/sim/player';
import { Brain } from '../src/ai/brain';

const DT = 1 / 60;
const archStats = { topSpeed: 6, sprintSpeed: 8.4, accel: 10, agility: 0.8, control: 0.75, power: 0.7 };

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
          expect(match.world.ball.pos.x).toBeCloseTo(PITCH.length / 2, 0);
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
    world.restartLock = 0; // skip the opening ceremony; stage the finish
    world.restartExclusion = 0;
    world.lastTouch = { team: 0, idx: 9 };
    world.ball.pos = vec(PITCH.length - 0.5, PITCH.width / 2);
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

  it('a striker fed in the box with a sight of goal SHOOTS — no settle freeze, no turning back', () => {
    const match = createMatch();
    const world = match.world;
    world.restartLock = 0;
    world.restartExclusion = 0;
    const goal = vec(PITCH.length, PITCH.width / 2);
    const striker = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'FW');
    world.players[striker].pos = vec(goal.x - 12, goal.y);
    // every away outfielder is beaten upfield; one presser closes from
    // behind, wide of the ball's line so the feed arrives clean
    let presserPlaced = false;
    world.players.forEach((p) => {
      if (p.id.team !== 1 || p.id.role === 'GK') return;
      if (!presserPlaced) {
        p.pos = vec(goal.x - 15.5, goal.y + 5.5);
        presserPlaced = true;
      } else {
        p.pos = vec(60, p.pos.y);
      }
    });
    // the through ball arrives from a teammate — a fresh reception, the exact
    // moment the old brain used to stand on it and then lay it off backwards
    const feeder = world.players.findIndex((p, i) => p.id.team === 0 && p.id.role === 'MF' && i !== striker);
    world.lastTouch = { team: 0, idx: feeder };
    world.ball.pos = vec(goal.x - 17, goal.y);
    world.ball.vel = vec(10, 0);

    let struck = false;
    for (let t = 0; t < 150 && !struck; t++) {
      advanceMatch(match, DT);
      for (const e of world.events) {
        if (e.kind === 'kick' && e.idx === striker) {
          // the first ball he plays leaves TOWARD the goal, with venom
          expect(world.ball.vel.x).toBeGreaterThan(8);
          struck = true;
        }
      }
    }
    expect(struck).toBe(true);
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
    const spend = draft.sides.map((s) => 200 - s.budget);
    expect(Math.abs(spend[0] - spend[1])).toBeLessThan(90);
  });

  it('canPick always leaves enough budget to finish the squad', () => {
    const draft = createDraft(0);
    const side = draft.sides[0];
    side.budget = 40;
    const star = PLAYER_POOL[0]; // 36M+ superstar
    expect(canPick(side, star)).toBe(false); // 10 slots left would go unpaid
  });

  it('a called shape rewrites the quota — needs track the BOARD, not a template', () => {
    const draft = createDraft(0, 11, false); // the wheel's honest one-each turns
    draft.sides[0].quota = quotaOfShape(FORMATIONS['4-5-1']);
    const needs = needsOf(draft.sides[0]);
    expect(needs).toEqual({ GK: 1, DF: 4, MF: 5, FW: 1 }); // one striker wanted, not two
    expect(quotaOfShape(FORMATIONS['3-4-3'])).toEqual({ GK: 1, DF: 3, MF: 4, FW: 3 });
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

describe('small-sided football', () => {
  it('a 5-a-side draft and quick split both field legal fives', () => {
    const draft = createDraft(0, 5);
    expect(draft.order.length).toBe(10);
    expect(draft.sides[0].budget).toBe(90);
    while (draft.turn < draft.order.length) {
      const i = aiPickIndex(draft);
      if (i >= 0) pick(draft, i);
      else {
        const needs = needsOf(draft.sides[draft.order[draft.turn]]);
        pickAcademy(draft, (Object.keys(needs) as Role[]).find((r) => needs[r] > 0)!);
      }
    }
    expect(draft.sides[0].picks.length).toBe(5);
    expect(draft.sides[1].picks.length).toBe(5);
    const [a] = quickSplit(5);
    const squad = toSquad(a, FORMATIONS['2-1-1']);
    expect(squad.length).toBe(5);
    expect(squad[0].role).toBe('GK');
  });

  it('a 7v7 match plays real football', () => {
    const [a, b] = quickSplit(7);
    const match = createMatch({
      homeSquad: toSquad(a, FORMATIONS['3-2-1']), homeShape: '3-2-1',
      awaySquad: toSquad(b, FORMATIONS['2-3-1']), awayShape: '2-3-1',
    });
    expect(match.world.players.length).toBe(14);
    let kicks = 0;
    for (let t = 0; t < 35 * 60; t++) {
      advanceMatch(match, DT);
      kicks += match.world.events.filter((e) => e.kind === 'kick').length;
    }
    expect(kicks).toBeGreaterThan(10);
    for (const p of match.world.players) expect(Number.isFinite(p.pos.x)).toBe(true);
  });
});

describe('the broadcast ledger', () => {
  it('counts shots, passes and completions from real play', () => {
    const match = createMatch();
    for (let t = 0; t < 45 * 60; t++) advanceMatch(match, DT);
    const s = match.stats;
    const passes = s.passes[0] + s.passes[1];
    expect(passes).toBeGreaterThan(8);
    expect(s.passesGood[0] + s.passesGood[1]).toBeGreaterThan(0);
    expect(s.passesGood[0]).toBeLessThanOrEqual(s.passes[0]);
    expect(s.passesGood[1]).toBeLessThanOrEqual(s.passes[1]);
    expect(s.onTarget[0]).toBeLessThanOrEqual(s.shots[0]);
    expect(s.onTarget[1]).toBeLessThanOrEqual(s.shots[1]);
    expect(s.kicks[0] + s.kicks[1]).toBeGreaterThanOrEqual(passes + s.shots[0] + s.shots[1]);
  });
});

describe('difficulty wears the brain', () => {
  it('an easy press CONTAINS the carrier; a sharp press eats him', () => {
    // The lever itself, staged clean: one man on the ball, one man pressing
    const duel = (profile: AiProfile) => {
      const world = new World();
      const carrier = new PlayerBody(vec(60, 37), archStats, { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 8 });
      const presser = new PlayerBody(vec(70, 37), archStats, { team: 1, role: 'MF', anchor: vec(0.5, 0.5), number: 6 });
      world.players.push(carrier, presser);
      world.ball.pos = vec(60.6, 37);
      const tb0 = new TeamBrain(0);
      const tb1 = new TeamBrain(1);
      tb1.profile = profile;
      const brain = new Brain(1, tb1);
      const idleIn = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      let standoff = 0;
      let samples = 0;
      for (let t = 0; t < 60 * 6; t++) {
        world.ball.pos = vec(60.6, 37); // the carrier shields it in place
        world.ball.vel = vec();
        carrier.pos = vec(60, 37);
        tb0.update(world, DT);
        tb1.update(world, DT);
        world.step(DT, [idleIn, brain.tick(world, DT)]);
        if (t > 60 * 3) { standoff += dist(presser.pos, carrier.pos); samples++; }
      }
      return standoff / samples;
    };
    const easy = duel(AI_PROFILES[0]);
    const sharp = duel(SHARP);
    expect(easy).toBeGreaterThan(sharp + 0.7); // the mercy is measured in meters
    expect(sharp).toBeLessThan(2.2);           // and the razor really arrives
  });

  it('an easy-profile CPU still plays real football', () => {
    const m = createMatch({ awayProfile: AI_PROFILES[0] });
    for (let t = 0; t < 90 * 60; t++) advanceMatch(m, DT);
    const s = m.stats;
    expect(s.passes[1]).toBeGreaterThan(3);
    expect(s.passesGood[0] / Math.max(1, s.passes[0])).toBeGreaterThan(0.2);
  });
});
