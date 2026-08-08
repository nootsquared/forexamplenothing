import { Vec2 } from '../core/math';
import { PlayerInput } from '../sim/player';
import { LocalControls } from './controls';
import { Keyboard } from './keyboard';
import { PadButton, pads } from './gamepad';

// The couch: who is actually sitting down. A seat is ONE device — a pad in a
// named slot, or one pair of hands on the keyboard — plus the side it plays
// for. The shell asks every seat for its intent each tick and never has to
// know which kind it is.

export type SeatDevice = { kind: 'pad'; index: number } | { kind: 'keys'; hands: 0 | 1 };

// The stable name of a device, so a seat survives a pad blinking out and back
export const deviceId = (d: SeatDevice) => (d.kind === 'pad' ? `pad${d.index}` : `keys${d.hands}`);
export const deviceLabel = (d: SeatDevice) =>
  d.kind === 'pad' ? `PAD ${d.index + 1}` : d.hands === 0 ? 'KEYBOARD' : 'KEYBOARD 2';

// The SECOND pair of hands on one keyboard. Seat one keeps WASD, shift, space
// and the mouse exactly as they have always been; seat two lives in the
// right-hand cluster — arrows to run, / to sprint, . to tackle, ; and ' to
// bend. It has no mouse, so its kick is the shell's to hand out.
export const SECOND_HANDS: Record<string, string> = {
  KeyW: 'ArrowUp', KeyS: 'ArrowDown', KeyA: 'ArrowLeft', KeyD: 'ArrowRight',
  ShiftLeft: 'Slash', ShiftRight: 'Slash',
  Space: 'Period', KeyK: 'Period',
  KeyJ: 'Semicolon', KeyL: 'Quote',
};
// The two keys seat two presses together to sit down — its own sprint and
// tackle, so the handshake teaches the controls
export const SECOND_JOIN = ['Slash', 'Period'];

// Same keyboard, different names on the keys: LocalControls only ever asks
// has(), so a thin front over the real one is a whole second player
const secondHands = (kb: Keyboard): Keyboard => {
  const front: Keyboard = Object.create(kb);
  front.has = (code: string) => kb.has(SECOND_HANDS[code] ?? code);
  return front;
};

// A board with nobody at it. A pad seat has to be DEAF to the keyboard, or
// the man typing on it walks every controller's player at once.
const noHands = (kb: Keyboard): Keyboard => {
  const front: Keyboard = Object.create(kb);
  front.has = () => false;
  return front;
};

export class Seat {
  readonly id: string;
  readonly label: string;
  controls: LocalControls;
  private front: Keyboard | null = null;

  constructor(readonly device: SeatDevice, public team: 0 | 1, squash: number) {
    this.id = deviceId(device);
    this.label = deviceLabel(device);
    this.controls = new LocalControls(squash);
  }

  // What these hands are asking for this tick — the pad this seat owns, or
  // its own half of the keyboard, never both
  sample(dt: number, kb: Keyboard, facing: Vec2): PlayerInput {
    if (this.device.kind === 'pad') {
      if (!this.front) this.front = noHands(kb);
      return pads.drive(this.device.index, () => this.controls.sample(dt, this.front!, facing));
    }
    if (this.device.hands === 1 && !this.front) this.front = secondHands(kb);
    return pads.drive(null, () => this.controls.sample(dt, this.front ?? kb, facing));
  }

  // The pass this seat's right stick just fired, if any — consumed once
  takeFlick() {
    return this.controls.takeFlick();
  }

  // A button edge on THIS seat's pad. Verbs that belong to one man — switch
  // me, auto-switch, cheer — ask here, so pad two never answers for pad one.
  pressed(button: PadButton): boolean {
    return this.device.kind === 'pad' && !!pads.device(this.device.index)?.pressed(button);
  }

  // A pad still on the table. Keyboard hands never walk off.
  get live(): boolean {
    return this.device.kind !== 'pad' || !!pads.device(this.device.index);
  }

  rumble(intensity: number, ms: number) {
    if (this.device.kind === 'pad') pads.device(this.device.index)?.rumble(intensity, ms);
  }
}

export class SeatRoster {
  seats: Seat[] = [];
  private squash = 1;

  // The couch never shuffles: keyboard hands first, then pads by slot
  private order(seat: Seat) {
    return seat.device.kind === 'keys' ? seat.device.hands : 10 + seat.device.index;
  }

  seat(id: string): Seat | null {
    return this.seats.find((s) => s.id === id) ?? null;
  }

  // Whose hands the shell itself wears — the couch's first chair
  get primary(): Seat | null {
    return this.seats[0] ?? null;
  }

  has(device: SeatDevice): boolean {
    return !!this.seat(deviceId(device));
  }

  join(device: SeatDevice, team: 0 | 1): Seat {
    const already = this.seat(deviceId(device));
    if (already) return already;
    const seat = new Seat(device, team, this.squash);
    this.seats = [...this.seats, seat].sort((a, b) => this.order(a) - this.order(b));
    return seat;
  }

  leave(id: string) {
    this.seats = this.seats.filter((s) => s.id !== id);
  }

  // A pad yanked out of the hub takes its chair with it — otherwise the room
  // sits there waiting on a device nobody is holding. Names the empty chairs.
  prune(): string[] {
    const gone = this.seats.filter((s) => !s.live).map((s) => s.id);
    if (gone.length) this.seats = this.seats.filter((s) => s.live);
    return gone;
  }

  clear() {
    this.seats = [];
  }

  forTeam(team: 0 | 1): Seat[] {
    return this.seats.filter((s) => s.team === team);
  }

  // A couch match needs somebody on each side — until then nothing kicks off
  get ready(): boolean {
    return this.forTeam(0).length > 0 && this.forTeam(1).length > 0;
  }

  get active(): boolean {
    return this.seats.length > 0;
  }

  // The iso y-squash is a render number that moves with the camera, and every
  // seat's aim has to be cut to it
  retune(squash: number) {
    this.squash = squash;
    for (const seat of this.seats) seat.controls = new LocalControls(squash);
  }
}

export const roster = new SeatRoster();
