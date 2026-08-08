import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';

// A number that never just CHANGES. It rolls the lottery way — sprinting off
// its old value, crawling into the new one, clicking every digit on the way —
// so money landing and a squad getting better are things you watch happen.
export class RollingNumber extends PixelText {
  private shown = 0;
  private pos = 0;
  private target = 0;
  private tickAt = 0;
  private rightEdge: number | null = null;

  constructor(
    assets: GameAssets,
    scale: number,
    tint: number,
    private suffix = '',
    private tickVol = 0,
    private dashAtZero = false, // a line nobody has filled reads as a dash
    font: 'main' | 'micro' = 'main',
  ) {
    super(assets, scale, tint, font);
    this.print();
  }

  // A fresh screen lands on its number; a live one rolls to it
  set(value: number, instant = false) {
    this.target = value;
    if (!instant) return;
    this.pos = value;
    this.shown = value;
    this.print();
  }

  get value(): number {
    return this.target;
  }

  // A column of figures reads off its RIGHT edge — a digit rolling in must
  // never shove the ones beside it
  alignRight(x: number) {
    this.rightEdge = x;
    this.print();
  }

  update(dt: number) {
    if (this.shown === this.target && this.pos === this.target) return;
    const gap = this.target - this.pos;
    // exponential settle with a floor under it — big jumps never crawl, small
    // ones never snap
    const step = Math.sign(gap) * Math.min(Math.abs(gap), Math.max(Math.abs(gap) * 11, 26) * dt);
    this.pos = Math.abs(gap) < 0.6 ? this.target : this.pos + step;
    const next = Math.round(this.pos);
    this.tickAt -= dt;
    if (next === this.shown) return;
    this.shown = next;
    this.print();
    if (this.tickVol > 0 && this.tickAt <= 0) {
      this.tickAt = 0.055;
      audio.ui('tick', this.tickVol);
    }
  }

  private print() {
    this.text = this.dashAtZero && this.shown === 0 ? '--' : `${this.shown}${this.suffix}`;
    if (this.rightEdge !== null) this.position.x = Math.round(this.rightEdge - this.textWidth);
  }
}
