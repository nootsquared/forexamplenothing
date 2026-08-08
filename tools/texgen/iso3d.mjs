import { PixelGrid, hexToRgb } from './lib.mjs';
import { ISO } from './palettes.mjs';

// Miniature raytracer that bakes real 3D forms into pixel art. Scenes are
// spheres and capsules in meters; the orthographic camera sits at the game's
// iso elevation, light is banded into four hard steps, and edges resolve by
// sub-ray coverage — so every direction of a character is the same solid body
// seen from a real angle, never a redrawn flat sprite.

const LIGHT = normIn([-0.45, -0.3, 0.84]); // screen top-left sun, matches the pitch bake
const BANDS = [
  { min: 0.55, mul: 1.24 },
  { min: 0.08, mul: 1.0 },
  { min: -0.38, mul: 0.74 },
  { min: -Infinity, mul: 0.52 },
];

export const sphere = (c, r, color) => ({ kind: 's', c, r, color });
export const capsule = (a, b, r, color) => ({ kind: 'c', a, b, r, color });

export function rotZ([x, y, z], ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [x * c - y * s, x * s + y * c, z];
}

// Tips a body forward onto its face: -π/2 lays a standing rig flat along +y
export function rotX([x, y, z], ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [x, y * c - z * s, y * s + z * c];
}

// Rotate a whole primitive list around the z axis through (0,0)
export function rotScene(prims, ang) {
  return prims.map((p) =>
    p.kind === 's'
      ? { ...p, c: rotZ(p.c, ang) }
      : { ...p, a: rotZ(p.a, ang), b: rotZ(p.b, ang) },
  );
}

// Render prims into a PixelGrid. Feet at world origin land on (originX, baselineY).
export function renderScene(prims, { w, h, S, originX, baselineY }) {
  const grid = new PixelGrid(w, h);
  const sq = ISO.squash;
  const zl = ISO.zLift;
  const rayDir = [0, -zl, -sq]; // unit: zl² + sq² = 1
  const SUB = [0.25, 0.75];

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let hits = 0;
      let best = null;
      for (const oy of SUB) {
        for (const ox of SUB) {
          const X = (px + ox - originX) / S;
          const Ym = (py + oy - baselineY) / S;
          const origin = [X, Ym * sq + 6 * zl, -Ym * zl + 6 * sq];
          const hit = trace(prims, origin, rayDir);
          if (!hit) continue;
          hits++;
          if (!best || hit.t < best.t) best = hit;
        }
      }
      if (hits < 2 || !best) continue; // half-covered pixels drop — crisp silhouette
      grid.set(px, py, shadePixel(best));
    }
  }
  return grid;
}

function trace(prims, o, d) {
  let t = Infinity;
  let n = null;
  let color = null;
  for (const p of prims) {
    if (p.kind === 's') {
      const ht = raySphere(o, d, p.c, p.r);
      if (ht !== null && ht < t) {
        t = ht;
        const hp = at(o, d, ht);
        n = normIn([hp[0] - p.c[0], hp[1] - p.c[1], hp[2] - p.c[2]]);
        color = p.color;
      }
    } else {
      const res = rayCapsule(o, d, p.a, p.b, p.r);
      if (res && res.t < t) {
        t = res.t;
        n = res.n;
        color = p.color;
      }
    }
  }
  return n ? { t, n, color } : null;
}

// Four hard light bands on the surface normal — pixel-art cel shading
function shadePixel({ n, color }) {
  const lit = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
  const mul = BANDS.find((b) => lit > b.min).mul;
  const [r, g, b] = hexToRgb(color);
  return rgbHex(r * mul, g * mul, b * mul);
}

const at = (o, d, t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];

function raySphere(o, d, c, r) {
  const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
  const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
  const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}

function rayCapsule(o, d, a, b, r) {
  const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
  if (len2 < 1e-9) {
    const t = raySphere(o, d, a, r);
    if (t === null) return null;
    const hp = at(o, d, t);
    return { t, n: normIn([hp[0] - a[0], hp[1] - a[1], hp[2] - a[2]]) };
  }
  const oa = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const bd = ba[0] * d[0] + ba[1] * d[1] + ba[2] * d[2];
  const bo = ba[0] * oa[0] + ba[1] * oa[1] + ba[2] * oa[2];
  // Quadratic for the infinite cylinder around the segment's line
  const A = len2 - bd * bd;
  const B = len2 * (oa[0] * d[0] + oa[1] * d[1] + oa[2] * d[2]) - bo * bd;
  const C = len2 * (oa[0] * oa[0] + oa[1] * oa[1] + oa[2] * oa[2] - r * r) - bo * bo;
  if (Math.abs(A) > 1e-9) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t > 0) {
        const axial = bo + t * bd;
        if (axial >= 0 && axial <= len2) {
          const hp = at(o, d, t);
          const s = axial / len2;
          const axis = [a[0] + ba[0] * s, a[1] + ba[1] * s, a[2] + ba[2] * s];
          return { t, n: normIn([hp[0] - axis[0], hp[1] - axis[1], hp[2] - axis[2]]) };
        }
      }
    }
  }
  // End caps
  let bestT = null;
  let cap = null;
  for (const end of [a, b]) {
    const t = raySphere(o, d, end, r);
    if (t !== null && (bestT === null || t < bestT)) {
      bestT = t;
      cap = end;
    }
  }
  if (bestT === null) return null;
  const hp = at(o, d, bestT);
  return { t: bestT, n: normIn([hp[0] - cap[0], hp[1] - cap[1], hp[2] - cap[2]]) };
}

function normIn(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function rgbHex(r, g, b) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + q(r) + q(g) + q(b);
}
