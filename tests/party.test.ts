import { describe, it, expect, beforeEach } from 'vitest';
import { Party, packInput, unpackInput } from '../src/net/party';
import { NetSession, GuestMsg, NetInput } from '../src/net/net';
import { vec } from '../src/core/math';

// The host's seat ledger, headless: a stub session swallows the wire so the
// claims, armbands, and input latches can be inspected in isolation.

const stubNet = () => {
  const sent: unknown[] = [];
  const net = {
    code: 'TEST',
    seat: -1,
    role: 'host',
    onMessage: () => {},
    broadcast: (m: unknown) => sent.push(m),
    to: () => {},
  } as unknown as NetSession;
  return { net, sent };
};

const quietInput: NetInput = { mx: 0, my: 0, sp: false, ch: false, kp: 0, kx: 0, ky: 0, tk: false, sw: false };

let party: Party;
beforeEach(() => {
  const { net } = stubNet();
  party = new Party(net, 'HOST', ['bra', 'arg', 'fra']);
});

const guest = (seat: number, msg: GuestMsg) => (party as unknown as { onGuest(s: number, m: GuestMsg): void }).onGuest(seat, msg);
const seatIn = (seat: number, patch: Partial<NetInput>) => guest(seat, { t: 'input', input: { ...quietInput, ...patch } });

const join = (seat: number, name: string) => {
  party.seats.set(seat, { seat, name, team: null, claimedAt: 0, ready: false, lastInput: null, switchPressed: false, pendingKick: null, activeAt: 0, heardAt: 0 });
};

describe('claims and armbands', () => {
  it('the first to claim a shirt wears the armband, however seats are numbered', () => {
    join(1, 'ALICE');
    join(2, 'BOB');
    party.claim(2, 0); // Bob claims first despite the higher seat
    party.claim(0, 0);
    party.claim(1, 0);
    expect(party.captainOf(0)).toBe(2);
  });

  it('the armband passes when the captain walks', () => {
    join(1, 'ALICE');
    party.claim(1, 1);
    party.claim(0, 1);
    expect(party.captainOf(1)).toBe(1);
    party.seats.delete(1);
    expect(party.captainOf(1)).toBe(0);
  });

  it('leaving a team and returning re-queues you at the back', () => {
    join(1, 'ALICE');
    party.claim(0, 0);
    party.claim(1, 0);
    party.claim(0, null); // host steps off...
    party.claim(0, 0);    // ...and back on
    expect(party.captainOf(0)).toBe(1);
  });

  it('readiness: everyone seated must be ready, the host presses start regardless', () => {
    join(1, 'ALICE');
    party.claim(1, 1);
    expect(party.allReady()).toBe(false);
    party.setReady(1, true);
    expect(party.allReady()).toBe(true); // the host's own flag never gates
  });
});

describe('wire inputs at the host desk', () => {
  beforeEach(() => join(1, 'ALICE'));

  it('a kick release LATCHES until the sim consumes it', () => {
    seatIn(1, { kp: 0.8, kx: 30, ky: 22 });
    seatIn(1, {}); // the next quiet packet lands before the tick
    const s = party.seats.get(1)!;
    expect(s.pendingKick).toEqual({ power: 0.8, x: 30, y: 22 });
    expect(s.lastInput!.kp).toBe(0); // the stale release rides only the latch
  });

  it('a switch press survives packet turnover until the tick reads it', () => {
    seatIn(1, { sw: true });
    seatIn(1, {});
    expect(party.seats.get(1)!.switchPressed).toBe(true);
  });

  it('doing something marks the seat active; idle packets do not', () => {
    const s = party.seats.get(1)!;
    seatIn(1, {});
    expect(s.activeAt).toBe(0); // sixty quiet packets a second are not hands
    seatIn(1, { mx: 0.5 });
    expect(s.activeAt).toBeGreaterThan(0);
  });

  it('every packet stamps the freshness gate — even a quiet one', () => {
    const s = party.seats.get(1)!;
    expect(s.heardAt).toBe(0); // a seat never heard from reads stale
    seatIn(1, {});
    expect(s.heardAt).toBeGreaterThan(0); // quiet hands still prove the line is alive
  });
});

describe('the keeper call at the host desk', () => {
  it('routes a distribution point to the sim and drops garbage on the floor', () => {
    join(1, 'ALICE');
    const calls: [number, number, number][] = [];
    party.onGuestGk = (seat, x, y) => calls.push([seat, x, y]);
    guest(1, { t: 'gk', x: 38, y: 22 });
    guest(1, { t: 'gk', x: Number.NaN, y: 22 });
    expect(calls).toEqual([[1, 38, 22]]);
  });
});

describe('the wire form of an input', () => {
  it('round-trips a full intent, aim point included', () => {
    const out = unpackInput(packInput({
      move: vec(0.34, -0.87),
      sprint: true,
      kickCharging: false,
      kickReleased: { power: 0.9, aimOffset: 0, aimAt: vec(52.5, 34) },
      tackle: true,
    }, true));
    expect(out.move.x).toBeCloseTo(0.34, 2);
    expect(out.move.y).toBeCloseTo(-0.87, 2);
    expect(out.sprint).toBe(true);
    expect(out.tackle).toBe(true);
    expect(out.kickReleased!.power).toBe(0.9);
    expect(out.kickReleased!.aimAt!.x).toBe(52.5);
    expect(out.kickReleased!.aimAt!.y).toBe(34);
  });

  it('no release on the wire means no release off it', () => {
    const out = unpackInput(packInput({ move: vec(), sprint: false, kickCharging: true, kickReleased: null }, false));
    expect(out.kickReleased).toBeNull();
    expect(out.kickCharging).toBe(true);
  });
});
