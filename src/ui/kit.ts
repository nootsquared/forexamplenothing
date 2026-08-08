import { Container, Graphics, Rectangle } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';

// Pixel UI atoms every screen shares: panels, shades, the materialize
// choreographer, and the pick-list.

// The shell's palette, named once. Gold speaks, mint accents, cloth is the
// plate itself — anything that paints a panel reads them from here.
export const GOLD = 0xffd95e;
export const GOLD_LIT = 0xfff3c4;
export const MINT = 0x9ff0b8;

// The crop-mark corner: four L-brackets and nothing between them. It is the
// shell's "this is a plate" mark, so it is drawn from ONE recipe — five
// hand-copies with five different arm lengths is five subtly different games.
const CORNER_ARM = 9;
const CORNER_T = 2;

export function cornerMarks(g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha = 0.68) {
  const a = CORNER_ARM;
  const t = CORNER_T;
  const paint = { color, alpha };
  for (const right of [false, true]) {
    for (const low of [false, true]) {
      g.rect(right ? x + w - a : x, low ? y + h - t : y, a, t).fill(paint);
      g.rect(right ? x + w - t : x, low ? y + h - a : y, t, a).fill(paint);
    }
  }
}

// Center a whole ROW of pixel text — words, keycaps, a link — on a point.
// Bounds are no good here: every glyph is baked into a fixed-width cell, so a
// row ending in a narrow letter measures wider than the ink you can see. Ask
// the children how much of them is actually inked and center THAT.
export function centerRow(node: Container, x: number, y: number) {
  let right = 0;
  for (const c of node.children) {
    right = Math.max(right, c.position.x + (c instanceof PixelText ? c.textWidth : c.width));
  }
  node.position.set(Math.round(x - right / 2), Math.round(y));
}

// A link out of the game, and there is only one of these in the whole shell:
// gold word, gold rule under it, brightens under the cursor, clicks like a
// card. Learn it on the front door and it is the same thing everywhere.
export function externalLink(assets: GameAssets, label: string, url: string): Container {
  const row = new Container();
  const word = new PixelText(assets, 2, GOLD);
  word.text = label;
  const rule = new Graphics().rect(0, word.textHeight + 2, word.textWidth, 2).fill({ color: GOLD, alpha: 0.55 });
  row.addChild(rule, word);
  row.eventMode = 'static';
  row.cursor = 'pointer';
  row.on('pointerover', () => { word.tint = GOLD_LIT; rule.alpha = 1; audio.ui('move', 0.3); });
  row.on('pointerout', () => { word.tint = GOLD; rule.alpha = 0.55; });
  row.on('pointertap', () => { audio.ui('card', 0.5); window.open(url, '_blank'); });
  return row;
}

export function panel(w: number, h: number): Graphics {
  const g = new Graphics();
  g.rect(0, 0, w, h).fill({ color: 0x10141c, alpha: 0.92 });
  g.rect(0, 0, w, 2).fill({ color: 0xffd95e, alpha: 0.5 });
  g.rect(0, h - 2, w, 2).fill({ color: 0x000000, alpha: 0.5 });
  g.rect(0, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
  g.rect(w - 1, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
  return g;
}

// One dark cloth for every shade: not a flat slab but a WOVEN one — faint
// scanline rows through the body so the dark reads as material, and a
// checkerboard dither where it lets go of the pitch, the way pixel art has
// always faded. The live match glows faintly through the weave.
const SHADE = 0x070a10;

function weave(g: Graphics, x: number, y: number, w: number, h: number) {
  for (let ry = y; ry < y + h; ry += 4) {
    g.rect(x, ry, w, 1).fill({ color: 0x000000, alpha: 0.1 });
  }
  for (let ry = y + 22; ry < y + h; ry += 44) {
    g.rect(x, ry, w, 1).fill({ color: 0xfff8e0, alpha: 0.022 });
  }
}

// Pixel falloff: three checker columns per side, 75% → 50% → 25% full,
// the innermost cell FLUSH against the slab on both sides
function ditherEdge(g: Graphics, x: number, h: number, dir: 1 | -1, alpha: number) {
  const cell = 4;
  const density = [3, 2, 1];
  density.forEach((keep, col) => {
    for (let sub = 0; sub < 3; sub++) {
      const off = (col * 3 + sub) * cell;
      const cx = dir === 1 ? x + off : x - off - cell;
      for (let ry = 0, i = 0; ry < h; ry += cell, i++) {
        if ((i + sub * 2 + col) % 4 < keep) g.rect(cx, ry, cell, cell).fill({ color: SHADE, alpha });
      }
    }
  });
}

// The pillar's footprint — shared by the shade, the watermark and the motes
export function pillarBounds(w: number, pillarW = 620) {
  const coreW = Math.min(pillarW, w * 0.72);
  const x0 = Math.round((w - coreW) / 2);
  return { x0, x1: x0 + Math.round(coreW), coreW: Math.round(coreW) };
}

// The centered stage: a full dim over the live pitch and a slab of dark
// GLASS down the middle — the match ghosts through it, its edges dissolve in
// a smooth gradient, a cold highlight rims each side. Light moves through
// the pane separately (GlassFlow); this is only the glass itself.
export function centerShade(g: Graphics, w: number, h: number, pillarW = 620) {
  g.clear();
  g.rect(0, 0, w, h).fill({ color: SHADE, alpha: 0.58 });
  const { x0, coreW } = pillarBounds(w, pillarW);
  g.rect(x0, 0, coreW, h).fill({ color: SHADE, alpha: 0.84 });
  weave(g, x0, 0, coreW, h); // the pane is cloth, not paint
  // the pane lets go of the pitch the pixel way — checkered, not blurred
  ditherEdge(g, x0, h, -1, 0.84);
  ditherEdge(g, x0 + coreW, h, 1, 0.84);
  // cold rim light on both faces of the pane, gold whisper past the dither
  g.rect(x0, 0, 1, h).fill({ color: 0xcfe0ff, alpha: 0.09 });
  g.rect(x0 + coreW - 1, 0, 1, h).fill({ color: 0xcfe0ff, alpha: 0.09 });
  g.rect(x0 - 40, 0, 1, h).fill({ color: 0xffd95e, alpha: 0.05 });
  g.rect(x0 + coreW + 39, 0, 1, h).fill({ color: 0xffd95e, alpha: 0.05 });
}

// The overgrown bed: long 2D blades of grass — each one its own tapered,
// curling ribbon with a lit vein down its heart — rooted along the pane's
// floor and spilling over its edges like hair. Three depths, every blade
// its own length, curl, and swing. A clearing parts the bed around
// whatever rests in it (the ball).
interface Blade {
  bx: number; by: number;       // root
  dir: number;                  // growth angle at the root
  len: number;
  curl: number;                 // how far the tip bends past the root angle
  width: number;
  phase: number; speed: number; amp: number;
  body: number; vein: number;   // its two greens
  layer: 0 | 1;                 // 0 behind the ball, 1 in front
}

const BLADE_T = [0, 0.2, 0.4, 0.6, 0.78, 0.92, 1];

export class GrassBed {
  soil = new Graphics();   // the ground itself: bumpy, ridged, drawn once
  back = new Graphics();
  front = new Graphics();
  private blades: Blade[] = [];
  private t = 0;
  private seed = 97;

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  // Plant the bed for this pane size. `clear` is the resting ball: blades
  // rooted near it lean away, so the bed visibly cradles it.
  layout(x0: number, coreW: number, h: number, clear?: { x: number; y: number; r: number }) {
    this.seed = 97;
    this.blades = [];
    const shades: [number, number][][] = [
      [[0x16301f, 0x24462b]],                    // far silhouettes
      [[0x27502f, 0x3c7443], [0x2d5c36, 0x4a8347]],
      [[0x336b3b, 0x55984f], [0x3a7a41, 0x63a85a]],
    ];
    const plant = (bx: number, by: number, dir: number, len: number, curl: number, depth: number) => {
      // a resting ball obeys physics: nothing tall grows THROUGH it, the
      // short stuff in front of it stays short, and neighbours part around
      let leanLen = len;
      if (clear) {
        const dx = Math.abs(bx - clear.x);
        if (dx < clear.r * 0.75 && depth !== 2) return;
        if (dx < clear.r * 0.8 && depth === 2) leanLen = Math.min(len, 24 + this.rand() * 16);
      }
      const [body, vein] = shades[depth][Math.floor(this.rand() * shades[depth].length)];
      const dry = depth === 2 && this.rand() < 0.06; // the odd sun-dried blade
      let lean = 0;
      if (clear && Math.abs(bx - clear.x) < clear.r * 2.4) {
        lean = (bx < clear.x ? -1 : 1) * (0.45 / (1 + Math.abs(bx - clear.x) / clear.r));
      }
      this.blades.push({
        bx, by, dir: dir + lean, len: leanLen, curl: curl + lean * 0.6,
        width: 2 + this.rand() * 2.4 + depth * 0.5,
        phase: this.rand() * Math.PI * 2,
        speed: 0.5 + this.rand() * 0.7,
        amp: (0.035 + this.rand() * 0.075) * (depth === 2 ? 1.35 : 1),
        body: dry ? 0x7d7d44 : body,
        vein: dry ? 0xb0aa5e : vein,
        layer: depth === 2 ? 1 : 0,
      });
    };
    // the bed is built like real turf: a PACKED short understory carrying
    // the mass, a moderate middle, and only a sparse few reaching tall
    const tiers: { depth: 0 | 1 | 2; gap: number; reach: [number, number] }[] = [
      { depth: 0, gap: 42, reach: [140, 235] },  // the tall few, dark, behind
      { depth: 1, gap: 8, reach: [60, 130] },    // the middle
      { depth: 2, gap: 4, reach: [22, 78] },     // the packed floor
    ];
    for (const tier of tiers) {
      const count = Math.round(coreW / tier.gap);
      for (let i = 0; i < count; i++) {
        const bx = x0 + 4 + this.rand() * (coreW - 8);
        plant(
          bx, h + 6 + this.rand() * 12,
          -Math.PI / 2 + (this.rand() - 0.5) * (tier.depth === 2 ? 0.7 : 0.5),
          tier.reach[0] + this.rand() * (tier.reach[1] - tier.reach[0]),
          (this.rand() - 0.35) * 0.95,
          tier.depth,
        );
      }
    }
    // the ground: pixel-celled earth with a WANDERING ridge line, darker
    // clods and mossy flecks buried in it — soil, not a bar
    this.soil.clear();
    const cell = 4;
    let rise = 26;
    for (let cx = x0; cx < x0 + coreW; cx += cell) {
      rise = Math.max(18, Math.min(42, rise + (this.rand() - 0.5) * 7));
      const top = h - Math.round(rise / cell) * cell;
      for (let cy = top; cy < h + cell; cy += cell) {
        const r = this.rand();
        const color = cy === top ? 0x24462b            // the lit lip of the ridge
          : r < 0.1 ? 0x0d1a10                          // a dark clod
          : r < 0.16 ? 0x1c3a22                         // a mossy fleck
          : 0x122417;                                   // packed earth
        this.soil.rect(cx, cy, cell, cell).fill({ color, alpha: 0.94 });
      }
    }
  }

  update(dt: number) {
    if (!this.blades.length) return;
    this.t += dt;
    this.back.clear();
    this.front.clear();
    for (const b of this.blades) {
      const g = b.layer === 1 ? this.front : this.back;
      const swing = Math.sin(this.t * b.speed + b.phase) * b.amp;
      const tipDir = b.dir + b.curl * 0.85 + swing;
      // spine: root → mid (root direction) → tip (curled direction)
      const mx = b.bx + Math.cos(b.dir + swing * 0.35) * b.len * 0.55;
      const my = b.by + Math.sin(b.dir + swing * 0.35) * b.len * 0.55;
      const tx = mx + Math.cos(tipDir) * b.len * 0.45;
      const ty = my + Math.sin(tipDir) * b.len * 0.45;
      const spine = BLADE_T.map((t) => {
        const a = 1 - t;
        return {
          x: a * a * b.bx + 2 * a * t * mx + t * t * tx,
          y: a * a * b.by + 2 * a * t * my + t * t * ty,
        };
      });
      // ribbon: widths taper to the tip; the poly walks up one flank, back
      // down the other
      const left: { x: number; y: number }[] = [];
      const right: { x: number; y: number }[] = [];
      for (let i = 0; i < spine.length; i++) {
        const p = spine[i];
        const q = spine[Math.min(i + 1, spine.length - 1)];
        const pr = spine[Math.max(i - 1, 0)];
        const nx = q.y - pr.y;
        const ny = -(q.x - pr.x);
        const nl = Math.hypot(nx, ny) || 1;
        const wHere = b.width * Math.pow(1 - BLADE_T[i], 1.12);
        left.push({ x: p.x + (nx / nl) * wHere, y: p.y + (ny / nl) * wHere });
        right.push({ x: p.x - (nx / nl) * wHere, y: p.y - (ny / nl) * wHere });
      }
      g.poly([...left, ...right.reverse()]).fill({ color: b.body, alpha: b.layer === 1 ? 0.98 : 0.95 });
      // the lit vein up the blade's heart — the shading inside each one
      g.moveTo(spine[0].x, spine[0].y);
      for (let i = 1; i < spine.length - 1; i++) g.lineTo(spine[i].x, spine[i].y);
      g.stroke({ width: Math.max(1, b.width * 0.5), color: b.vein, alpha: 0.55 });
    }
  }
}

// Stadium set-dressing for the beam's empty air: the pitch's own centre
// circle and halfway line, plotted CELL BY CELL like chalk pixels and kept
// strictly inside the cloth — the channel's own ceremonial ground
export function pitchMark(g: Graphics, w: number, h: number, x0: number, x1: number) {
  g.clear();
  const cy = Math.round(h * 0.58);
  const r = Math.round(Math.min(h * 0.34, w * 0.3));
  const inL = x0 + 10;
  const inR = x1 - 12;
  const cellAt = (x: number, y: number, alpha: number) => {
    if (x < inL || x > inR) return;
    g.rect(Math.round(x / 2) * 2, Math.round(y / 2) * 2, 2, 2).fill({ color: 0xfff8e0, alpha });
  };
  const steps = Math.ceil((Math.PI * 2 * r) / 2);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    cellAt(w / 2 + Math.cos(a) * r, cy + Math.sin(a) * r, 0.055);
  }
  for (let x = inL; x <= inR; x += 2) cellAt(x, cy, 0.05);
  g.rect(Math.round(w / 2) - 3, cy - 3, 6, 6).fill({ color: 0xfff8e0, alpha: 0.055 });
}

// Floodlight dust: a dozen motes drifting slowly up the beam, breathing —
// the pillar's air made visible
interface BeamMote {
  x: number; y: number; speed: number; phase: number; size: number; gold: boolean;
}

export class BeamMotes {
  g = new Graphics();
  private motes: BeamMote[] = [];
  private t = 0;
  private x0 = 0;
  private x1 = 0;
  private h = 0;
  private seed = 31;

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  layout(x0: number, x1: number, h: number) {
    this.x0 = x0;
    this.x1 = x1;
    this.h = h;
    if (!this.motes.length) {
      for (let i = 0; i < 12; i++) {
        this.motes.push({
          x: x0 + this.rand() * (x1 - x0),
          y: this.rand() * h,
          speed: 7 + this.rand() * 9,
          phase: this.rand() * Math.PI * 2,
          size: this.rand() < 0.7 ? 2 : 3,
          gold: this.rand() < 0.25,
        });
      }
    }
  }

  update(dt: number) {
    if (!this.motes.length) return;
    this.t += dt;
    this.g.clear();
    for (const m of this.motes) {
      m.y -= m.speed * dt;
      if (m.y < -4) {
        m.y = this.h + 4;
        m.x = this.x0 + this.rand() * (this.x1 - this.x0);
      }
      const breathe = 0.11 + 0.07 * Math.sin(this.t * 0.9 + m.phase);
      this.g.rect(Math.round(m.x), Math.round(m.y), m.size, m.size)
        .fill({ color: m.gold ? 0xffd95e : 0xfff8e0, alpha: breathe });
    }
  }
}

// The entrance easing: a dropped plate carries MASS — it slams through its
// rest, sinks a hair past, and settles. One curve for the whole shell.
export const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

// The drop choreographer: signage falling onto the stage. Each piece falls
// from above its rest on the back-out curve and reports the exact frame it
// first slams through — the moment dust, sound and flash all belong to.
interface DropItem {
  target: Container;
  delay: number;
  from: number;
  dur: number;
  baseY: number;
  hit: boolean;
  onImpact?: () => void;
}

export class Drop {
  private items: DropItem[] = [];
  private t = Infinity;

  get active(): boolean {
    return this.t !== Infinity;
  }

  add(target: Container, delay: number, opts: { from?: number; dur?: number; onImpact?: () => void } = {}) {
    this.items.push({ target, delay, from: opts.from ?? 30, dur: opts.dur ?? 0.34, baseY: target.position.y, hit: false, onImpact: opts.onImpact });
  }

  clear() {
    this.items = [];
    this.t = Infinity;
  }

  // Snap every piece straight to its rest — a new drop must never read a
  // mid-air position as home
  finish() {
    for (const it of this.items) {
      it.target.position.y = it.baseY;
      it.target.alpha = 1;
      it.target.visible = true;
    }
    this.t = Infinity;
  }

  // Rests are read NOW — the caller's layout has planted everything
  play() {
    this.t = 0;
    for (const it of this.items) {
      it.baseY = it.target.position.y;
      it.hit = false;
      this.applyTo(it);
    }
  }

  update(dt: number) {
    if (this.t === Infinity) return;
    this.t += dt;
    let live = false;
    for (const it of this.items) {
      this.applyTo(it);
      if (this.t - it.delay < it.dur) live = true;
    }
    if (!live) this.t = Infinity;
  }

  private applyTo(it: DropItem) {
    const local = this.t === Infinity ? 1 : Math.max(0, Math.min(1, (this.t - it.delay) / it.dur));
    it.target.visible = local > 0;
    it.target.alpha = Math.min(1, local / 0.25);
    it.target.position.y = it.baseY - Math.round((1 - easeOutBack(local)) * it.from);
    // the back-out curve first crosses its rest at t = 1 - c1/c3 — the slam
    if (!it.hit && local >= 0.37) {
      it.hit = true;
      it.onImpact?.();
    }
  }
}

// Impact dust: a handful of pixel motes kicked out of a landing edge, hopping
// up and dying under gravity — the match's arcade physicality, in the shell
interface Mote {
  x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: number;
}

export class PixelDust {
  g = new Graphics();
  private motes: Mote[] = [];
  private drawn = false;
  private seed = 7;

  // deterministic scatter — no Math.random in a fixed-tick shell
  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  burst(x: number, y: number, spread: number, count = 10) {
    for (let i = 0; i < count; i++) {
      const r = this.rand();
      this.motes.push({
        x: x + (r - 0.5) * spread,
        y: y + (this.rand() - 0.5) * 3,
        vx: (this.rand() - 0.5) * 90,
        vy: -30 - this.rand() * 70,
        life: 0, max: 0.3 + this.rand() * 0.2,
        size: this.rand() < 0.6 ? 2 : 3,
        color: r < 0.45 ? 0xfff8e0 : r < 0.8 ? 0x8a91a0 : 0xffd95e,
      });
    }
  }

  update(dt: number) {
    if (!this.motes.length) {
      if (this.drawn) { this.g.clear(); this.drawn = false; }
      return;
    }
    this.g.clear();
    this.drawn = true;
    this.motes = this.motes.filter((m) => (m.life += dt) < m.max);
    for (const m of this.motes) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.vy += 340 * dt;
      const fade = 1 - m.life / m.max;
      this.g.rect(Math.round(m.x), Math.round(m.y), m.size, m.size).fill({ color: m.color, alpha: 0.85 * fade });
    }
  }
}

// The materialize choreographer: registered pieces step in on a quantized
// alpha ladder with a one-pixel landing drop — staggered, never smeared.
// PixelText pieces type themselves out letter by letter instead.
interface RevealItem {
  target: Container;
  delay: number;
  baseY: number;
}

export class Reveal {
  private items: RevealItem[] = [];
  private t = Infinity;

  add(target: Container, delay: number) {
    this.items.push({ target, delay, baseY: target.position.y });
    this.applyTo(this.items[this.items.length - 1]);
  }

  // (Re)run the entrance from black — resting positions are read NOW, after
  // the caller's layout has planted everything where it belongs
  play() {
    this.t = 0;
    for (const it of this.items) {
      it.baseY = it.target.position.y;
      this.applyTo(it);
    }
  }

  clear() {
    this.items = [];
    this.t = Infinity;
  }

  get done(): boolean {
    return this.items.every((it) => this.t - it.delay >= 0.16);
  }

  update(dt: number) {
    if (this.t === Infinity) return;
    this.t += dt;
    for (const it of this.items) this.applyTo(it);
    if (this.done) this.t = Infinity;
  }

  private applyTo(it: RevealItem) {
    const local = this.t === Infinity ? 1 : Math.max(0, Math.min(1, (this.t - it.delay) / 0.16));
    if (it.target instanceof PixelText) {
      it.target.reveal = local;
      it.target.visible = local > 0;
      return;
    }
    const step = Math.floor(local * 4) / 4; // the alpha ladder: 0 ¼ ½ ¾ 1
    it.target.visible = step > 0;
    it.target.alpha = step;
    it.target.position.y = it.baseY + (step < 1 ? Math.round((1 - step) * 4) : 0);
  }
}

export interface ListRow {
  label: string;
  value?: string; // the adjustable part — drawn gold in < > at the value column
  enabled: boolean;
  gapBefore?: boolean; // BACK rows drop a step below the pack — an obvious exit
  slider?: { value: number; max: number }; // trades the < > brackets for a track
}

// A slider's track measured in label columns, so it lands on the same grid the
// letters do — and the gap the numeral waits in on its right
const TRACK_COLS = 5;
const TRACK_GAP = 10;

// Keyboard/mouse row list: gold chevron marks the pick, LABELS stay quiet
// while VALUES wear gold selector brackets, disabled rows grey out, long
// lists scroll a window around the selection. `center` plants the whole
// block symmetrically for the centered screens.
export class PixelList {
  root = new Container();
  sel = 0;
  onPick: (index: number) => void = () => {};
  onSelect: () => void = () => {}; // fires whenever the highlight moves
  onAdjust: (index: number, value: number) => void = () => {}; // a slider moved
  private rows: ListRow[] = [];
  private views: { box: Container; label: PixelText; value: PixelText | null; track: Graphics | null }[] = [];
  private marker: PixelText;
  private selBar = new Graphics();
  private scroll = 0;
  private blockW = 0;
  private blockX = 16;
  private reveal = new Reveal();
  private markerGlideY: number | null = null;
  private dragRow: number | null = null;

  constructor(
    private assets: GameAssets,
    private scale: number,
    private rowH: number,
    private maxVisible: number,
    private valueCol = 13, // character columns of label space before values begin
    private center = false,
  ) {
    this.marker = new PixelText(assets, scale, 0xffd95e);
    this.marker.text = '>';
    this.root.addChild(this.selBar, this.marker);
  }

  setRows(rows: ListRow[], keepSel = false, animate = false, stagger = 0) {
    this.rows = rows;
    for (const v of this.views) v.box.destroy({ children: true });
    this.views = [];
    this.reveal.clear();
    if (!keepSel || this.sel >= rows.length) this.sel = 0;
    if (!(rows[this.sel]?.enabled)) this.sel = Math.max(0, rows.findIndex((r) => r.enabled));
    rows.forEach((row, i) => {
      const box = new Container();
      const label = new PixelText(this.assets, this.scale);
      label.text = row.label;
      let value: PixelText | null = null;
      let track: Graphics | null = null;
      if (row.slider) {
        track = new Graphics();
        track.position.set(this.trackX(), 0);
        box.addChild(track);
      }
      if (row.value !== undefined) {
        value = new PixelText(this.assets, this.scale);
        value.text = track ? row.value : `< ${row.value} >`;
        value.position.set(this.valueCol * 6 * this.scale + (track ? this.trackW() + TRACK_GAP : 0), 0);
        box.addChild(value);
      }
      box.addChild(label);
      const w = Math.max(label.textWidth, value ? value.position.x + value.textWidth : 0);
      box.hitArea = new Rectangle(-6, -4, w + 16, this.rowH);
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.on('pointerover', () => {
        if (this.dragRow !== null) return; // a hand on a slider owns the list
        if (!this.rows[i].enabled || this.sel === i) return;
        this.sel = i;
        audio.ui('move');
        this.layout();
      });
      box.on('pointertap', () => {
        if (!this.rows[i].enabled) return audio.ui('denied');
        if (this.rows[i].slider) return; // the pointer already set it on the way down
        this.sel = i;
        this.layout();
        audio.ui(this.backish(i) ? 'back' : 'select');
        this.onPick(i);
      });
      // a slider answers the hand directly: grab anywhere on the row and the
      // notch follows until you let go, anywhere on screen. A button that came
      // up off-window never sends an up event — the buttons check catches it.
      if (row.slider) {
        box.on('pointerdown', (e) => {
          if (!this.rows[i].enabled) return;
          this.sel = i;
          this.dragRow = i;
          this.layout();
          this.setFromPointer(i, e.getLocalPosition(box).x);
        });
        box.on('globalpointermove', (e) => {
          if (this.dragRow !== i) return;
          if (e.buttons === 0) this.dragRow = null;
          else this.setFromPointer(i, e.getLocalPosition(box).x);
        });
        box.on('pointerup', () => { this.dragRow = null; });
        box.on('pointerupoutside', () => { this.dragRow = null; });
      }
      this.root.addChild(box);
      this.views.push({ box, label, value, track });
      if (animate) this.reveal.add(box, stagger + i * 0.035);
    });
    // One shared left edge: the widest row sets the block, center plants it
    this.blockW = this.views.reduce((m, v) =>
      Math.max(m, v.value ? v.value.position.x + v.value.textWidth : v.label.textWidth), 0);
    this.blockX = this.center ? Math.round(-this.blockW / 2) : 16;
    this.layout();
    if (animate) this.reveal.play(); // after layout: entrances land on real rests
  }

  move(dir: 1 | -1) {
    if (!this.rows.length) return;
    let i = this.sel;
    for (let hop = 0; hop < this.rows.length; hop++) {
      i = (i + dir + this.rows.length) % this.rows.length;
      if (this.rows[i].enabled) break;
    }
    this.sel = i;
    audio.ui('move');
    this.layout();
  }

  // A screen can park the keyboard walk somewhere else of its own (the front
  // door's plaque). The list keeps its place and stops claiming the eye.
  setActive(on: boolean) {
    this.marker.alpha = on ? 1 : 0.22;
    this.selBar.alpha = on ? 1 : 0.22;
  }

  activate() {
    if (!this.rows[this.sel]?.enabled) return;
    if (this.rows[this.sel].slider) return this.adjust(1); // nothing to confirm — it nudges
    audio.ui(this.backish(this.sel) ? 'back' : 'select');
    this.onPick(this.sel);
  }

  // Left/right on a slider row. Ends of the track are walls, not wraps: a
  // volume that jumps from 10 to 0 under your thumb is a jump scare.
  adjust(dir: 1 | -1) {
    const row = this.rows[this.sel];
    if (!row?.slider || !row.enabled) return;
    this.bump(this.sel, row.slider.value + dir);
  }

  private trackW() {
    return TRACK_COLS * 6 * this.scale;
  }
  private trackX() {
    return this.valueCol * 6 * this.scale;
  }

  // Where the hand landed on the track, in steps — grabbing the row anywhere
  // left of the track reads as 0, anywhere right of it as full
  private setFromPointer(i: number, localX: number) {
    const s = this.rows[i].slider!;
    this.bump(i, Math.round(((localX - this.trackX()) / this.trackW()) * s.max));
  }

  private bump(i: number, value: number) {
    const s = this.rows[i].slider!;
    const next = Math.max(0, Math.min(s.max, value));
    if (next === s.value) return;
    s.value = next;
    const v = this.views[i];
    if (v?.value) v.value.text = String(next);
    this.layout();
    this.onAdjust(i, next);
  }

  // Every retreat sounds the same everywhere: BACK rows speak the back pluck,
  // the one the online screen's button taught us to like
  private backish(i: number) {
    return this.rows[i]?.label === 'BACK';
  }

  // The marker glides to its row in pixel steps; entrances play out
  update(dt: number) {
    this.reveal.update(dt);
    if (this.markerGlideY !== null) {
      const d = this.markerGlideY - this.marker.position.y;
      if (Math.abs(d) < 1) {
        this.marker.position.y = this.markerGlideY;
        this.markerGlideY = null;
      } else {
        this.marker.position.y += Math.round(d * Math.min(1, dt * 22));
      }
    }
  }

  // The list's footprint, for screens that draw a box around it
  get blockWidth(): number {
    return this.blockW;
  }
  get totalHeight(): number {
    const visible = Math.min(this.rows.length, this.maxVisible);
    const gaps = this.rows.slice(this.scroll, this.scroll + visible).filter((r) => r.gapBefore).length;
    return visible * this.rowH + gaps * 14;
  }

  private layout() {
    // keep the selection inside the window
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + this.maxVisible) this.scroll = this.sel - this.maxVisible + 1;
    const rowX = (v: { label: PixelText; value: PixelText | null }) =>
      this.center && !v.value ? Math.round(-v.label.textWidth / 2) : this.blockX;
    // rows stack top-down; a gapBefore row steps clear of the pack
    const rowYs: number[] = [];
    let y = 0;
    this.rows.forEach((row, i) => {
      const vis = i >= this.scroll && i < this.scroll + this.maxVisible;
      if (vis && row.gapBefore) y += 14;
      rowYs.push(y);
      if (vis) y += this.rowH;
    });
    this.views.forEach((v, i) => {
      const row = this.rows[i];
      const vis = i >= this.scroll && i < this.scroll + this.maxVisible;
      v.box.visible = vis;
      // action rows center on themselves; setting rows share the column block
      if (vis) v.box.position.set(rowX(v), rowYs[i]);
      const active = i === this.sel;
      v.label.tint = !row.enabled ? 0x5a6070
        : v.value ? (active ? 0xdfe4ee : 0x8f97a8)  // a setting: the label stays quiet
        : (active ? 0xffffff : 0xe8ecf4);           // an action: the label IS the thing
      if (v.value) v.value.tint = !row.enabled ? 0x5a6070 : active ? 0xffe98f : 0xd8ab3c;
      if (v.track && row.slider) this.drawTrack(v.track, row.slider, !row.enabled ? 0x5a6070 : active ? 0xffe98f : 0xd8ab3c);
    });
    const selY = rowYs[this.sel] ?? 0;
    const selV = this.views[this.sel];
    const selX = selV ? rowX(selV) : this.blockX;
    const selW = selV ? (selV.value ? this.blockW : selV.label.textWidth) : this.blockW;
    this.markerGlideY = selY;
    if (!this.marker.visible) this.marker.position.y = selY; // first light: no glide
    this.marker.position.x = selX - 16;
    this.marker.visible = this.rows.length > 0;
    // The live row's plate, measured from the INK: the font cell carries an
    // outline row above and below (9 rows, letters on 1..7), so the band
    // centers on the letters themselves — even air all around, chevron and
    // word embraced together, finished with the game's pixel bevel
    this.selBar.clear();
    if (selV) {
      const s = this.scale;
      const padX = s + 6;
      const padY = s + 2;
      const bx = selX - 16 - padX;            // the marker parks at selX - 16
      const bw = selW + 16 + padX * 2;
      const by = selY + s - padY;             // ink top sits one outline row in
      const bh = s * 7 + padY * 2;
      this.selBar.rect(bx, by, bw, bh).fill({ color: 0xffd95e, alpha: 0.08 });
      this.selBar.rect(bx, by, bw, 1).fill({ color: 0xfff8e0, alpha: 0.14 });
      this.selBar.rect(bx, by + bh - 1, bw, 1).fill({ color: 0x000000, alpha: 0.45 });
    }
    this.onSelect();
  }

  // The track wears the menu box's clothes: a sunken chalk groove scored with
  // one hairline per step, gold filled to where you are, and a notch standing
  // proud of the rail so the eye finds the value without reading the numeral.
  private drawTrack(g: Graphics, s: { value: number; max: number }, tone: number) {
    const u = this.scale;
    const w = this.trackW();
    const h = u * 3;
    const y = u * 3; // the rail centers on the letters, not on the font cell
    const fill = Math.round((s.value / s.max) * w);
    const nx = Math.min(w - u * 2, Math.max(0, fill - u));
    g.clear();
    g.rect(0, y, w, h).fill({ color: 0x05070b, alpha: 0.55 });
    if (fill > 0) g.rect(0, y, fill, h).fill({ color: tone, alpha: 0.5 });
    for (let i = 1; i < s.max; i++) { // scored across the fill too — a rail, not a meter
      g.rect(Math.round((i / s.max) * w), y, 1, h).fill({ color: 0xfff8e0, alpha: 0.16 });
    }
    g.rect(0, y, w, 1).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(0, y + h - 1, w, 1).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(nx, y - u, u * 2, h + u * 2).fill({ color: tone });
  }
}
