export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });
export const len = (v: Vec2) => Math.hypot(v.x, v.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

export function norm(v: Vec2): Vec2 {
  const l = len(v);
  return l < 1e-6 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

export function clampLen(v: Vec2, max: number): Vec2 {
  const l = len(v);
  return l > max ? scale(v, max / l) : v;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Frame-rate independent smoothing: moves current toward target at `rate` per second
export function expDecay(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function expDecayVec(current: Vec2, target: Vec2, rate: number, dt: number): Vec2 {
  const k = Math.exp(-rate * dt);
  return { x: target.x + (current.x - target.x) * k, y: target.y + (current.y - target.y) * k };
}

// Unsigned angle between two directions in radians
export function angleBetween(a: Vec2, b: Vec2): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-6 || lb < 1e-6) return 0;
  return Math.acos(clamp((a.x * b.x + a.y * b.y) / (la * lb), -1, 1));
}

export function rotate(v: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
