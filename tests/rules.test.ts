import { describe, it, expect } from 'vitest';
import { Vec2, vec, dist } from '../src/core/math';
import { PITCH } from '../src/sim/constants';
import { World } from '../src/sim/world';
import { PlayerBody, PlayerInput, PlayerStats, PlayerIdentity } from '../src/sim/player';
import { createMatch, advanceMatch } from '../src/match';
import { TeamBrain } from '../src/ai/blackboard';
import { KeeperMind } from '../src/ai/keeper';

const DT = 1 / 60;
// Minutes of simulated football take real seconds; vitest's 5s default is a
// stopwatch on the machine's mood, not on the code
const LONG_SIM = 30_000;
const idle: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
const mk = (over: Partial<PlayerStats> = {}): PlayerStats => ({
  topSpeed: 5.7, sprintSpeed: 7.7, accel: 8, agility: 0.8, control: 0.8, power: 0.75,
  shoot: 0.7, pass: 0.8, longBall: 0.7, defend: 0.5, phys: 0.5, reflex: 0.5, dive: 0.5, handling: 0.5,
  ...over,
});
const id = (team: 0 | 1, role: PlayerIdentity['role'] = 'MF'): PlayerIdentity =>
  ({ team, role, anchor: vec(0.5, 0.5), number: 1 });

// One passer, one runner, and a back four's worth of line: the exact stage the
// flag was written for. The kick is released at a named power the same tick.
const offsideStage = (runnerX: number, ballX = 50) => {
  const world = new World();
  const passer = new PlayerBody(vec(ballX - 0.6, 34), mk(), id(0));
  const runner = new PlayerBody(vec(runnerX, 34), mk(), id(0, 'FW'));
  const stopper = new PlayerBody(vec(70, 30), mk(), id(1, 'DF'));
  const keeper = new PlayerBody(vec(110, 34), mk(), id(1, 'GK'));
  world.players.push(passer, runner, stopper, keeper);
  world.ball.pos = vec(ballX, 34);
  return { world, passer, runner };
};

describe('the flag', () => {
  it('a runner beyond the last line at the kick is caught by his own first touch', () => {
    const { world, runner } = offsideStage(80); // ten meters past the stopper
    world.step(DT, [{ ...idle, move: vec(1, 0), kickReleased: { power: 0.6 } }, idle, idle, idle]);
    let flag: { idx: number } | null = null;
    for (let t = 0; t < 60 * 6 && !flag; t++) {
      const to = vec(world.ball.pos.x - runner.pos.x, world.ball.pos.y - runner.pos.y);
      const l = Math.hypot(to.x, to.y) || 1;
      world.step(DT, [idle, { ...idle, move: vec(to.x / l, to.y / l) }, idle, idle]);
      const e = world.events.find((ev) => ev.kind === 'offside');
      if (e && e.kind === 'offside') flag = e;
    }
    expect(flag).not.toBeNull();
    expect(flag!.idx).toBe(1);
    // and the defenders get the ball back, at the spot, with the beat of a restart
    const restart = world.events.find((e) => e.kind === 'restart');
    expect(restart && restart.kind === 'restart' && restart.restart).toBe('offside');
    expect(restart && restart.kind === 'restart' && restart.team).toBe(1);
    expect(world.restartLock).toBeGreaterThan(0);
  });

  it('a runner level with the line is onside, and stays onside all the way through', () => {
    const { world, runner } = offsideStage(69.8); // shoulder to shoulder with the stopper
    world.step(DT, [{ ...idle, move: vec(1, 0), kickReleased: { power: 0.6 } }, idle, idle, idle]);
    for (let t = 0; t < 60 * 6; t++) {
      const to = vec(world.ball.pos.x - runner.pos.x, world.ball.pos.y - runner.pos.y);
      const l = Math.hypot(to.x, to.y) || 1;
      world.step(DT, [idle, { ...idle, move: vec(to.x / l, to.y / l), sprint: true }, idle, idle]);
      expect(world.events.some((e) => e.kind === 'offside')).toBe(false);
    }
  });

  it('you cannot be offside in your own half, however far you have run', () => {
    const world = new World();
    const passer = new PlayerBody(vec(20, 34), mk(), id(0));
    const runner = new PlayerBody(vec(40, 34), mk(), id(0, 'FW'));
    // both defenders pinned deep in THEIR half — the line sits on the halfway
    world.players.push(passer, runner, new PlayerBody(vec(100, 30), mk(), id(1, 'DF')),
      new PlayerBody(vec(110, 34), mk(), id(1, 'GK')));
    world.ball.pos = vec(20.6, 34);
    world.step(DT, [{ ...idle, move: vec(1, 0), kickReleased: { power: 0.6 } }, idle, idle, idle]);
    for (let t = 0; t < 60 * 5; t++) {
      const to = vec(world.ball.pos.x - runner.pos.x, world.ball.pos.y - runner.pos.y);
      const l = Math.hypot(to.x, to.y) || 1;
      world.step(DT, [idle, { ...idle, move: vec(to.x / l, to.y / l) }, idle, idle]);
      expect(world.events.some((e) => e.kind === 'offside')).toBe(false);
    }
  });

  it('a ball put back in from the touchline plays nobody offside', () => {
    const { world, passer, runner } = offsideStage(80, 50);
    world.lastTouch = { team: 1, idx: 2 };
    world.ball.pos = vec(50, PITCH.width + 0.5); // out for a throw to team 0
    world.ball.vel = vec(0, 6);
    for (let t = 0; t < 30 && world.restartLock <= 0; t++) world.step(DT, [idle, idle, idle, idle]);
    expect(world.restartLock).toBeGreaterThan(0);
    world.restartLock = 0; // the taker is on it
    passer.pos = vec(world.ball.pos.x - 0.6, world.ball.pos.y);
    world.step(DT, [{ ...idle, move: vec(0, -1), kickReleased: { power: 0.5 } }, idle, idle, idle]);
    for (let t = 0; t < 60 * 4; t++) {
      const to = vec(world.ball.pos.x - runner.pos.x, world.ball.pos.y - runner.pos.y);
      const l = Math.hypot(to.x, to.y) || 1;
      world.step(DT, [idle, { ...idle, move: vec(to.x / l, to.y / l) }, idle, idle]);
      expect(world.events.some((e) => e.kind === 'offside')).toBe(false);
    }
  });

  it('a staged session can switch the flag off entirely', () => {
    const { world, runner } = offsideStage(80);
    world.offsideEnabled = false;
    world.step(DT, [{ ...idle, move: vec(1, 0), kickReleased: { power: 0.6 } }, idle, idle, idle]);
    for (let t = 0; t < 60 * 5; t++) {
      const to = vec(world.ball.pos.x - runner.pos.x, world.ball.pos.y - runner.pos.y);
      const l = Math.hypot(to.x, to.y) || 1;
      world.step(DT, [idle, { ...idle, move: vec(to.x / l, to.y / l) }, idle, idle]);
      expect(world.events.some((e) => e.kind === 'offside')).toBe(false);
    }
  });

  it('the chalk line is the second-last defender, never behind the halfway', () => {
    const { world } = offsideStage(80);
    expect(world.offsideLineX(0)).toBeCloseTo(70, 5); // the stopper, keeper behind him
    world.players[2].pos = vec(30, 30); // he steps up past the halfway line
    expect(world.offsideLineX(0)).toBe(PITCH.length / 2);
  });
});

describe('the strafe', () => {
  it('a walker keeps his eyes on the ball while his feet carry him backwards', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), mk(), id(0));
    world.players.push(p);
    world.ball.pos = vec(70, 34); // the ball is east; he retreats west
    const retreat: PlayerInput = { ...idle, move: vec(-1, 0), attend: world.ball.pos };
    let sharpestTurn = 0;
    for (let t = 0; t < 60 * 2; t++) {
      const before = vec(p.look.x, p.look.y);
      world.step(DT, [retreat]);
      sharpestTurn = Math.max(sharpestTurn, Math.abs(Math.atan2(
        before.x * p.look.y - before.y * p.look.x, before.x * p.look.x + before.y * p.look.y)));
    }
    expect(p.pos.x).toBeLessThan(48);     // he really moved backwards
    expect(p.look.x).toBeGreaterThan(0.9); // still square to the ball
    expect(sharpestTurn).toBeLessThan(0.13); // and the head never snapped around
  });

  it('the second you sprint, the shoulders go where the legs go', () => {
    const world = new World();
    const p = new PlayerBody(vec(52, 34), mk(), id(0));
    world.players.push(p);
    world.ball.pos = vec(70, 34);
    const bolt: PlayerInput = { ...idle, move: vec(-1, 0), sprint: true, attend: world.ball.pos };
    for (let t = 0; t < 60; t++) world.step(DT, [bolt]);
    expect(p.look.x).toBeLessThan(-0.9);
  });

  it('a human seat gets the ball as its attend point for free, unless it is aiming', () => {
    const match = createMatch();
    const world = match.world;
    world.restartLock = 0;
    const seat = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'DF');
    world.players[seat].pos = vec(world.ball.pos.x - 6, world.ball.pos.y + 6);
    const walk: PlayerInput = { ...idle, move: vec(-1, 0) };
    for (let t = 0; t < 60; t++) advanceMatch(match, DT, { [seat]: walk });
    const body = world.players[seat];
    const toBall = vec(world.ball.pos.x - body.pos.x, world.ball.pos.y - body.pos.y);
    const l = Math.hypot(toBall.x, toBall.y) || 1;
    expect((body.look.x * toBall.x + body.look.y * toBall.y) / l).toBeGreaterThan(0.8);
    // charging a kick hands the body back to the sight — eyes off the ball
    for (let t = 0; t < 60; t++) advanceMatch(match, DT, { [seat]: { ...walk, kickCharging: true } });
    expect(body.look.x).toBeLessThan(-0.8);
  });
});

describe('firm bodies', () => {
  it('22 shoulders never share ground, however hard a full match squeezes', () => {
    const match = createMatch();
    // the tightest pair of the whole match, reported once — an assertion per
    // pair per tick is a quarter million matcher calls and tells you no more
    let tightest = Infinity;
    for (let t = 0; t < 60 * 40; t++) {
      advanceMatch(match, DT);
      if (t % 7) continue;
      const ps = match.world.players;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) tightest = Math.min(tightest, dist(ps[i].pos, ps[j].pos));
      }
    }
    expect(tightest).toBeGreaterThan(0.86);
  }, LONG_SIM);

  it('a defender is a boundary: a sprinter cannot run through him, and the strong man holds the ground', () => {
    const world = new World();
    const wall = new PlayerBody(vec(52, 34), mk({ phys: 0.95 }), id(1, 'DF'));
    const runner = new PlayerBody(vec(46, 34), mk({ phys: 0.25 }), id(0, 'FW'));
    world.players.push(wall, runner);
    world.ball.pos = vec(20, 10); // the ball is nowhere near this duel
    for (let t = 0; t < 60 * 3; t++) {
      world.step(DT, [idle, { ...idle, move: vec(1, 0), sprint: true }]);
      expect(dist(wall.pos, runner.pos)).toBeGreaterThan(0.86);
    }
    expect(runner.pos.x).toBeLessThan(wall.pos.x);       // never got past the shoulder
    expect(Math.abs(wall.pos.x - 52)).toBeLessThan(1.4); // and the heavy man barely moved
  });
});

describe('the turn', () => {
  // Full pace one way, then a new direction asked of it — and what that cost
  const wheel = (turn: Vec2, over: Partial<PlayerStats> = {}) => {
    const p = new PlayerBody(vec(50, 34), mk(over), id(0));
    for (let t = 0; t < 180; t++) p.update(DT, { ...idle, move: vec(1, 0), sprint: true }, []);
    const top = p.speed();
    let slowest = top;
    let roundAt = -1;
    for (let t = 0; t < 180; t++) {
      p.update(DT, { ...idle, move: turn, sprint: true }, []);
      slowest = Math.min(slowest, p.speed());
      const along = p.vel.x * turn.x + p.vel.y * turn.y; // pace made good the new way
      if (roundAt < 0 && along > top * 0.6) roundAt = t / 60;
    }
    return { top, slowest, roundAt };
  };

  it('a run bends through every angle instead of flipping along one axis', () => {
    const p = new PlayerBody(vec(50, 34), mk(), id(0));
    for (let t = 0; t < 180; t++) p.update(DT, { ...idle, move: vec(1, 0), sprint: true }, []);
    let arced = 0;
    for (let t = 0; t < 30; t++) {
      p.update(DT, { ...idle, move: vec(0, 1), sprint: true }, []);
      if (Math.abs(p.vel.x) > 0.5 && Math.abs(p.vel.y) > 0.5) arced++; // genuinely diagonal
    }
    expect(arced).toBeGreaterThan(8);
  });

  // This is an ARCADE game: the keys are obeyed now. A reversal costs the
  // momentum you have to shed and nothing else — no turn-rate cap, no brake
  // tax on the angle. Slow, deliberate turning is what made the hands feel
  // laggy, and it is never coming back.
  it('answers a full reversal fast, and asks nothing at all for a nudge', () => {
    const flip = wheel(vec(-1, 0));
    expect(flip.roundAt).toBeLessThan(0.4);            // round and up to pace, quick
    const nudge = wheel(vec(Math.cos(0.35), Math.sin(0.35)));
    expect(nudge.roundAt).toBeLessThan(0.05);
    expect(nudge.slowest).toBeGreaterThan(nudge.top * 0.9);
  });

  it('is a stat: the agile man comes round quicker than the wooden one', () => {
    expect(wheel(vec(0, 1), { agility: 0.95 }).roundAt)
      .toBeLessThan(wheel(vec(0, 1), { agility: 0.2 }).roundAt);
  });
});

describe('the shield', () => {
  const shieldStage = () => {
    const world = new World();
    const carrier = new PlayerBody(vec(52, 34), mk({ control: 0.8, phys: 0.8 }), id(0));
    const defender = new PlayerBody(vec(50.6, 34), mk({ defend: 0.9, phys: 0.8 }), id(1, 'DF'));
    world.players.push(carrier, defender);
    world.ball.pos = vec(52.5, 34); // the carrier's body sits between the two
    world.ball.vel = vec(1.2, 0);
    for (let i = 0; i < 30 && !world.carrier; i++) world.step(DT, [idle, idle]);
    return { world, carrier, defender };
  };

  it('a turned back slows the jaws to a crawl, and the sim says who is shielding whom', () => {
    const { world } = shieldStage();
    const squeeze: PlayerInput = { ...idle, move: vec(1, 0), clamp: true };
    let closeAfterASecond = 0;
    for (let t = 0; t < 60; t++) {
      world.step(DT, [{ ...idle, move: vec(1, 0) }, squeeze]);
      closeAfterASecond = world.clamp?.close ?? closeAfterASecond;
    }
    expect(world.shielding?.idx).toBe(0);
    expect(world.shielding?.from).toBe(1);
    expect(closeAfterASecond).toBeLessThan(0.75); // a whole second and the jaws are still open
    expect(world.events.some((e) => e.kind === 'steal')).toBe(false);
  });

  it('a lunge from the shielded side wins a shoulder and nothing else', () => {
    const { world, carrier } = shieldStage();
    let shrugged = false;
    for (let t = 0; t < 90 && !shrugged; t++) {
      world.step(DT, [{ ...idle, move: vec(1, 0) }, { ...idle, move: vec(1, 0), tackle: t === 0 }]);
      shrugged = world.events.some((e) => e.kind === 'shrug');
      expect(world.events.some((e) => e.kind === 'steal')).toBe(false);
    }
    expect(shrugged).toBe(true);
    expect(world.carrier?.idx).toBe(0);           // still his ball
    expect(dist(world.ball.pos, carrier.pos)).toBeLessThan(1.4);
  });
});

describe('the whistle', () => {
  // A shielded carrier deep in the corner of the box, with a quicker man
  // arriving through his back — the one contact the referee actually watches
  const boxStage = () => {
    const world = new World();
    const carrier = new PlayerBody(vec(102, 37), mk({ control: 0.8, phys: 0.8 }), id(0, 'FW'));
    const defender = new PlayerBody(vec(100.4, 37), mk({ topSpeed: 7.5, sprintSpeed: 9.5, defend: 0.9 }), id(1, 'DF'));
    world.players.push(carrier, defender);
    world.ball.pos = vec(102.5, 37); // the carrier's body sits between the two
    world.ball.vel = vec(1.2, 0);
    for (let i = 0; i < 30 && !world.carrier; i++) world.step(DT, [idle, idle]);
    return world;
  };
  // Charge him down and report the call: whether a whistle blew, and the
  // restart that landed on the very same tick. Stops on the whistle so the
  // dead-ball beat is still standing when the assertions look at it.
  const charge = (world: World, ticks: number) => {
    const call = { whistled: false, restart: '', team: -1 };
    for (let t = 0; t < ticks; t++) {
      world.step(DT, [{ ...idle, move: vec(1, 0) }, { ...idle, move: vec(1, 0), sprint: true, tackle: t % 40 === 0 }]);
      const foul = world.events.find((e) => e.kind === 'foul');
      if (foul?.kind !== 'foul') continue;
      call.whistled = true;
      for (const e of world.events) {
        if (e.kind === 'restart') { call.restart = e.restart; call.team = e.team; }
      }
      break;
    }
    return call;
  };

  it('a challenge through the back inside the box is a free kick, never a penalty', () => {
    const world = boxStage();
    const call = charge(world, 400);
    expect(call.whistled).toBe(true);
    expect(call.restart).toBe('freekick');    // the spot kick is retired
    expect(call.team).toBe(0);                // the fouled side gets the ball
    // placed where the man went down — deep in the box, not on the spot
    expect(world.ball.pos.x).toBeGreaterThan(PITCH.length - 16.5);
    expect(world.awaitingRestart).toBe(true);
    expect(world.restartLock).toBeGreaterThan(0);
  });

  it('a staged session switches the referee off, and nobody is ever re-staged by him', () => {
    const world = boxStage();
    world.foulsEnabled = false;
    expect(charge(world, 400).whistled).toBe(false);
    expect(world.awaitingRestart).toBe(false); // nothing was ever staged
  });
});

describe('stoppage time', () => {
  it('a goal ceremony is dead time, and the referee hands every second of it back', () => {
    const match = createMatch({ halfLength: 20 });
    const world = match.world;
    for (let t = 0; t < 60 * 5; t++) advanceMatch(match, DT); // the ball lives
    world.restartLock = 0;
    world.restartExclusion = 0;
    world.lastTouch = { team: 0, idx: 9 };
    world.ball.pos = vec(PITCH.length - 0.5, PITCH.width / 2);
    world.ball.vel = vec(15, 0);
    let ticks = 60 * 5;
    let owed = 0;
    for (let t = 0; t < 60 * 90 && match.half === 1; t++) {
      advanceMatch(match, DT);
      owed = Math.max(owed, match.stoppage);
      ticks++;
    }
    expect(match.half).toBe(2);
    expect(owed).toBeGreaterThan(6);            // party plus walk home, all of it counted
    expect(ticks / 60).toBeGreaterThan(20 + 6); // and the half really ran that long
    expect(match.stoppage).toBe(0);             // the sum starts over after the break
    expect(match.halfLive).toBe(false);
  }, LONG_SIM);

  it('the opening ceremony is not stoppage — only a ball that has lived can die', () => {
    const match = createMatch({ halfLength: 60 });
    for (let t = 0; t < 30; t++) advanceMatch(match, DT); // still inside the kickoff beat
    expect(match.world.restartLock).toBeGreaterThan(0);
    expect(match.stoppage).toBe(0);
  });
});

describe('the walk back', () => {
  it('a goal ends in a kickoff, and nobody ever jumps a step getting there', () => {
    const match = createMatch();
    const world = match.world;
    world.restartLock = 0;
    world.restartExclusion = 0;
    world.lastTouch = { team: 0, idx: 9 };
    world.ball.pos = vec(PITCH.length - 0.5, PITCH.width / 2);
    world.ball.vel = vec(15, 0);
    const seen = new Set<string>();
    let sawKickoff = false;
    let biggestStep = 0;
    for (let t = 0; t < 60 * 20 && !sawKickoff; t++) {
      const before = world.players.map((p) => vec(p.pos.x, p.pos.y));
      advanceMatch(match, DT);
      seen.add(world.ceremony);
      world.players.forEach((p, i) => { biggestStep = Math.max(biggestStep, dist(before[i], p.pos)); });
      sawKickoff = world.events.some((e) => e.kind === 'kickoff');
    }
    expect(seen.has('celebrate')).toBe(true);
    expect(seen.has('walkback')).toBe(true);
    expect(sawKickoff).toBe(true);
    expect(biggestStep).toBeLessThan(0.16); // a hurried stride at 60Hz — never a jump cut
    // everybody arrived on his own mark, on his own legs — one man on the spot
    const spot = vec(PITCH.length / 2, PITCH.width / 2);
    for (const p of world.players) {
      expect(Math.min(dist(p.pos, p.home), dist(p.pos, spot))).toBeLessThan(2);
    }
  }, LONG_SIM);

  it('the coach can abort the whole ceremony mid-walk and the world plays on', () => {
    const match = createMatch();
    const world = match.world;
    world.restartLock = 0;
    world.lastTouch = { team: 0, idx: 9 };
    world.ball.pos = vec(PITCH.length - 0.5, PITCH.width / 2);
    world.ball.vel = vec(15, 0);
    for (let t = 0; t < 60 * 8 && world.ceremony !== 'walkback'; t++) advanceMatch(match, DT);
    expect(world.ceremony).toBe('walkback');
    for (let t = 0; t < 60; t++) advanceMatch(match, DT); // a second into the walk, ball out of the net
    world.abortGoalReset();
    expect(world.ceremony).toBe('live');
    expect(world.celebration).toBeNull();
    world.restartLock = 0;
    advanceMatch(match, DT);
    expect(world.ceremony).toBe('live'); // and it stays gone
  });
});

describe('the keeper leaves his feet', () => {
  const diveStage = () => {
    const world = new World();
    const gk = new PlayerBody(vec(2, 34), mk({ dive: 0.9, agility: 0.85, handling: 0.8 }), id(0, 'GK'));
    world.players.push(gk);
    return { world, gk };
  };

  it('a dive intent commits the leap, announces it, and cannot be steered mid-air', () => {
    const { world, gk } = diveStage();
    world.ball.pos = vec(60, 34); // nothing to save yet — this is the leap alone
    world.step(DT, [{ ...idle, dive: { dirY: 1, height: 0 } }]);
    const e = world.events.find((ev) => ev.kind === 'gkDive');
    expect(e && e.kind === 'gkDive' && e.dirY).toBe(1);
    expect(gk.vel.y).toBeGreaterThan(8);
    // steering the other way mid-flight changes nothing
    for (let t = 0; t < 12; t++) world.step(DT, [{ ...idle, move: vec(0, -1) }]);
    expect(gk.vel.y).toBeGreaterThan(6);
    expect(gk.pos.y).toBeGreaterThan(35);
  });

  it('the leap buys reach: a ball he could never stand and stop dies in his gloves', () => {
    const flight = (leap: boolean) => {
      const { world } = diveStage();
      world.ball.pos = vec(2, 37.4); // three strides to his side — hopeless on his feet
      world.ball.vel = vec(-6, 0);
      for (let t = 0; t < 40; t++) {
        world.step(DT, [t === 0 && leap ? { ...idle, dive: { dirY: 1, height: 0 } } : idle]);
        if (world.events.some((e) => e.kind === 'save' || e.kind === 'parry')) return true;
      }
      return false;
    };
    expect(flight(true)).toBe(true);
    expect(flight(false)).toBe(false); // standing there, the same ball is a goal
  });

  it('a world where nobody ever dives behaves exactly as it always did', () => {
    const a = createMatch();
    const b = createMatch();
    for (let t = 0; t < 60 * 10; t++) {
      advanceMatch(a, DT);
      advanceMatch(b, DT);
    }
    expect(a.world.ball.pos.x).toBe(b.world.ball.pos.x);
    expect(a.world.players.every((p) => p.diveTimer === 0)).toBe(true);
  }, LONG_SIM);
});

describe('the six-yard box is the best place to shoot from', () => {
  // One striker, one keeper, one goal: fire a spread of shots at the mouth and
  // count what beats him. Football's whole reward shape lives in this number.
  const conversion = (from: number, shots = 24) => {
    let goals = 0;
    let onTarget = 0;
    for (let s = 0; s < shots; s++) {
      const world = new World(9000 + s * 37); // independent samples, not one lucky stream
      world.foulsEnabled = false;
      const gx = PITCH.length;
      const mid = PITCH.width / 2;
      const striker = new PlayerBody(vec(gx - from, mid), mk(), id(0, 'FW'));
      const keeper = new PlayerBody(vec(gx - 0.6, mid), mk({ dive: 0.6, reflex: 0.6 }), id(1, 'GK'));
      world.players.push(striker, keeper);
      world.ball.pos = vec(gx - from + 0.4, mid);
      const bb = new TeamBrain(1, world);
      const mind = new KeeperMind(1);
      const aimAt = vec(gx + 0.5, mid + ((s % 7) - 3) * 1.4);
      let done = false;
      for (let t = 0; t < 60 * 4 && !done; t++) {
        const gk: PlayerInput = { ...idle };
        bb.update(world, DT);
        mind.steer(world, keeper, bb, DT, gk);
        world.step(DT, [t === 0 ? { ...idle, kickReleased: { power: 0.55 + (s % 5) * 0.11, aimAt } } : idle, gk]);
        if (world.events.some((e) => e.kind === 'save' || e.kind === 'parry')) { onTarget++; done = true; }
        if (world.ball.pos.x >= gx) {
          done = true;
          if (Math.abs(world.ball.pos.y - mid) < PITCH.goalWidth / 2 && world.ball.z < PITCH.goalHeight) {
            onTarget++;
            goals++;
          }
        }
      }
    }
    return onTarget ? goals / onTarget : 0;
  };

  it('a finish from six meters beats a strike from eighteen, and beats it clearly', () => {
    const close = conversion(6);
    const far = conversion(18);
    expect(close).toBeGreaterThan(0.5);   // the tap-in is the best chance in the game
    expect(close).toBeGreaterThan(far + 0.2); // and range is never the easier option
  }, LONG_SIM);

  it('a keeper still has an afternoon: the mouth is guarded, not blanketed', () => {
    expect(conversion(12)).toBeLessThan(0.5); // a set keeper at twelve meters is a real wall
  }, LONG_SIM);
});
