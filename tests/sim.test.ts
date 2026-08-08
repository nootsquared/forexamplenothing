import { describe, it, expect } from 'vitest';
import { vec } from '../src/core/math';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput } from '../src/sim/player';
import { Ball } from '../src/sim/ball';
import { PITCH, SURFACES } from '../src/sim/constants';

const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const stats = { topSpeed: 5.7, sprintSpeed: 7.7, accel: 6.5, agility: 0.8, control: 0.8, power: 0.75,
 shoot: 0.72, pass: 0.8, longBall: 0.72, defend: 0.55, phys: 0.55, reflex: 0.55, dive: 0.55, handling: 0.55 };

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
    expect(smash).toBeLessThan(24); // fairness cap
  });

  it('even a max shot stays driven, never ballooned over the pitch', () => {
    const world = new World();
    world.players.push(new PlayerBody(vec(52, 34), stats));
    world.ball.pos = vec(52.6, 34);
    world.step(1 / 60, [{ ...idle, kickReleased: { power: 1 } }]);
    expect(world.ball.vz).toBeLessThanOrEqual(4.2);
  });

  it('shoots exactly where the stick points, not where the body faces', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), stats);
    p.facing = vec(1, 0); // running east
    world.players.push(p);
    world.ball.pos = vec(52.5, 34);
    // Stick held north at release: the shot must fly north, at a right angle to the run
    world.step(1 / 60, [{ ...idle, move: vec(0, -1), kickReleased: { power: 0.5 } }]);
    expect(world.ball.vel.y).toBeLessThan(0);
    expect(Math.abs(world.ball.vel.x)).toBeLessThan(Math.abs(world.ball.vel.y) * 0.3);
  });

  it('J/L bend angles the shot off the body line without turning', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), stats);
    p.facing = vec(1, 0);
    world.players.push(p);
    world.ball.pos = vec(52.5, 34);
    // Bent a full radian toward the left: flies up-field, never straight east
    world.step(1 / 60, [{ ...idle, kickReleased: { power: 0.5, aimOffset: -1.0 } }]);
    expect(world.ball.vel.x).toBeGreaterThan(0);
    expect(world.ball.vel.y).toBeLessThan(0);
    expect(Math.abs(world.ball.vel.y)).toBeGreaterThan(Math.abs(world.ball.vel.x));
  });

  it('a bent strike curls in flight — the heading keeps bending after it leaves', () => {
    const world = new World();
    const p = new PlayerBody(vec(30, 34), stats);
    p.facing = vec(1, 0);
    world.players.push(p);
    world.ball.pos = vec(30.5, 34);
    world.step(1 / 60, [{ ...idle, kickReleased: { power: 1, aimOffset: 1.31 } }]);
    const headingAt = () => Math.atan2(world.ball.vel.y, world.ball.vel.x);
    const early = headingAt();
    for (let i = 0; i < 40; i++) world.step(1 / 60, [idle]);
    expect(headingAt()).toBeGreaterThan(early + 0.15); // banana, not a straight line
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
    expect(maxGap).toBeGreaterThan(0.4);               // ball genuinely runs free
    expect(maxGap).toBeLessThan(2.5);                  // but never out of control
    expect(touches).toBeGreaterThan(3);                // distinct repeated touches
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

  it('sprinting straight over a resting ball can never phase through it', () => {
    const world = new World();
    const p = new PlayerBody(vec(48, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(52, 34);
    const charge: PlayerInput = { ...idle, move: vec(1, 0), sprint: true };
    for (let i = 0; i < 300; i++) {
      world.step(1 / 60, [charge]);
      // Every step ends outside the keep-out ring — the ball is solid
      expect(Math.hypot(world.ball.pos.x - p.pos.x, world.ball.pos.y - p.pos.y)).toBeGreaterThan(0.5);
    }
    expect(world.ball.pos.x).toBeGreaterThan(52); // and it got moved, not ignored
  });

  it('holding the charge while dribbling also never phases through the ball', () => {
    const world = new World();
    const p = new PlayerBody(vec(48, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(50, 34);
    const chargeRun: PlayerInput = { ...idle, move: vec(1, 0), kickCharging: true };
    for (let i = 0; i < 300; i++) {
      world.step(1 / 60, [chargeRun]);
      expect(Math.hypot(world.ball.pos.x - p.pos.x, world.ball.pos.y - p.pos.y)).toBeGreaterThan(0.5);
    }
  });

  it('an off-foot touch converges the ball back onto the dominant-foot lane', () => {
    const world = new World();
    const p = new PlayerBody(vec(50, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(50.6, 33.5); // caught on the LEFT foot after a turn
    const run: PlayerInput = { ...idle, move: vec(1, 0) };
    for (let i = 0; i < 180; i++) world.step(1 / 60, [run]);
    // Ball settles on the right-of-center lane, still leading the run
    expect(world.ball.pos.y - p.pos.y).toBeGreaterThan(-0.05);
    expect(world.ball.pos.y - p.pos.y).toBeLessThan(0.6);
    expect(world.ball.pos.x).toBeGreaterThan(p.pos.x);
  });

  it('receives a pass, turns 180°, and takes the ball with him', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), stats);
    world.players.push(p);
    world.ball.pos = vec(46, 34);
    world.ball.vel = vec(10, 0); // the pass arrives from behind his new run
    runSteps(world, [idle], 45); // cushion it at the feet
    runSteps(world, [{ ...idle, move: vec(1, 0) }], 160); // now turn and GO east
    expect(p.pos.x).toBeGreaterThan(54);                    // the turn actually happened
    expect(world.ball.pos.x).toBeGreaterThan(p.pos.x - 0.2); // ball came along, in front
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
  it('a shot into the mouth scores, play resets home, and a taker mans the spot', () => {
    const world = new World();
    const p = new PlayerBody(vec(30, 20), stats);
    const striker = new PlayerBody(vec(60, 34), stats, { team: 0, role: 'FW', anchor: vec(0.7, 0.5), number: 9 });
    world.players.push(p, striker);
    p.pos = vec(80, 50); // wandered far from the kickoff spot
    world.ball.pos = vec(2, PITCH.width / 2);
    world.ball.vel = vec(-14, 0);
    runSteps(world, [idle, idle], 60 * 15); // the party, then the walk home
    expect(world.score.right).toBe(1);
    expect(world.ball.pos.x).toBeCloseTo(PITCH.length / 2, 1);
    expect(p.pos.x).toBeCloseTo(30, 1); // back home for the restart
    expect(p.pos.y).toBeCloseTo(20, 1);
    expect(striker.pos.x).toBeCloseTo(PITCH.length / 2 - 1.5, 0); // the central forward stands over the ball
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

describe('goal frames are solid', () => {
  const NEAR_NET_Y = PITCH.width / 2 + PITCH.goalWidth / 2; // south side netting of the left goal

  it('a player cannot walk out through the side netting', () => {
    const world = new World();
    const p = new PlayerBody(vec(-1, PITCH.width / 2), stats); // standing inside the goal mouth
    world.players.push(p);
    runSteps(world, [{ ...idle, move: vec(0, 1) }], 180); // shove south into the net
    expect(p.pos.y).toBeLessThan(NEAR_NET_Y - 0.2);
  });

  it('a scored ball stays caught in the net box until the reset', () => {
    const world = new World();
    world.ball.pos = vec(2, PITCH.width / 2);
    world.ball.vel = vec(-16, 4); // scores, then tries to burst out the side
    for (let i = 0; i < 45; i++) {
      world.step(1 / 60, []);
      if (world.score.right === 1) {
        expect(world.ball.pos.y).toBeLessThan(NEAR_NET_Y + 0.2);
        expect(world.ball.pos.x).toBeGreaterThan(-2.4);
      }
    }
    expect(world.score.right).toBe(1);
  });

  it('a shot onto the post pings back into play', () => {
    const world = new World();
    world.ball.pos = vec(4, NEAR_NET_Y); // dead in line with the near post
    world.ball.vel = vec(-16, 0);
    runSteps(world, [], 90);
    expect(world.ball.pos.x).toBeGreaterThan(0.5); // bounced out, not through
    expect(world.score.right).toBe(0);
  });
});
