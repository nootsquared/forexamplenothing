// The wire: one small session class over the relay at /mp. The HOST's tab is
// the single authority — guests send intents and inputs, the host answers
// with state. Nothing here knows football; it moves envelopes.

export interface NetInput {
  mx: number;   // move x/y, quantized client-side
  my: number;
  sp: boolean;  // sprint
  ch: boolean;  // kick charging
  kp: number;   // kick power released this frame (0 = none)
  kx: number;   // kick aim point x (only meaningful when kp > 0)
  ky: number;
  tk: boolean;  // tackle
  sw: boolean;  // switch (E) pressed this frame
}

// The war room over the wire. A guest CAPTAIN sends intents; the host is the
// only referee — it validates, converts each intent into an op, applies it to
// its own draft and broadcasts it, and every mirror replays the same op on an
// identical replica. Deterministic state, one authority, zero drift.
export type DraftIntent =
  | { k: 'shape'; id: string }                    // my formation call
  | { k: 'sign'; poolIdx: number }                // draft mode: buy this man
  | { k: 'academy' }                              // draft mode: take a junior
  | { k: 'roll'; role: string }                   // gamble mode: spin this shelf
  | { k: 'arrange'; slots: (number | null)[] };   // my board layout (slot → pick)

// Who runs a war-room side: the host's own hands, a guest seat, or the CPU
export type DraftCtl = { kind: 'local' } | { kind: 'remote'; seat: number } | { kind: 'cpu' };

export type DraftOp =
  | { k: 'begin'; mode: 'draft' | 'gamble'; size: number; first: 0 | 1;
      ctl: [DraftCtl, DraftCtl]; teamNames: [string, string]; capNames: [string, string];
      seatSides: Record<number, 0 | 1> }
  | { k: 'shape'; side: 0 | 1; id: string }
  | { k: 'sign'; side: 0 | 1; poolIdx: number }
  | { k: 'academy'; side: 0 | 1; role: string }
  | { k: 'roll'; side: 0 | 1; role: string; winnerPoolIdx: number; seed: number }
  | { k: 'cpu'; side: 0 | 1 }   // a captain walked out — the CPU takes his chair
  | { k: 'abort' };             // the host called the whole thing off

// guest → host
export type GuestMsg =
  | { t: 'hello'; name: string }
  | { t: 'claim'; team: 0 | 1 | null }
  | { t: 'nation'; dir: 1 | -1 }
  | { t: 'teamname'; name: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'draft'; action: DraftIntent }
  | { t: 'input'; input: NetInput };

// host → guests
export type HostMsg =
  | { t: 'lobby'; state: LobbySnap }
  | { t: 'start'; config: NetStartConfig }
  | { t: 'draft'; op: DraftOp }
  | { t: 'snap'; snap: MatchSnap }
  | { t: 'end'; score: [number, number] };

export interface SeatSnap {
  seat: number;        // 0 = the host
  name: string;
  team: 0 | 1 | null;
  captain: boolean;
  ready: boolean;
}

export interface LobbySnap {
  code: string;
  phase: 'teams' | 'draft' | 'match';
  seats: SeatSnap[];
  nations: [string, string];      // nation id per team
  teamNames: [string, string];
  mode: 'quick' | 'draft' | 'gamble';
  size: number;
  half: number;
  difficulty: number;
}

import type { SquadPlayer } from '../data/roster';

// Everything a guest needs to build the same stage the host built
export interface NetStartConfig {
  halfLength: number;
  homeShape: string;
  awayShape: string;
  homeSquad: SquadPlayer[];
  awaySquad: SquadPlayer[];
  kits: [string, string];        // player-sheet keys, e.g. 'bra-h'
  nations: [string, string];
  teamNames: [string, string];
  seatTeams: Record<number, 0 | 1>;
  seatNames: Record<number, string>;
  kickoffFirst: 0 | 1;
}

// One tick of truth for every client renderer
export interface MatchSnap {
  tick: number;
  ball: number[];                  // x, y, z, vx, vy, vz
  players: number[][];             // per body: x, y, vx, vy, fx, fy, lunge, charging
  score: [number, number];
  clock: number;
  half: number;
  restartLock: number;
  celebration: boolean;
  cursors: Record<number, number>; // seat → body idx (for markers + own camera)
  suggest: Record<number, number>; // seat → the body E would take (the white chevron)
  events: unknown[];               // SimEvents raised since the last snap
  sidesSwapped: boolean;
}

type Handler = (msg: HostMsg | { t: 'peer-joined'; seat: number; name: string } | { t: 'peer-left'; seat: number } | { t: 'from'; seat: number; msg: GuestMsg } | { t: 'hosted'; code: string } | { t: 'joined'; seat: number } | { t: 'no-room' } | { t: 'room-closed' }) => void;

export class NetSession {
  private ws: WebSocket | null = null;
  role: 'host' | 'guest' | null = null;
  code = '';
  seat = -1; // my seat id as a guest
  onMessage: Handler = () => {};
  onClosed: () => void = () => {};

  private open(onReady: () => void) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/mp`);
    this.ws.onopen = onReady;
    this.ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        // record identity FIRST — handlers read code/seat the moment they fire
        if (m.t === 'hosted') this.code = m.code;
        if (m.t === 'joined') this.seat = m.seat;
        // unwrap relay envelopes for guests
        if (m.t === 'msg') this.onMessage(m.msg);
        else this.onMessage(m);
      } catch { /* garbage on the wire is nobody's problem */ }
    };
    this.ws.onclose = () => this.onClosed();
  }

  host() {
    this.role = 'host';
    this.open(() => this.raw({ t: 'host' }));
  }

  join(code: string, name: string) {
    this.role = 'guest';
    this.open(() => this.raw({ t: 'join', code, name }));
  }

  // host → one guest / all guests
  to(seat: number, msg: HostMsg) {
    this.raw({ t: 'to', seat, msg });
  }

  broadcast(msg: HostMsg) {
    this.raw({ t: 'broadcast', msg });
  }

  // guest → host
  send(msg: GuestMsg) {
    this.raw(msg);
  }

  private raw(obj: unknown) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.role = null;
  }
}
