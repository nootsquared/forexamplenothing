import { describe, it, expect } from 'vitest';
import { vec } from '../src/core/math';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput } from '../src/sim/player';
import { Ball } from '../src/sim/ball';
import { SURFACES } from '../src/sim/constants';

const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const stats = { topSpeed: 5.7, sprintSpeed: 7.7, accel: 6.5, agility: 0.8, control: 0.8, power: 0.75 };

const runSteps = (world: World, inputs: PlayerInput[], steps: number) => {
  for (let i = 0; i < steps; i++) world.step(1 / 60, inputs);
};

describe('ball physics', () => {
  it('rolling ball slows to a stop from friction', () => {
    const ball = new Ball();
    ball.vel = vec(12, 0);
    for (let i = 0; i < 60 * 8; i++) ball.update(1 / 60, SURFACES.grass, []);
    expect(ball.speed()).toBe(0);
    expect(ball.pos.x).toBeGreaterThan(52.5 + 10); // but it traveled a real distance first
  });

  it('bounces lose height and eventually settle', () => {
    const ball = new Ball();
    ball.z = 2;
    let peak = 0;
    let settled = false;
    for (let i = 0; i < 60 * 6; i++) {
      ball.update(1 / 60, SURFACES.grass, []);
      if (ball.vz === 0 && ball.z === 0) { settled = true; break; }
      peak = Math.max(peak, ball.z);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(settled).toBe(true);
  });
});

describe('kicking', () => {
  const kick = (power: number) => {
    const world = new World();
    world.players.push(new PlayerBody(vec(52, 34), stats));
    world.ball.pos = vec(52.6, 34);
    world.step(1 / 60, [{ ...idle, kickReleased: { power } }]);
    return world.ball.speed();
  };

  it('full power beats a tap, and neither is a cannon from anywhere', () => {
    const tap = kick(0.15);
    const smash = kick(1);
    expect(smash).toBeGreaterThan(tap * 1.8);
    expect(smash).toBeLessThan(31); // fairness cap
  });

  it('cannot kick a ball out of reach', () => {
    const world = new World();
    world.players.push(new PlayerBody(vec(30, 34), stats));
    world.ball.pos = vec(52.5, 34);
    world.step(1 / 60, [{ ...idle, kickReleased: { power: 1 } }]);
    expect(world.ball.speed()).toBe(0);
  });
});

describe('dribbling', () => {
  it('knocks the ball ahead in free-rolling touches, never glued', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(52.6, 34);
    const run: PlayerInput = { ...idle, move: vec(1, 0) };
    let maxGap = 0;
    let touches = 0;
    for (let i = 0; i < 240; i++) {
      world.step(1 / 60, [run]);
      maxGap = Math.max(maxGap, world.ball.pos.x - p.pos.x);
      touches += world.events.filter((e) => e.kind === 'touch').length;
    }
    expect(world.ball.pos.x).toBeGreaterThan(p.pos.x); // ball leads the run
    expect(p.pos.x).toBeGreaterThan(56);               // they travel together
    expect(maxGap).toBeGreaterThan(0.7);               // ball genuinely runs free
    expect(maxGap).toBeLessThan(3);                    // but never out of control
    expect(touches).toBeGreaterThan(2);                // distinct repeated touches
  });

  it('carries the ball through a hard turn instead of losing it', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(52.6, 34);
    runSteps(world, [{ ...idle, move: vec(1, 0) }], 60);  // dribble east at pace
    runSteps(world, [{ ...idle, move: vec(0, 1) }], 60);  // hard 90° cut, then stride onto it
    // The ball came around the corner with the player, now rolling the new way
    expect(Math.abs(world.ball.vel.y)).toBeGreaterThan(Math.abs(world.ball.vel.x));
    expect(world.ball.vel.y).toBeGreaterThan(0);
    expect(Math.hypot(world.ball.pos.x - p.pos.x, world.ball.pos.y - p.pos.y)).toBeLessThan(1.8);
  });

  it('standing player traps an incoming ball dead at the feet', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(46, 34);
    world.ball.vel = vec(10, 0);
    runSteps(world, [idle], 90);
    expect(world.ball.speed()).toBeLessThan(1);
    expect(Math.hypot(world.ball.pos.x - p.pos.x, world.ball.pos.y - p.pos.y)).toBeLessThan(1.2);
  });
});

describe('goals', () => {
  it('a shot into the mouth scores and play resets to kickoff spots', () => {
    const world = new World();
    const p = new PlayerBody(vec(30, 20), stats);
    world.players.push(p);
    p.pos = vec(80, 50); // wandered far from the kickoff spot
    world.ball.pos = vec(2, 34);
    world.ball.vel = vec(-14, 0);
    runSteps(world, [idle], 60 * 5);
    expect(world.score.right).toBe(1);
    expect(world.ball.pos.x).toBeCloseTo(52.5, 1);
    expect(p.pos.x).toBeCloseTo(30, 1); // back home for the restart
    expect(p.pos.y).toBeCloseTo(20, 1);
  });

  it('a shot wide of the mouth stays in play', () => {
    const world = new World();
    world.ball.pos = vec(2, 20);
    world.ball.vel = vec(-14, 0);
    runSteps(world, [], 60 * 2);
    expect(world.score.right).toBe(0);
    expect(world.ball.pos.x).toBeGreaterThan(-1.6);
  });
});
