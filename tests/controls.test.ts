import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalControls } from '../src/input/controls';
import { pads, PadState } from '../src/input/gamepad';
import { vec } from '../src/core/math';
import { Keyboard } from '../src/input/keyboard';
import { HUMAN_KICK_FLOOR } from '../src/sim/tuning';

// The twin-stick sling, headless: pads.state is a plain object the poller
// would have written — these tests write it by hand and read the intent out.

const SQUASH = 0.788;
const kb = { has: () => false } as unknown as Keyboard;
const facing = vec(1, 0);

const idlePad = (): PadState => ({
  move: vec(),
  aim: { x: 0, y: 0, mag: 0 },
  kickDepth: 0,
  tackle: false,
  sprint: false,
});

let controls: LocalControls;
beforeEach(() => {
  controls = new LocalControls(SQUASH);
  pads.state = idlePad();
});
afterEach(() => {
  pads.state = null;
});

const step = (n = 1) => {
  let out = null;
  for (let i = 0; i < n; i++) out = controls.sample(1 / 60, kb, facing);
  return out!;
};

describe('the right-stick sling', () => {
  it('a full throw releases a full-power pass where the stick pointed', () => {
    pads.state!.aim = { x: 1, y: 0, mag: 1 };
    step(6);
    expect(controls.flickAim).not.toBeNull();
    expect(controls.flickAim!.power).toBeCloseTo(1, 5);
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    step();
    const fired = controls.takeFlick();
    expect(fired).not.toBeNull();
    expect(fired!.power).toBeCloseTo(1, 5);
    expect(fired!.dir.x).toBeCloseTo(1, 5);
    expect(fired!.dir.y).toBeCloseTo(0, 5);
    expect(controls.takeFlick()).toBeNull(); // consumed exactly once
  });

  it('screen angles become field angles: the iso squash steepens the aim', () => {
    const d = Math.SQRT1_2;
    pads.state!.aim = { x: d, y: d, mag: 1 };
    step(4);
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    step();
    const fired = controls.takeFlick()!;
    // what looks 45° on the glass runs steeper on the grass
    expect(fired.dir.y / fired.dir.x).toBeCloseTo(1 / SQUASH, 3);
  });

  it('a soft nudge still plays a real ball — the floor is a medium pass', () => {
    pads.state!.aim = { x: 0.4, y: 0, mag: 0.4 };
    step(4);
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    step();
    const fired = controls.takeFlick()!;
    expect(fired.power).toBeGreaterThanOrEqual(0.45);
    expect(fired.power).toBeLessThan(0.6);
  });

  it('power remembers the deepest throw, not the letting-go', () => {
    pads.state!.aim = { x: 1, y: 0, mag: 1 };
    step(4);
    pads.state!.aim = { x: 0.3, y: 0, mag: 0.3 }; // springing back through low mags
    step();
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    step();
    expect(controls.takeFlick()!.power).toBeCloseTo(1, 5);
  });

  it('the spring-back never steers the ball', () => {
    pads.state!.aim = { x: 1, y: 0, mag: 1 };
    step(4);
    // the stick recoils through a skewed low-mag direction on its way home
    pads.state!.aim = { x: 0.2, y: -0.35, mag: 0.4 };
    step();
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    step();
    const fired = controls.takeFlick()!;
    expect(fired.dir.x).toBeCloseTo(1, 3);
    expect(Math.abs(fired.dir.y)).toBeLessThan(0.05);
  });

  it('a pulled trigger turns the stick into a pointer, not a trigger', () => {
    pads.state!.kickDepth = 0.7;
    pads.state!.aim = { x: 0, y: -1, mag: 1 };
    const charging = step(10);
    expect(charging.kickCharging).toBe(true);
    expect(controls.flickAim).toBeNull();          // no sling while charging
    expect(controls.aimDir!.y).toBeLessThan(-0.9); // the arrow points up the glass
    pads.state!.kickDepth = 0;
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    const released = step();
    expect(released.kickReleased).not.toBeNull();  // the charged ball plays
    expect(controls.takeFlick()).toBeNull();       // and no phantom flick rides it
  });

  it('sub-dead-zone wiggle never fires anything', () => {
    pads.state!.aim = { x: 0.1, y: 0.1, mag: 0.15 };
    step(10);
    pads.state!.aim = { x: 0, y: 0, mag: 0 };
    step();
    expect(controls.takeFlick()).toBeNull();
    expect(controls.flickAim).toBeNull();
  });

  it('with no pad at all the keyboard path is untouched', () => {
    pads.state = null;
    const out = step(3);
    expect(out.move.x).toBe(0);
    expect(out.kickCharging).toBe(false);
    expect(controls.takeFlick()).toBeNull();
  });

  it('pad movement and buttons flow into the intent: hold clamps, a tap lunges on release', () => {
    pads.state!.move = vec(0.6, -0.3);
    pads.state!.sprint = true;
    pads.state!.tackle = true;
    const out = step();
    expect(out.move.x).toBeCloseTo(0.6, 5);
    expect(out.move.y).toBeCloseTo(-0.3, 5);
    expect(out.sprint).toBe(true);
    expect(out.clamp).toBe(true);   // held = the squeeze
    expect(out.tackle).toBe(false); // the lunge waits for the release
    pads.state!.tackle = false;
    const released = step();
    expect(released.tackle).toBe(true);  // a quick tap fires the poke
    expect(released.clamp).toBe(false);
  });
});

describe('the right trigger is the boot: depth is power', () => {
  const FLOOR = HUMAN_KICK_FLOOR; // even a tap is a real ball

  it('the chalk lives in your finger: charge tracks the pull, both ways', () => {
    pads.state!.kickDepth = 0.6;
    const out = step(4);
    expect(out.kickCharging).toBe(true);
    expect(controls.charge).toBeCloseTo(0.6, 5);
    pads.state!.kickDepth = 0.3; // easing off shrinks the sight — no ratchet
    step(8);
    expect(controls.charge).toBeCloseTo(0.3, 5);
  });

  it('release fires at the held depth, floored like the bar', () => {
    pads.state!.kickDepth = 0.6;
    step(8);
    pads.state!.kickDepth = 0;
    const out = step();
    expect(out.kickReleased).not.toBeNull();
    expect(out.kickReleased!.power).toBeCloseTo(FLOOR + 0.6 * (1 - FLOOR), 2);
  });

  it('the spring-back never robs the strike — the trail remembers the pull', () => {
    pads.state!.kickDepth = 0.9;
    step(8);
    pads.state!.kickDepth = 0.2; // one frame of the trigger racing home
    step();
    pads.state!.kickDepth = 0;
    const out = step();
    expect(out.kickReleased!.power).toBeCloseTo(FLOOR + 0.9 * (1 - FLOOR), 2);
  });

  it('pinning the trigger full past the grace FIZZLES the strike', () => {
    pads.state!.kickDepth = 1;
    step(25); // ~0.42s pinned — past the 0.35s grace
    expect(controls.charge).toBe(0); // dead in your hands
    pads.state!.kickDepth = 0;
    const out = step();
    expect(out.kickReleased).toBeNull();
  });

  it('easing off the pin resets the clock — backing out saves the ball', () => {
    pads.state!.kickDepth = 1;
    step(15); // 0.25s on the pin, still inside the grace
    pads.state!.kickDepth = 0.6;
    step(20); // well past what WOULD have fizzled, but off the pin
    pads.state!.kickDepth = 0;
    const out = step();
    expect(out.kickReleased).not.toBeNull();
    expect(out.kickReleased!.power).toBeCloseTo(FLOOR + 0.6 * (1 - FLOOR), 2);
  });
});

describe('SPACE is the boot, K is the defending hand', () => {
  const kbWith = (codes: string[]) => ({ has: (c: string) => codes.includes(c) }) as unknown as Keyboard;

  it('U and O bend the locked aim; the old J/L keys no longer steer it', () => {
    for (let i = 0; i < 12; i++) controls.sample(1 / 60, kbWith(['Space', 'KeyO']), facing);
    expect(controls.aimDir!.y).toBeGreaterThan(0.15); // O sweeps the arrow one way
    controls.sample(1 / 60, kbWith([]), facing);
    for (let i = 0; i < 12; i++) controls.sample(1 / 60, kbWith(['Space', 'KeyU']), facing);
    expect(controls.aimDir!.y).toBeLessThan(-0.15);   // U the other
    controls.sample(1 / 60, kbWith([]), facing);
    for (let i = 0; i < 12; i++) controls.sample(1 / 60, kbWith(['Space', 'KeyJ', 'KeyL']), facing);
    expect(Math.abs(controls.aimDir!.y)).toBeLessThan(0.01); // J/L retired to the kit
  });

  it('holding space charges, releasing fires at the held weight', () => {
    let out = controls.sample(1 / 60, kbWith(['Space']), facing);
    for (let i = 0; i < 30; i++) out = controls.sample(1 / 60, kbWith(['Space']), facing);
    expect(out.kickCharging).toBe(true);
    expect(out.clamp).toBe(false);
    expect(controls.charge).toBeGreaterThan(0.3);
    out = controls.sample(1 / 60, kbWith([]), facing);
    expect(out.kickReleased).not.toBeNull();
    expect(out.kickReleased!.power).toBeGreaterThan(0.5);
  });

  it('a full bar held too long FIZZLES — the release fires nothing', () => {
    // charge to the pin (0.85s), then sit on it past the grace (0.35s)
    for (let i = 0; i < 55; i++) controls.sample(1 / 60, kbWith(['Space']), facing);
    expect(controls.charge).toBeGreaterThan(0.9); // pinned and still live
    for (let i = 0; i < 30; i++) controls.sample(1 / 60, kbWith(['Space']), facing);
    expect(controls.charge).toBe(0); // spent — the sight is dead in your hands
    const out = controls.sample(1 / 60, kbWith([]), facing);
    expect(out.kickReleased).toBeNull();
  });

  it('K holds the clamp and a quick K tap fires the lunge', () => {
    let out = controls.sample(1 / 60, kbWith(['KeyK']), facing);
    for (let i = 0; i < 30; i++) out = controls.sample(1 / 60, kbWith(['KeyK']), facing);
    expect(out.clamp).toBe(true);
    expect(out.kickCharging).toBe(false);
    out = controls.sample(1 / 60, kbWith([]), facing);
    expect(out.tackle).toBe(false); // a long hold releases into nothing — the clamp was the act
    controls.sample(1 / 60, kbWith(['KeyK']), facing);
    out = controls.sample(1 / 60, kbWith([]), facing);
    expect(out.tackle).toBe(true); // the tap is the lunge
  });
});
