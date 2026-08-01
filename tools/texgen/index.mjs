import { writeFileSync, mkdirSync } from 'node:fs';
import { savePNG, makeCanvas } from './lib.mjs';
import { VARIANTS, KITS, PX_PER_METER, ISO } from './palettes.mjs';
import { generatePitchTexture, PITCH } from './pitch.mjs';
import { generatePlayerSheet, FRAME_W, FRAME_H, BASELINE, DIRS, FRAMES } from './players.mjs';
import { generateBallSheet, BALL_SIZE, BALL_DIRS, BALL_PHASES, BALL_VISUAL_R } from './ball.mjs';
import { generateDustSheet, generateGrassBitsSheet, generateRingSheet, generateShadow, generateSkid, generateBladeSheet, generateAimArrowSheet, generateSwitchChevrons, generateGoalBar, BLADE_W, BLADE_H, BLADE_FRAMES, AIM_SIZE, AIM_DIRS, CHEV_W, CHEV_H } from './fx.mjs';
import { generateFontSheet, generateTitleSheet, GLYPHS, CELL_W, CELL_H, TITLE_W, TITLE_H } from './font.mjs';
import { generateStand, generateBoards, generateDugout, generateCornerFlag, generateCloudShadow, STAND_H, BOARD_H } from './stands.mjs';

const OUT = new URL('../../public/assets/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const t0 = performance.now();

for (const variant of VARIANTS) {
  savePNG(generatePitchTexture(variant), `${OUT}pitch-${variant.id}.png`);
}
const playerSheets = [];
for (const kit of KITS) {
  const name = `players-${kit.id}.png`;
  savePNG(generatePlayerSheet(kit), OUT + name);
  playerSheets.push(name);
}
savePNG(generateBallSheet(), `${OUT}ball.png`);
savePNG(generateDustSheet(), `${OUT}fx-dust.png`);
savePNG(generateGrassBitsSheet(), `${OUT}fx-grass.png`);
savePNG(generateRingSheet(), `${OUT}fx-ring.png`);
savePNG(generateShadow(), `${OUT}fx-shadow.png`);
savePNG(generateSkid(), `${OUT}fx-skid.png`);
savePNG(generateBladeSheet(), `${OUT}fx-blade.png`);
savePNG(generateAimArrowSheet(), `${OUT}fx-aim.png`);
savePNG(generateSwitchChevrons(), `${OUT}fx-chev.png`);
savePNG(generateGoalBar(), `${OUT}goal-bar.png`);
savePNG(generateFontSheet(), `${OUT}font.png`);
savePNG(generateTitleSheet(), `${OUT}title.png`);
savePNG(generateStand(), `${OUT}stand.png`);
savePNG(generateBoards(), `${OUT}boards.png`);
savePNG(generateDugout(), `${OUT}dugout.png`);
savePNG(generateCornerFlag(), `${OUT}flag.png`);
savePNG(generateCloudShadow(), `${OUT}cloud.png`);

// Single source of truth the renderer reads: projection + frame geometry
const manifest = {
  pxPerMeter: PX_PER_METER,
  iso: ISO,
  pitch: { length: PITCH.length, width: PITCH.width, apron: PITCH.apron },
  player: {
    frameW: FRAME_W, frameH: FRAME_H, baseline: BASELINE, dirs: DIRS, frames: FRAMES,
    anims: { idleStart: 0, idleLen: 2, runStart: 2, runLen: 8, kickStart: 10, kickLen: 3, lunge: 13, recover: 14 },
  },
  ball: { size: BALL_SIZE, dirs: BALL_DIRS, phases: BALL_PHASES, worldR: BALL_VISUAL_R },
  fx: {
    dust: { size: 14, frames: 5 }, grass: { size: 12, frames: 4 }, ring: { size: 26, frames: 3 },
    blade: { w: BLADE_W, h: BLADE_H, frames: BLADE_FRAMES },
    aim: { size: AIM_SIZE, frames: AIM_DIRS },
    chev: { w: CHEV_W, h: CHEV_H, frames: 2 },
  },
  font: { cellW: CELL_W, cellH: CELL_H, glyphs: GLYPHS },
  title: { w: TITLE_W, h: TITLE_H },
  stand: { h: STAND_H, frames: 2 },
  boards: { h: BOARD_H },
  flag: { w: 10, h: 16, frames: 2 },
  variants: VARIANTS.map((v) => ({ id: v.id, name: v.name, pitch: `pitch-${v.id}.png` })),
  playerSheets,
};
writeFileSync(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));

await buildPreview();
console.log(`assets generated in ${(performance.now() - t0).toFixed(0)}ms → public/assets/`);

// Contact sheet for human/agent review: full pitches, 1:1 turf crops,
// zoomed player directions and the ball's roll matrix
async function buildPreview() {
  const { loadImage } = await import('@napi-rs/canvas');
  const { canvas, ctx } = makeCanvas(1560, 1560);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#14181f';
  ctx.fillRect(0, 0, 1560, 1560);

  const [day, night, home, away, ball] = await Promise.all(
    ['pitch-day.png', 'pitch-night.png', 'players-home.png', 'players-away.png', 'ball.png']
      .map((name) => loadImage(OUT + name)),
  );
  ctx.drawImage(day, 0, 0, day.width, day.height, 10, 10, 730, 420);
  ctx.drawImage(night, 0, 0, night.width, night.height, 760, 10, 730, 420);

  const M = PX_PER_METER;
  const ox = PITCH.apron * M;
  const oy = PITCH.apron * M * ISO.squash;
  // Goalmouth + center circle crops at 2× — judge turf and chalk up close
  ctx.drawImage(day, ox - 3 * M, oy + (34 - 8) * M * ISO.squash, 22 * M, 16 * M, 10, 450, 22 * M * 2, 16 * M * 2);
  ctx.drawImage(day, ox + (52.5 - 11) * M, oy + (34 - 8) * M * ISO.squash, 22 * M, 16 * M, 760, 450, 22 * M * 2, 16 * M * 2);

  // Every heading's run frame at 5× — omnidirectional readability check
  for (let d = 0; d < DIRS; d++) {
    const col = d % 8;
    const row = Math.floor(d / 8);
    ctx.drawImage(home, 4 * FRAME_W, d * FRAME_H, FRAME_W, FRAME_H,
      10 + col * FRAME_W * 5, 980 + row * FRAME_H * 5, FRAME_W * 5, FRAME_H * 5);
  }
  // One direction's full frame strip: idle, run cycle, kick — home and away
  ctx.drawImage(home, 0, 2 * FRAME_H, FRAME_W * FRAMES, FRAME_H, 10, 1290, FRAME_W * FRAMES * 3, FRAME_H * 3);
  ctx.drawImage(away, 0, 10 * FRAME_H, FRAME_W * FRAMES, FRAME_H, 10, 1380, FRAME_W * FRAMES * 3, FRAME_H * 3);
  // Ball roll matrix at 4×
  ctx.drawImage(ball, 0, 0, ball.width, ball.height, 1240, 980, ball.width * 4, ball.height * 4);
  savePNG(canvas, `${OUT}preview.png`);
}
