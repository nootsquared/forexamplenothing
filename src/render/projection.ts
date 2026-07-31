// Broadcast oblique projection: top-down meters in, angled screen art-pixels out.
// The y-axis is squashed (camera tilt) and ball height lifts things up the screen.
export const SQUASH = 0.62;
export const Z_LIFT = 0.9;

let M = 16; // art px per meter, set from the asset manifest

export function setPxPerMeter(px: number) {
  M = px;
}

export function pxPerMeter() {
  return M;
}

export interface Projected {
  sx: number;
  sy: number;
  depth: number;
  scale: number; // subtle near/far size gradient sells the camera angle
}

export function project(x: number, y: number, z = 0): Projected {
  return {
    sx: x * M,
    sy: y * M * SQUASH - z * M * Z_LIFT,
    depth: y * 10 + x * 0.001,
    scale: 0.93 + (y / 68) * 0.14,
  };
}
