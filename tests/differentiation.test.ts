import { describe, it, expect } from 'vitest';
import { vec } from '../src/core/math';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput, PlayerStats } from '../src/sim/player';
import { coneHalfAngle, kickAccuracy } from '../src/sim/tuning';
import { PLAYER_POOL } from '../src/data/players';

const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const mk = (over: Partial<PlayerStats>): PlayerStats => ({
  topSpeed: 5.5, sprintSpeed: 7.5, accel: 10, agility: 0.8, control: 0.8, power: 0.75,
  shoot: 0.7, pass: 0.7, longBall: 0.7, defend: 0.5, phys: 0.5, reflex: 0.1, dive: 0.1, handling: 0.1,
  ...over,
});

describe('positional exclusivity — no role substitutes for another', () => {
  const byRole = (r: string) => PLAYER_POOL.filter((p) => p.role === r);

  it('a gold defender never out-finishes even a gray striker', () => {
    const bestDfShoot = Math.max(...byRole('DF').map((p) => p.stats.shoot));
    const worstFwShoot = Math.min(...byRole('FW').map((p) => p.stats.shoot));
    expect(bestDfShoot).toBeLessThan(worstFwShoot - 0.1);
  });

  it('no striker defends like even the softest defender', () => {
    const bestFwDefend = Math.max(...byRole('FW').map((p) => p.stats.defend));
    const worstDfDefend = Math.min(...byRole('DF').map((p) => p.stats.defend));
    expect(bestFwDefend).toBeLessThan(worstDfDefend);
  });

  it('a keeper fielded outfield is chaos: passing and finishing floors', () => {
    for (const gk of byRole('GK')) {
      expect(gk.stats.pass).toBeLessThanOrEqual(0.25);
      expect(gk.stats.shoot).toBeLessThanOrEqual(0.15);
      expect(gk.stats.reflex).toBeGreaterThan(0.2); // and his real trade exists
    }
  });

  it('defenders lose the long ball: their raking accuracy sits under their short game', () => {
    for (const df of byRole('DF')) {
      expect(df.stats.longBall).toBeLessThan(df.stats.pass - 0.05);
    }
  });

  it('the pace band is wide enough that gold genuinely runs away from gray', () => {
    const sprints = PLAYER_POOL.map((p) => p.stats.sprintSpeed);
    expect(Math.max(...sprints) - Math.min(...sprints)).toBeGreaterThan(1.2);
  });

  it('tiers climb inside a role: legend forwards finish far above common ones', () => {
    const fw = byRole('FW');
    const legends = fw.filter((p) => p.ovr >= 88).map((p) => p.stats.shoot);
    const commons = fw.filter((p) => p.ovr < 76).map((p) => p.stats.shoot);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(legends)).toBeGreaterThan(mean(commons) + 0.2);
  });
});

describe('the aim cone', () => {
  it('is tap-tight for everyone and blooms with the pull — faster for worse feet', () => {
    expect(coneHalfAngle(0.3, 0.45)).toBeLessThan(0.1);        // a gray tap is playable
    expect(coneHalfAngle(0.9, 1)).toBeLessThan(0.07);          // a gold rocket stays a laser
    expect(coneHalfAngle(0.3, 1)).toBeGreaterThan(0.25);       // a gray rocket is a prayer
    expect(coneHalfAngle(0.3, 1)).toBeLessThan(0.6);           // but never a stupid arc
    expect(coneHalfAngle(0.3, 1)).toBeGreaterThan(coneHalfAngle(0.3, 0.6));
    expect(coneHalfAngle(0.3, 0.8)).toBeGreaterThan(coneHalfAngle(0.9, 0.8) * 3);
  });

  it('decays toward the long-ball stat as the delivery stretches', () => {
    const df = mk({ pass: 0.6, longBall: 0.2 });
    expect(kickAccuracy(df, 0, 10)).toBeCloseTo(0.6, 1);
    expect(kickAccuracy(df, 0, 42)).toBeCloseTo(0.2, 1);
    expect(kickAccuracy(df, 1, 10)).toBe(df.shoot);      // square at the mouth reads finishing
    const half = kickAccuracy(df, 0.5, 10);              // and the blend has no cliffs
    expect(half).toBeGreaterThan(Math.min(df.shoot, 0.6) - 0.01);
    expect(half).toBeLessThan(Math.max(df.shoot, 0.6) + 0.01);
  });

  it('the sim samples inside it: bad feet spray, good feet group', () => {
    const spread = (stats: PlayerStats) => {
      const world = new World();
      const body = new PlayerBody(vec(52, 20), stats);
      world.players.push(body);
      let sum = 0;
      const N = 300;
      for (let i = 0; i < N; i++) {
        world.ball.pos = vec(52, 20.6);
        world.ball.vel = vec();
        world.ball.z = 0;
        body.kickCooldown = 0;
        body.touchCooldown = 0;
        world.step(1 / 60, [{ ...idle, kickReleased: { power: 0.9, aimAt: vec(52, 60) } }]);
        sum += Math.abs(Math.atan2(world.ball.vel.x, world.ball.vel.y)); // deviation off +y
      }
      return sum / N;
    };
    const gold = spread(mk({ pass: 0.95, longBall: 0.95 }));
    const gray = spread(mk({ pass: 0.3, longBall: 0.15 }));
    expect(gold).toBeGreaterThan(0);
    expect(gray).toBeGreaterThan(gold * 3);
    expect(gray).toBeLessThan(0.75); // sprayed, not backwards
  });
});

describe('the fresh-touch beat', () => {
  // The friends' bug: press a NEW direction as the pass reaches your feet and
  // the ball used to bounce down the old lane — the receiver waits, then turns
  it('a received ball obeys the stick: tap-and-turn actually turns', () => {
    const world = new World();
    const body = new PlayerBody(vec(52, 34), mk({}));
    world.players.push(body);
    world.ball.pos = vec(48, 34);
    world.ball.vel = vec(14, 0);
    const up: PlayerInput = { ...idle, move: vec(0, 1) };
    let turned = false;
    for (let i = 0; i < 120; i++) {
      const near = Math.hypot(world.ball.pos.x - body.pos.x, world.ball.pos.y - body.pos.y) < 1.1;
      world.step(1 / 60, [near || world.lastTouch ? up : idle]);
      const v = world.ball.vel;
      if (world.lastTouch && world.ball.speed() > 0.5 && Math.abs(v.y) > Math.abs(v.x) * 1.2) { turned = true; break; }
    }
    expect(turned).toBe(true);
    // and the ball stayed playable — redirected, not bounced away
    expect(Math.hypot(world.ball.pos.x - body.pos.x, world.ball.pos.y - body.pos.y)).toBeLessThan(3);
  });

  it('arms only on receptions and expires', () => {
    const world = new World();
    const body = new PlayerBody(vec(52, 34), mk({}));
    world.players.push(body);
    world.ball.pos = vec(50, 34);
    world.ball.vel = vec(14, 0);
    let armed = false;
    for (let i = 0; i < 100; i++) {
      world.step(1 / 60, [idle]);
      if (body.freshTouch > 0) armed = true;
    }
    expect(armed).toBe(true);
    expect(body.freshTouch).toBe(0);
  });
});
