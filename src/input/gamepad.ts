const DEAD_ZONE = 0.18;

export interface PadState {
  moveX: number;
  moveY: number;
  bend: number; // right-stick x: sweeps the aim while a kick charges
  sprint: boolean;
  kick: boolean;
}

// First connected pad; couch multi-pad mapping arrives with multiplayer in M4
export function pollPad(): PadState | null {
  const pad = navigator.getGamepads?.()[0];
  if (!pad) return null;
  const dz = (v: number) => (Math.abs(v) < DEAD_ZONE ? 0 : v);
  return {
    moveX: dz(pad.axes[0] ?? 0),
    moveY: dz(pad.axes[1] ?? 0),
    bend: dz(pad.axes[2] ?? 0),
    sprint: pad.buttons[5]?.pressed || pad.buttons[7]?.pressed || false, // RB or RT
    kick: pad.buttons[0]?.pressed || false, // A / Cross
  };
}
