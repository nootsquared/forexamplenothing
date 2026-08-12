import { describe, it, expect } from 'vitest';
import { vec, dist, norm, sub } from '../src/core/math';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput, PlayerStats, PlayerIdentity, SkillKind } from '../src/sim/player';
import { packInput, unpackInput } from '../src/net/party';

// The skill kit, headless: moves always fire, the ball is displaced
// deterministically, stats scale quality, and the sim gates context and
// cooldowns identically for hands and brains.

const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const mk = (over: Partial<PlayerStats>): PlayerStats => ({
  topSpeed: 5.5, sprintSpeed: 7.5, accel: 10, agility: 0.8, control: 0.5, power: 0.7,
  shoot: 0.5, pass: 0.6, longBall: 0.5, defend: 0.5, phys: 0.5, reflex: 0.1, dive: 0.1, handling: 0.1,
  ...over,
});
const id = (team: 0 | 1, role: PlayerIdentity['role'] = 'MF'): PlayerIdentity =>
  ({ team, role, anchor: vec(0.5, 0.5), number: 1 });
const doSkill = (kind: SkillKind, dir = vec(0, 1)): PlayerInput => ({ ...idle, skill: { kind, dir } });

// A carrier latched onto his ball, an opponent stood where the test wants him
const stage = (carrierStats: PlayerStats, otherStats: PlayerStats, otherPos = vec(50.5, 34)) => {
  const world = new World();
  const carrier = new PlayerBody(vec(52, 34), carrierStats, id(0));
  const other = new PlayerBody(otherPos, otherStats, id(1, 'DF'));
  world.players.push(carrier, other);
  world.ball.pos = vec(52.5, 34);
  world.ball.vel = vec(1.5, 0);
  for (let i = 0; i < 30 && !world.carrier; i++) world.step(1 / 60, [idle, idle]);
  expect(world.carrier?.idx).toBe(0);
  return { world, carrier, other };
};

describe('the kit fires and the sim gates it', () => {
  it('context is the grammar: attack moves need the ball, challenges refuse it', () => {
    const { world, carrier, other } = stage(mk({}), mk({}));
    world.step(1 / 60, [doSkill('slide', vec(1, 0)), doSkill('croqueta')]);
    expect(carrier.sliding).toBe(false);          // a carrier cannot slide
    expect(carrier.moveCd.slide).toBe(0);
    expect(other.moveCd.croqueta).toBe(0);        // and a chaser cannot croqueta
    world.step(1 / 60, [doSkill('croqueta'), doSkill('slide', vec(1, 0))]);
    expect(carrier.moveCd.croqueta).toBeGreaterThan(0); // the right page answers
    expect(other.sliding).toBe(true);
  });

  it('cooldowns make it a decision: the second rainbow in a breath is refused', () => {
    const { world, carrier } = stage(mk({ agility: 0.9, control: 0.9 }), mk({}), vec(40, 20));
    world.step(1 / 60, [doSkill('rainbow', vec(1, 0)), idle]);
    expect(world.ball.vz).toBeGreaterThan(5);     // it flew
    const cd = carrier.moveCd.rainbow;
    expect(cd).toBeGreaterThan(4);
    world.step(1 / 60, [doSkill('rainbow', vec(1, 0)), idle]);
    expect(carrier.moveCd.rainbow).toBeLessThan(cd); // only decayed — never re-armed
  });

  it('the croqueta shifts the ball across, tighter and faster for better feet', () => {
    const gold = stage(mk({ control: 0.95 }), mk({}), vec(40, 20));
    gold.world.step(1 / 60, [doSkill('croqueta', vec(0, 1)), idle]);
    const goldVy = gold.world.ball.vel.y;
    const silver = stage(mk({ control: 0.2 }), mk({}), vec(40, 20));
    silver.world.step(1 / 60, [doSkill('croqueta', vec(0, 1)), idle]);
    expect(goldVy).toBeGreaterThan(8);            // the shift is a dart
    expect(goldVy).toBeGreaterThan(silver.world.ball.vel.y); // stats buy speed
  });

  it('the rainbow goes OVER a man: the ball clears head height mid-flight', () => {
    const { world } = stage(mk({ agility: 0.9, control: 0.9 }), mk({}), vec(53.5, 34));
    world.step(1 / 60, [doSkill('rainbow', vec(1, 0)), idle]);
    let peak = 0;
    for (let i = 0; i < 50; i++) {
      world.step(1 / 60, [idle, idle]);
      peak = Math.max(peak, world.ball.z);
    }
    expect(peak).toBeGreaterThan(1.2);
  });

  it('the feint bursts OPPOSITE the sway and the ball rides the cut', () => {
    const { world, carrier } = stage(mk({ agility: 0.9, control: 0.9 }), mk({}), vec(40, 20));
    world.step(1 / 60, [doSkill('feint', vec(0, 1)), idle]); // sway named toward +y
    expect(carrier.vel.y).toBeLessThan(-2);                  // the burst went -y
    expect(world.ball.vel.y).toBeLessThan(-1);               // and the ball went with him
  });
});

describe('the slide answers to its own referee', () => {
  it('any ball the slide reaches is won outright, and the dribbler goes down', () => {
    const { world, carrier, other } = stage(mk({}), mk({ defend: 0.8 }), vec(52.6, 35.6));
    // face the carrier down the slide's line so the contact is honest, not a back
    carrier.facing = vec(0, 1);
    let stole = false;
    world.step(1 / 60, [idle, doSkill('slide', norm(sub(world.ball.pos, other.pos)))]);
    for (let i = 0; i < 40 && !stole; i++) {
      stole = world.events.some((e) => e.kind === 'steal');
      if (!stole) world.step(1 / 60, [idle, idle]);
    }
    expect(stole).toBe(true);
    expect(carrier.lungeTimer).toBeGreaterThan(0); // the sprawl — he went down over the boot
    expect(world.lastTouch?.team).toBe(1);
  });

  it('a slide through a back is a foul and a free kick, ball won or not', () => {
    const { world, carrier, other } = stage(mk({}), mk({ defend: 0.8 }), vec(53.9, 34));
    carrier.facing = vec(-1, 0); // his back is square to the slider...
    // ...and his ball is on his FRONT side: reaching it means going through him
    world.ball.pos = vec(carrier.pos.x - 0.8, 34);
    world.ball.vel = vec();
    world.humanIdxs.add(1);
    let foul = false;
    let restart = '';
    world.step(1 / 60, [idle, doSkill('slide', norm(sub(carrier.pos, other.pos)))]);
    for (let i = 0; i < 40 && !foul; i++) {
      world.step(1 / 60, [idle, idle]);
      foul = world.events.some((e) => e.kind === 'foul' && e.by === 1);
      const r = world.events.find((e) => e.kind === 'restart');
      if (r?.kind === 'restart') restart = r.restart;
    }
    expect(foul).toBe(true);
    expect(restart).toBe('freekick');
  });

  it('a slide that finds nothing is a second on the grass', () => {
    const { world, other } = stage(mk({}), mk({ defend: 0.5 }), vec(46, 28));
    world.step(1 / 60, [idle, doSkill('slide', vec(-1, 0))]); // away from everything
    for (let i = 0; i < 40; i++) world.step(1 / 60, [idle, idle]);
    expect(other.recoverTimer).toBeGreaterThan(0.3); // still wearing the miss
    expect(world.events.some((e) => e.kind === 'steal')).toBe(false);
  });
});

describe('the barge is a PHYS contest', () => {
  it('the strong shoulder breaks a shielder: his ball is nobody\'s for a beat', () => {
    const { world, other } = stage(mk({ phys: 0.2, control: 0.6 }), mk({ phys: 0.95 }), vec(51.2, 34));
    world.step(1 / 60, [idle, doSkill('barge', vec(1, 0))]);
    expect(world.carrier).toBeNull();              // the latch broke with the wall
    expect(world.players[0].recoverTimer).toBeGreaterThan(0.2); // he staggered
    expect(other.moveCd.barge).toBeGreaterThan(0);
  });

  it('the weak shoulder bounces off and eats the recovery', () => {
    const { world, carrier, other } = stage(mk({ phys: 0.95 }), mk({ phys: 0.05 }), vec(51.2, 34));
    world.step(1 / 60, [idle, doSkill('barge', vec(1, 0))]);
    expect(world.carrier?.idx).toBe(0);            // the wall held
    expect(other.recoverTimer).toBeGreaterThan(0.3);
    expect(carrier.recoverTimer).toBe(0);
    expect(world.events.some((e) => e.kind === 'shrug')).toBe(true);
  });
});

describe('the kit on the wire', () => {
  it('a skill round-trips packInput with its kind and line intact', () => {
    const round = unpackInput(packInput({ ...idle, skill: { kind: 'rainbow', dir: vec(0.6, -0.8) } }, false));
    expect(round.skill?.kind).toBe('rainbow');
    expect(round.skill?.dir.x).toBeCloseTo(0.6, 5);
    expect(round.skill?.dir.y).toBeCloseTo(-0.8, 5);
    expect(unpackInput(packInput(idle, false)).skill).toBeNull();
  });
});
