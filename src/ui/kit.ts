import { Container, Graphics } from 'pixi.js';
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
  enabled: boolean;
}

// Keyboard/mouse row list: gold chevron marks the pick, disabled rows grey
// out, long lists scroll a window around the selection.
export class PixelList {
  root = new Container();
  sel = 0;
  onPick: (index: number) => void = () => {};
  onSelect: () => void = () => {}; // fires whenever the highlight moves
  private rows: ListRow[] = [];
  private texts: PixelText[] = [];
  private marker: PixelText;
  private scroll = 0;

  constructor(private assets: GameAssets, private scale: number, private rowH: number, private maxVisible: number) {
    this.marker = new PixelText(assets, scale, 0xffd95e);
    this.marker.text = '>';
    this.root.addChild(this.marker);
  }

  setRows(rows: ListRow[], keepSel = false) {
    this.rows = rows;
    for (const t of this.texts) t.destroy();
    this.texts = [];
    if (!keepSel || this.sel >= rows.length) this.sel = 0;
    if (!(rows[this.sel]?.enabled)) this.sel = Math.max(0, rows.findIndex((r) => r.enabled));
    rows.forEach((row, i) => {
      const t = new PixelText(this.assets, this.scale, row.enabled ? 0xe8ecf4 : 0x5a6070);
      t.text = row.label;
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.on('pointerover', () => { if (this.rows[i].enabled) { this.sel = i; this.layout(); } });
      t.on('pointertap', () => { if (this.rows[i].enabled) { this.sel = i; this.layout(); this.onPick(i); } });
      this.root.addChild(t);
      this.texts.push(t);
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
    this.texts.forEach((t, i) => {
      const vis = i >= this.scroll && i < this.scroll + this.maxVisible;
      t.visible = vis;
      if (vis) t.position.set(16, (i - this.scroll) * this.rowH);
      t.tint = this.rows[i].enabled ? (i === this.sel ? 0xffffff : 0xe8ecf4) : 0x5a6070;
    });
    this.marker.position.set(0, (this.sel - this.scroll) * this.rowH);
    this.marker.visible = this.rows.length > 0;
    this.onSelect();
  }
}
