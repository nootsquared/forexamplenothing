import { Container, Graphics } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';

// The broadcast dress: bars top and bottom, a roll of scanlines behind them,
// the red light in the corner and — online — the room's list of nods. It
// frames the football and never stands in front of it.

const INK = 0x05070b;
const CLOTH = 0x0d1119;
const GOLD = 0xffd95e;
const MINT = 0x9ff0b8;
const TEXT = 0xdfe4ee;
const DIM = 0x8a91a0;
const RED = 0xff5340;
const LINE_STEP = 3;   // scanline pitch, px — any tighter and it moires
const ROLL_H = 46;     // the bright band that crawls down a taped picture

export interface ReplayRoomRow {
  name: string;
  ready: boolean;
}

// Everything the truck says about this frame of the replay
export interface ReplayView {
  open: number;      // 0..1 — how far the dress has landed
  progress: number;  // 0..1 through the cut
  slow: boolean;
  wash: number;      // the blip's white
  crush: number;     // ...and its black
  hint: string;
  room: ReplayRoomRow[] | null;
}

export class ReplayOverlay {
  root = new Container();
  private lines = new Container();
  private linesG = new Graphics();
  private roll = new Graphics();
  private bars = new Graphics();
  private recDot = new Graphics();
  private label: PixelText;
  private slomo: PixelText;
  private scrub = new Graphics();
  private hint: PixelText;
  private plate = new Graphics();
  private rows = new Container();
  private title: PixelText;
  private flash = new Graphics();
  private w = 0;
  private h = 0;
  private phase = 0;
  private rowsKey = '';

  constructor(private assets: GameAssets) {
    this.label = new PixelText(assets, 3, GOLD);
    this.label.text = 'REPLAY';
    this.slomo = new PixelText(assets, 2, MINT);
    this.slomo.text = 'SLO-MO';
    this.hint = new PixelText(assets, 2, DIM);
    this.title = new PixelText(assets, 2, TEXT);
    this.title.text = 'WAITING FOR THE ROOM';
    this.lines.addChild(this.linesG);
    this.root.addChild(this.lines, this.roll, this.bars, this.recDot, this.label, this.slomo,
      this.scrub, this.hint, this.plate, this.title, this.rows, this.flash);
    this.root.visible = false;
  }

  // The tape's own texture, baked once per size: hairlines the whole way down
  // and one soft band that crawls over them
  private build(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rowsKey = ''; // the roll call is laid out in absolute pixels — relay it
    this.linesG.clear();
    for (let y = 0; y < h + LINE_STEP * 2; y += LINE_STEP) {
      this.linesG.rect(0, y, w, 1).fill({ color: INK, alpha: 0.5 });
    }
    this.roll.clear();
    for (let i = 0; i < 6; i++) {
      const a = Math.sin(((i + 0.5) / 6) * Math.PI) * 0.05;
      this.roll.rect(0, (i * ROLL_H) / 6, w, ROLL_H / 6 + 1).fill({ color: TEXT, alpha: a });
    }
  }

  render(dt: number, w: number, h: number, view: ReplayView) {
    this.root.visible = true;
    if (w !== this.w || h !== this.h) this.build(w, h);
    this.phase += dt;

    const bar = Math.round(Math.min(90, Math.max(20, h * 0.055)) * view.open);
    this.lines.alpha = view.open * 0.55;
    this.lines.position.y = -((this.phase * 9) % LINE_STEP);
    this.roll.alpha = view.open;
    this.roll.position.y = ((this.phase * 90) % (h + ROLL_H)) - ROLL_H;

    this.bars.clear();
    if (bar > 0) {
      this.bars.rect(0, 0, w, bar).fill({ color: INK, alpha: 0.96 });
      this.bars.rect(0, h - bar, w, bar).fill({ color: INK, alpha: 0.96 });
      this.bars.rect(0, bar, w, 1).fill({ color: GOLD, alpha: 0.35 });
      this.bars.rect(0, h - bar - 1, w, 1).fill({ color: GOLD, alpha: 0.35 });
    }

    // The red light: it blinks because a tape is running, not for decoration
    const lit = 0.45 + 0.55 * (Math.sin(this.phase * 5.4) > -0.2 ? 1 : 0);
    const midTop = bar / 2;
    this.recDot.clear();
    this.recDot.visible = bar > 14;
    if (this.recDot.visible) {
      this.recDot.rect(20, Math.round(midTop - 5), 10, 10).fill({ color: RED, alpha: lit * view.open });
    }
    this.label.visible = this.recDot.visible;
    this.label.alpha = view.open;
    this.label.position.set(40, Math.round(midTop - this.label.textHeight / 2));
    this.slomo.visible = this.recDot.visible && view.slow;
    this.slomo.alpha = view.open;
    this.slomo.position.set(40 + this.label.textWidth + 14, Math.round(midTop - this.slomo.textHeight / 2) + 2);

    // The scrub bar rides the bottom bar's lip — how much tape is left, honestly
    const y = h - bar;
    this.scrub.clear();
    if (bar > 0) {
      this.scrub.rect(20, y + 6, w - 40, 3).fill({ color: TEXT, alpha: 0.12 });
      const run = Math.round((w - 40) * Math.min(1, Math.max(0, view.progress)));
      this.scrub.rect(20, y + 6, run, 3).fill({ color: MINT, alpha: 0.75 });
      this.scrub.rect(20 + run - 2, y + 4, 3, 7).fill({ color: GOLD, alpha: 0.9 });
    }
    this.hint.visible = bar > 14 && !view.room && view.hint.length > 0;
    if (this.hint.visible) {
      this.hint.text = view.hint;
      this.hint.alpha = view.open * 0.9;
      this.hint.position.set(w - 20 - this.hint.textWidth, Math.round(y + 9 + (bar - 9) / 2 - this.hint.textHeight / 2));
    }

    this.drawRoom(w, h, view.room);

    // The cut itself: two hard blips and a crush, the way a truck punches a
    // tape onto the air
    this.flash.clear();
    if (view.crush > 0.004) this.flash.rect(0, 0, w, h).fill({ color: INK, alpha: view.crush });
    if (view.wash > 0.004) this.flash.rect(0, 0, w, h).fill({ color: 0xfff8e0, alpha: view.wash });
  }

  hide() {
    this.root.visible = false;
  }

  // Who has nodded and who the room is still waiting on — one plate, one row
  // each, rebuilt only when the answer actually changes
  private drawRoom(w: number, h: number, room: ReplayRoomRow[] | null) {
    const on = !!room && room.length > 0;
    this.plate.visible = on;
    this.title.visible = on;
    this.rows.visible = on;
    if (!room || !on) {
      if (this.rowsKey) { this.rows.removeChildren().forEach((c) => c.destroy({ children: true })); this.rowsKey = ''; }
      return;
    }
    const key = room.map((r) => `${r.name}${r.ready ? 1 : 0}`).join('|');
    const rowH = 22;
    const pw = 300;
    const ph = 46 + room.length * rowH;
    const px = Math.round(w / 2 - pw / 2);
    const py = Math.round(h / 2 - ph / 2);
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      this.rows.removeChildren().forEach((c) => c.destroy({ children: true }));
      room.forEach((r, i) => {
        const name = new PixelText(this.assets, 2, r.ready ? TEXT : DIM);
        name.text = r.name.slice(0, 12);
        name.position.set(px + 18, py + 38 + i * rowH);
        const mark = new PixelText(this.assets, 2, r.ready ? MINT : DIM);
        mark.text = r.ready ? 'READY' : '- - -';
        mark.position.set(px + pw - 18 - mark.textWidth, py + 38 + i * rowH);
        this.rows.addChild(name, mark);
      });
    }
    this.plate.clear();
    this.plate.rect(px, py, pw, ph).fill({ color: CLOTH, alpha: 0.94 });
    this.plate.rect(px, py, pw, 2).fill({ color: GOLD, alpha: 0.7 });
    for (const [cx, cy] of [[px, py], [px + pw - 4, py], [px, py + ph - 4], [px + pw - 4, py + ph - 4]]) {
      this.plate.rect(cx, cy, 4, 4).fill({ color: MINT, alpha: 0.8 });
    }
    this.title.position.set(Math.round(px + pw / 2 - this.title.textWidth / 2), py + 14);
  }
}
