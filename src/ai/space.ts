import { Vec2, add, clamp, dist, scale, sub, vec } from '../core/math';
import { PITCH } from '../sim/constants';

// Three questions about a patch of grass — how much room is there, is the
// line to it clean, how hard am I being squeezed. Pure over whatever bodies
// the asker believes in, so a keeper watching the play and a winger running
// on stale beliefs share the math without sharing a worldview.

// Meters to the nearest body, capped — past the cap, more space pays nothing
export function spaceAt(point: Vec2, others: Vec2[], cap = 10): number {
  let nearest = cap;
  for (const o of others) nearest = Math.min(nearest, dist(o, point));
  return nearest;
}

// 1 when nobody sits on the segment a→b, →0 as a body closes it. `sparedNearB`
// forgives blockers hugging the destination — a keeper on his line is never a
// reason not to shoot.
export function laneOpen(a: Vec2, b: Vec2, blockers: Vec2[], sparedNearB = 0): number {
  const ab = sub(b, a);
  const abLen2 = ab.x * ab.x + ab.y * ab.y;
  if (abLen2 < 1e-8) return 1;
  let worst = 1;
  for (const o of blockers) {
    if (sparedNearB > 0 && dist(o, b) < sparedNearB) continue;
    const t = clamp(((o.x - a.x) * ab.x + (o.y - a.y) * ab.y) / abLen2, 0.05, 0.95);
    const perp = dist(o, add(a, scale(ab, t)));
    if (perp < 2.2) worst = Math.min(worst, perp / 2.2);
  }
  return worst;
}

// No brain ever steers at the stands: every target lands inside the paint
export function clampPitch(p: Vec2): Vec2 {
  return vec(clamp(p.x, 1.5, PITCH.length - 1.5), clamp(p.y, 1.5, PITCH.width - 1.5));
}

// 0 in acres of space, →1 with a body breathing on you
export function pressureAt(point: Vec2, others: Vec2[], reach = 4.5): number {
  let worst = 0;
  for (const o of others) {
    const d = dist(o, point);
    if (d < reach) worst = Math.max(worst, 1 - d / reach);
  }
  return worst;
}
