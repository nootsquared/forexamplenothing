import { Vec2, vec, norm, scale } from '../core/math';

// Twin-stick pads, EVERY slot, hot-plugged. The left stick moves (analog, with
// a radial dead zone), the right stick IS the pass: push it and you're
// winding, angle aims, throw depth is power, and the spring-back fires the
// ball. A charges the big kick, B tackles, RT/RB sprint, LB or X switches,
// Y toggles auto-switch, Start pauses, and the dpad walks every menu.
// Each pad is read on its own so a couch full of them can play at once; the
// shell's one-pad calls quietly speak for whichever pad is driving.

const DEAD_ZONE = 0.18;
const NAV_PUSH = 0.55;   // left-stick throw that counts as a menu step
const NAV_HOLD = 0.42;   // ...and where the step disarms again
const NAV_REPEAT = 0.32; // held-stick repeat cadence

const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, rt: 7, start: 9, up: 12, down: 13, left: 14, right: 15 } as const;
export type PadButton = keyof typeof BTN;
const BUTTONS = Object.keys(BTN) as PadButton[];
const ARROW: Record<string, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

export interface PadState {
  move: Vec2;                                  // left stick, dead-zone rescaled
  aim: { x: number; y: number; mag: number };  // right stick, raw beyond the dead zone
  kick: boolean;
  tackle: boolean;
  sprint: boolean;
}

// One physical pad in one hardware slot: its own sticks, its own button edges,
// its own menu cadence. Nothing here is shared with the pad beside it.
export class Pad {
  state: PadState | null = null;
  held = 0; // buttons down RIGHT NOW — two at once is the couch's handshake
  private ref: Gamepad | null = null;
  private edges = new Set<PadButton>();
  private prev = new Set<PadButton>();
  private navDir: PadButton | null = null;
  private navT = 0;
  private navQueue: PadButton[] = [];

  constructor(readonly index: number, readonly id: string) {}

  // One read per frame; everything downstream shares this poll
  read(pad: Gamepad, dt: number) {
    this.ref = pad;
    this.edges.clear();
    this.navQueue.length = 0;
    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    const lm = Math.hypot(lx, ly);
    const ax = pad.axes[2] ?? 0;
    const ay = pad.axes[3] ?? 0;
    const am = Math.hypot(ax, ay);
    this.state = {
      move: lm < DEAD_ZONE ? vec() : scale(norm(vec(lx, ly)), Math.min(1, (lm - DEAD_ZONE) / (1 - DEAD_ZONE))),
      aim: am < DEAD_ZONE ? { x: 0, y: 0, mag: 0 } : { x: ax, y: ay, mag: Math.min(1, am) },
      kick: !!pad.buttons[BTN.a]?.pressed,
      tackle: !!pad.buttons[BTN.b]?.pressed,
      sprint: !!(pad.buttons[BTN.rb]?.pressed || pad.buttons[BTN.rt]?.pressed),
    };

    this.held = 0;
    for (const name of BUTTONS) {
      const down = !!pad.buttons[BTN[name]]?.pressed;
      if (down && !this.prev.has(name)) this.edges.add(name);
      if (down) {
        this.prev.add(name);
        this.held++;
      } else this.prev.delete(name);
    }

    // The left stick doubles as a dpad in menus: step on the push, repeat
    // while held, disarm on the way back — no strobing between rows
    const dir: PadButton | null = lm < (this.navDir ? NAV_HOLD : NAV_PUSH)
      ? null
      : Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'right' : 'left') : (ly > 0 ? 'down' : 'up');
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navT = 0;
      if (dir) this.navQueue.push(dir);
    } else if (dir) {
      this.navT += dt;
      if (this.navT >= NAV_REPEAT) {
        this.navT = 0;
        this.navQueue.push(dir);
      }
    }
  }

  pressed(b: PadButton): boolean {
    return this.edges.has(b);
  }

  // Menu steps this frame — dpad edges plus left-stick pushes, as key codes
  navCodes(): string[] {
    const codes: string[] = [];
    for (const d of ['up', 'down', 'left', 'right'] as const) {
      if (this.edges.has(d)) codes.push(ARROW[d]);
    }
    for (const d of this.navQueue) codes.push(ARROW[d]);
    return codes;
  }

  // A short kick of the motors, on pads that have them
  rumble(intensity: number, ms: number) {
    const actuator = (this.ref as unknown as {
      vibrationActuator?: { playEffect?: (kind: string, opts: object) => Promise<unknown> };
    } | null)?.vibrationActuator;
    actuator?.playEffect?.('dual-rumble', {
      duration: ms,
      strongMagnitude: Math.min(1, intensity),
      weakMagnitude: Math.min(1, intensity * 0.6),
    })?.catch(() => { /* older pads just sit still */ });
  }
}

export class Gamepads {
  state: PadState | null = null; // the driving pad's freshest poll; null = no pad
  connected = false;
  onConnect: () => void = () => {};
  onDisconnect: () => void = () => {};
  devices: Pad[] = []; // every live pad, hardware-slot order
  // A screen that reads the whole bench itself (the couch lobby) claims it:
  // the shared one-pad calls go quiet so the shell can't answer a button the
  // lobby has already answered.
  exclusive = false;
  private driving: Pad | null | undefined = undefined; // undefined = whoever is first

  poll(dt: number) {
    const live = (typeof navigator === 'undefined' ? [] : navigator.getGamepads?.()) ?? [];
    const bench: Pad[] = [];
    for (const g of live) {
      if (!g?.connected) continue;
      const pad = this.devices.find((p) => p.index === g.index) ?? new Pad(g.index, g.id);
      pad.read(g, dt);
      bench.push(pad);
    }
    this.devices = bench;
    this.state = this.voice?.state ?? null;
    const any = bench.length > 0;
    if (any === this.connected) return;
    this.connected = any;
    (any ? this.onConnect : this.onDisconnect)();
  }

  device(index: number): Pad | null {
    return this.devices.find((p) => p.index === index) ?? null;
  }

  // Nobody named a pad: the shell means the first one plugged in
  private get voice(): Pad | null {
    return this.driving === undefined ? this.devices[0] ?? null : this.driving;
  }

  pressed(b: PadButton): boolean {
    return !this.exclusive && !!this.voice?.pressed(b);
  }

  navCodes(): string[] {
    return this.exclusive ? [] : this.voice?.navCodes() ?? [];
  }

  rumble(intensity: number, ms: number) {
    this.voice?.rumble(intensity, ms);
  }

  // For the length of one call, every reader downstream is holding THIS pad —
  // how a couch seat samples its own hands through the shared controls. A
  // null slot deafens the pads entirely, so keyboard seats stay keyboard-only.
  drive<T>(index: number | null, fn: () => T): T {
    const wasPad = this.driving;
    const wasState = this.state;
    this.driving = index === null ? null : this.device(index);
    this.state = this.driving?.state ?? null;
    try {
      return fn();
    } finally {
      this.driving = wasPad;
      this.state = wasState;
    }
  }
}

export const pads = new Gamepads();
