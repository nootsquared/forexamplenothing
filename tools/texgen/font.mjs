import { makeCanvas, PixelGrid } from './lib.mjs';

// The game's voice: a PROPORTIONAL 7px retro face — narrow rounded letterforms
// with real sidebearings, tabular 4px digits so scoreboards line up, and a 5px
// micro face for on-field names and card fine print. Readable first, pixel always.

export const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!-.:%><^';
export const CELL_W = 7; // widest glyph (5) + 1px outline each side
export const CELL_H = 9;

export const ROWS = {
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  B: ['###.', '#..#', '###.', '#..#', '#..#', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '#...', '#...', '.###'],
  D: ['###.', '#..#', '#..#', '#..#', '#..#', '#..#', '###.'],
  E: ['###', '#..', '##.', '#..', '#..', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..', '#..', '#..'],
  G: ['.###', '#...', '#...', '#.##', '#..#', '#..#', '.###'],
  H: ['#..#', '#..#', '####', '#..#', '#..#', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['...#', '...#', '...#', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#.#.', '##..', '##..', '#.#.', '#..#', '#..#'],
  L: ['#..', '#..', '#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#..#', '##.#', '##.#', '#.##', '#.##', '#..#', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '#..#', '###.', '#...', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.', '...#'],
  R: ['###.', '#..#', '#..#', '###.', '#.#.', '#..#', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '...#', '#..#', '.##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.'],
  U: ['#..#', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  V: ['#.#', '#.#', '#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#.#', '#.#', '.#.', '.#.', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '#.#', '.#.', '.#.', '.#.', '.#.'],
  Z: ['####', '...#', '..#.', '.#..', '.#..', '#...', '####'],
  0: ['.##.', '#..#', '#.##', '##.#', '#..#', '#..#', '.##.'],
  1: ['..#.', '.##.', '..#.', '..#.', '..#.', '..#.', '####'],
  2: ['.##.', '#..#', '...#', '..#.', '.#..', '#...', '####'],
  3: ['###.', '...#', '.##.', '...#', '...#', '#..#', '.##.'],
  4: ['...#', '..##', '.#.#', '#..#', '####', '...#', '...#'],
  5: ['####', '#...', '###.', '...#', '...#', '#..#', '.##.'],
  6: ['.##.', '#...', '###.', '#..#', '#..#', '#..#', '.##.'],
  7: ['####', '...#', '..#.', '..#.', '.#..', '.#..', '.#..'],
  8: ['.##.', '#..#', '.##.', '#..#', '#..#', '#..#', '.##.'],
  9: ['.##.', '#..#', '#..#', '#..#', '.###', '...#', '.##.'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '-': ['...', '...', '...', '###', '...', '...', '...'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ':': ['.', '#', '.', '.', '.', '#', '.'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '>': ['#...', '##..', '.##.', '..##', '.##.', '##..', '#...'],
  '<': ['...#', '..##', '.##.', '##..', '.##.', '..##', '...#'],
  '^': ['.#.', '#.#', '...', '...', '...', '...', '...'],
};

export const WIDTHS = Object.fromEntries(
  Object.entries(ROWS).map(([ch, rows]) => [ch, rows[0].length]),
);

// Advance = glyph + 1px breathing room; a space is 3px of air
export const SPACE_W = 3;
export function textWidth(text, scale = 1, spacing = 1) {
  let w = 0;
  for (const ch of text.toUpperCase()) w += (WIDTHS[ch] ?? SPACE_W - spacing) + spacing;
  return Math.max(0, w - spacing) * scale;
}

export function generateFontSheet() {
  const { canvas, ctx } = makeCanvas(CELL_W * GLYPHS.length, CELL_H);
  for (let i = 0; i < GLYPHS.length; i++) {
    const rows = ROWS[GLYPHS[i]];
    const grid = new PixelGrid(CELL_W, CELL_H);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '#') grid.set(x + 1, y + 1, '#ffffff');
    });
    grid.autoOutline('#1a1626');
    grid.blitTo(ctx, i * CELL_W, 0);
  }
  return canvas;
}

// ---------------------------------------------------------------- micro face
// 5px-tall labels that live ON the pitch: player names, shirt numbers, card
// fine print. Same outline discipline so they read over grass.
export const MICRO_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.';
export const MICRO_CELL_W = 7;
export const MICRO_CELL_H = 7;

const MICRO_ROWS = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['###', '#.#', '#.#', '###', '..#'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  0: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '##.'],
  '-': ['...', '...', '###', '...', '...'],
  '.': ['.', '.', '.', '.', '#'],
};

export const MICRO_WIDTHS = Object.fromEntries(
  Object.entries(MICRO_ROWS).map(([ch, rows]) => [ch, rows[0].length]),
);

export function generateMicroFontSheet() {
  const { canvas, ctx } = makeCanvas(MICRO_CELL_W * MICRO_GLYPHS.length, MICRO_CELL_H);
  for (let i = 0; i < MICRO_GLYPHS.length; i++) {
    const rows = MICRO_ROWS[MICRO_GLYPHS[i]];
    const grid = new PixelGrid(MICRO_CELL_W, MICRO_CELL_H);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '#') grid.set(x + 1, y + 1, '#ffffff');
    });
    grid.autoOutline('#1a1626');
    grid.blitTo(ctx, i * MICRO_CELL_W, 0);
  }
  return canvas;
}

// The title wordmark: GOLAZO cut from the game font at pixel level, wearing
// a gold gradient with a white shine row, a chunky outline and a hard
// south-east drop shadow — a logo, not a line of text.
const TITLE_WORD = 'GOLAZO';
const TITLE_SPACING = 2; // the logo breathes wider than body text
export const TITLE_W = textWidth(TITLE_WORD, 1, TITLE_SPACING) + 8;
export const TITLE_H = 7 + 8;
export function generateTitleSheet() {
  const { canvas, ctx } = makeCanvas(TITLE_W, TITLE_H);
  const grid = new PixelGrid(TITLE_W, TITLE_H);
  const shades = ['#fff9d9', '#ffef9e', '#ffe27a', '#ffd95e', '#f0b83f', '#dc9a30', '#c47c26'];
  const stamp = (ox, oy, colorOf) => {
    let x = ox;
    for (const ch of TITLE_WORD) {
      const rows = ROWS[ch];
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] === '#') grid.set(x + rx, oy + ry, colorOf(ry));
        }
      });
      x += WIDTHS[ch] + TITLE_SPACING;
    }
  };
  stamp(4, 5, () => '#0a0806');       // the shadow, thrown low
  stamp(3, 4, () => '#0a0806');
  stamp(2, 2, (ry) => shades[ry]);    // the face
  grid.autoOutline('#241a08');
  grid.blitTo(ctx, 0, 0);
  return canvas;
}

// Stamp the 5px micro face onto a canvas (card fine print, coin crests)
export function stampMicro(ctx, text, x, y, color, scale = 1) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const rows = MICRO_ROWS[ch];
    if (!rows) { cx += 3 * scale; continue; }
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] === '#') {
          ctx.fillStyle = color;
          ctx.fillRect(cx + rx * scale, y + ry * scale, scale, scale);
        }
      }
    });
    cx += (MICRO_WIDTHS[ch] + 1) * scale;
  }
}

export function microWidth(text, scale = 1) {
  let w = 0;
  for (const ch of text.toUpperCase()) w += (MICRO_WIDTHS[ch] ?? 2) + 1;
  return Math.max(0, w - 1) * scale;
}

// Stamp a word directly onto another canvas (used by the ad boards and cards)
export function stampText(ctx, text, x, y, color, scale = 1) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const rows = ROWS[ch];
    if (!rows) { cx += SPACE_W * scale; continue; }
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] === '#') {
          ctx.fillStyle = color;
          ctx.fillRect(cx + rx * scale, y + ry * scale, scale, scale);
        }
      }
    });
    cx += (WIDTHS[ch] + 1) * scale;
  }
}
