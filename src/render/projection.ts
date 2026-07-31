// High-angle iso projection: top-down meters in, screen px out. Parallel
// projection — ground rows compress by one shared squash, height lifts by one
// shared factor, nothing scales with distance. The pitch texture, the sprite
// raytracer and this file all read the same two numbers from the manifest.

let M = 16;          // art px per meter
let sq = 0.788;      // ground row squash (sin of camera elevation)
let zl = 0.616;      // height lift (cos of camera elevation)

export interface IsoParams {
  squash: number;
  zLift: number;
}

export function setProjection(pxPerMeter: number, iso: IsoParams) {
  M = pxPerMeter;
  sq = iso.squash;
  zl = iso.zLift;
}

export function pxPerMeter() {
  return M;
}

export function squash() {
  return sq;
}

export interface Projected {
  sx: number;
  sy: number;
  depth: number;
}

export function project(x: number, y: number, z = 0): Projected {
  return {
    sx: x * M,
    sy: (y * sq - z * zl) * M,
    depth: y * 10 + x * 0.001,
  };
}
