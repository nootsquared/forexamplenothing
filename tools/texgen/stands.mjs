import { makeCanvas, mulberry32, shade } from './lib.mjs';
import { stampText, textWidth } from './font.mjs';

// Everything that turns a lonely field into an arena: grandstand, ad boards,
// dugouts, corner flags, and drifting cloud shadows.

export const STAND_H = 96;
const CROWD = ['#cf5f56', '#d1a94e', '#5b98cf', '#74bd5f', '#d8d2c4', '#9c72c2', '#d9d9d9', '#cf824e'];
const EMPTY_SEAT = '#2a3750';

export function generateStand() {
  const w = 256;
  const { canvas, ctx } = makeCanvas(w, STAND_H);
  const rng = mulberry32(2024);

  // Roof deck at the top
  ctx.fillStyle = '#161d2e';
  ctx.fillRect(0, 0, w, 10);
  ctx.fillStyle = '#6b7a9b';
  ctx.fillRect(0, 0, w, 1);
  ctx.fillStyle = '#0e1320';
  ctx.fillRect(0, 9, w, 1);

  // Seven crowd terraces stepping down toward the pitch
  const rows = 7;
  const rowH = 10;
  for (let r = 0; r < rows; r++) {
    const y = 10 + r * rowH;
    ctx.fillStyle = r % 2 === 0 ? '#243050' : '#202a46';
    ctx.fillRect(0, y, w, rowH);
    ctx.fillStyle = '#151d33';
    ctx.fillRect(0, y + rowH - 1, w, 1); // step shadow
    for (let x = 0; x < w; x += 3) {
      if (rng() < 0.82) {
        const c = rng() < 0.12 ? EMPTY_SEAT : CROWD[Math.floor(rng() * CROWD.length)];
        const px = x + (rng() < 0.5 ? 0 : 1);
        const py = y + 2 + Math.floor(rng() * 3);
        ctx.fillStyle = c;
        ctx.fillRect(px, py, 2, 3);                        // body
        ctx.fillStyle = rng() < 0.5 ? '#caa27e' : '#8a6a4c';
        ctx.fillRect(px, py - 1, 2, 1);                    // head
      }
    }
  }

  // Front fascia wall with rail
  const fasciaY = 10 + rows * rowH;
  ctx.fillStyle = '#38466b';
  ctx.fillRect(0, fasciaY, w, STAND_H - fasciaY);
  ctx.fillStyle = '#8fa0c5';
  ctx.fillRect(0, fasciaY, w, 1);
  ctx.fillStyle = '#202a46';
  for (let x = 16; x < w; x += 32) ctx.fillRect(x, fasciaY + 2, 1, STAND_H - fasciaY - 3);
  ctx.fillStyle = '#141a28';
  ctx.fillRect(0, STAND_H - 1, w, 1);

  // Roof support posts in front of everything
  ctx.fillStyle = '#10151f';
  for (let x = 20; x < w; x += 72) ctx.fillRect(x, 0, 3, STAND_H);

  return canvas;
}

const BOARD_ADS = [
  { text: 'GOLAZO', bg: '#c44a3f', fg: '#f2e8de' },
  { text: 'PIXEL FC', bg: '#ddd6c6', fg: '#263450' },
  { text: 'TURBO', bg: '#2f56b0', fg: '#dde5f4' },
  { text: 'ARCADE', bg: '#d8b13a', fg: '#3a2c12' },
  { text: 'NEON', bg: '#1b2531', fg: '#57c2ad' },
  { text: 'GRASS CO.', bg: '#3d7a33', fg: '#dcead2' },
];
export const BOARD_H = 16;

export function generateBoards() {
  const panelW = 72;
  const { canvas, ctx } = makeCanvas(panelW * BOARD_ADS.length, BOARD_H);
  BOARD_ADS.forEach((ad, i) => {
    const x = i * panelW;
    ctx.fillStyle = ad.bg;
    ctx.fillRect(x, 0, panelW, BOARD_H);
    ctx.fillStyle = shade(ad.bg, 1.25);
    ctx.fillRect(x, 0, panelW, 1);
    ctx.fillStyle = shade(ad.bg, 0.6);
    ctx.fillRect(x, BOARD_H - 2, panelW, 2);
    ctx.fillStyle = '#10151f';
    ctx.fillRect(x, 0, 1, BOARD_H);
    stampText(ctx, ad.text, x + Math.floor((panelW - textWidth(ad.text)) / 2), 4, ad.fg);
  });
  return canvas;
}

export function generateDugout() {
  const w = 56;
  const h = 26;
  const { canvas, ctx } = makeCanvas(w, h);
  // Interior shadow + bench with staff
  ctx.fillStyle = '#141b2b';
  ctx.fillRect(2, 8, w - 4, h - 10);
  const rng = mulberry32(7);
  for (let i = 0; i < 4; i++) {
    const x = 8 + i * 11;
    ctx.fillStyle = ['#d94f43', '#eee9df', '#2f62d8', '#d94f43'][i];
    ctx.fillRect(x, 14, 4, 5);
    ctx.fillStyle = rng() < 0.5 ? '#caa27e' : '#8a6a4c';
    ctx.fillRect(x, 11, 4, 3);
  }
  ctx.fillStyle = '#22304a';
  ctx.fillRect(0, h - 2, w, 2);
  // Acrylic roof with a light streak
  ctx.fillStyle = '#22304a';
  ctx.fillRect(0, 4, w, 5);
  ctx.fillStyle = '#54688f';
  ctx.fillRect(0, 4, w, 1);
  ctx.fillStyle = '#8fa9d6';
  ctx.fillRect(6, 5, 18, 1);
  ctx.fillStyle = '#10151f';
  ctx.fillRect(0, 8, w, 1);
  ctx.fillRect(0, 4, 2, h - 4);
  ctx.fillRect(w - 2, 4, 2, h - 4);
  return canvas;
}

export function generateCornerFlag() {
  const w = 10;
  const h = 16;
  const frames = 2;
  const { canvas, ctx } = makeCanvas(w * frames, h);
  for (let f = 0; f < frames; f++) {
    const x = f * w;
    ctx.fillStyle = '#d8d8d2';
    ctx.fillRect(x + 2, 2, 1, h - 3);
    ctx.fillStyle = '#f2c73c';
    if (f === 0) {
      ctx.fillRect(x + 3, 2, 5, 2);
      ctx.fillRect(x + 3, 4, 3, 2);
    } else {
      ctx.fillRect(x + 3, 3, 5, 2);
      ctx.fillRect(x + 3, 5, 2, 1);
    }
  }
  return canvas;
}

export function generateCloudShadow() {
  const w = 220;
  const h = 140;
  const { canvas, ctx } = makeCanvas(w, h);
  const rng = mulberry32(31);
  ctx.fillStyle = '#08140a';
  for (let i = 0; i < 26; i++) {
    const cx = 30 + rng() * (w - 60);
    const cy = 30 + rng() * (h - 60);
    const r = 18 + rng() * 34;
    ctx.globalAlpha = 0.05 + rng() * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}
