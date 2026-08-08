import { Container, Sprite } from 'pixi.js';
import { GameAssets } from './assets';

// Bitmap text from the baked proportional font — every word stays on the
// pixel grid. 'main' is the 7px voice, 'micro' the 5px whisper for the pitch.

const warned = new Set<string>(); // one dev warning per missing glyph, not per frame

export class PixelText extends Container {
  private glyphSprites: Sprite[] = [];
  private textValue = '';
  private widthValue = 0;

  constructor(
    private assets: GameAssets,
    private pxScale: number,
    tint = 0xffffff,
    private font: 'main' | 'micro' = 'main',
  ) {
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
    const micro = this.font === 'micro';
    const glyphs = micro ? this.assets.microGlyphs : this.assets.glyphs;
    const metrics = micro ? this.assets.manifest.font.micro.widths : this.assets.manifest.font.widths;
    let x = 0;
    for (const ch of upper) {
      const tex = glyphs[ch];
      if (tex) {
        const sprite = new Sprite(tex);
        sprite.scale.set(this.pxScale);
        // Every glyph cell carries a 1px outline column before its ink. Pull
        // the sprites back by it so this container's origin is where the INK
        // starts — otherwise every centered word in the game sits one scaled
        // pixel right of the thing it was asked to center on.
        sprite.position.set(x - this.pxScale, 0);
        this.addChild(sprite);
        this.glyphSprites.push(sprite);
        x += (metrics[ch] + 1) * this.pxScale;
      } else {
        // A character the bake never cut leaves a hole in the copy — a space
        // is the one that means it. The player gets air rather than a crash;
        // the author gets told, once.
        if (import.meta.env.DEV && ch !== ' ' && !warned.has(ch)) {
          warned.add(ch);
          console.warn(`pixel font has no glyph for "${ch}" — cut it in tools/texgen/font.mjs`);
        }
        x += 3 * this.pxScale;
      }
    }
    this.widthValue = Math.max(0, x - this.pxScale);
  }

  get textWidth(): number {
    return this.widthValue;
  }

  // The rendered cell height — glyph ink plus its baked outline rows
  get textHeight(): number {
    const cellH = this.font === 'micro' ? this.assets.manifest.font.micro.cellH : this.assets.manifest.font.cellH;
    return cellH * this.pxScale;
  }

  // Typewriter materialize: 0..1 shows the word letter by letter, the newest
  // glyph landing from a pixel above — motion ON the grid, never a smear
  set reveal(t: number) {
    const n = Math.ceil(Math.max(0, Math.min(1, t)) * this.glyphSprites.length);
    this.glyphSprites.forEach((g, i) => {
      g.visible = i < n;
      g.position.y = i === n - 1 && t < 1 ? -this.pxScale : 0;
    });
  }

  centerAt(x: number, y: number) {
    this.position.set(Math.round(x - this.widthValue / 2), Math.round(y));
  }
}
