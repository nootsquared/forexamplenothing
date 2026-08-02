import { Vec2, vec, norm, scale } from '../core/math';

// Twin-stick pads, any slot, hot-plugged. The left stick moves (analog, with
// a radial dead zone), the right stick IS the pass: push it and you're
// winding, angle aims, throw depth is power, and the spring-back fires the
// ball. A charges the big kick, B tackles, RT/RB sprint, LB or X switches,
// Y toggles auto-switch, Start pauses, and the dpad walks every menu.

const DEAD_ZONE = 0.18;
const NAV_PUSH = 0.55;   // left-stick throw that counts as a menu step
const NAV_HOLD = 0.42;   // ...and where the step disarms again
const NAV_REPEAT = 0.32; // held-stick repeat cadence

const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, rt: 7, start: 9, up: 12, down: 13, left: 14, right: 15 } as const;
export type PadButton = keyof typeof BTN;
const ARROW: Record<string, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

export interface PadState {
  move: Vec2;                                  // left stick, dead-zone rescaled
  aim: { x: number; y: number; mag: number };  // right stick, raw beyond the dead zone
  kick: boolean;
  tackle: boolean;
  sprint: boolean;
}

export class Gamepads {
  state: PadState | null = null; // freshest poll; null = no pad
  connected = false;
  onConnect: () => void = () => {};
  onDisconnect: () => void = () => {};
  private padRef: Gamepad | null = null;
  private edges = new Set<PadButton>();
  private prev = new Set<PadButton>();
  private navDir: PadButton | null = null;
  private navT = 0;
  private navQueue: PadButton[] = [];

  // One read per frame; everything downstream shares this poll
  poll(dt: number) {
    this.edges.clear();
    this.navQueue.length = 0;
    let pad: Gamepad | null = null;
    for (const p of navigator.getGamepads?.() ?? []) {
      if (p?.connected) { pad = p; break; }
    }
    this.padRef = pad;
    if (!pad) {
      if (this.connected) {
        this.connected = false;
        this.state = null;
        this.prev.clear();
        this.navDir = null;
        this.onDisconnect();
      }
      return;
    }
    if (!this.connected) {
      this.connected = true;
      this.onConnect();
    }

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

    for (const name of Object.keys(BTN) as PadButton[]) {
      const down = !!pad.buttons[BTN[name]]?.pressed;
      if (down && !this.prev.has(name)) this.edges.add(name);
      if (down) this.prev.add(name);
      else this.prev.delete(name);
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
    const actuator = (this.padRef as unknown as {
      vibrationActuator?: { playEffect?: (kind: string, opts: object) => Promise<unknown> };
    } | null)?.vibrationActuator;
    actuator?.playEffect?.('dual-rumble', {
      duration: ms,
      strongMagnitude: Math.min(1, intensity),
      weakMagnitude: Math.min(1, intensity * 0.6),
    })?.catch(() => { /* older pads just sit still */ });
  }
}

export const pads = new Gamepads();
