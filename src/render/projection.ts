// Broadcast perspective projection: top-down meters in, a receding ground
// plane out. Horizontal scale narrows toward the far touchline and row
// spacing compresses with distance — the same formula the pitch texture is
// baked with, so sprites and turf share one 2.5D world. Ball height lifts
// things up the screen.
export const SQUASH = 0.63; // average tilt, for screen-space aspect uses only
export const Z_LIFT = 0.9;

const PITCH_W = 68;
const PITCH_CX = 52.5;

let M = 16; // art px per meter, set from the asset manifest

export interface Perspective {
  xsFar: number;
  xsSpan: number;
  sqFar: number;
  sqSpan: number;
}

let P: Perspective = { xsFar: 0.84, xsSpan: 0.22, sqFar: 0.52, sqSpan: 0.22 };

export function setProjection(pxPerMeter: number, persp: Perspective) {
  M = pxPerMeter;
  P = persp;
}

export function pxPerMeter() {
  return M;
}

// Narrowest horizontal scale (the far touchline) — cameras clamp with this so
// the frame never slides past the texture on the skinny end of the trapezoid
export function minXScale() {
  return P.xsFar;
}

export interface Projected {
  sx: number;
  sy: number;
  depth: number;
  scale: number; // near players loom, far players shrink — sells the camera
}

export function project(x: number, y: number, z = 0): Projected {
  const xs = P.xsFar + P.xsSpan * (y / PITCH_W);
  return {
    sx: (x - PITCH_CX) * M * xs + PITCH_CX * M,
    sy: M * (P.sqFar * y + (P.sqSpan / (2 * PITCH_W)) * y * y) - z * M * Z_LIFT,
    depth: y * 10 + x * 0.001,
    scale: 0.86 + 0.28 * (y / PITCH_W),
  };
}
