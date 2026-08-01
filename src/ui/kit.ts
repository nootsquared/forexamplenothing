import { Container, Graphics, Rectangle } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';

// Pixel UI atoms every screen shares: the dark panel and the pick-list.

export function panel(w: number, h: number): Graphics {
  const g = new Graphics();
  g.rect(0, 0, w, h).fill({ color: 0x10141c, alpha: 0.92 });
  g.rect(0, 0, w, 2).fill({ color: 0xffd95e, alpha: 0.5 });
  g.rect(0, h - 2, w, 2).fill({ color: 0x000000, alpha: 0.5 });
  g.rect(0, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
  g.rect(w - 1, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
  return g;
}

export interface ListRow {
  label: string;
  value?: string; // the adjustable part — drawn gold in < > at the value column
  enabled: boolean;
}

// Keyboard/mouse row list: gold chevron marks the pick, LABELS stay quiet
// while VALUES wear gold selector brackets, disabled rows grey out, long
// lists scroll a window around the selection.
export class PixelList {
  root = new Container();
  sel = 0;
  onPick: (index: number) => void = () => {};
  onSelect: () => void = () => {}; // fires whenever the highlight moves
  private rows: ListRow[] = [];
  private views: { box: Container; label: PixelText; value: PixelText | null }[] = [];
  private marker: PixelText;
  private scroll = 0;

  constructor(
    private assets: GameAssets,
    private scale: number,
    private rowH: number,
    private maxVisible: number,
    private valueCol = 13, // characters of label space before values begin
  ) {
    this.marker = new PixelText(assets, scale, 0xffd95e);
    this.marker.text = '>';
    this.root.addChild(this.marker);
  }

  setRows(rows: ListRow[], keepSel = false) {
    this.rows = rows;
    for (const v of this.views) v.box.destroy({ children: true });
    this.views = [];
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
      box.hitArea = new Rectangle(-4, -2, w + 12, this.rowH);
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.on('pointerover', () => { if (this.rows[i].enabled) { this.sel = i; this.layout(); } });
      box.on('pointertap', () => { if (this.rows[i].enabled) { this.sel = i; this.layout(); this.onPick(i); } });
      this.root.addChild(box);
      this.views.push({ box, label, value });
    });
    this.layout();
  }

  move(dir: 1 | -1) {
    if (!this.rows.length) return;
    let i = this.sel;
    for (let hop = 0; hop < this.rows.length; hop++) {
      i = (i + dir + this.rows.length) % this.rows.length;
      if (this.rows[i].enabled) break;
    }
    this.sel = i;
    this.layout();
  }

  activate() {
    if (this.rows[this.sel]?.enabled) this.onPick(this.sel);
  }

  private layout() {
    // keep the selection inside the window
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + this.maxVisible) this.scroll = this.sel - this.maxVisible + 1;
    this.views.forEach((v, i) => {
      const row = this.rows[i];
      const vis = i >= this.scroll && i < this.scroll + this.maxVisible;
      v.box.visible = vis;
      if (vis) v.box.position.set(16, (i - this.scroll) * this.rowH);
      const active = i === this.sel;
      v.label.tint = !row.enabled ? 0x5a6070
        : v.value ? (active ? 0xdfe4ee : 0x8f97a8)  // a setting: the label stays quiet
        : (active ? 0xffffff : 0xe8ecf4);           // an action: the label IS the thing
      if (v.value) v.value.tint = !row.enabled ? 0x5a6070 : active ? 0xffe98f : 0xd8ab3c;
    });
    this.marker.position.set(0, (this.sel - this.scroll) * this.rowH);
    this.marker.visible = this.rows.length > 0;
    this.onSelect();
  }
}
