import { makeCanvas, PixelGrid } from './lib.mjs';
import { ISO } from './palettes.mjs';

export const BALL_SIZE = 12;
export const BALL_DIRS = 16;    // roll-axis bins, one per heading
export const BALL_PHASES = 12;  // pattern rotation steps per revolution
export const BALL_VISUAL_R = 5.2 / 16; // meters the drawn ball spans — drives roll speed

// A true 2.5D ball: the visible hemisphere's real normals, a pentagon pattern
// rotated around the physical roll axis for the ball's heading, and a fixed
// top-left sun — pattern spins with travel, lighting never moves. Rows are
// headings, columns are roll phases.
export function generateBallSheet() {
  const { canvas, ctx } = makeCanvas(BALL_SIZE * BALL_PHASES, BALL_SIZE * BALL_DIRS);
  const R = 5.2;
  const c = BALL_SIZE / 2 - 0.5;
  const sq = ISO.squash;
  const zl = ISO.zLift;
  // Camera basis at the iso elevation: screen right / screen down / toward viewer
  const camDown = [0, sq, -zl];
  const camOut = [0, zl, sq];
  const light = norm3([-0.45, -0.3, 0.84]);
  const half = norm3([light[0], light[1] + camOut[1], light[2] + camOut[2]]);
  const patches = icosahedronDirs();

  for (let dir = 0; dir < BALL_DIRS; dir++) {
    const heading = (dir * Math.PI * 2) / BALL_DIRS;
    const axis = [-Math.sin(heading), Math.cos(heading), 0]; // ω for rolling toward heading
    for (let ph = 0; ph < BALL_PHASES; ph++) {
      const grid = new PixelGrid(BALL_SIZE, BALL_SIZE);
      const angle = (ph * Math.PI * 2) / BALL_PHASES;
      for (let y = 0; y < BALL_SIZE; y++) {
        for (let x = 0; x < BALL_SIZE; x++) {
          const dx = (x - c) / R;
          const dy = (y - c) / R;
          const d2 = dx * dx + dy * dy;
          if (d2 > 1) continue;
          const nz = Math.sqrt(1 - d2);
          const n = [
            dx + camDown[0] * dy + camOut[0] * nz,
            camDown[1] * dy + camOut[1] * nz,
            camDown[2] * dy + camOut[2] * nz,
          ];
          // Undo the ball's spin to sample the pattern painted on it
          const np = rodrigues(n, axis, -angle);
          let best = -1;
          for (const p of patches) best = Math.max(best, np[0] * p[0] + np[1] * p[1] + np[2] * p[2]);
          const isPatch = best > 0.924;
          const base = isPatch ? [42, 42, 50] : [242, 240, 230];

          const lit = n[0] * light[0] + n[1] * light[1] + n[2] * light[2];
          let mul = lit > 0.52 ? 1.16 : lit > 0.05 ? 1.0 : lit > -0.42 ? 0.78 : 0.58;
          if (n[2] < -0.25) mul *= 0.82; // ground-facing skirt darkens into the turf
          const spec = n[0] * half[0] + n[1] * half[1] + n[2] * half[2];
          if (spec > 0.985 && !isPatch) mul = 1.45;
          grid.set(x, y, rgb(base[0] * mul, base[1] * mul, base[2] * mul));
        }
      }
      grid.autoOutline('#141420');
      grid.blitTo(ctx, ph * BALL_SIZE, dir * BALL_SIZE);
    }
  }
  return canvas;
}

// Twelve icosahedron vertices — the classic pentagon layout on a football
function icosahedronDirs() {
  const g = (1 + Math.sqrt(5)) / 2;
  const raw = [];
  for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
    raw.push([0, s1, s2 * g], [s1, s2 * g, 0], [s2 * g, 0, s1]);
  }
  return raw.map(norm3);
}

function rodrigues(v, k, ang) {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const cross = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * cs + cross[0] * sn + k[0] * dot * (1 - cs),
    v[1] * cs + cross[1] * sn + k[1] * dot * (1 - cs),
    v[2] * cs + cross[2] * sn + k[2] * dot * (1 - cs),
  ];
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function rgb(r, g, b) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + q(r) + q(g) + q(b);
}
