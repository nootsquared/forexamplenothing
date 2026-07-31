import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Deterministic RNG so every asset rebuild is identical
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Position-stable integer hash → [0,1): textures read as planted, not random
export function hash2(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Bilinear value noise with smoothstep, cell size s px
export function vnoise(x, y, s) {
  const gx = Math.floor(x / s);
  const gy = Math.floor(y / s);
  const fx = x / s - gx;
  const fy = y / s - gy;
  const a = hash2(gx, gy);
  const b = hash2(gx + 1, gy);
  const c = hash2(gx, gy + 1);
  const d = hash2(gx + 1, gy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function makeCanvas(w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  return { canvas, ctx };
}

export function savePNG(canvas, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canvas.toBuffer('image/png'));
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

// Multiply lightness; amount 1.15 lightens, 0.85 darkens
export function shade(hex, amount) {
  return rgbToHex(hexToRgb(hex).map((v) => v * amount));
}

// Pixel-plotting surface: raw art pixels, no antialiasing, with auto-outline support
export class PixelGrid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Array(w * h).fill(null); // null = transparent, else [r,g,b,a]
  }
  set(x, y, hex, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b] = hexToRgb(hex);
    this.data[y * this.w + x] = [r, g, b, a];
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.data[y * this.w + x];
  }
  rect(x, y, w, h, hex, a = 255) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, hex, a);
  }
  // Top-left light: lighten pixels open above, darken pixels closed on the right edge
  autoShade(lighten = 1.18, darken = 0.86) {
    const next = this.data.slice();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const p = this.get(x, y);
        if (!p) continue;
        let [r, g, b, a] = p;
        if (!this.get(x, y - 1)) { r *= lighten; g *= lighten; b *= lighten; }
        else if (!this.get(x + 1, y)) { r *= darken; g *= darken; b *= darken; }
        next[y * this.w + x] = [Math.min(255, r), Math.min(255, g), Math.min(255, b), a];
      }
    }
    this.data = next;
  }
  // 1px outline around the silhouette — the classic premium pixel-art look
  autoOutline(hex = '#1a1626') {
    const [r, g, b] = hexToRgb(hex);
    const src = this.data.slice();
    const at = (x, y) => (x < 0 || y < 0 || x >= this.w || y >= this.h ? null : src[y * this.w + x]);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (at(x, y)) continue;
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
          this.data[y * this.w + x] = [r, g, b, 255];
        }
      }
    }
  }
  blitTo(ctx, dx, dy) {
    const img = ctx.createImageData(this.w, this.h);
    for (let i = 0; i < this.data.length; i++) {
      const p = this.data[i];
      if (!p) continue;
      img.data[i * 4] = p[0]; img.data[i * 4 + 1] = p[1]; img.data[i * 4 + 2] = p[2]; img.data[i * 4 + 3] = p[3];
    }
    ctx.putImageData(img, dx, dy);
  }
}
