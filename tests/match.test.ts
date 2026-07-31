import { describe, it, expect } from 'vitest';
import { vec, dist } from '../src/core/math';
import { createMatch, advanceMatch } from '../src/match';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput } from '../src/sim/player';

const DT = 1 / 60;
const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const stats = { topSpeed: 6, sprintSpeed: 8.4, accel: 10, agility: 0.8, control: 0.75, power: 0.7 };

describe('the 22-brain match', () => {
  it('plays real football on its own: passes, possession swings, sane positions', () => {
    const match = createMatch();
    let kicks = 0;
    let possessionFlips = 0;
    let lastTeam: 0 | 1 | null = null;
    for (let i = 0; i < 60 * 60; i++) {
      advanceMatch(match, DT);
      kicks += match.world.events.filter((e) => e.kind === 'kick').length;
      const touch = match.world.lastTouch;
      if (touch && touch.team !== lastTeam) {
        if (lastTeam !== null) possessionFlips++;
        lastTeam = touch.team;
      }
    }
    for (const p of match.world.players) {
      expect(Number.isFinite(p.pos.x)).toBe(true);
      expect(Number.isFinite(p.pos.y)).toBe(true);
      expect(p.pos.x).toBeGreaterThan(-8);
      expect(p.pos.x).toBeLessThan(113);
      expect(p.pos.y).toBeGreaterThan(-8);
      expect(p.pos.y).toBeLessThan(76);
    }
    expect(Number.isFinite(match.world.ball.pos.x)).toBe(true);
    expect(kicks).toBeGreaterThan(8);           // the ball actually gets played
    expect(possessionFlips).toBeGreaterThan(2); // and contested
  });

  it('keeps a team shape instead of 22 players mobbing the ball', () => {
    const match = createMatch();
    for (let i = 0; i < 60 * 20; i++) advanceMatch(match, DT);
    const near = match.world.players.filter((p) => dist(p.pos, match.world.ball.pos) < 8).length;
    expect(near).toBeLessThan(9); // some contest it; most hold their jobs
  });

  it('is fully deterministic — same seed, same match, tick for tick', () => {
    const a = createMatch();
    const b = createMatch();
    for (let i = 0; i < 60 * 20; i++) {
      advanceMatch(a, DT);
      advanceMatch(b, DT);
    }
    expect(a.world.ball.pos.x).toBe(b.world.ball.pos.x);
    expect(a.world.ball.pos.y).toBe(b.world.ball.pos.y);
    a.world.players.forEach((p, i) => {
      expect(p.pos.x).toBe(b.world.players[i].pos.x);
      expect(p.pos.y).toBe(b.world.players[i].pos.y);
    });
  });

  it('a keeper deals with a slow ball rolling toward his goal', () => {
    const match = createMatch();
    match.world.ball.pos = vec(6, 34);
    match.world.ball.vel = vec(-2, 0);
    for (let i = 0; i < 60 * 5; i++) advanceMatch(match, DT);
    // Smothered and cleared — never left dribbling on the doorstep
    expect(match.world.ball.pos.x).toBeGreaterThan(8);
  });
});

describe('restarts', () => {
  it('a ball out over the sideline becomes a throw-in for the other team', () => {
    const world = new World();
    const home = new PlayerBody(vec(50, 60), stats, { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 8 });
    const away = new PlayerBody(vec(60, 60), stats, { team: 1, role: 'MF', anchor: vec(0.5, 0.5), number: 8 });
    world.players.push(home, away);
    world.lastTouch = { team: 0, idx: 0 }; // home put it out
    world.ball.pos = vec(55, 67.5);
    world.ball.vel = vec(0, 9);
    let restart: { taker: number; team: 0 | 1 } | null = null;
    for (let i = 0; i < 90 && !restart; i++) {
      world.step(DT, [idle, idle]);
      const e = world.events.find((ev) => ev.kind === 'restart');
      if (e && e.kind === 'restart') restart = e;
    }
    expect(restart).not.toBeNull();
    expect(restart!.team).toBe(1);
    expect(restart!.taker).toBe(1);
    expect(world.ball.pos.y).toBeLessThan(68); // placed on the line, in play
    expect(world.restartLock).toBeGreaterThan(0);
  });

  it('out over the goal line gives a corner against the defender who touched it', () => {
    const world = new World();
    const defender = new PlayerBody(vec(3, 20), stats, { team: 0, role: 'DF', anchor: vec(0.2, 0.3), number: 4 });
    const attacker = new PlayerBody(vec(10, 20), stats, { team: 1, role: 'FW', anchor: vec(0.7, 0.3), number: 9 });
    world.players.push(defender, attacker);
    world.lastTouch = { team: 0, idx: 0 }; // defending side deflects it out
    world.ball.pos = vec(0.5, 12);
    world.ball.vel = vec(-8, 0);
    let corner: { team: 0 | 1 } | null = null;
    for (let i = 0; i < 90 && !corner; i++) {
      world.step(DT, [idle, idle]);
      const e = world.events.find((ev) => ev.kind === 'restart');
      if (e && e.kind === 'restart') corner = e;
    }
    expect(corner).not.toBeNull();
    expect(corner!.team).toBe(1); // attackers take it
    expect(world.ball.pos.x).toBeLessThan(2);
    expect(world.ball.pos.y).toBeLessThan(2); // from the corner arc
  });
});

describe('tackling', () => {
  it('a lunge in range wins the ball clean', () => {
    const world = new World();
    const carrier = new PlayerBody(vec(50, 34), stats, { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 10 });
    const defender = new PlayerBody(vec(54.5, 34), stats, { team: 1, role: 'DF', anchor: vec(0.3, 0.5), number: 5 });
    world.players.push(carrier, defender);
    world.ball.pos = vec(50.6, 34);
    let stole = false;
    for (let i = 0; i < 240 && !stole; i++) {
      const close = dist(defender.pos, world.ball.pos) < 1.3;
      world.step(DT, [
        { ...idle, move: vec(1, 0) },
        { ...idle, move: vec(-1, 0), tackle: close },
      ]);
      stole = world.events.some((e) => e.kind === 'steal');
    }
    expect(stole).toBe(true);
    // The dispossession sticks: the old carrier no longer has it at his feet
    for (let i = 0; i < 30; i++) world.step(DT, [{ ...idle, move: vec(1, 0) }, idle]);
    expect(dist(carrier.pos, world.ball.pos)).toBeGreaterThan(1.1);
  });

  it('a whiffed lunge leaves the defender in recovery', () => {
    const world = new World();
    const p = new PlayerBody(vec(50, 34), stats, { team: 1, role: 'DF', anchor: vec(0.3, 0.5), number: 5 });
    world.players.push(p);
    world.ball.pos = vec(70, 34); // nothing to win
    world.step(DT, [{ ...idle, tackle: true }]);
    for (let i = 0; i < 20; i++) world.step(DT, [idle]);
    expect(p.recoverTimer).toBeGreaterThan(0);
  });
});
