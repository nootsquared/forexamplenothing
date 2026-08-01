import { Assets, Rectangle, Texture } from 'pixi.js';

export interface Manifest {
  pxPerMeter: number;
  iso: { squash: number; zLift: number };
  pitch: { length: number; width: number; apron: number };
  player: {
    frameW: number; frameH: number; baseline: number; dirs: number; frames: number;
    anims: { idleStart: number; idleLen: number; runStart: number; runLen: number; kickStart: number; kickLen: number; lunge: number; recover: number };
  };
  ball: { size: number; dirs: number; phases: number; worldR: number };
  fx: { dust: { size: number; frames: number }; grass: { size: number; frames: number }; ring: { size: number; frames: number }; blade: { w: number; h: number; frames: number }; aim: { size: number; frames: number }; chev: { w: number; h: number; frames: number } };
  font: {
    cellW: number; cellH: number; glyphs: string; widths: Record<string, number>;
    micro: { cellW: number; cellH: number; glyphs: string; widths: Record<string, number> };
  };
  title: { w: number; h: number };
  stand: { h: number; frames: number };
  boards: { h: number };
  flag: { w: number; h: number; frames: number };
  cards: { w: number; h: number; figW: number; figH: number; rarities: string[]; coin: number };
  variants: { id: string; name: string; pitch: string }[];
  playerSheets: string[];
  flags: { w: number; h: number };
  nations: { id: string; name: string; color: string; sheets: { h: string; a: string } }[];
}

export interface GameAssets {
  manifest: Manifest;
  pitch: Record<string, Texture>;
  // sheet name → [directionRow][frame]
  players: Record<string, Texture[][]>;
  // [headingBin][rollPhase]
  ballFrames: Texture[][];
  dustFrames: Texture[];
  grassFrames: Texture[];
  ringFrames: Texture[];
  bladeFrames: Texture[];
  aimFrames: Texture[];
  chevFrames: Texture[]; // [0] solid gold "you", [1] white "E takes this man"
  flagFrames: Texture[];
  glyphs: Record<string, Texture>;
  microGlyphs: Record<string, Texture>;
  title: Texture; // the baked GOLAZO wordmark
  shadow: Texture;
  skid: Texture;
  goalBar: Texture;
  standFrames: Texture[];
  boards: Texture;
  dugout: Texture;
  cloud: Texture;
  cardFrames: Record<string, Texture>;   // rarity → frame
  cardFigures: Record<string, Texture>;  // rarity → kit figure
  coinFrames: Texture[]; // [red face, blue face, edge]
  flagFor: Record<string, Texture>; // nation id → its pixel flag
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
    'fx-blade.png', 'fx-aim.png', 'fx-chev.png', 'goal-bar.png', 'font.png', 'font-micro.png', 'title.png', 'stand.png', 'boards.png', 'dugout.png', 'flag.png', 'cloud.png',
    'cards.png', 'card-figures.png', 'coin.png', 'flags.png',
  ];
  const loaded: Record<string, Texture> = {};
  await Promise.all(names.map(async (n) => { loaded[n] = await Assets.load(url(n)); }));

  const pitch: Record<string, Texture> = {};
  for (const v of manifest.variants) pitch[v.id] = loaded[v.pitch];

  const players: Record<string, Texture[][]> = {};
  const { frameW, frameH, dirs, frames } = manifest.player;
  for (const sheetName of manifest.playerSheets) {
    const key = sheetName.replace('players-', '').replace('.png', ''); // e.g. "home"
    players[key] = Array.from({ length: dirs }, (_, row) => sliceRow(loaded[sheetName], frameW, frameH, row, frames));
  }

  const sliceGlyphs = (sheet: Texture, cellW: number, cellH: number, order: string) => {
    const out: Record<string, Texture> = {};
    [...order].forEach((ch, i) => {
      out[ch] = new Texture({ source: sheet.source, frame: new Rectangle(i * cellW, 0, cellW, cellH) });
    });
    return out;
  };
  const glyphs = sliceGlyphs(loaded['font.png'], manifest.font.cellW, manifest.font.cellH, manifest.font.glyphs);
  const microGlyphs = sliceGlyphs(loaded['font-micro.png'], manifest.font.micro.cellW, manifest.font.micro.cellH, manifest.font.micro.glyphs);

  return {
    manifest,
    pitch,
    players,
    ballFrames: Array.from({ length: manifest.ball.dirs }, (_, dir) =>
      sliceRow(loaded['ball.png'], manifest.ball.size, manifest.ball.size, dir, manifest.ball.phases)),
    dustFrames: sliceRow(loaded['fx-dust.png'], manifest.fx.dust.size, manifest.fx.dust.size, 0, manifest.fx.dust.frames),
    grassFrames: sliceRow(loaded['fx-grass.png'], manifest.fx.grass.size, manifest.fx.grass.size, 0, manifest.fx.grass.frames),
    ringFrames: sliceRow(loaded['fx-ring.png'], manifest.fx.ring.size, manifest.fx.ring.size, 0, manifest.fx.ring.frames),
    bladeFrames: sliceRow(loaded['fx-blade.png'], manifest.fx.blade.w, manifest.fx.blade.h, 0, manifest.fx.blade.frames),
    aimFrames: sliceRow(loaded['fx-aim.png'], manifest.fx.aim.size, manifest.fx.aim.size, 0, manifest.fx.aim.frames),
    chevFrames: sliceRow(loaded['fx-chev.png'], manifest.fx.chev.w, manifest.fx.chev.h, 0, manifest.fx.chev.frames),
    flagFrames: sliceRow(loaded['flag.png'], manifest.flag.w, manifest.flag.h, 0, manifest.flag.frames),
    glyphs,
    microGlyphs,
    title: loaded['title.png'],
    shadow: loaded['fx-shadow.png'],
    skid: loaded['fx-skid.png'],
    goalBar: loaded['goal-bar.png'],
    standFrames: Array.from({ length: manifest.stand.frames }, (_, i) =>
      new Texture({ source: loaded['stand.png'].source, frame: new Rectangle(0, i * manifest.stand.h, loaded['stand.png'].width, manifest.stand.h) })),
    boards: loaded['boards.png'],
    dugout: loaded['dugout.png'],
    cloud: loaded['cloud.png'],
    cardFrames: Object.fromEntries(manifest.cards.rarities.map((r, i) => [r,
      new Texture({ source: loaded['cards.png'].source, frame: new Rectangle(i * manifest.cards.w, 0, manifest.cards.w, manifest.cards.h) })])),
    cardFigures: Object.fromEntries(manifest.cards.rarities.map((r, i) => [r,
      new Texture({ source: loaded['card-figures.png'].source, frame: new Rectangle(i * manifest.cards.figW, 0, manifest.cards.figW, manifest.cards.figH) })])),
    coinFrames: sliceRow(loaded['coin.png'], manifest.cards.coin, manifest.cards.coin, 0, 3),
    flagFor: Object.fromEntries(manifest.nations.map((n, i) => [n.id,
      new Texture({ source: loaded['flags.png'].source, frame: new Rectangle(i * manifest.flags.w, 0, manifest.flags.w, manifest.flags.h) })])),
  };
}

// National kits load on demand — 30 raytraced sheets would tax every boot,
// so a match fetches just the two wardrobes it dresses in
export async function loadNationSheets(assets: GameAssets, sheetFiles: string[]) {
  const { frameW, frameH, dirs, frames } = assets.manifest.player;
  await Promise.all(sheetFiles.map(async (file) => {
    const key = file.replace('players-', '').replace('.png', '');
    if (assets.players[key]) return;
    const sheet = await Assets.load(`/assets/${file}`);
    assets.players[key] = Array.from({ length: dirs }, (_, row) => sliceRow(sheet, frameW, frameH, row, frames));
  }));
}
