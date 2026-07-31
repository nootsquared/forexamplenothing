import { makeCanvas, PixelGrid, mulberry32 } from './lib.mjs';

// All juice sprites: dust puffs, kick flash rings, skid streaks, soft shadows,
// swaying grass tufts, and the goal net tile

// Kicked-up dirt: ragged-edged puffs in muted earth tones that spread, thin
// out and die — per-pixel noise keeps every silhouette irregular, never a blob
export function generateDustSheet() {
  const size = 14;
  const frames = 5;
  const { canvas, ctx } = makeCanvas(size * frames, size);
  const rng = mulberry32(42);
  const blobs = Array.from({ length: 7 }, () => ({
    x: 4 + rng() * 6, y: 5 + rng() * 5, dx: (rng() - 0.5) * 6, dy: -1 - rng() * 2.5,
    tone: rng() < 0.4 ? '#b9ae90' : '#cfc8b0',
  }));
  const edge = mulberry32(9);
  const rag = Array.from({ length: size * size }, () => 0.7 + edge() * 0.55);
  for (let f = 0; f < frames; f++) {
    const grid = new PixelGrid(size, size);
    const t = f / (frames - 1);
    for (const b of blobs) {
      const r = 1.4 + t * 2;
      const bx = b.x + b.dx * t;
      const by = b.y + b.dy * t;
      const alpha = Math.round(165 * (1 - t * 0.9));
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const rr = r * rag[y * size + x];
        if ((x - bx) ** 2 + (y - by) ** 2 < rr * rr) grid.set(x, y, b.tone, alpha);
      }
    }
    grid.blitTo(ctx, f * size, 0);
  }
  return canvas;
}

// Grass clippings torn up by boots: little green bits that fly out and fall
export function generateGrassBitsSheet() {
  const size = 12;
  const frames = 4;
  const { canvas, ctx } = makeCanvas(size * frames, size);
  const rng = mulberry32(77);
  const bits = Array.from({ length: 6 }, () => ({
    x: 5 + rng() * 2, y: 7 + rng() * 2,
    vx: (rng() - 0.5) * 9, vy: -4 - rng() * 5,
    tone: ['#3f7c31', '#5a9440', '#33702a', '#8f8347'][Math.floor(rng() * 4)],
    big: rng() < 0.35,
  }));
  for (let f = 0; f < frames; f++) {
    const grid = new PixelGrid(size, size);
    const t = f / (frames - 1);
    for (const b of bits) {
      const bx = b.x + b.vx * t;
      const by = b.y + b.vy * t + 10 * t * t; // gravity pulls them back down
      const alpha = Math.round(235 * (1 - t * 0.55));
      grid.set(bx, by, b.tone, alpha);
      if (b.big) grid.set(bx, by - 1, b.tone, alpha);
    }
    grid.blitTo(ctx, f * size, 0);
  }
  return canvas;
}

export function generateRingSheet() {
  const size = 26;
  const frames = 3;
  const { canvas, ctx } = makeCanvas(size * frames, size);
  const c = size / 2 - 0.5;
  for (let f = 0; f < frames; f++) {
    const grid = new PixelGrid(size, size);
    const r = 4 + f * 4;
    const alpha = 230 - f * 75;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - c) ** 2 + ((y - c) * 1.6) ** 2); // squashed ring sits on the ground plane
      if (Math.abs(d - r) < 1.3) grid.set(x, y, '#fffbe8', alpha);
    }
    grid.blitTo(ctx, f * size, 0);
  }
  return canvas;
}

// Contact shadow that GROUNDS: a dense pool right under the feet melting fast
// into the turf — wide faint halos are what make sprites float
export function generateShadow() {
  const w = 22, h = 11;
  const { canvas, ctx } = makeCanvas(w, h);
  const grid = new PixelGrid(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = ((x - w / 2 + 0.5) / (w / 2)) ** 2 + ((y - h / 2 + 0.5) / (h / 2)) ** 2;
    if (d < 0.16) grid.set(x, y, '#0a1408', 135);
    else if (d < 0.48) grid.set(x, y, '#0a1408', 70);
    else if (d < 1) grid.set(x, y, '#0a1408', 24);
  }
  grid.blitTo(ctx, 0, 0);
  return canvas;
}


// Torn-turf skid streak, stamped on the ground where boots plant and cut
export function generateSkid() {
  const w = 16, h = 5;
  const { canvas, ctx } = makeCanvas(w, h);
  const grid = new PixelGrid(w, h);
  const rng = mulberry32(13);
  for (let x = 0; x < w; x++) {
    const fade = 1 - x / w;
    const a = Math.round(115 * fade);
    grid.set(x, 2, '#1e3318', a);
    if (rng() < 0.75) grid.set(x, 1, '#2a441f', Math.round(a * 0.7));
    if (rng() < 0.45) grid.set(x, 3, '#152a10', Math.round(a * 0.6));
  }
  grid.blitTo(ctx, 0, 0);
  return canvas;
}

// Six little blade clusters in mixed heights and greens — planted by the
// hundreds and bent by wind at runtime
export function generateTuftSheet() {
  const size = 10;
  const count = 6;
  const { canvas, ctx } = makeCanvas(size * count, size);
  const rng = mulberry32(7);
  const bases = ['#2c5d24', '#33702a', '#417f33'];
  for (let i = 0; i < count; i++) {
    const grid = new PixelGrid(size, size);
    const blades = 3 + Math.floor(rng() * 4);
    for (let b = 0; b < blades; b++) {
      const x = 1 + Math.floor(rng() * (size - 2));
      const tall = 2 + Math.floor(rng() * 5);
      const dry = rng() < 0.08;
      const body = dry ? '#877b45' : bases[Math.floor(rng() * bases.length)];
      const tip = dry ? '#b3a05e' : '#9cc46a';
      for (let y = 0; y < tall; y++) grid.set(x, size - 1 - y, y === tall - 1 ? tip : body);
    }
    grid.blitTo(ctx, i * size, 0);
  }
  return canvas;
}

// Round aluminium goal bar, vertical; the renderer tiles it to any length
export function generateGoalBar() {
  const w = 4;
  const h = 8;
  const { canvas, ctx } = makeCanvas(w, h);
  const grid = new PixelGrid(w, h);
  const cols = ['#ffffff', '#f2f2ea', '#dcdcd2', '#a8aca4'];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid.set(x, y, cols[x]);
  grid.blitTo(ctx, 0, 0);
  return canvas;
}
