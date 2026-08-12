import { NetSession, LobbySnap, SeatSnap, GuestMsg, HostMsg, NetInput, DraftIntent } from './net';
import { PlayerInput, SkillKind } from '../sim/player';
import { vec } from '../core/math';

// The party, as the HOST's tab sees it: who's here, what they're named,
// which team they claimed, who captains it, which nations are dressed.
// Guests hold only the latest LobbySnap the host broadcast them.

export interface Seat {
  seat: number;            // 0 = host
  name: string;
  team: 0 | 1 | null;
  claimedAt: number;       // claim-order stamp — first to claim wears the armband
  ready: boolean;
  lastInput: NetInput | null; // freshest input while a match runs
  switchPressed: boolean;     // E arrived since last tick
  // a kick release LATCHES until the sim consumes it — packets outrun ticks,
  // and a release overwritten before its tick would eat the pass
  pendingKick: { power: number; x: number; y: number } | null;
  heardAt: number;            // last packet at all — the freshness gate: stale hands
                              // must never keep steering a body down the old line
}

const DEFAULT_NATIONS: [string, string] = ['bra', 'arg'];

export class Party {
  seats = new Map<number, Seat>();
  nations: [string, string] = [...DEFAULT_NATIONS];
  teamNames: [string, string] = ['', ''];   // '' = wear the nation's name
  mode: 'quick' | 'draft' | 'gamble' = 'quick';
  half = 120; // seconds per half — the host's console sets it
  phase: 'teams' | 'draft' | 'match' = 'teams';
  onChange: () => void = () => {};          // host UI refresh hook
  onSeatJoined: (seat: number) => void = () => {}; // a fresh face walked in
  onSeatLeft: (seat: number) => void = () => {};   // ...and one walked out
  onGuestDraft: (seat: number, action: DraftIntent) => void = () => {};
  // a guest captain called his keeper's distribution — the sim decides if it's his to call
  onGuestGk: (seat: number, x: number, y: number) => void = () => {};
  // ...and a guest pressed Enter on the goal replay: the host counts the nods
  onGuestReplay: (seat: number) => void = () => {};
  private claimSeq = 1; // ticket roll for claim order

  constructor(public net: NetSession, hostName: string, public nationIds: string[]) {
    this.seats.set(0, { seat: 0, name: hostName, team: null, claimedAt: 0, ready: false, lastInput: null, switchPressed: false, pendingKick: null, heardAt: 0 });
  }

  // The captain of a team is whoever CLAIMED it first — first in the shirt,
  // armband on. The host joining late stands in line like anyone else.
  captainOf(team: 0 | 1): number {
    let cap = -1;
    let at = Infinity;
    for (const s of this.seats.values()) {
      if (s.team === team && s.claimedAt < at) { at = s.claimedAt; cap = s.seat; }
    }
    return cap;
  }

  humansOn(team: 0 | 1): Seat[] {
    return [...this.seats.values()].filter((s) => s.team === team);
  }

  claim(seat: number, team: 0 | 1 | null) {
    const s = this.seats.get(seat);
    if (!s || s.team === team) return;
    // a team holds at most 11 humans — one body each
    if (team !== null && this.humansOn(team).length >= 11) return;
    s.team = team;
    s.claimedAt = team === null ? 0 : this.claimSeq++;
    s.ready = false;
    this.publish();
  }

  cycleNation(seat: number, dir: 1 | -1) {
    const s = this.seats.get(seat);
    if (!s || s.team === null || this.captainOf(s.team) !== seat) return;
    const cur = this.nationIds.indexOf(this.nations[s.team]);
    const n = this.nationIds.length;
    let next = (cur + dir + n) % n;
    // both teams wearing the same colors would be a farce
    if (this.nationIds[next] === this.nations[s.team === 0 ? 1 : 0]) next = (next + dir + n) % n;
    this.nations[s.team] = this.nationIds[next];
    this.publish();
  }

  renameTeam(seat: number, name: string) {
    const s = this.seats.get(seat);
    if (!s || s.team === null || this.captainOf(s.team) !== seat) return;
    this.teamNames[s.team] = name.slice(0, 14).toUpperCase();
    this.publish();
  }

  setReady(seat: number, ready: boolean) {
    const s = this.seats.get(seat);
    if (s) {
      s.ready = ready;
      this.publish();
    }
  }

  // Everyone seated on a team is ready (host presses start regardless of his own flag)
  allReady(): boolean {
    return [...this.seats.values()].every((s) => s.seat === 0 || s.team === null || s.ready);
  }

  snap(): LobbySnap {
    const seats: SeatSnap[] = [...this.seats.values()].map((s) => ({
      seat: s.seat,
      name: s.name,
      team: s.team,
      captain: s.team !== null && this.captainOf(s.team) === s.seat,
      ready: s.ready,
    }));
    return {
      code: this.net.code,
      phase: this.phase,
      seats,
      nations: [...this.nations],
      teamNames: [...this.teamNames],
      mode: this.mode,
      size: 11,
      half: this.half,
      difficulty: 1,
    };
  }

  publish() {
    this.net.broadcast({ t: 'lobby', state: this.snap() });
    this.onChange();
  }

  // Wire the relay traffic into party state. Returns a detach function.
  attach(): void {
    this.net.onMessage = (m) => {
      if (m.t === 'peer-joined') {
        this.seats.set(m.seat, { seat: m.seat, name: m.name, team: null, claimedAt: 0, ready: false, lastInput: null, switchPressed: false, pendingKick: null, heardAt: 0 });
        this.publish();
        this.onSeatJoined(m.seat);
      } else if (m.t === 'peer-left') {
        this.seats.delete(m.seat);
        this.publish();
        this.onSeatLeft(m.seat);
      } else if (m.t === 'from') {
        this.onGuest(m.seat, m.msg);
      }
    };
  }

  private onGuest(seat: number, msg: GuestMsg) {
    switch (msg.t) {
      case 'hello': {
        const s = this.seats.get(seat);
        if (s) { s.name = msg.name.slice(0, 12); this.publish(); }
        break;
      }
      case 'claim': this.claim(seat, msg.team); break;
      case 'nation': this.cycleNation(seat, msg.dir); break;
      case 'teamname': this.renameTeam(seat, msg.name); break;
      case 'ready': this.setReady(seat, msg.ready); break;
      case 'draft': this.onGuestDraft(seat, msg.action); break;
      case 'replay': this.onGuestReplay(seat); break;
      case 'gk':
        if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) this.onGuestGk(seat, msg.x, msg.y);
        break;
      case 'input': {
        const s = this.seats.get(seat);
        if (s) {
          if (msg.input.sw) s.switchPressed = true;
          if (msg.input.kp > 0) s.pendingKick = { power: msg.input.kp, x: msg.input.kx, y: msg.input.ky };
          s.heardAt = performance.now();
          s.lastInput = msg.input;
        }
        break;
      }
    }
  }

  broadcast(msg: HostMsg) {
    this.net.broadcast(msg);
  }
}

// The wire form of a PlayerInput, and back
export function packInput(input: PlayerInput, sw: boolean): NetInput {
  return {
    mx: Math.round(input.move.x * 100) / 100,
    my: Math.round(input.move.y * 100) / 100,
    sp: input.sprint,
    ch: input.kickCharging,
    kp: input.kickReleased ? input.kickReleased.power : 0,
    kx: input.kickReleased?.aimAt?.x ?? 0,
    ky: input.kickReleased?.aimAt?.y ?? 0,
    tk: !!input.tackle,
    sk: input.skill ? SKILL_WIRE.indexOf(input.skill.kind) + 1 : 0,
    sx: input.skill?.dir.x ?? 0,
    sy: input.skill?.dir.y ?? 0,
    sw,
  };
}

// The kit on the wire: one index per verb, stable on both ends
const SKILL_WIRE: SkillKind[] = ['feint', 'croqueta', 'rainbow', 'slide', 'barge'];

export function unpackInput(n: NetInput): PlayerInput {
  return {
    move: vec(n.mx, n.my),
    sprint: n.sp,
    kickCharging: n.ch,
    kickReleased: n.kp > 0 ? { power: n.kp, aimOffset: 0, aimAt: n.kx || n.ky ? vec(n.kx, n.ky) : undefined } : null,
    tackle: n.tk,
    skill: n.sk > 0 && SKILL_WIRE[n.sk - 1] ? { kind: SKILL_WIRE[n.sk - 1], dir: vec(n.sx, n.sy) } : null,
  };
}
