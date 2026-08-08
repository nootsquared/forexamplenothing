import { Vec2, vec, norm, scale, clamp } from '../core/math';

// Twin-stick pads, EVERY slot, hot-plugged. The left stick moves (analog, with
// a radial dead zone and a walk-then-sprint curve), the right stick IS the
// pass: push it and you're winding, angle aims, throw depth is power, and the
// spring-back fires the ball. A charges the big kick, B tackles, RT/RB sprint,
// LB or X switches, Y toggles auto-switch, Start pauses, Select calls up the
// controls card, and the dpad walks every menu.
// Each pad is read on its own so a couch full of them can play at once; the
// shell's unnamed calls speak for the WHOLE bench, so the man holding pad two
// can pause, back out and walk a menu exactly like the man holding pad one.

const MOVE_DEAD = 0.16;   // a thumb resting on the stick is not a instruction
const AIM_DEAD = 0.22;    // the sling arms higher — a lazy thumb never passes
// Top of the range, well short of the physical gate: a stick worn down by a
// thousand matches still reaches full sprint and full-blooded passes
const SATURATE = 0.86;
const TRIGGER = 0.3;      // analog pull that counts as a held trigger
const NAV_PUSH = 0.55;    // left-stick throw that counts as a menu step
const NAV_HOLD = 0.4;     // ...and where the step disarms again
const NAV_DELAY = 0.36;   // the first repeat waits, so one push is one row...
const NAV_REPEAT = 0.105; // ...and a held direction then scrolls at speed

const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15 } as const;
export type PadButton = keyof typeof BTN;
const BUTTONS = Object.keys(BTN) as PadButton[];
const ARROW: Record<string, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const DPAD = ['up', 'down', 'left', 'right'] as const;
type NavDir = (typeof DPAD)[number];

// The first half of the throw is a walk, the last half is everything you have
// — the band where you can jockey a man without wrestling the stick
const throwCurve = (t: number) => t * (0.55 + 0.45 * t);
// Triggers arrive as analog values on some drivers and plain booleans on
// others; either way a real pull is a real pull
const held = (b: GamepadButton | undefined) => !!b && (b.pressed || b.value > TRIGGER);

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
  down = 0; // buttons down RIGHT NOW — how the lobby feels you leaning on it
  private ref: Gamepad | null = null;
  private edges = new Set<PadButton>();
  private prev = new Set<PadButton>();
  private navDir: NavDir | null = null;
  private navT = 0;
  private navQueue: NavDir[] = [];

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
      move: lm < MOVE_DEAD ? vec() : scale(norm(vec(lx, ly)), throwCurve(clamp((lm - MOVE_DEAD) / (SATURATE - MOVE_DEAD), 0, 1))),
      aim: am < AIM_DEAD ? { x: 0, y: 0, mag: 0 } : { x: ax, y: ay, mag: clamp((am - AIM_DEAD) / (SATURATE - AIM_DEAD), 0, 1) },
      kick: held(pad.buttons[BTN.a]),
      tackle: held(pad.buttons[BTN.b]),
      sprint: held(pad.buttons[BTN.rb]) || held(pad.buttons[BTN.rt]),
    };

    this.down = 0;
    for (const name of BUTTONS) {
      const on = held(pad.buttons[BTN[name]]);
      if (on && !this.prev.has(name)) this.edges.add(name);
      if (on) {
        this.prev.add(name);
        this.down++;
      } else this.prev.delete(name);
    }

    // Menus answer the dpad AND the left stick from one machine: step on the
    // push, wait a beat, then scroll — no strobing, no dead second press
    const stick: NavDir | null = lm < (this.navDir ? NAV_HOLD : NAV_PUSH)
      ? null
      : Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'right' : 'left') : (ly > 0 ? 'down' : 'up');
    const dir = DPAD.find((d) => this.prev.has(d)) ?? stick;
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navT = -NAV_DELAY;
      if (dir) this.navQueue.push(dir);
    } else if (dir) {
      this.navT += dt;
      if (this.navT >= 0) {
        this.navT -= NAV_REPEAT;
        this.navQueue.push(dir);
      }
    }
  }

  pressed(b: PadButton): boolean {
    return this.edges.has(b);
  }

  // Menu steps this frame, as key codes — one push, or a held scroll
  navCodes(): string[] {
    return this.navQueue.map((d) => ARROW[d]);
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
  private holdT = 0;
  private driving: Pad | null | undefined = undefined; // undefined = the whole bench

  poll(dt: number) {
    this.holdT = Math.max(0, this.holdT - dt);
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

  // A screen that reads the whole bench itself (the couch lobby) claims it
  // EVERY frame it is alive: the shell's shared calls go quiet so it can't
  // answer a button the lobby already answered. The claim expires on its own
  // the moment that screen stops running, so nothing can leave the shell deaf.
  hold() {
    this.holdT = 0.25;
  }

  get exclusive(): boolean {
    return this.holdT > 0;
  }

  // Nobody named a pad: the shell means the first one plugged in
  private get voice(): Pad | null {
    return this.driving === undefined ? this.devices[0] ?? null : this.driving;
  }

  // Unnamed, this is the whole room — whoever grabs a pad can press the button
  pressed(b: PadButton): boolean {
    if (this.driving !== undefined) return !!this.driving?.pressed(b);
    return !this.exclusive && this.devices.some((p) => p.pressed(b));
  }

  navCodes(): string[] {
    if (this.driving !== undefined) return this.driving?.navCodes() ?? [];
    if (this.exclusive) return [];
    // two people pushing the same way is still one step down the list
    return [...new Set(this.devices.flatMap((p) => p.navCodes()))];
  }

  rumble(intensity: number, ms: number) {
    if (this.driving !== undefined) return this.driving?.rumble(intensity, ms);
    for (const pad of this.devices) pad.rumble(intensity, ms);
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
