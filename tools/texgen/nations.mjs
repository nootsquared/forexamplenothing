import { makeCanvas } from './lib.mjs';

// The national wardrobe: the major World Cup nations (plus India, Bangladesh
// and Pakistan by request), each with a pixel flag and home/away kit
// palettes for the player-sheet bake. One list, baked into the manifest —
// the runtime never re-declares a nation.

export const FLAG_W = 18;
export const FLAG_H = 12;

// px(ctx) helpers paint 18×12 flags: bold shapes, no fine print
const bands = (ctx, colors, vertical = false) => {
  const n = colors.length;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[i];
    if (vertical) ctx.fillRect(Math.round((FLAG_W / n) * i), 0, Math.ceil(FLAG_W / n), FLAG_H);
    else ctx.fillRect(0, Math.round((FLAG_H / n) * i), FLAG_W, Math.ceil(FLAG_H / n));
  }
};
const disc = (ctx, cx, cy, r, color) => {
  ctx.fillStyle = color;
  for (let y = 0; y < FLAG_H; y++) {
    for (let x = 0; x < FLAG_W; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) ctx.fillRect(x, y, 1, 1);
    }
  }
};

export const NATIONS = [
  {
    id: 'bra', name: 'BRAZIL', color: '#e8c832',
    home: { shirt: '#e8c832', shirtTrim: '#2e7d46', shorts: '#2953a8', socks: '#e6e2d4', skin: '#97673f', hair: '#241c17' },
    away: { shirt: '#2953a8', shirtTrim: '#e8c832', shorts: '#e6e2d4', socks: '#2953a8', skin: '#7a4f2e', hair: '#1c1512' },
    flag: (ctx) => {
      ctx.fillStyle = '#2e7d46'; ctx.fillRect(0, 0, FLAG_W, FLAG_H);
      ctx.fillStyle = '#e8c832';
      for (let y = 0; y < FLAG_H; y++) {
        const half = Math.max(0, 7 - Math.abs(y - 6) * 1.4);
        ctx.fillRect(Math.round(9 - half), y, Math.round(half * 2), 1);
      }
      disc(ctx, 9, 6, 2.4, '#2953a8');
    },
  },
  {
    id: 'arg', name: 'ARGENTINA', color: '#7fb7e3',
    home: { shirt: '#7fb7e3', shirtTrim: '#f2f5fa', shorts: '#1a2947', socks: '#f2f5fa', skin: '#d3a87e', hair: '#241c17' },
    away: { shirt: '#2b2f4a', shirtTrim: '#7fb7e3', shorts: '#2b2f4a', socks: '#7fb7e3', skin: '#97673f', hair: '#1c1512' },
    flag: (ctx) => {
      bands(ctx, ['#7fb7e3', '#f2f5fa', '#7fb7e3']);
      disc(ctx, 9, 6, 1.6, '#e8b64c');
    },
  },
  {
    id: 'fra', name: 'FRANCE', color: '#27408f',
    home: { shirt: '#27408f', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#c4432f', skin: '#7a4f2e', hair: '#141210' },
    away: { shirt: '#f2f5fa', shirtTrim: '#27408f', shorts: '#27408f', socks: '#f2f5fa', skin: '#d3a87e', hair: '#5b3d20' },
    flag: (ctx) => bands(ctx, ['#27408f', '#f2f5fa', '#c4432f'], true),
  },
  {
    id: 'eng', name: 'ENGLAND', color: '#f2f5fa',
    home: { shirt: '#f2f5fa', shirtTrim: '#27408f', shorts: '#1a2947', socks: '#f2f5fa', skin: '#d3a87e', hair: '#5b3d20' },
    away: { shirt: '#c4432f', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#c4432f', skin: '#97673f', hair: '#241c17' },
    flag: (ctx) => {
      ctx.fillStyle = '#f2f5fa'; ctx.fillRect(0, 0, FLAG_W, FLAG_H);
      ctx.fillStyle = '#c4432f';
      ctx.fillRect(0, 5, FLAG_W, 2);
      ctx.fillRect(8, 0, 2, FLAG_H);
    },
  },
  {
    id: 'esp', name: 'SPAIN', color: '#c4432f',
    home: { shirt: '#c4432f', shirtTrim: '#e8c832', shorts: '#1a2947', socks: '#1a2947', skin: '#b98a5c', hair: '#241c17' },
    away: { shirt: '#f2f5fa', shirtTrim: '#c4432f', shorts: '#c4432f', socks: '#f2f5fa', skin: '#97673f', hair: '#1c1512' },
    flag: (ctx) => {
      ctx.fillStyle = '#c4432f'; ctx.fillRect(0, 0, FLAG_W, 3); ctx.fillRect(0, 9, FLAG_W, 3);
      ctx.fillStyle = '#e8c832'; ctx.fillRect(0, 3, FLAG_W, 6);
      ctx.fillStyle = '#c4432f'; ctx.fillRect(4, 5, 2, 2);
    },
  },
  {
    id: 'ger', name: 'GERMANY', color: '#f2f5fa',
    home: { shirt: '#f2f5fa', shirtTrim: '#141210', shorts: '#141210', socks: '#f2f5fa', skin: '#d3a87e', hair: '#a8894a' },
    away: { shirt: '#2a3038', shirtTrim: '#4ec48f', shorts: '#2a3038', socks: '#4ec48f', skin: '#b98a5c', hair: '#241c17' },
    flag: (ctx) => bands(ctx, ['#141210', '#c4432f', '#e8b64c']),
  },
  {
    id: 'por', name: 'PORTUGAL', color: '#a83232',
    home: { shirt: '#a83232', shirtTrim: '#2e7d46', shorts: '#2e7d46', socks: '#a83232', skin: '#b98a5c', hair: '#141210' },
    away: { shirt: '#f2f5fa', shirtTrim: '#a83232', shorts: '#f2f5fa', socks: '#a83232', skin: '#97673f', hair: '#241c17' },
    flag: (ctx) => {
      ctx.fillStyle = '#2e7d46'; ctx.fillRect(0, 0, 7, FLAG_H);
      ctx.fillStyle = '#a83232'; ctx.fillRect(7, 0, FLAG_W - 7, FLAG_H);
      disc(ctx, 7, 6, 2, '#e8b64c');
    },
  },
  {
    id: 'ned', name: 'NETHERLANDS', color: '#e07020',
    home: { shirt: '#e07020', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#e07020', skin: '#d3a87e', hair: '#5b3d20' },
    away: { shirt: '#1a2947', shirtTrim: '#e07020', shorts: '#1a2947', socks: '#e07020', skin: '#7a4f2e', hair: '#141210' },
    flag: (ctx) => bands(ctx, ['#c4432f', '#f2f5fa', '#27408f']),
  },
  {
    id: 'usa', name: 'USA', color: '#f2f5fa',
    home: { shirt: '#f2f5fa', shirtTrim: '#27408f', shorts: '#27408f', socks: '#c4432f', skin: '#b98a5c', hair: '#241c17' },
    away: { shirt: '#27408f', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#27408f', skin: '#d3a87e', hair: '#5b3d20' },
    flag: (ctx) => {
      for (let y = 0; y < FLAG_H; y++) {
        ctx.fillStyle = y % 2 === 0 ? '#c4432f' : '#f2f5fa';
        ctx.fillRect(0, y, FLAG_W, 1);
      }
      ctx.fillStyle = '#27408f'; ctx.fillRect(0, 0, 8, 6);
      ctx.fillStyle = '#f2f5fa';
      for (const [sx, sy] of [[1, 1], [4, 1], [6, 2], [2, 3], [5, 4], [1, 4]]) ctx.fillRect(sx, sy, 1, 1);
    },
  },
  {
    id: 'mex', name: 'MEXICO', color: '#2e7d46',
    home: { shirt: '#2e7d46', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#c4432f', skin: '#97673f', hair: '#141210' },
    away: { shirt: '#7a2432', shirtTrim: '#e8c832', shorts: '#1a1a20', socks: '#7a2432', skin: '#b98a5c', hair: '#241c17' },
    flag: (ctx) => {
      bands(ctx, ['#2e7d46', '#f2f5fa', '#c4432f'], true);
      disc(ctx, 9, 6, 1.7, '#8a6a3a');
    },
  },
  {
    id: 'jpn', name: 'JAPAN', color: '#27408f',
    home: { shirt: '#27408f', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#27408f', skin: '#e3c193', hair: '#141210' },
    away: { shirt: '#f2f5fa', shirtTrim: '#c4432f', shorts: '#c4432f', socks: '#f2f5fa', skin: '#e3c193', hair: '#241c17' },
    flag: (ctx) => {
      ctx.fillStyle = '#f2f5fa'; ctx.fillRect(0, 0, FLAG_W, FLAG_H);
      disc(ctx, 9, 6, 3, '#c4432f');
    },
  },
  {
    id: 'kor', name: 'KOREA', color: '#c4432f',
    home: { shirt: '#c4432f', shirtTrim: '#141210', shorts: '#141210', socks: '#c4432f', skin: '#e3c193', hair: '#141210' },
    away: { shirt: '#f2f5fa', shirtTrim: '#27408f', shorts: '#27408f', socks: '#f2f5fa', skin: '#e3c193', hair: '#241c17' },
    flag: (ctx) => {
      ctx.fillStyle = '#f2f5fa'; ctx.fillRect(0, 0, FLAG_W, FLAG_H);
      disc(ctx, 9, 5, 3, '#c4432f');
      ctx.fillStyle = '#27408f';
      for (let x = 6; x <= 12; x++) if (x >= 9 - 3 && x <= 9 + 3) ctx.fillRect(x, 6, 1, Math.round(Math.sqrt(9 - (x - 9) * (x - 9))));
      ctx.fillStyle = '#141210';
      ctx.fillRect(2, 2, 3, 1); ctx.fillRect(2, 4, 3, 1);
      ctx.fillRect(13, 8, 3, 1); ctx.fillRect(13, 10, 3, 1);
    },
  },
  {
    id: 'ind', name: 'INDIA', color: '#e08a2e',
    home: { shirt: '#e08a2e', shirtTrim: '#27408f', shorts: '#f2f5fa', socks: '#2e7d46', skin: '#7a4f2e', hair: '#141210' },
    away: { shirt: '#27408f', shirtTrim: '#e08a2e', shorts: '#1a2947', socks: '#27408f', skin: '#97673f', hair: '#141210' },
    flag: (ctx) => {
      bands(ctx, ['#e08a2e', '#f2f5fa', '#2e7d46']);
      disc(ctx, 9, 6, 1.6, '#27408f');
    },
  },
  {
    id: 'bgd', name: 'BANGLADESH', color: '#1f5c3d',
    home: { shirt: '#1f5c3d', shirtTrim: '#c4432f', shorts: '#1f5c3d', socks: '#c4432f', skin: '#7a4f2e', hair: '#141210' },
    away: { shirt: '#c4432f', shirtTrim: '#1f5c3d', shorts: '#f2f5fa', socks: '#c4432f', skin: '#97673f', hair: '#141210' },
    flag: (ctx) => {
      ctx.fillStyle = '#1f5c3d'; ctx.fillRect(0, 0, FLAG_W, FLAG_H);
      disc(ctx, 8, 6, 3, '#c4432f');
    },
  },
  {
    id: 'pak', name: 'PAKISTAN', color: '#2a6141',
    home: { shirt: '#2a6141', shirtTrim: '#f2f5fa', shorts: '#f2f5fa', socks: '#2a6141', skin: '#97673f', hair: '#141210' },
    away: { shirt: '#f2f5fa', shirtTrim: '#2a6141', shorts: '#2a6141', socks: '#f2f5fa', skin: '#7a4f2e', hair: '#241c17' },
    flag: (ctx) => {
      ctx.fillStyle = '#2a6141'; ctx.fillRect(0, 0, FLAG_W, FLAG_H);
      ctx.fillStyle = '#f2f5fa'; ctx.fillRect(0, 0, 4, FLAG_H);
      disc(ctx, 11, 6, 3, '#f2f5fa');
      disc(ctx, 12, 5.4, 2.6, '#2a6141');
      ctx.fillStyle = '#f2f5fa'; ctx.fillRect(13, 3, 1, 1);
    },
  },
];

// All flags on one row, manifest-ordered
export function generateFlagSheet() {
  const { canvas, ctx } = makeCanvas(FLAG_W * NATIONS.length, FLAG_H);
  NATIONS.forEach((n, i) => {
    ctx.save();
    ctx.translate(i * FLAG_W, 0);
    n.flag(ctx);
    // a 1px dark frame so every flag pops off any backdrop
    ctx.fillStyle = 'rgba(10,14,20,0.9)';
    ctx.fillRect(0, 0, FLAG_W, 1);
    ctx.fillRect(0, FLAG_H - 1, FLAG_W, 1);
    ctx.fillRect(0, 0, 1, FLAG_H);
    ctx.fillRect(FLAG_W - 1, 0, 1, FLAG_H);
    ctx.restore();
  });
  return canvas;
}
