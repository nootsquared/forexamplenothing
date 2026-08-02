import { describe, it, expect } from 'vitest';
import { createMatch } from '../src/match';
import { takeSnap, SnapPlayer } from '../src/net/snapshot';
import { MatchSnap } from '../src/net/net';
import { SimEvent } from '../src/sim/events';

// The wire's truth, headless: a host match flattened, JSON-bounced like the
// relay would, and rebuilt in a guest world — sprint dust, stamina and the
// keeper sight all ride the same envelope.

const DT = 1 / 60;
const wire = (snap: MatchSnap): MatchSnap => JSON.parse(JSON.stringify(snap));

describe('the snapshot envelope', () => {
  it('carries sprint, stamina and the keeper-sight seat into a guest world', () => {
    const host = createMatch();
    const runner = host.world.players[5];
    runner.isSprinting = true;
    runner.stamina = 0.42;
    runner.vel.x = 7.2;
    const snap = wire(takeSnap(host, 10, { 0: 5 }, { 0: -1 }, [], 3));
    expect(snap.gkAim).toBe(3);

    const guest = createMatch();
    const player = new SnapPlayer();
    player.push(snap);
    player.push(wire(takeSnap(host, 12, { 0: 5 }, { 0: -1 }, [])));
    player.apply(guest.world, DT);
    const mirror = guest.world.players[5];
    expect(mirror.isSprinting).toBe(true);
    expect(mirror.stamina).toBeCloseTo(0.42, 2);
    expect(mirror.vel.x).toBeCloseTo(7.2, 1);
  });

  it('holds an event until the buffered timeline reaches its moment', () => {
    const host = createMatch();
    const player = new SnapPlayer();
    const goal: SimEvent = { kind: 'goal', side: 'left', scorer: 4 };
    player.push(wire(takeSnap(host, 98, {}, {}, [])));
    player.push(wire(takeSnap(host, 100, {}, {}, [goal])));

    const guest = createMatch();
    player.apply(guest.world, DT); // render clock still short of tick 99
    expect(player.drainEvents()).toEqual([]);
    for (let i = 0; i < 8; i++) player.apply(guest.world, DT); // rides up to tick 99
    expect(player.drainEvents()).toEqual([goal]);
    expect(player.drainEvents()).toEqual([]); // exactly once
  });
});
