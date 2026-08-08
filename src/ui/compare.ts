import { Container, Graphics } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { RATING_LABELS, RATING_ROWS, RATING_SHORT, SquadRating } from '../data/ratings';
import { RollingNumber } from './rollup';

// The head-to-head: two squads' numbers stacked against each other, the
// stronger side of every line lit gold and the split painted under it. It
// answers the only question anyone has before kickoff — who wins this?

const HOME_TINT = 0xff9c8a;
const AWAY_TINT = 0x9cc4f0;
const WIN_TINT = 0xffd95e;
const LOSE_TINT = 0x77808f;

// Gold is for LEADING — a level line stays ink, and a line nobody has filled
// yet stays quiet, so the eye only ever chases a real advantage
const tone = (mine: number, theirs: number) =>
  mine > theirs ? WIN_TINT : mine < theirs ? LOSE_TINT : mine === 0 ? LOSE_TINT : 0xdfe4ee;

interface CompareRow {
  label: PixelText;
  left: RollingNumber;
  right: RollingNumber;
  bar: Graphics;
}

// The dugout's own sub-card: five numbers in a row under a team board, the
// ones this side is winning lit gold. Two of them facing each other across
// the war room IS the comparison — no reading required.
export class RatingStrip extends Container {
  private plate = new Graphics();
  private labels: PixelText[] = [];
  private values: RollingNumber[] = [];
  private w = 200;

  constructor(assets: GameAssets) {
    super();
    this.addChild(this.plate);
    for (const key of RATING_ROWS) {
      const label = new PixelText(assets, 2, 0x8f97a8, 'micro');
      label.text = RATING_SHORT[key];
      const value = new RollingNumber(assets, 2, LOSE_TINT, '', 0, true);
      this.labels.push(label);
      this.values.push(value);
      this.addChild(label, value);
    }
    this.resize(this.w);
  }

  get plateHeight(): number {
    return 10 + this.labels[0].textHeight + 4 + this.values[0].textHeight + 8;
  }

  resize(w: number) {
    this.w = w;
    const col = w / RATING_ROWS.length;
    const g = this.plate;
    g.clear();
    g.rect(0, 0, w, this.plateHeight).fill({ color: 0x0d1119, alpha: 0.85 });
    g.rect(0, 0, w, 1).fill({ color: 0xffd95e, alpha: 0.35 });
    g.rect(0, this.plateHeight - 1, w, 1).fill({ color: 0x000000, alpha: 0.5 });
    this.labels.forEach((label, i) => {
      label.centerAt(col * (i + 0.5), 8);
      this.values[i].position.y = 8 + label.textHeight + 4;
      this.center(i, col);
    });
  }

  // `theirs` only decides the gold — the numbers shown are always this side's
  setRatings(mine: SquadRating, theirs: SquadRating) {
    const col = this.w / RATING_ROWS.length;
    RATING_ROWS.forEach((key, i) => {
      this.values[i].set(mine[key]);
      this.values[i].tint = tone(mine[key], theirs[key]);
      this.center(i, col);
    });
  }

  update(dt: number) {
    const col = this.w / RATING_ROWS.length;
    this.values.forEach((v, i) => {
      v.update(dt);
      this.center(i, col);
    });
  }

  private center(i: number, col: number) {
    this.values[i].position.x = Math.round(col * (i + 0.5) - this.values[i].textWidth / 2);
  }
}

export class CompareCard extends Container {
  private plate = new Graphics();
  private crumb: PixelText;
  private names: [PixelText, PixelText];
  private rows: CompareRow[] = [];
  private verdict: PixelText;
  private w = 0;
  private h = 0;

  // `s` is the pixel scale of the numbers: 2 for a dugout panel, 3 for the
  // card that takes the whole stage before kickoff
  constructor(assets: GameAssets, private s: number, private rolls = true) {
    super();
    this.crumb = new PixelText(assets, Math.max(2, s - 1), 0x8a91a0, 'micro');
    this.crumb.text = 'HEAD TO HEAD';
    this.names = [new PixelText(assets, Math.max(2, s - 1), HOME_TINT), new PixelText(assets, Math.max(2, s - 1), AWAY_TINT)];
    this.verdict = new PixelText(assets, Math.max(2, s - 1), 0x9ff0b8);
    this.addChild(this.plate, this.crumb, this.names[0], this.names[1], this.verdict);
    for (const key of RATING_ROWS) {
      const label = new PixelText(assets, Math.max(2, s - 1), 0x8f97a8, 'micro');
      label.text = RATING_LABELS[key];
      const left = new RollingNumber(assets, s, LOSE_TINT, '', 0, true);
      const right = new RollingNumber(assets, s, LOSE_TINT, '', 0, true);
      const bar = new Graphics();
      this.rows.push({ label, left, right, bar });
      this.addChild(bar, label, left, right);
    }
    this.layout();
  }

  get size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  setNames(left: string, right: string) {
    this.names[0].text = left;
    this.names[1].text = right;
    this.layout();
  }

  // Fresh numbers land rolling; `instant` is for a card that just appeared
  setRatings(left: SquadRating, right: SquadRating, instant = false) {
    RATING_ROWS.forEach((key, i) => {
      const row = this.rows[i];
      row.left.set(left[key], instant || !this.rolls);
      row.right.set(right[key], instant || !this.rolls);
      row.left.tint = tone(left[key], right[key]);
      row.right.tint = tone(right[key], left[key]);
      this.drawBar(row, left[key], right[key]);
    });
    const wins = RATING_ROWS.filter((k) => left[k] > right[k]).length;
    const losses = RATING_ROWS.filter((k) => right[k] > left[k]).length;
    this.verdict.text = wins === losses ? 'DEAD EVEN' : wins > losses ? 'YOU LOOK STRONGER' : 'THEY LOOK STRONGER';
    this.verdict.tint = wins === losses ? 0x9ff0b8 : wins > losses ? HOME_TINT : AWAY_TINT;
    this.layout();
  }

  update(dt: number) {
    for (const row of this.rows) {
      row.left.update(dt);
      row.right.update(dt);
    }
  }

  private rowH() {
    return this.s * 9 + 14;
  }

  private layout() {
    const s = this.s;
    const pad = s * 8;
    const numW = s * 18;                                    // room for two digits either side
    const barW = Math.max(90, s * 46);
    const w = pad * 2 + numW * 2 + barW;
    const top = pad + this.crumb.textHeight + 8 + this.names[0].textHeight + 10;
    const h = top + this.rows.length * this.rowH() + 6 + this.verdict.textHeight + pad;
    this.w = w;
    this.h = h;
    this.drawPlate(w, h);
    this.crumb.centerAt(w / 2, pad);
    this.names[0].position.set(pad, pad + this.crumb.textHeight + 8);
    this.names[1].position.set(Math.round(w - pad - this.names[1].textWidth), pad + this.crumb.textHeight + 8);
    this.rows.forEach((row, i) => {
      const y = top + i * this.rowH();
      row.left.position.set(pad, y);
      row.right.position.y = y;
      row.right.alignRight(w - pad);
      row.label.centerAt(w / 2, y + Math.round(s * 1.5));
      row.bar.position.set(Math.round(w / 2 - barW / 2), y + s * 7 + 4);
    });
    this.verdict.centerAt(w / 2, h - pad - this.verdict.textHeight + 2);
  }

  // The split under a line: each side's share of the pair, the leader's half
  // in gold — the shape of the gap, before you read a single digit
  private drawBar(row: CompareRow, left: number, right: number) {
    const barW = Math.max(90, this.s * 46);
    const g = row.bar;
    g.clear();
    g.rect(0, 0, barW, 3).fill({ color: 0x05070b, alpha: 0.6 });
    if (left + right === 0) return; // nobody signed yet: an empty groove, not a verdict
    const lw = Math.round((left / (left + right)) * barW);
    const half = (x: number, w: number, mine: number, theirs: number, tint: number) => {
      if (w <= 0) return;
      const level = mine === theirs;
      g.rect(x, 0, w, 3).fill({ color: level ? 0x8a91a0 : mine > theirs ? WIN_TINT : tint, alpha: level ? 0.4 : mine > theirs ? 0.9 : 0.45 });
    };
    half(0, lw, left, right, HOME_TINT);
    half(lw, barW - lw, right, left, AWAY_TINT);
  }

  // The menu box's cloth and studs — the card belongs to the same building
  private drawPlate(w: number, h: number) {
    const g = this.plate;
    g.clear();
    g.rect(0, 0, w, h).fill({ color: 0x0d1119, alpha: 0.92 });
    g.rect(0, 0, w, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    g.rect(0, h - 2, w, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(0, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(w - 1, 2, 1, h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    for (const [cx, cy] of [[3, 5], [w - 6, 5], [3, h - 8], [w - 6, h - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: 0xffd95e, alpha: 0.55 });
    }
  }
}
