import { makeCanvas, mulberry32, shade } from './lib.mjs';
import { stampMicro, microWidth } from './font.mjs';

// The collector's shelf: rarity card frames, kit figures to stand on them,
// the toss coin, and the gamble wheel. All the draft's furniture, baked.

export const CARD_W = 58;
export const CARD_H = 80;
export const RARITIES = ['legend', 'epic', 'rare', 'common'];

// Each rarity's metals: [bright edge, mid metal, dark metal, inner glow]
const METALS = {
  legend: ['#fff3c4', '#f0c552', '#8a5c16', '#3a2c10'],
  epic: ['#efd9ff', '#b06ae0', '#5a2a86', '#2c1638'],
  rare: ['#d9eaff', '#6aa0dc', '#28507e', '#14243a'],
  common: ['#e8ecf2', '#9aa2b0', '#4a5160', '#20242e'],
};

// A frame per rarity: cut pixel corners, beveled metal border, a lighter
// crest band up top for the rating, and a shine streak collectors know
export function generateCardSheet() {
  const { canvas, ctx } = makeCanvas(CARD_W * RARITIES.length, CARD_H);
  RARITIES.forEach((rarity, i) => drawCardFrame(ctx, i * CARD_W, rarity));
  return canvas;
}

function drawCardFrame(ctx, ox, rarity) {
  const [bright, mid, dark, glow] = METALS[rarity];
  const cut = 3; // pixel-cut corners
  const inRect = (x, y) => {
    if (x < 0 || y < 0 || x >= CARD_W || y >= CARD_H) return false;
    const cx = Math.min(x, CARD_W - 1 - x);
    const cy = Math.min(y, CARD_H - 1 - y);
    return cx + cy >= cut;
  };
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      if (!inRect(x, y)) continue;
      const cx = Math.min(x, CARD_W - 1 - x);
      const cy = Math.min(y, CARD_H - 1 - y);
      const edge = Math.min(cx, cy, Math.floor((cx + cy - cut) / 1.5));
      let color;
      if (edge === 0) color = dark;                       // outline
      else if (edge === 1) color = x + y < CARD_W ? bright : mid; // bevel: lit toward top-left
      else if (edge === 2) color = mid;
      else color = y < 26 ? shade(glow, 1.35) : '#121722'; // crest band, then the panel
      ctx.fillStyle = color;
      ctx.fillRect(ox + x, y, 1, 1);
    }
  }
  // panel texture: faint horizontal weave
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let y = 28; y < CARD_H - 4; y += 3) ctx.fillRect(ox + 4, y, CARD_W - 8, 1);
  // the crest band's floor
  ctx.fillStyle = mid;
  ctx.fillRect(ox + 3, 26, CARD_W - 6, 1);
  // shine streak across the top-right shoulder
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let s = 0; s < 10; s++) ctx.fillRect(ox + CARD_W - 18 + s, 4 + Math.floor(s / 2), 1, 1);
  // legends and epics wear corner gems
  if (rarity === 'legend' || rarity === 'epic') {
    ctx.fillStyle = bright;
    for (const [gx, gy] of [[4, 4], [CARD_W - 6, CARD_H - 6]]) {
      ctx.fillRect(ox + gx, gy, 2, 2);
    }
  }
}

// The little pro who stands on the card: front-facing, kit dyed to rarity
export const FIG_W = 20;
export const FIG_H = 28;
export function generateCardFigures() {
  const { canvas, ctx } = makeCanvas(FIG_W * RARITIES.length, FIG_H);
  RARITIES.forEach((rarity, i) => drawFigure(ctx, i * FIG_W, METALS[rarity][1], METALS[rarity][0]));
  return canvas;
}

function drawFigure(ctx, ox, kit, trim) {
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(ox + x, y, w, h); };
  const skin = '#caa27e';
  const skinD = '#9c7350';
  const kitD = shade(kit, 0.62);
  // head + hair
  px(8, 2, 5, 5, skin);
  px(8, 2, 5, 2, '#3a2c1c');
  px(12, 3, 1, 3, skinD);
  // neck + shirt
  px(9, 7, 3, 1, skinD);
  px(6, 8, 9, 8, kit);
  px(6, 8, 9, 1, trim);          // collar line
  px(13, 9, 2, 6, kitD);         // shaded side
  px(4, 9, 2, 5, kit);           // arms
  px(15, 9, 2, 5, kitD);
  px(4, 14, 2, 2, skin);         // hands
  px(15, 14, 2, 2, skinD);
  // shorts
  px(6, 16, 9, 4, kitD);
  px(6, 16, 9, 1, shade(kit, 0.8));
  // legs + socks + boots
  px(7, 20, 3, 3, skin);
  px(11, 20, 3, 3, skinD);
  px(7, 23, 3, 3, kit);
  px(11, 23, 3, 3, kitD);
  px(6, 26, 4, 2, '#1c1c22');
  px(11, 26, 4, 2, '#1c1c22');
}

// The referee's coin: a red crest, a blue crest, and the thin edge between
export const COIN_S = 20;
export function generateCoinSheet() {
  const { canvas, ctx } = makeCanvas(COIN_S * 3, COIN_S);
  const face = (ox, bg, bgD, letter, letterColor) => {
    for (let y = 0; y < COIN_S; y++) {
      for (let x = 0; x < COIN_S; x++) {
        const dx = x - COIN_S / 2 + 0.5;
        const dy = y - COIN_S / 2 + 0.5;
        const d = Math.hypot(dx, dy);
        if (d > 9.5) continue;
        ctx.fillStyle =
          d > 8.4 ? '#8a5c16' :
          d > 7.4 ? (dy < 0 ? '#fff3c4' : '#b8860b') :
          dy - dx * 0.3 < -3 ? shade(bg, 1.2) : dy > 4 ? bgD : bg;
        ctx.fillRect(ox + x, y, 1, 1);
      }
    }
    stampMicro(ctx, letter, ox + Math.round((COIN_S - microWidth(letter)) / 2), 7, letterColor);
  };
  face(0, '#f0c552', '#c89a2e', 'R', '#a02c1c');
  face(COIN_S, '#f0c552', '#c89a2e', 'B', '#1c3a8c');
  // the edge-on frame: a thin gold bar
  ctx.fillStyle = '#8a5c16';
  ctx.fillRect(COIN_S * 2 + 3, 8, 14, 4);
  ctx.fillStyle = '#f0c552';
  ctx.fillRect(COIN_S * 2 + 3, 8, 14, 2);
  return canvas;
}
