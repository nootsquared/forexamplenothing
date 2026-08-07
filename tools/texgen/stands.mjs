import { makeCanvas, mulberry32, shade, vnoise } from './lib.mjs';
import { stampText, textWidth } from './font.mjs';

// Everything that turns a lonely field into an arena: grandstand, ad boards,
// dugouts, corner flags, and drifting cloud shadows.

export const STAND_H = 96;
export const STAND_IDLE_FRAMES = 4; // a rolling murmur: bobs and sways drift down the terraces
export const STAND_HYPE_FRAMES = 4; // goal frenzy: jumps, thrown arms, scarves and flags overhead
export const STAND_FRAMES = STAND_IDLE_FRAMES + STAND_HYPE_FRAMES;

const STAND_W = 256;
const ROWS = 7;
const ROW_H = 10;
const ROOF_H = 10;
const SKIN = ['#e8b98a', '#d3a476', '#b1885e', '#8a6a4c', '#6f4f33'];
const HAIR = ['#191411', '#191411', '#3d2817', '#6e4a26', '#c9a45a', '#8d8d90', null]; // null = bald
const SCARF = ['#e0c04a', '#cf5f56', '#5b98cf', '#d8d2c4'];
// Supporter blocks: each 32px section of the tile leans a palette, so the
// crowd reads as ends and pockets instead of confetti static
const SECTIONS = [
  ['#cf5f56', '#c44a3f', '#d8d2c4', '#a33d33'],                       // home end reds
  ['#cf5f56', '#d1a94e', '#5b98cf', '#74bd5f', '#d8d2c4', '#9c72c2'], // neutrals
  ['#5b98cf', '#3f6fb5', '#d8d2c4', '#2f5691'],                       // away pocket blues
  ['#d8b13a', '#d1a94e', '#cf824e', '#d8d2c4'],                       // gold ultras
  ['#cf5f56', '#d8d2c4', '#a33d33', '#c44a3f'],
  ['#74bd5f', '#d1a94e', '#5b98cf', '#d9d9d9', '#cf5f56'],
  ['#3f6fb5', '#5b98cf', '#d8d2c4', '#9c72c2'],
  ['#cf5f56', '#c44a3f', '#d1a94e', '#d8d2c4'],
];
const AISLES = [{ x0: 62, x1: 67 }, { x0: 190, x1: 195 }]; // stair gaps splitting the terraces
// Bob cycles indexed by per-fan phase: idle murmurs, hype leaps
const IDLE_CALM = [0, 0, -1, -1];
const IDLE_KEEN = [0, -1, -2, -1];
const HYPE_JUMP = [0, -2, -4, -2];
const SWAY = [0, 1, 0, -1];

// Every fan rolled ONCE, then drawn identically on all eight frames — only
// the pose moves, never the person
function buildFans() {
  const rng = mulberry32(2024);
  const fans = [];
  for (let r = 0; r < ROWS; r++) {
    const y = ROOF_H + r * ROW_H;
    for (let x = 1; x < STAND_W - 3; x += 4) {
      if (AISLES.some((a) => x + 2 >= a.x0 && x <= a.x1)) {
        // aisle edges get the odd hi-vis steward, standing sideways to the game
        if (rng() < 0.1) fans.push({ x, y: y + 3, r, shirt: '#e3d43c', skin: SKIN[1], hair: '#191411', bodyH: 4, phase: 0, keen: false, sway: 0, prop: 'steward' });
        continue;
      }
      if (rng() >= 0.9) continue; // an empty seat
      const section = SECTIONS[Math.floor(x / 32) % SECTIONS.length];
      const shirt = rng() < 0.62
        ? section[Math.floor(rng() * section.length)]
        : SECTIONS[1][Math.floor(rng() * SECTIONS[1].length)];
      const propRoll = rng();
      fans.push({
        x: x + (rng() < 0.5 ? 0 : 1),
        // the back row sits two px lower so risen hair never clips the roof
        y: y + 2 + Math.floor(rng() * 2) + (r === 0 ? 2 : 0),
        r,
        shirt,
        skin: SKIN[Math.floor(rng() * SKIN.length)],
        hair: HAIR[Math.floor(rng() * HAIR.length)],
        bodyH: 3 + Math.floor(rng() * 2),
        // the wave phase rides x with a little jitter, so bobs travel down
        // the stand instead of popping at random
        phase: (Math.floor(x / 13) + (rng() < 0.3 ? 1 : 0)) % 4,
        jumpPhase: (Math.floor(x / 32) + (rng() < 0.25 ? 1 : 0)) % 4,
        keen: rng() < 0.35,
        sway: rng() < 0.25 ? (rng() < 0.5 ? 1 : -1) : 0,
        prop: propRoll < 0.07 ? 'scarf' : propRoll < 0.09 ? 'flag' : null,
        propColor: SCARF[Math.floor(rng() * SCARF.length)],
      });
    }
  }
  return fans;
}

// Eight stacked frames of one stand: 4 idle bobs, then 4 hype leaps.
// Cycled slow at rest, fast and loud on goals.
export function generateStand() {
  const fans = buildFans();
  const { canvas, ctx } = makeCanvas(STAND_W, STAND_H * STAND_FRAMES);
  for (let f = 0; f < STAND_IDLE_FRAMES; f++) drawStandFrame(ctx, f * STAND_H, fans, f, false);
  for (let f = 0; f < STAND_HYPE_FRAMES; f++) drawStandFrame(ctx, (STAND_IDLE_FRAMES + f) * STAND_H, fans, f, true);
  return canvas;
}

// Rows are lit like a real bowl: dim under the roof at the back, brightening
// toward the pitch
const rowLight = (r) => 0.78 + (r / (ROWS - 1)) * 0.28;

function drawStandFrame(ctx, oy, fans, step, hype) {
  // Roof deck: lit lip, ribbed underside, dark drip edge
  ctx.fillStyle = '#161d2e';
  ctx.fillRect(0, oy, STAND_W, ROOF_H);
  ctx.fillStyle = '#6b7a9b';
  ctx.fillRect(0, oy, STAND_W, 1);
  ctx.fillStyle = '#202a42';
  for (let x = 4; x < STAND_W; x += 16) ctx.fillRect(x, oy + 2, 1, 6);
  ctx.fillStyle = '#0e1320';
  ctx.fillRect(0, oy + ROOF_H - 1, STAND_W, 1);

  // Terraces stepping down toward the pitch, each with a lit tread edge
  for (let r = 0; r < ROWS; r++) {
    const y = oy + ROOF_H + r * ROW_H;
    const f = rowLight(r);
    ctx.fillStyle = shade(r % 2 === 0 ? '#243050' : '#202a46', f);
    ctx.fillRect(0, y, STAND_W, ROW_H);
    ctx.fillStyle = shade('#3a4a74', f);
    ctx.fillRect(0, y, STAND_W, 1); // tread edge catching the sun
    ctx.fillStyle = '#151d33';
    ctx.fillRect(0, y + ROW_H - 1, STAND_W, 1); // step riser shadow
  }

  // Stair aisles cut through the terraces
  for (const a of AISLES) {
    for (let r = 0; r < ROWS; r++) {
      const y = oy + ROOF_H + r * ROW_H;
      const f = rowLight(r);
      ctx.fillStyle = shade('#31406a', f);
      ctx.fillRect(a.x0, y, a.x1 - a.x0 + 1, ROW_H);
      ctx.fillStyle = shade('#4a5c8c', f);
      ctx.fillRect(a.x0, y + 4, a.x1 - a.x0 + 1, 1); // half-step tread
      ctx.fillStyle = '#141b2f';
      ctx.fillRect(a.x0, y + ROW_H - 1, a.x1 - a.x0 + 1, 1);
      ctx.fillRect(a.x0 - 1, y, 1, ROW_H); // handrail shadow lines
      ctx.fillRect(a.x1 + 1, y, 1, ROW_H);
    }
  }

  // The crowd, back row first so front bodies overlap cleanly
  for (const fan of fans) drawFan(ctx, oy, fan, step, hype);

  // The roof throws its shade over the back rows — over the fans too
  for (const [dy, a] of [[0, 0.3], [3, 0.2], [6, 0.1]]) {
    ctx.fillStyle = `rgba(8, 10, 20, ${a})`;
    ctx.fillRect(0, oy + ROOF_H + dy, STAND_W, 3);
  }

  // Front fascia wall: lit rail, panel seams, hanging supporter banners
  const fasciaY = oy + ROOF_H + ROWS * ROW_H;
  const fasciaH = oy + STAND_H - fasciaY;
  ctx.fillStyle = '#38466b';
  ctx.fillRect(0, fasciaY, STAND_W, fasciaH);
  ctx.fillStyle = '#8fa0c5';
  ctx.fillRect(0, fasciaY, STAND_W, 1);
  ctx.fillStyle = '#202a46';
  for (let x = 16; x < STAND_W; x += 32) ctx.fillRect(x, fasciaY + 2, 1, fasciaH - 3);
  for (const [bx, bw, c1, c2] of [[26, 24, '#c44a3f', '#d8d2c4'], [112, 28, '#3f6fb5', '#d8b13a'], [206, 22, '#d8d2c4', '#c44a3f']]) {
    ctx.fillStyle = c1;
    ctx.fillRect(bx, fasciaY + 3, bw, 5);
    ctx.fillStyle = c2;
    ctx.fillRect(bx, fasciaY + 8, bw, 4);
    ctx.fillStyle = 'rgba(10, 13, 26, 0.5)';
    ctx.fillRect(bx, fasciaY + 12, bw, 1); // banner's own shadow on the wall
  }
  ctx.fillStyle = '#141a28';
  ctx.fillRect(0, oy + STAND_H - 1, STAND_W, 1);

  // Roof support posts in front of everything
  ctx.fillStyle = '#10151f';
  for (let x = 20; x < STAND_W; x += 72) {
    ctx.fillRect(x, oy, 3, STAND_H);
    ctx.fillStyle = '#2a3450';
    ctx.fillRect(x, oy, 1, STAND_H); // lit post edge
    ctx.fillStyle = '#10151f';
  }
}

// One supporter: grounded shadow, sun-shaded body, head with hair, and on
// hype frames thrown arms with scarves and flags overhead. The shadow stays
// on the step while the body rises — that gap is what sells the jump.
function drawFan(ctx, oy, fan, step, hype) {
  const light = rowLight(fan.r);
  let dy = 0;
  let dx = 0;
  if (fan.prop !== 'steward') {
    if (hype) {
      dy = HYPE_JUMP[(step + fan.jumpPhase) % 4];
      if (fan.r === 0) dy = Math.max(dy, -2); // the back row can't leap into the roof
    } else {
      dy = (fan.keen ? IDLE_KEEN : IDLE_CALM)[(step + fan.phase) % 4];
      dx = fan.sway * SWAY[(step + fan.phase) % 4];
    }
  }
  const x = fan.x + dx;
  const y = oy + fan.y + dy;
  const airborne = -dy; // px of daylight under the boots

  // Cast shadow, pinned to the terrace: fainter the higher they rise
  ctx.fillStyle = `rgba(5, 8, 18, ${0.4 - airborne * 0.06})`;
  ctx.fillRect(fan.x, oy + fan.y + fan.bodyH, 3, 1);

  // Body: lit left flank, shaded right, darker hem
  ctx.fillStyle = shade(fan.shirt, light);
  ctx.fillRect(x, y, 2, fan.bodyH);
  ctx.fillStyle = shade(fan.shirt, light * 0.72);
  ctx.fillRect(x + 2, y, 1, fan.bodyH);
  ctx.fillStyle = shade(fan.shirt, light * 0.85);
  ctx.fillRect(x, y + fan.bodyH - 1, 2, 1);

  // Head and hair
  const headY = y - 2;
  ctx.fillStyle = shade(fan.skin, light);
  ctx.fillRect(x, headY, 2, 2);
  if (fan.hair) {
    ctx.fillStyle = shade(fan.hair, light);
    ctx.fillRect(x, headY - 1, 2, 1);
  }

  // Hype: arms fly up on the rise, props wave overhead
  const armsUp = hype && dy <= -2 && fan.prop !== 'steward';
  if (armsUp) {
    ctx.fillStyle = shade(fan.skin, light);
    ctx.fillRect(x - 1, headY - 1, 1, 2);
    ctx.fillRect(x + 3, headY - 1, 1, 2);
  }
  if (fan.prop === 'scarf') {
    ctx.fillStyle = shade(fan.propColor, light);
    if (armsUp) ctx.fillRect(x - 1, headY - 2, 5, 1);       // stretched overhead
    else ctx.fillRect(x - 1, y + 1, 5, 1);                  // worn at the chest
  } else if (fan.prop === 'flag') {
    const wave = (step + fan.phase) % 2;
    ctx.fillStyle = '#c9c9c2';
    ctx.fillRect(x + 2, headY - 4, 1, 4);                   // pole
    ctx.fillStyle = shade(fan.propColor, light);
    ctx.fillRect(wave ? x + 3 : x - 1, headY - 4 + wave, 3, 2);
  }
}

const BOARD_ADS = [
  { text: 'TOTAL22', bg: '#c44a3f', fg: '#f2e8de' },
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

// A cumulus silhouette carved from layered value noise — a ragged, organic
// mass with soft edges, drifting like real cloud shade. Never circles.
export function generateCloudShadow() {
  const w = 320;
  const h = 190;
  const { canvas, ctx } = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sy = y * 1.55; // clouds stretch along their drift
      const v =
        0.55 * vnoise(x, sy, 64) +
        0.3 * vnoise(x + 91, sy + 41, 27) +
        0.15 * vnoise(x + 211, sy + 97, 11);
      // fade out before the canvas edge so the mass never clips square
      const rx = (x / w - 0.5) * 2;
      const ry = (y / h - 0.5) * 2;
      const falloff = Math.max(0, 1.25 - (rx * rx + ry * ry) * 1.35);
      const m = Math.max(0, Math.min(1, (v * falloff - 0.5) * 4.5));
      if (m > 0) {
        const i = (y * w + x) * 4;
        img.data[i] = 10; img.data[i + 1] = 20; img.data[i + 2] = 8;
        img.data[i + 3] = Math.round(m * 30);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
