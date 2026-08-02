import { describe, it, expect } from 'vitest';
import { vec, dist } from '../src/core/math';
import { PITCH } from '../src/sim/constants';
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
    world.ball.pos = vec(55, PITCH.width - 0.5);
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
    expect(world.ball.pos.y).toBeLessThan(PITCH.width); // placed on the line, in play
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

describe('the dead ball knows its end', () => {
  const cast = () => [
    new PlayerBody(vec(3, 37), stats, { team: 0, role: 'GK', anchor: vec(0.04, 0.5), number: 1 }),
    new PlayerBody(vec(30, 30), stats, { team: 0, role: 'DF', anchor: vec(0.2, 0.4), number: 4 }),
    new PlayerBody(vec(102, 37), stats, { team: 1, role: 'GK', anchor: vec(0.04, 0.5), number: 1 }),
    new PlayerBody(vec(30, 44), stats, { team: 1, role: 'FW', anchor: vec(0.8, 0.6), number: 9 }),
  ];
  const overEnd = (world: World, x: number, byTeam: 0 | 1, byIdx: number) => {
    world.lastTouch = { team: byTeam, idx: byIdx };
    world.ball.pos = vec(x, 10); // well clear of the goal mouth
    world.ball.vel = vec(x < 50 ? -8 : 8, 0);
    world.step(DT, []);
    return world.events.find((e) => e.kind === 'restart');
  };

  it('first half: an attacker over the end line concedes the goal kick', () => {
    const world = new World();
    world.players.push(...cast());
    const e = overEnd(world, -0.3, 1, 3); // team 1 attacks -x and overhits
    expect(e && e.kind === 'restart' && e.restart).toBe('goalkick');
    expect(e && e.kind === 'restart' && e.team).toBe(0);
  });

  it('first half: a defender over his own line concedes the corner', () => {
    const world = new World();
    world.players.push(...cast());
    const e = overEnd(world, -0.3, 0, 1); // team 0 defends left and turns it over
    expect(e && e.kind === 'restart' && e.restart).toBe('corner');
    expect(e && e.kind === 'restart' && e.team).toBe(1);
  });

  it('second half: the ends swapped, and the calls swap with them', () => {
    const goalKick = new World();
    goalKick.players.push(...cast());
    goalKick.swapSides(); // the break — team 0 now defends the RIGHT end
    const e = overEnd(goalKick, PITCH.length + 0.3, 1, 3);
    expect(e && e.kind === 'restart' && e.restart).toBe('goalkick');
    expect(e && e.kind === 'restart' && e.team).toBe(0);

    const corner = new World();
    corner.players.push(...cast());
    corner.swapSides();
    const e2 = overEnd(corner, -0.3, 1, 3); // team 1 now defends left and turns it over
    expect(e2 && e2.kind === 'restart' && e2.restart).toBe('corner');
    expect(e2 && e2.kind === 'restart' && e2.team).toBe(0);
  });

  it('the taker stands BEHIND the dead ball, never between it and the field', () => {
    const world = new World();
    world.players.push(...cast());
    const e = overEnd(world, -0.3, 0, 1); // corner for team 1 at the near-left flag
    expect(e && e.kind === 'restart' && e.taker).toBeGreaterThanOrEqual(0);
    if (e && e.kind === 'restart') {
      const taker = world.players[e.taker];
      const center = vec(PITCH.length / 2, PITCH.width / 2);
      expect(dist(taker.pos, center)).toBeGreaterThan(dist(world.ball.pos, center));
      expect(dist(taker.pos, world.ball.pos)).toBeLessThan(2); // still on the ball
    }
  });
});

describe('the whistle and the spot', () => {
  it('a mistimed lunge mid-pitch NEVER whistles — free kicks are gone, play on', () => {
    const world = new World();
    const carrier = new PlayerBody(vec(50, 37), stats, { team: 0, role: 'MF', anchor: vec(0.5, 0.5), number: 8 });
    const hacker = new PlayerBody(vec(49.1, 36.4), stats, { team: 1, role: 'MF', anchor: vec(0.5, 0.5), number: 6 });
    world.players.push(carrier, hacker);
    world.ball.pos = vec(50.8, 37); // on the carrier's far side — the lunge finds legs, not ball
    for (let t = 0; t < 60 * 60; t++) {
      world.ball.pos = vec(50.8, 37); // the duel stays staged
      world.ball.vel = vec();
      carrier.pos = vec(50, 37);
      hacker.pos = vec(49.45, 36.7); // through the MAN, nowhere near the ball
      world.step(DT, [idle, { ...idle, tackle: true }]);
      for (const e of world.events) {
        expect(e.kind).not.toBe('foul'); // outside the box the referee waves on
      }
    }
    expect(world.penalty).toBeNull();
  });

  it('the same crime inside the box still concedes the penalty', () => {
    const world = new World();
    const carrier = new PlayerBody(vec(106, 37), stats, { team: 0, role: 'FW', anchor: vec(0.9, 0.5), number: 9 });
    const hacker = new PlayerBody(vec(105.1, 36.4), stats, { team: 1, role: 'DF', anchor: vec(0.2, 0.5), number: 4 });
    const gk = new PlayerBody(vec(112, 37), stats, { team: 1, role: 'GK', anchor: vec(0.04, 0.5), number: 1 });
    world.players.push(carrier, hacker, gk);
    let penalty = false;
    for (let t = 0; t < 60 * 120 && !penalty; t++) {
      world.ball.pos = vec(106.8, 37); // staged deep in team 1's box
      world.ball.vel = vec();
      carrier.pos = vec(106, 37);
      hacker.pos = vec(105.45, 36.7); // through the MAN, nowhere near the ball
      world.step(DT, [idle, { ...idle, tackle: true }, idle]);
      for (const e of world.events) {
        if (e.kind === 'foul' && e.penalty) penalty = true;
      }
    }
    expect(penalty).toBe(true);
    expect(world.penalty?.phase).toBe('aiming');
  });

  it('the spot kick: aiming freezes the duel, the strike resolves it live', () => {
    const world = new World();
    const shooter = new PlayerBody(vec(60, 30), { ...stats, control: 0.9, power: 0.9 }, { team: 0, role: 'FW', anchor: vec(0.7, 0.5), number: 9 });
    const gk = new PlayerBody(vec(112, 37), stats, { team: 1, role: 'GK', anchor: vec(0.04, 0.5), number: 1 });
    world.players.push(shooter, gk);
    world.beginPenalty(0, 0);
    expect(world.penalty?.phase).toBe('aiming');
    for (let t = 0; t < 60; t++) world.step(DT, [idle, idle]);
    // a full second later the world is still holding its breath
    expect(world.penalty?.phase).toBe('aiming');
    expect(world.restartLock).toBeGreaterThan(0);
    expect(Math.abs(world.ball.pos.x - (PITCH.length - 11))).toBeLessThan(0.01);
    world.takePenalty(1, false);
    expect(world.ball.speed()).toBeGreaterThan(15); // the strike is away
    expect(gk.lungeTimer).toBeGreaterThan(0);       // and the keeper is committed
    for (let t = 0; t < 60 * 2; t++) world.step(DT, [idle, idle]);
    expect(world.penalty).toBeNull(); // the duel resolved and cleaned up
    // a 90-rated striker from the spot: goal, save, or woodwork — never a stall
    const resolved = world.score.left === 1 || world.restartLock > 0 || world.ball.speed() > 0.5 || world.holdingGk >= 0;
    expect(resolved).toBe(true);
  });
});

describe('the support triangle', () => {
  it('in possession someone owes the carrier an angle, and someone owes him depth', () => {
    const match = createMatch({ halfLength: 0 });
    let attackTicks = 0;
    let nearHeld = 0;
    let depthHeld = 0;
    for (let t = 0; t < 60 * 30; t++) {
      advanceMatch(match, DT);
      for (const tb of match.teamBrains) {
        if (tb.phase !== 'attack' || tb.possessorIdx === null) continue;
        attackTicks++;
        if (tb.supportNearIdx >= 0 && tb.supportNearIdx !== tb.possessorIdx) nearHeld++;
        if (tb.supportDepthIdx >= 0 && tb.supportDepthIdx !== tb.possessorIdx && tb.supportDepthIdx !== tb.supportNearIdx) depthHeld++;
      }
    }
    expect(attackTicks).toBeGreaterThan(200);
    expect(nearHeld / attackTicks).toBeGreaterThan(0.85);  // the safe angle almost always exists
    expect(depthHeld / attackTicks).toBeGreaterThan(0.75); // and so does the stretch
  });
});

describe('the turnover', () => {
  it('teams swap ends at the break and goals still credit the right column', () => {
    const match = createMatch({ halfLength: 3 });
    for (let t = 0; t < 60 * 12 && match.half === 1; t++) advanceMatch(match, DT);
    expect(match.half).toBe(2);
    const w = match.world;
    expect(w.attackSign(0)).toBe(-1); // team 0 attacks LEFT after the break
    expect(w.attackSign(1)).toBe(1);
    // a team-0 finish into the LEFT net now counts in team 0's column
    w.restartLock = 0;
    w.restartExclusion = 0;
    const striker = w.players.findIndex((p) => p.id.team === 0);
    w.lastTouch = { team: 0, idx: striker };
    w.ball.pos = vec(2, PITCH.width / 2);
    w.ball.vel = vec(-18, 0);
    w.ball.z = 0.3;
    w.ball.vz = 0;
    let scored = false;
    for (let t = 0; t < 90 && !scored; t++) {
      w.step(DT, []);
      scored = w.events.some((e) => e.kind === 'goal');
    }
    expect(scored).toBe(true);
    expect(w.score.left).toBe(1);
    expect(w.score.right).toBe(0);
  });
});

describe('the restart law and the rigging', () => {
  it('slides an excluded body around the ring instead of pinning him in the net', () => {
    const match = createMatch();
    const world = match.world;
    // an attacker parked INSIDE the goal mouth when the goal kick is placed
    const intruder = world.players.findIndex((p) => p.id.team === 1);
    world.players[intruder].pos = vec(-0.6, PITCH.width / 2);
    const gk = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'GK');
    world.ball.pos = vec(5.5, PITCH.width / 2);
    world.ball.vel = vec();
    world.lastTouch = { team: 0, idx: gk };
    world.restartExclusion = 11;
    const inputs = world.players.map(() => idle);
    for (let i = 0; i < 180; i++) {
      world.restartLock = 1; // the keeper is still reading the field
      world.step(DT, inputs);
    }
    const p = world.players[intruder].pos;
    expect(p.x).toBeGreaterThan(0.3); // out of the rigging, on the pitch
    expect(dist(p, world.ball.pos)).toBeGreaterThan(10.5); // and outside the law's ring
  });
});
