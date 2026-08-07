import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalControls } from '../src/input/controls';
import { pads, PadState } from '../src/input/gamepad';
import { vec } from '../src/core/math';
import { Keyboard } from '../src/input/keyboard';

// The twin-stick sling, headless: pads.state is a plain object the poller
// would have written — these tests write it by hand and read the intent out.

const SQUASH = 0.788;
const kb = { has: () => false } as unknown as Keyboard;
const facing = vec(1, 0);

const idlePad = (): PadState => ({
  move: vec(),
  aim: { x: 0, y: 0, mag: 0 },
  kick: false,
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

  it('holding the kick button turns the stick into a pointer, not a trigger', () => {
    pads.state!.kick = true;
    pads.state!.aim = { x: 0, y: -1, mag: 1 };
    const charging = step(10);
    expect(charging.kickCharging).toBe(true);
    expect(controls.flickAim).toBeNull();          // no sling while charging
    expect(controls.aimDir!.y).toBeLessThan(-0.9); // the arrow points up the glass
    pads.state!.kick = false;
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
