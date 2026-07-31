import { makeCanvas, PixelGrid } from './lib.mjs';

export const FRAME_W = 36;
export const FRAME_H = 40;
export const BASELINE = 37; // foot line inside the frame
// Row order on the sheet; renderer maps facing angle → row
export const DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
export const FRAMES = 11; // 0 idle, 1-8 run cycle, 9 kick windup, 10 kick strike

const BOOT = '#26211f';
const OUTLINE = '#161226';
// Locked art direction, Pixel-Cup-school: a big expressive head on a chunky
// outlined body — visible fringe, sleeves with cuffs, trimmed shorts, thick
// confident legs. Every direction is its own pose, drawn, not implied.
const P = { head: 10, torso: 9, shorts: 3, leg: 9 };

// One sheet per kit: 8 direction rows × 11 frame columns
export function generatePlayerSheet(kit) {
  const { canvas, ctx } = makeCanvas(FRAME_W * FRAMES, FRAME_H * DIRS.length);
  for (let d = 0; d < DIRS.length; d++) {
    for (let f = 0; f < FRAMES; f++) {
      const grid = new PixelGrid(FRAME_W, FRAME_H);
      paintFrame(grid, DIRS[d], f, kit);
      grid.autoShade(1.24, 0.8); // sun-side pop, shade-side depth — form, not flat fill
      grid.autoOutline(OUTLINE);
      grid.blitTo(ctx, f * FRAME_W, d * FRAME_H);
    }
  }
  return canvas;
}

function paintFrame(grid, dir, frame, kit) {
  const phase = frame >= 1 && frame <= 8 ? (frame - 1) / 8 : null;
  const swing = phase === null ? 0 : Math.sin(phase * Math.PI * 2);
  const kick = frame === 9 ? 'windup' : frame === 10 ? 'strike' : null;
  const view = dir === 'S' || dir === 'SW' || dir === 'SE' ? 'front' : dir === 'N' || dir === 'NW' || dir === 'NE' ? 'back' : 'side';
  const mirror = dir === 'W' || dir === 'SW' || dir === 'NW';
  const diag = dir.length === 2;
  // Two-step bob makes the run pound the turf instead of hovering over it
  const bob = phase === null ? 0 : Math.abs(swing) > 0.7 ? 2 : Math.abs(swing) > 0.25 ? 1 : 0;
  const p = { grid, kit, swing, kick, view, diag, bob };
  if (view === 'side') paintSide(p);
  else paintFrontBack(p);
  if (mirror) mirrorGrid(grid);
}

// Front, back and true 3/4 views. Diagonals are a real angled pose — staggered
// stance, boot toes into the direction, head turned — never a front view in
// disguise. Limbs sit clear of the torso so the outline pass separates them.
function paintFrontBack(p) {
  const { grid, kit, swing, kick, view, diag, bob } = p;
  const cx = 18;
  const base = BASELINE - bob;
  const legTop = base - P.leg;
  const lLift = kick === 'strike' ? 4 : Math.max(0, Math.round(swing * 3));
  const rLift = kick === 'windup' ? 4 : Math.max(0, Math.round(-swing * 3));

  drawLegFB(grid, kit, cx - (diag ? 7 : 6), legTop, base, lLift, diag);
  drawLegFB(grid, kit, cx + (diag ? 3 : 2), legTop, base, rLift, diag);

  const shortsTop = legTop - P.shorts;
  grid.rect(cx - 6, shortsTop, 12, P.shorts, kit.shorts);
  grid.rect(cx - 6, shortsTop + P.shorts - 1, 12, 1, shadeHex(kit.shorts));
  grid.rect(cx - 6, shortsTop, 1, P.shorts, kit.shirtTrim);  // side trim
  grid.rect(cx + 5, shortsTop, 1, P.shorts, kit.shirtTrim);

  const lean = kick === 'windup' ? 1 : kick === 'strike' ? -1 : 0;
  const torsoTop = shortsTop - P.torso + lean;
  grid.rect(cx - 6, torsoTop, 12, P.torso, kit.shirt);
  grid.rect(cx - 6, torsoTop, 12, 1, kit.shirtTrim);              // shoulder trim
  grid.rect(cx - 6, torsoTop + P.torso - 1, 12, 1, shadeHex(kit.shirt));
  if (view === 'front') {
    grid.rect(cx - 1 + (diag ? 1 : 0), torsoTop + 1, 2, 2, kit.shirtTrim); // collar V
  }

  const armSwing = kick ? (kick === 'windup' ? -3 : 3) : Math.round(swing * 2.5);
  drawArmFB(grid, kit, cx - 9, torsoTop + 1 + armSwing);
  drawArmFB(grid, kit, cx + (diag ? 6 : 7) - 1, torsoTop + 1 - armSwing); // lead arm tucks on 3/4

  const headTop = torsoTop - 1 - P.head;
  const hx = cx - 5 + (diag ? 1 : 0); // head turns a pixel into the direction
  if (view === 'front') {
    grid.rect(hx, headTop, 10, P.head, kit.skin);
    grid.rect(hx, headTop, 10, 3, kit.hair);
    grid.set(hx + 3, headTop + 2, kit.skin);                // fringe notches
    grid.set(hx + 6, headTop + 2, kit.skin);
    if (diag) grid.rect(hx - 1, headTop + 1, 1, 4, kit.hair); // back of head on the trailing side
    else {
      grid.set(hx, headTop + 3, kit.hair);                  // sideburns
      grid.set(hx + 9, headTop + 3, kit.hair);
    }
    const eyeY = headTop + 5;
    grid.set(hx + (diag ? 3 : 2), eyeY, OUTLINE);
    grid.set(hx + 7, eyeY, OUTLINE);
  } else {
    grid.rect(hx, headTop, 10, P.head, kit.hair);
    grid.rect(hx + 1, headTop + P.head - 1, 8, 1, kit.skin); // neck peek
    if (diag) {
      grid.set(hx + 9, headTop + 4, kit.skin);               // sliver of cheek
      grid.set(hx + 9, headTop + 5, kit.skin);
    }
  }
}

function drawLegFB(grid, kit, x, legTop, base, lift, toe) {
  const bottom = base - lift;
  grid.rect(x, bottom - 2, 4, 2, BOOT);
  if (toe) grid.set(x + 4, bottom - 1, BOOT); // boot toe points into the facing
  grid.rect(x, bottom - 5, 4, 3, kit.socks);
  grid.rect(x, bottom - 5, 4, 1, kit.shirtTrim); // sock cuff
  const thighH = P.leg - 5 + lift;
  if (thighH > 0) grid.rect(x, legTop, 4, thighH, kit.skin);
}

function drawArmFB(grid, kit, x, y) {
  grid.rect(x, y, 3, 3, kit.shirt);       // sleeve
  grid.rect(x, y + 3, 3, 1, kit.shirtTrim); // cuff
  grid.rect(x, y + 4, 3, 3, kit.skin);
}

// Side view: deep strides read on screen-x with a knee bend; kicks extend the leg
function paintSide(p) {
  const { grid, kit, swing, kick, bob } = p;
  const cx = 18;
  const base = BASELINE - bob;
  const legTop = base - P.leg;
  const stride = Math.round(swing * 4);

  const backX = kick === 'windup' ? cx - 7 : cx - stride - 2;
  const frontX = kick === 'strike' ? cx + 7 : cx + stride - 2;
  drawLegSide(grid, kit, cx, backX, legTop, base, stride < -1 || kick === 'windup' ? 1 : 0);
  drawLegSide(grid, kit, cx, frontX, legTop, base, stride > 1 || kick === 'strike' ? 1 : 0);

  const shortsTop = legTop - P.shorts;
  grid.rect(cx - 4, shortsTop, 8, P.shorts, kit.shorts);
  grid.rect(cx - 4, shortsTop + P.shorts - 1, 8, 1, shadeHex(kit.shorts));
  grid.rect(cx + 3, shortsTop, 1, P.shorts, kit.shirtTrim); // side trim faces us

  const lean = kick === 'windup' ? -2 : kick === 'strike' ? 2 : Math.round(swing * 0.6);
  const torsoTop = shortsTop - P.torso;
  grid.rect(cx - 4 + lean, torsoTop, 8, P.torso, kit.shirt);
  grid.rect(cx - 4 + lean, torsoTop, 8, 1, kit.shirtTrim);
  grid.rect(cx - 4 + lean, torsoTop + P.torso - 1, 8, 1, shadeHex(kit.shirt));

  // The near arm swings across the body, resting a touch forward at idle
  const armX = cx - 1 + lean + (kick ? (kick === 'strike' ? -4 : 4) : Math.round(swing * 4));
  grid.rect(armX, torsoTop + 1, 3, 3, kit.shirt);
  grid.rect(armX, torsoTop + 4, 3, 1, kit.shirtTrim);
  grid.rect(armX, torsoTop + 5, 3, 3, kit.skin);

  const headTop = torsoTop - 1 - P.head;
  const hx = cx - 4 + lean;
  grid.rect(hx, headTop, 9, P.head, kit.skin);
  grid.rect(hx - 1, headTop, 9, 3, kit.hair);                  // hair sweeps back
  grid.rect(hx - 1, headTop + 3, 3, P.head - 6, kit.hair);
  grid.set(hx + 7, headTop + 5, OUTLINE); // eye
}

function drawLegSide(grid, kit, hipX, footX, legTop, base, lift) {
  const bottom = base - lift * 2;
  grid.rect(footX, bottom - 2, 5, 2, BOOT);
  grid.rect(footX, bottom - 5, 4, 3, kit.socks);
  grid.rect(footX, bottom - 5, 4, 1, kit.shirtTrim);
  // Thigh bridges from the hip toward the foot — a visible knee bend
  const kneeX = Math.round((footX + hipX) / 2) - 1;
  const thighH = P.leg - 5 + lift * 2;
  if (thighH > 0) grid.rect(kneeX, legTop, 4, thighH, kit.skin);
}

function shadeHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  const dim = (v) => Math.max(0, Math.round(v * 0.78));
  return '#' + [dim((n >> 16) & 255), dim((n >> 8) & 255), dim(n & 255)]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
}

function mirrorGrid(grid) {
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < Math.floor(grid.w / 2); x++) {
      const a = grid.data[y * grid.w + x];
      grid.data[y * grid.w + x] = grid.data[y * grid.w + (grid.w - 1 - x)];
      grid.data[y * grid.w + (grid.w - 1 - x)] = a;
    }
  }
}
