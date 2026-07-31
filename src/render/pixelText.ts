import { Container, Sprite } from 'pixi.js';
import { GameAssets } from './assets';

// Bitmap text from the baked arcade font — every HUD word stays on the pixel grid
export class PixelText extends Container {
  private glyphSprites: Sprite[] = [];
  private textValue = '';

  constructor(private assets: GameAssets, private pxScale: number, tint = 0xffffff) {
    super();
    this.tint = tint;
  }

  set text(value: string) {
    const upper = value.toUpperCase();
    if (upper === this.textValue) return;
    this.textValue = upper;
    for (const s of this.glyphSprites) s.destroy();
    this.glyphSprites = [];
    this.removeChildren();
    const advance = 6 * this.pxScale;
    let x = 0;
    for (const ch of upper) {
      const tex = this.assets.glyphs[ch];
      if (tex) {
        const sprite = new Sprite(tex);
        sprite.scale.set(this.pxScale);
        sprite.position.set(x, 0);
        this.addChild(sprite);
        this.glyphSprites.push(sprite);
      }
      x += advance; // unknown glyphs render as spaces
    }
  }

  get textWidth(): number {
    return Math.max(0, this.textValue.length * 6 - 1) * this.pxScale;
  }

  centerAt(x: number, y: number) {
    this.position.set(Math.round(x - this.textWidth / 2), Math.round(y));
  }
}
