import { writeFileSync, mkdirSync } from 'node:fs';
import { savePNG, makeCanvas } from './lib.mjs';
import { VARIANTS, KITS, PX_PER_METER, PERSPECTIVE } from './palettes.mjs';
import { generatePitchTexture, PITCH } from './pitch.mjs';
import { generatePlayerSheet, FRAME_W, FRAME_H, BASELINE, DIRS, FRAMES } from './players.mjs';
import { generateBallSheet, BALL_SIZE, BALL_FRAMES } from './ball.mjs';
import { generateDustSheet, generateGrassBitsSheet, generateRingSheet, generateShadow, generateSkid, generateTuftSheet, generateGoalBar } from './fx.mjs';
import { generateFontSheet, GLYPHS, CELL_W, CELL_H } from './font.mjs';
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
savePNG(generateTuftSheet(), `${OUT}fx-tuft.png`);
savePNG(generateGoalBar(), `${OUT}goal-bar.png`);
savePNG(generateFontSheet(), `${OUT}font.png`);
savePNG(generateStand(), `${OUT}stand.png`);
savePNG(generateBoards(), `${OUT}boards.png`);
savePNG(generateDugout(), `${OUT}dugout.png`);
savePNG(generateCornerFlag(), `${OUT}flag.png`);
savePNG(generateCloudShadow(), `${OUT}cloud.png`);

// Single source of truth the renderer reads: frame geometry + variant list
const manifest = {
  pxPerMeter: PX_PER_METER,
  persp: PERSPECTIVE,
  pitch: { length: PITCH.length, width: PITCH.width, apron: PITCH.apron },
  player: {
    frameW: FRAME_W, frameH: FRAME_H, baseline: BASELINE, dirs: DIRS, frames: FRAMES,
    anims: { idle: 0, runStart: 1, runLen: 8, windup: 9, strike: 10 },
  },
  ball: { size: BALL_SIZE, frames: BALL_FRAMES },
  fx: { dust: { size: 14, frames: 5 }, grass: { size: 12, frames: 4 }, ring: { size: 26, frames: 3 }, tuft: { size: 10, frames: 6 } },
  font: { cellW: CELL_W, cellH: CELL_H, glyphs: GLYPHS },
  stand: { h: STAND_H },
  boards: { h: BOARD_H },
  flag: { w: 10, h: 16, frames: 2 },
  variants: VARIANTS.map((v) => ({ id: v.id, name: v.name, pitch: `pitch-${v.id}.png` })),
  playerSheets,
};
writeFileSync(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));

await buildPreview();
console.log(`assets generated in ${(performance.now() - t0).toFixed(0)}ms → public/assets/`);

// Contact sheet for human/agent review: full pitches, 1:1 turf crops
// (goalmouth + center circle), zoomed sprites
async function buildPreview() {
  const { loadImage } = await import('@napi-rs/canvas');
  const { canvas, ctx } = makeCanvas(1500, 1250);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#14181f';
  ctx.fillRect(0, 0, 1500, 1250);

  const [day, night, home, away, ball] = await Promise.all(
    ['pitch-day.png', 'pitch-night.png', 'players-home.png', 'players-away.png', 'ball.png']
      .map((name) => loadImage(OUT + name)),
  );
  ctx.drawImage(day, 0, 0, day.width, day.height, 10, 10, 730, 480);
  ctx.drawImage(night, 0, 0, night.width, night.height, 760, 10, 730, 480);

  const M = PX_PER_METER;
  const ox = PITCH.apron * M;
  const oy = PITCH.apron * M;
  // Goalmouth crop at 2× — judge the blade texture, fringe and lines up close
  ctx.drawImage(day, ox - 3 * M, oy + (34 - 8) * M, 22 * M, 16 * M, 10, 510, 22 * M * 2, 16 * M * 2);
  // Center circle crop at 2×
  ctx.drawImage(day, ox + (52.5 - 11) * M, oy + (34 - 8) * M, 22 * M, 16 * M, 740, 510, 22 * M * 2, 16 * M * 2);

  ctx.drawImage(home, 0, 0, home.width, home.height, 10, 1040, home.width * 0.55, home.height * 0.55);
  ctx.drawImage(away, 0, 0, away.width, away.height, 10 + home.width * 0.55 + 20, 1040, away.width * 0.55, away.height * 0.55);
  ctx.drawImage(home, 0, 0, FRAME_W * 4, FRAME_H, 460, 1040, FRAME_W * 4 * 4, FRAME_H * 4);
  ctx.drawImage(ball, 0, 0, ball.width, ball.height, 460, 1195, ball.width * 4, ball.height * 4);
  savePNG(canvas, `${OUT}preview.png`);
}
