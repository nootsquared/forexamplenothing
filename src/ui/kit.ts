import { Container, Graphics, Rectangle } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';

// Pixel UI atoms every screen shares: panels, shades, the materialize
// choreographer, and the pick-list.

export function panel(w: number, h: number): Graphics {
  const g = new Graphics();
  g.rect(0, 0, w, h).fill({ color: 0x10141c, alpha: 0.92 });
  g.rect(0, 0, w, 2).fill({ color: 0xffd95e, alpha: 0.5 });
  g.rect(0, h - 2, w, 2).fill({ color: 0x000000, alpha: 0.5 });
  g.rect(0, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
  g.rect(w - 1, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
  return g;
}

// The screens' shared backdrop: pixel-stepped dark bands thinning toward the
// live pitch, plus a low strip for the footer line
export function stepShade(g: Graphics, w: number, h: number) {
  g.clear();
  const bands = 12;
  const bandW = Math.ceil((w * 0.52) / bands);
  for (let i = 0; i < bands; i++) {
    g.rect(i * bandW, 0, bandW, h).fill({ color: 0x070a10, alpha: 0.94 - i * 0.075 });
  }
  g.rect(0, h - 64, w, 64).fill({ color: 0x070a10, alpha: 0.55 });
}

// The centered stage: a full dim over the live pitch and a dark pillar down
// the middle whose edges step away band by band — the spotlight the menu
// stack stands in
export function centerShade(g: Graphics, w: number, h: number, pillarW = 620) {
  g.clear();
  g.rect(0, 0, w, h).fill({ color: 0x070a10, alpha: 0.58 });
  const steps = 7;
  const stepW = 26;
  const coreW = Math.min(pillarW, w * 0.72);
  for (let i = steps; i >= 0; i--) {
    const bw = coreW + i * stepW * 2;
    g.rect(Math.round((w - bw) / 2), 0, Math.round(bw), h)
      .fill({ color: 0x070a10, alpha: 0.1 + (steps - i) * 0.048 });
  }
  g.rect(0, h - 64, w, 64).fill({ color: 0x070a10, alpha: 0.4 });
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
}

// Keyboard/mouse row list: gold chevron marks the pick, LABELS stay quiet
// while VALUES wear gold selector brackets, disabled rows grey out, long
// lists scroll a window around the selection. `center` plants the whole
// block symmetrically for the centered screens.
export class PixelList {
  root = new Container();
  sel = 0;
  onPick: (index: number) => void = () => {};
  onSelect: () => void = () => {}; // fires whenever the highlight moves
  private rows: ListRow[] = [];
  private views: { box: Container; label: PixelText; value: PixelText | null }[] = [];
  private marker: PixelText;
  private selBar = new Graphics();
  private scroll = 0;
  private blockW = 0;
  private blockX = 16;
  private reveal = new Reveal();
  private markerGlideY: number | null = null;

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

  setRows(rows: ListRow[], keepSel = false, animate = false) {
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
      if (row.value !== undefined) {
        value = new PixelText(this.assets, this.scale);
        value.text = `< ${row.value} >`;
        value.position.set(this.valueCol * 6 * this.scale, 0);
        box.addChild(value);
      }
      box.addChild(label);
      const w = Math.max(label.textWidth, value ? value.position.x + value.textWidth : 0);
      box.hitArea = new Rectangle(-6, -4, w + 16, this.rowH);
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.on('pointerover', () => {
        if (!this.rows[i].enabled || this.sel === i) return;
        this.sel = i;
        audio.ui('move');
        this.layout();
      });
      box.on('pointertap', () => {
        if (!this.rows[i].enabled) return audio.ui('denied');
        this.sel = i;
        this.layout();
        audio.ui('select');
        this.onPick(i);
      });
      this.root.addChild(box);
      this.views.push({ box, label, value });
      if (animate) this.reveal.add(box, i * 0.035);
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

  activate() {
    if (!this.rows[this.sel]?.enabled) return;
    audio.ui('select');
    this.onPick(this.sel);
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
    });
    const selY = rowYs[this.sel] ?? 0;
    const selV = this.views[this.sel];
    const selX = selV ? rowX(selV) : this.blockX;
    const selW = selV ? (selV.value ? this.blockW : selV.label.textWidth) : this.blockW;
    this.markerGlideY = selY;
    if (!this.marker.visible) this.marker.position.y = selY; // first light: no glide
    this.marker.position.x = selX - 16;
    this.marker.visible = this.rows.length > 0;
    // a quiet band under the live row — even air above and below the word
    this.selBar.clear();
    if (selV) {
      this.selBar.rect(selX - 22, selY - 5, selW + 40, this.scale * 7 + 10)
        .fill({ color: 0xffd95e, alpha: 0.07 });
    }
    this.onSelect();
  }
}
