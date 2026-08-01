import { describe, it, expect } from 'vitest';
import { vec, dist } from '../src/core/math';
import { createMatch, advanceMatch } from '../src/match';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput } from '../src/sim/player';
import { TeamBrain } from '../src/ai/blackboard';
import { passMargin, leadTarget } from '../src/ai/brain';

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

  it('a kicked pass gets a NAMED receiver on the team sheet', () => {
    const world = new World();
    const passer = new PlayerBody(vec(50, 34), stats, { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 8 });
    const target = new PlayerBody(vec(64, 35), stats, { team: 0, role: 'FW', anchor: vec(0.7, 0.5), number: 9 });
    world.players.push(passer, target);
    world.ball.pos = vec(50.6, 34);
    const bb = new TeamBrain(0);
    bb.update(world, DT);
    world.step(DT, [{ ...idle, move: vec(1, 0), kickReleased: { power: 0.4 } }, idle]);
    bb.update(world, DT); // reads the kick event, calls the receiver's name
    expect(bb.calledReceiver).toBe(1);
  });

  it('the keeper DIVES to smother a driven shot on goal', () => {
    const match = createMatch();
    match.world.restartLock = 0; // skip the opening ceremony; stage the shot
    match.world.restartExclusion = 0;
    match.world.ball.pos = vec(13, 34);
    match.world.ball.vel = vec(-17, 0); // drilled dead at the home goal
    let saved = false;
    for (let i = 0; i < 150 && !saved; i++) {
      advanceMatch(match, DT);
      saved = match.world.events.some((e) => e.kind === 'save');
    }
    expect(saved).toBe(true);
    expect(match.world.score.right).toBe(0); // it never went in
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

describe('the interception model', () => {
  it('a defender sitting on the lane kills the pass; one wide of it does not', () => {
    const from = vec(30, 34);
    const to = vec(50, 34);
    const onLane = passMargin(from, to, 16, [vec(40, 34.5)]);
    const wideOf = passMargin(from, to, 16, [vec(40, 44)]);
    expect(onLane).toBeLessThan(0.15);   // he steps in and takes it
    expect(wideOf).toBeGreaterThan(0.5); // nine meters away — never getting there
  });

  it('a pass to a runner is aimed at where he WILL be, not where he stands', () => {
    const from = vec(45, 34);
    const runner = vec(60, 34);
    const runnerVel = vec(0, -5); // sprinting north
    const meet = leadTarget(from, runner, runnerVel, 16);
    expect(meet.y).toBeLessThan(32); // led into the run, meters up the lane
    // And the meeting is honest: ball time ≈ runner time to that point
    const ballT = Math.hypot(meet.x - from.x, meet.y - from.y) / 16;
    const runT = Math.hypot(meet.x - runner.x, meet.y - runner.y) / 5;
    expect(Math.abs(ballT - runT)).toBeLessThan(0.15);
  });

  it('a fast ball beats a defender the same distance off the line', () => {
    const from = vec(30, 34);
    const to = vec(50, 34);
    const slow = passMargin(from, to, 9, [vec(44, 38.5)]);
    const fast = passMargin(from, to, 21, [vec(44, 38.5)]);
    expect(fast).toBeGreaterThan(slow); // pace protects the pass
  });

  it('in possession the fullbacks push past the middle third while a CB stays home', () => {
    const world = new World();
    const mk = (role: 'GK' | 'DF' | 'MF' | 'FW', ax: number, ay: number, x: number, y: number) =>
      world.players.push(new PlayerBody(vec(x, y), stats, { team: 0, role, anchor: vec(ax, ay), number: 1 }));
    mk('GK', 0.04, 0.5, 4, 34);
    mk('DF', 0.2, 0.15, 21, 10);  // fullback
    mk('DF', 0.18, 0.38, 19, 26); // centre-back
    mk('DF', 0.18, 0.62, 19, 42); // centre-back
    mk('DF', 0.2, 0.85, 21, 58);  // fullback
    mk('FW', 0.72, 0.5, 88, 34);  // holding it up at the away box
    world.ball.pos = vec(88.5, 34);
    const bb = new TeamBrain(0);
    bb.update(world, DT);
    expect(bb.phase).toBe('attack');
    const fullback = bb.anchorOf(1);
    const centreBack = bb.anchorOf(2);
    expect(fullback.x).toBeGreaterThan(46);              // bombed on to control the middle
    expect(fullback.x).toBeGreaterThan(centreBack.x + 3); // the insurance stays deeper
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

describe('the restart law', () => {
  it('walks the other team out of the mandated space — no jumped throw-ins', () => {
    const match = createMatch();
    const world = match.world;
    world.ball.pos = vec(52.5, -1); // over the sideline
    world.lastTouch = { team: 1, idx: 12 }; // so team 0 gets the throw
    advanceMatch(match, DT); // the restart is awarded
    const opp = world.players.find((p) => p.id.team === 1)!;
    opp.pos = vec(world.ball.pos.x + 0.5, world.ball.pos.y + 0.5); // parked on the spot
    for (let t = 0; t < 60; t++) advanceMatch(match, DT); // one second of the beat
    expect(world.restartLock).toBeGreaterThan(0);
    expect(dist(opp.pos, world.ball.pos)).toBeGreaterThan(6.0);
  });
});

describe('keeper distribution', () => {
  it('a scatterless punt drops the ball at the chosen spot', () => {
    const world = new World();
    world.players.push(new PlayerBody(vec(6, 34), stats, { team: 0, role: 'GK', anchor: vec(0.04, 0.5), number: 1 }));
    world.ball.pos = vec(6, 34);
    const target = vec(30, 30);
    world.gkLaunch(0, target, 'punt', 0);
    expect(world.ball.vz).toBeGreaterThan(5); // it LEFT the boot, high
    for (let t = 0; t < 60 * 4; t++) world.step(DT, []);
    expect(dist(world.ball.pos, target)).toBeLessThan(8);
  });

  it('a throw stays flat and reaches a nearer man', () => {
    const world = new World();
    world.players.push(new PlayerBody(vec(6, 34), stats, { team: 0, role: 'GK', anchor: vec(0.04, 0.5), number: 1 }));
    world.ball.pos = vec(6, 34);
    const target = vec(20, 40);
    world.gkLaunch(0, target, 'throw', 0);
    for (let t = 0; t < 60 * 4; t++) world.step(DT, []);
    expect(dist(world.ball.pos, target)).toBeLessThan(7);
  });
});

describe('mouse passing', () => {
  it('a kick released AT a field point flies toward that point, whatever the stick says', () => {
    const world = new World();
    world.players.push(new PlayerBody(vec(30, 34), stats, { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 8 }));
    world.ball.pos = vec(30.8, 34);
    const inputs: PlayerInput = {
      move: vec(0, -1), // stick pressed NORTH...
      sprint: false, kickCharging: false,
      kickReleased: { power: 0.5, aimOffset: 0, aimAt: vec(50, 44) }, // ...aimed EAST-SOUTH by mouse
    };
    world.step(DT, [inputs]);
    const v = world.ball.vel;
    expect(v.x).toBeGreaterThan(5);  // it went toward the point
    expect(v.y).toBeGreaterThan(1);  // south-ish, not the stick's north
  });
});

describe('the long punt', () => {
  it('reaches the edge of the far box', () => {
    const world = new World();
    world.players.push(new PlayerBody(vec(5, 34), stats, { team: 0, role: 'GK', anchor: vec(0.04, 0.5), number: 1 }));
    world.ball.pos = vec(5, 34);
    world.gkLaunch(0, vec(85, 34), 'punt', 0);
    for (let t = 0; t < 60 * 5; t++) world.step(DT, []);
    expect(world.ball.pos.x).toBeGreaterThan(74); // deep into their half, box-edge territory
    expect(world.ball.pos.x).toBeLessThan(96);    // and not sailing over the goal line
  });
});
