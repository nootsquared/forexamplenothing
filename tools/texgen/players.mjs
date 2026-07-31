import { makeCanvas, PixelGrid } from './lib.mjs';

export const FRAME_W = 32;
export const FRAME_H = 36;
export const BASELINE = 33; // foot line inside the frame
// Row order on the sheet; renderer maps facing angle → row
export const DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
export const FRAMES = 11; // 0 idle, 1-8 run cycle, 9 kick windup, 10 kick strike

const BOOT = '#26211f';
const OUTLINE = '#1a1626';
// Locked art direction: stocky retro dudes — big head, barrel chest, short
// quick legs. Proportioned to the 14px ball, small against the pitch.
const P = { head: 8, torso: 7, shorts: 3, leg: 7 };

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
  const p = { grid, kit, swing, kick, view, diag, bob: Math.abs(swing) > 0.7 ? 1 : 0 };
  if (view === 'side') paintSide(p);
  else paintFrontBack(p);
  if (mirror) mirrorGrid(grid);
}

// Front and back views: legs lift alternately, arms pump, limbs sit clear of
// the torso so the outline pass separates them — that's what reads as "a body"
function paintFrontBack(p) {
  const { grid, kit, swing, kick, view, diag, bob } = p;
  const cx = 16 + (diag ? 1 : 0);
  const base = BASELINE - bob;
  const legTop = base - P.leg;
  const lLift = kick === 'strike' ? 3 : Math.max(0, Math.round(swing * 2.5));
  const rLift = kick === 'windup' ? 3 : Math.max(0, Math.round(-swing * 2.5));

  drawLegFB(grid, kit, cx - 4, legTop, base, lLift, diag ? 1 : 0);
  drawLegFB(grid, kit, cx + 2, legTop, base, rLift, diag ? -1 : 0);

  const shortsTop = legTop - P.shorts;
  grid.rect(cx - 5, shortsTop, 10, P.shorts, kit.shorts);
  grid.rect(cx - 5, shortsTop + P.shorts - 1, 10, 1, shadeHex(kit.shorts));

  const lean = kick === 'windup' ? 1 : kick === 'strike' ? -1 : 0;
  const torsoTop = shortsTop - P.torso + lean;
  grid.rect(cx - 5, torsoTop, 10, P.torso, kit.shirt);
  grid.rect(cx - 5, torsoTop, 10, 1, kit.shirtTrim);              // shoulder trim
  grid.rect(cx - 5, torsoTop + P.torso - 1, 10, 1, shadeHex(kit.shirt));
  if (view === 'front') {
    grid.rect(cx - 1, torsoTop + 1, 2, 2, kit.shirtTrim);         // collar V
  }

  const armSwing = kick ? (kick === 'windup' ? -2 : 2) : Math.round(swing * 2);
  drawArmFB(grid, kit, cx - 8, torsoTop + 1 + armSwing);
  drawArmFB(grid, kit, cx + 6, torsoTop + 1 - armSwing);

  const headTop = torsoTop - 1 - P.head;
  const hx = cx - 4; // 9 wide — the big retro head
  if (view === 'front') {
    grid.rect(hx, headTop, 9, P.head, kit.skin);
    grid.rect(hx, headTop, 9, 2, kit.hair);
    grid.set(hx, headTop + 2, kit.hair);
    grid.set(hx + 8, headTop + 2, kit.hair);
    const eyeY = headTop + 4;
    grid.set(hx + 2, eyeY, OUTLINE);
    grid.set(hx + 6, eyeY, OUTLINE);
  } else {
    grid.rect(hx, headTop, 9, P.head, kit.hair);
    grid.rect(hx + 1, headTop + P.head - 1, 7, 1, kit.skin); // neck peek
  }
}

function drawLegFB(grid, kit, x, legTop, base, lift, splay) {
  const bottom = base - lift;
  grid.rect(x + splay, bottom - 2, 3, 2, BOOT);
  grid.rect(x + splay, bottom - 5, 3, 3, kit.socks);
  grid.rect(x + splay, bottom - 5, 3, 1, kit.shirtTrim); // sock stripe
  const thighH = P.leg - 5 + lift;
  if (thighH > 0) grid.rect(x, legTop, 3, thighH, kit.skin);
}

function drawArmFB(grid, kit, x, y) {
  grid.rect(x, y, 2, 2, kit.shirt);   // sleeve
  grid.rect(x, y + 2, 2, 3, kit.skin);
}

// Side view: the stride reads on screen-x with knee bend; kicks extend the leg
function paintSide(p) {
  const { grid, kit, swing, kick, bob } = p;
  const cx = 16;
  const base = BASELINE - bob;
  const legTop = base - P.leg;
  const stride = Math.round(swing * 3);

  const backX = kick === 'windup' ? cx - 6 : cx - stride - 1;
  const frontX = kick === 'strike' ? cx + 6 : cx + stride - 1;
  drawLegSide(grid, kit, cx, backX, legTop, base, stride < -1 || kick === 'windup' ? 1 : 0);
  drawLegSide(grid, kit, cx, frontX, legTop, base, stride > 1 || kick === 'strike' ? 1 : 0);

  const shortsTop = legTop - P.shorts;
  grid.rect(cx - 3, shortsTop, 7, P.shorts, kit.shorts);
  grid.rect(cx - 3, shortsTop + P.shorts - 1, 7, 1, shadeHex(kit.shorts));

  const lean = kick === 'windup' ? -2 : kick === 'strike' ? 2 : Math.round(swing * 0.6);
  const torsoTop = shortsTop - P.torso;
  grid.rect(cx - 3 + lean, torsoTop, 6, P.torso, kit.shirt);
  grid.rect(cx - 3 + lean, torsoTop, 6, 1, kit.shirtTrim);
  grid.rect(cx - 3 + lean, torsoTop + P.torso - 1, 6, 1, shadeHex(kit.shirt));

  // The near arm swings across the body, resting a touch forward at idle
  const armX = cx - 1 + lean + (kick ? (kick === 'strike' ? -4 : 4) : Math.round(swing * 3));
  grid.rect(armX, torsoTop + 1, 2, 2, kit.shirt);
  grid.rect(armX, torsoTop + 3, 2, 3, kit.skin);

  const headTop = torsoTop - 1 - P.head;
  const hx = cx - 3 + lean;
  grid.rect(hx, headTop, 8, P.head, kit.skin);
  grid.rect(hx - 1, headTop, 8, 2, kit.hair);                    // hair sweeps back
  grid.rect(hx - 1, headTop + 2, 2, P.head - 4, kit.hair);
  grid.set(hx + 6, headTop + 4, OUTLINE); // eye
}

function drawLegSide(grid, kit, hipX, footX, legTop, base, lift) {
  const bottom = base - lift * 2;
  grid.rect(footX, bottom - 2, 4, 2, BOOT);
  grid.rect(footX, bottom - 5, 3, 3, kit.socks);
  grid.rect(footX, bottom - 5, 3, 1, kit.shirtTrim);
  // Thigh bridges from the hip toward the foot — a visible knee bend
  const kneeX = Math.round((footX + hipX) / 2) - 1;
  const thighH = P.leg - 5 + lift * 2;
  if (thighH > 0) grid.rect(kneeX, legTop, 3, thighH, kit.skin);
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
