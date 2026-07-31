import { Assets, Rectangle, Texture } from 'pixi.js';

export interface Manifest {
  pxPerMeter: number;
  persp: { xsFar: number; xsSpan: number; sqFar: number; sqSpan: number };
  pitch: { length: number; width: number; apron: number };
  player: {
    frameW: number; frameH: number; baseline: number; dirs: string[]; frames: number;
    anims: { idle: number; runStart: number; runLen: number; windup: number; strike: number };
  };
  ball: { size: number; frames: number };
  fx: { dust: { size: number; frames: number }; grass: { size: number; frames: number }; ring: { size: number; frames: number }; tuft: { size: number; frames: number } };
  font: { cellW: number; cellH: number; glyphs: string };
  stand: { h: number };
  boards: { h: number };
  flag: { w: number; h: number; frames: number };
  variants: { id: string; name: string; pitch: string }[];
  playerSheets: string[];
}

export interface GameAssets {
  manifest: Manifest;
  pitch: Record<string, Texture>;
  // sheet name → [directionRow][frame]
  players: Record<string, Texture[][]>;
  ballFrames: Texture[];
  dustFrames: Texture[];
  grassFrames: Texture[];
  ringFrames: Texture[];
  tuftFrames: Texture[];
  flagFrames: Texture[];
  glyphs: Record<string, Texture>;
  shadow: Texture;
  skid: Texture;
  goalBar: Texture;
  stand: Texture;
  boards: Texture;
  dugout: Texture;
  cloud: Texture;
}

function sliceRow(sheet: Texture, frameW: number, frameH: number, row: number, count: number): Texture[] {
  return Array.from({ length: count }, (_, i) =>
    new Texture({ source: sheet.source, frame: new Rectangle(i * frameW, row * frameH, frameW, frameH) }),
  );
}

export async function loadAssets(): Promise<GameAssets> {
  const manifest: Manifest = await (await fetch('/assets/manifest.json')).json();
  const url = (f: string) => `/assets/${f}`;

  const names = [
    ...manifest.variants.map((v) => v.pitch),
    ...manifest.playerSheets,
    'ball.png', 'fx-dust.png', 'fx-grass.png', 'fx-ring.png', 'fx-shadow.png', 'fx-skid.png',
    'fx-tuft.png', 'goal-bar.png', 'font.png', 'stand.png', 'boards.png', 'dugout.png', 'flag.png', 'cloud.png',
  ];
  const loaded: Record<string, Texture> = {};
  await Promise.all(names.map(async (n) => { loaded[n] = await Assets.load(url(n)); }));

  const pitch: Record<string, Texture> = {};
  for (const v of manifest.variants) pitch[v.id] = loaded[v.pitch];

  const players: Record<string, Texture[][]> = {};
  const { frameW, frameH, dirs, frames } = manifest.player;
  for (const sheetName of manifest.playerSheets) {
    const key = sheetName.replace('players-', '').replace('.png', ''); // e.g. "hero-home"
    players[key] = dirs.map((_, row) => sliceRow(loaded[sheetName], frameW, frameH, row, frames));
  }

  const glyphs: Record<string, Texture> = {};
  const { cellW, cellH, glyphs: order } = manifest.font;
  [...order].forEach((ch, i) => {
    glyphs[ch] = new Texture({ source: loaded['font.png'].source, frame: new Rectangle(i * cellW, 0, cellW, cellH) });
  });

  return {
    manifest,
    pitch,
    players,
    ballFrames: sliceRow(loaded['ball.png'], manifest.ball.size, manifest.ball.size, 0, manifest.ball.frames),
    dustFrames: sliceRow(loaded['fx-dust.png'], manifest.fx.dust.size, manifest.fx.dust.size, 0, manifest.fx.dust.frames),
    grassFrames: sliceRow(loaded['fx-grass.png'], manifest.fx.grass.size, manifest.fx.grass.size, 0, manifest.fx.grass.frames),
    ringFrames: sliceRow(loaded['fx-ring.png'], manifest.fx.ring.size, manifest.fx.ring.size, 0, manifest.fx.ring.frames),
    tuftFrames: sliceRow(loaded['fx-tuft.png'], manifest.fx.tuft.size, manifest.fx.tuft.size, 0, manifest.fx.tuft.frames),
    flagFrames: sliceRow(loaded['flag.png'], manifest.flag.w, manifest.flag.h, 0, manifest.flag.frames),
    glyphs,
    shadow: loaded['fx-shadow.png'],
    skid: loaded['fx-skid.png'],
    goalBar: loaded['goal-bar.png'],
    stand: loaded['stand.png'],
    boards: loaded['boards.png'],
    dugout: loaded['dugout.png'],
    cloud: loaded['cloud.png'],
  };
}
