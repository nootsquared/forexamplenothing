import { makeCanvas, PixelGrid } from './lib.mjs';

export const BALL_SIZE = 12;
export const BALL_FRAMES = 10;

// Rolling ball that reads as a SPHERE: dark patches wrap under a fixed light —
// hot top-left specular, hard terminator into a cool shadow side, extra
// darkening where it meets the ground. Lighting never rotates, only the patches.
export function generateBallSheet() {
  const { canvas, ctx } = makeCanvas(BALL_SIZE * BALL_FRAMES, BALL_SIZE);
  const r = 4.6;
  const c = BALL_SIZE / 2 - 0.5;
  const span = r * 2 - 1;
  const patches = [
    [0, -2.8], [2.5, 1.2], [-2.5, 1.2], [0, 4.9], [2, -5.2], [-2, -5.2],
  ];
  for (let f = 0; f < BALL_FRAMES; f++) {
    const grid = new PixelGrid(BALL_SIZE, BALL_SIZE);
    const roll = (f / BALL_FRAMES) * span;
    for (let y = 0; y < BALL_SIZE; y++) {
      for (let x = 0; x < BALL_SIZE; x++) {
        const dx = x - c;
        const dy = y - c;
        if (dx * dx + dy * dy > r * r) continue;
        let color = '#efeee6';
        for (const [px, py] of patches) {
          let wy = ((py + roll + span / 2) % span + span) % span - span / 2;
          // Patches foreshorten near the top/bottom edge like on a real sphere
          const squash = Math.max(0.3, 1 - (Math.abs(wy) / r) * 0.6);
          if (Math.abs(dx - px) < 1.15 && Math.abs(dy - wy) < squash + 0.2) color = '#23232a';
        }
        grid.set(x, y, color);
      }
    }
    for (let y = 0; y < BALL_SIZE; y++) {
      for (let x = 0; x < BALL_SIZE; x++) {
        const p = grid.get(x, y);
        if (!p) continue;
        const dx = x - c;
        const dy = y - c;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        const lit = (-dx - dy) / (r * 2);
        const contact = Math.max(0, dy / r - 0.15) * 0.38;
        const k = 1 + lit * 0.34 - Math.max(0, d - 0.55) * 0.62 - contact;
        const cool = k < 0.97 ? 1.07 : 1; // shadow side drifts cool, not grey
        grid.data[y * grid.w + x] = [
          Math.min(255, p[0] * k),
          Math.min(255, p[1] * k),
          Math.min(255, Math.max(0, p[2] * k * cool)),
          255,
        ];
      }
    }
    grid.set(Math.round(c - 2), Math.round(c - 3), '#ffffff');
    grid.set(Math.round(c - 3), Math.round(c - 2), '#ffffff');
    grid.set(Math.round(c - 2), Math.round(c - 2), '#fbfbf4');
    grid.autoOutline('#14141a');
    grid.blitTo(ctx, f * BALL_SIZE, 0);
  }
  return canvas;
}
