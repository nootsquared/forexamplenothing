import { describe, it, expect } from 'vitest';
import { vec, dist } from '../src/core/math';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput, PlayerStats, PlayerIdentity } from '../src/sim/player';
import { packInput, unpackInput } from '../src/net/party';

const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const mk = (over: Partial<PlayerStats>): PlayerStats => ({
  topSpeed: 5.5, sprintSpeed: 7.5, accel: 10, agility: 0.8, control: 0.5, power: 0.7,
  shoot: 0.5, pass: 0.6, longBall: 0.5, defend: 0.5, phys: 0.5, reflex: 0.1, dive: 0.1, handling: 0.1,
  ...over,
});
const id = (team: 0 | 1, role: PlayerIdentity['role'] = 'MF'): PlayerIdentity =>
  ({ team, role, anchor: vec(0.5, 0.5), number: 1 });

// A world with a LATCHED carrier: the ball trickles onto his boot and he traps it
const latchedStage = (carrierStats: PlayerStats, otherStats: PlayerStats, otherPos = vec(50.5, 34), otherTeam: 0 | 1 = 1) => {
  const world = new World();
  const carrier = new PlayerBody(vec(52, 34), carrierStats, id(0));
  const other = new PlayerBody(otherPos, otherStats, id(otherTeam));
  world.players.push(carrier, other);
  world.ball.pos = vec(52.5, 34);
  world.ball.vel = vec(1.5, 0);
  for (let i = 0; i < 30 && !world.carrier; i++) world.step(1 / 60, [idle, idle]);
  expect(world.carrier?.idx).toBe(0);
  return { world, carrier, other };
};

describe('the possession war', () => {
  it('walking through a latched carrier steals NOTHING anymore', () => {
    const { world, carrier } = latchedStage(mk({}), mk({ defend: 0.9, phys: 0.9 }), vec(49.5, 34));
    const charge: PlayerInput = { ...idle, move: vec(1, 0), sprint: true };
    for (let i = 0; i < 100; i++) world.step(1 / 60, [idle, charge]);
    expect(world.lastTouch?.team).toBe(0);
    expect(dist(world.ball.pos, carrier.pos)).toBeLessThan(1.5);
  });

  it('a gold defender CLAMPS a gray carrier and takes the ball clean', () => {
    const { world, other } = latchedStage(mk({ control: 0.45, phys: 0.42 }), mk({ defend: 0.92, phys: 0.84 }));
    let wonAt = -1;
    for (let i = 0; i < 220 && wonAt < 0; i++) {
      // a real clamper CHASES — feints buy the carrier ground, not freedom.
      // The duel ends either way a defender wins: jaws closing, or the escape
      // breaking down and the loose ball collected clean.
      const to = vec(world.ball.pos.x - other.pos.x, world.ball.pos.y - other.pos.y);
      const l = Math.hypot(to.x, to.y) || 1;
      world.step(1 / 60, [idle, { ...idle, move: vec(to.x / l, to.y / l), clamp: true }]);
      const owns = world.carrier && world.players[world.carrier.idx].id.team === 1;
      if (owns || world.events.some((e) => e.kind === 'steal')) wonAt = i;
    }
    expect(wonAt).toBeGreaterThanOrEqual(0);
    expect(wonAt / 60).toBeLessThan(2.5);
    expect(world.lastTouch?.team).toBe(1);
  });

  it("a striker's clamp on a gold carrier basically never closes", () => {
    const { world } = latchedStage(mk({ control: 0.95, phys: 0.6 }), mk({ defend: 0.06, phys: 0.3 }));
    const squeeze: PlayerInput = { ...idle, clamp: true };
    for (let i = 0; i < 180; i++) world.step(1 / 60, [idle, squeeze]);
    expect(world.events.some((e) => e.kind === 'steal')).toBe(false);
    expect(world.lastTouch?.team).toBe(0);
  });

  it('a weak lunge BOUNCES OFF a strong shielded carrier', () => {
    const { world, other } = latchedStage(mk({ control: 0.6, phys: 0.95 }), mk({ defend: 0.1, phys: 0.3 }), vec(51, 34));
    let shrugged = false;
    const dive: PlayerInput = { ...idle, move: vec(1, 0), tackle: true };
    for (let i = 0; i < 40; i++) {
      world.step(1 / 60, [idle, i === 0 ? dive : { ...idle, move: vec(1, 0) }]);
      if (world.events.some((e) => e.kind === 'shrug')) shrugged = true;
    }
    expect(shrugged).toBe(true);
    expect(other.recoverTimer).toBeGreaterThanOrEqual(0); // he ate the stagger
    expect(world.lastTouch?.team).toBe(0);                // and won nothing
  });

  it('a loose ball goes to whoever is genuinely first — not the higher array index', () => {
    const world = new World();
    const home = new PlayerBody(vec(50.9, 34), mk({}), id(0));
    const away = new PlayerBody(vec(53.1, 34), mk({}), id(1)); // higher index, a hair farther
    world.players.push(home, away);
    world.ball.pos = vec(52, 34);
    const inH: PlayerInput = { ...idle, move: vec(1, 0) };
    const inA: PlayerInput = { ...idle, move: vec(-1, 0) };
    for (let i = 0; i < 60 && !world.carrier; i++) world.step(1 / 60, [inH, inA]);
    expect(world.carrier).not.toBeNull();
    expect(world.players[world.carrier!.idx].id.team).toBe(0);
  });

  it('the clamp bit rides the wire', () => {
    const round = unpackInput(packInput({ ...idle, clamp: true, tackle: false }, false));
    expect(round.clamp).toBe(true);
    expect(round.tackle).toBe(false);
  });
});
