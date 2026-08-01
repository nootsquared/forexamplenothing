import { Container, Graphics } from 'pixi.js';
import { GameAssets } from './assets';
import { PixelText } from './pixelText';

const SEGMENTS = 12;
const SEG_W = 13;
const SEG_H = 16;
const SEG_GAP = 2;
const METER_W = SEGMENTS * (SEG_W + SEG_GAP) - SEG_GAP;

// All HUD text is baked pixel font — nothing breaks the retro grid
export class Hud {
  root = new Container();
  private sprintBar = new Graphics();
  private sprintLabel: PixelText;
  private stamina = 1;
  private sprinting = false;
  private sprintPulse = 0;
  private meterX = 0;
  private clockText!: PixelText;
  private toast: PixelText;
  private toastTimer = 0;
  private banner: PixelText;
  private bannerTimer = 0;
  private scoreText: PixelText;
  private scoreTabs = new Graphics();
  private lastScore = '';
  private penAim = new Graphics();
  private penHint: PixelText;
  private penState: { col: number; row: number } | null = null;
  private penPulse = 0;

  constructor(assets: GameAssets) {
    this.sprintLabel = new PixelText(assets, 2, 0x9aa2b0);
    this.sprintLabel.text = 'SPRINT';
    this.penHint = new PixelText(assets, 2, 0xffe27a);
    this.penHint.text = 'WASD PICK A BIN - ENTER SHOOTS';
    this.penHint.visible = false;

    this.clockText = new PixelText(assets, 3, 0xfff3c4);

    this.toast = new PixelText(assets, 4, 0xffe27a);
    this.toast.visible = false;

    this.banner = new PixelText(assets, 14, 0xffdf5e);
    this.banner.text = 'GOAL!';
    this.banner.visible = false;

    this.scoreText = new PixelText(assets, 4);
    this.root.addChild(this.scoreTabs, this.scoreText, this.clockText, this.sprintLabel, this.sprintBar, this.penAim, this.penHint, this.toast, this.banner);
  }

  // The spot-kick sight: a pixel goal mouth split into six bins. The shooter
  // walks the gold bracket around; everything else stays out of the way.
  setPenaltyAim(state: { col: number; row: number } | null) {
    this.penState = state;
    this.penHint.visible = state !== null;
    if (!state) this.penAim.clear();
  }

  setClock(text: string) {
    this.clockText.text = text;
  }

  // The controlled body's tank, fed every frame by the scene
  setSprint(stamina: number, sprinting: boolean) {
    this.stamina = stamina;
    this.sprinting = sprinting;
  }

  layout(w: number, h: number, score: { left: number; right: number }) {
    // The tank lives top-right where a fighting game keeps its meters
    this.meterX = w - METER_W - 18;
    this.sprintLabel.position.set(this.meterX, 16);
    this.toast.centerAt(w / 2, 54);
    this.banner.centerAt(w / 2, h / 2 - 70);

    const scoreLabel = `${score.left} - ${score.right}`;
    this.scoreText.text = scoreLabel;
    this.scoreText.centerAt(w / 2, 14);
    this.clockText.centerAt(w / 2, 52);
    if (scoreLabel !== this.lastScore) {
      this.lastScore = scoreLabel;
      // Kit-colored tabs flanking the score, drawn once per change
      const half = this.scoreText.textWidth / 2;
      this.scoreTabs.clear();
      this.scoreTabs.rect(w / 2 - half - 26, 16, 16, 16).fill(0xc4432f);
      this.scoreTabs.rect(w / 2 - half - 26, 32, 16, 4).fill(0x7e2417);
      this.scoreTabs.rect(w / 2 + half + 10, 16, 16, 16).fill(0x3458a8);
      this.scoreTabs.rect(w / 2 + half + 10, 32, 16, 4).fill(0x1c3260);
    }
  }

  showToast(text: string) {
    this.toast.text = text;
    this.toast.visible = true;
    this.toastTimer = 1.4;
  }

  goalFlash() {
    this.banner.text = 'GOAL!';
    this.banner.visible = true;
    this.banner.scale.set(0.3);
    this.bannerTimer = 1.6;
  }

  // Broadcast caption for a dead-ball moment: THROW IN, CORNER KICK, KICK OFF…
  announce(text: string) {
    this.banner.text = text;
    this.banner.visible = true;
    this.banner.scale.set(0.3);
    this.bannerTimer = 1.3;
  }

  update(dt: number, w: number, h: number) {
    void w; void h;
    // The penalty sight draws itself over the play: chunky white frame like
    // the real goal furniture, six dark bins, the chosen one burning gold
    this.penPulse += dt * 6;
    if (this.penState) {
      const g = this.penAim;
      const binW = 64;
      const binH = 44;
      const frameW = binW * 3;
      const frameH = binH * 2;
      const x0 = Math.round(w / 2 - frameW / 2);
      const y0 = Math.round(h * 0.3 - frameH / 2);
      g.clear();
      g.rect(x0 - 8, y0 - 8, frameW + 16, frameH + 12).fill({ color: 0x0a0e14, alpha: 0.55 });
      // posts and bar, pixel-chunky
      g.rect(x0 - 6, y0 - 6, frameW + 12, 6).fill({ color: 0xf2f5fa, alpha: 0.95 });
      g.rect(x0 - 6, y0, 6, frameH + 4).fill({ color: 0xf2f5fa, alpha: 0.95 });
      g.rect(x0 + frameW, y0, 6, frameH + 4).fill({ color: 0xf2f5fa, alpha: 0.95 });
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 2; r++) {
          const bx = x0 + c * binW;
          const by = y0 + r * binH;
          const sel = this.penState.col === c && this.penState.row === r;
          g.rect(bx + 2, by + 2, binW - 4, binH - 4).fill({ color: sel ? 0x2a2410 : 0x10141c, alpha: sel ? 0.85 : 0.5 });
          // net weave hint
          for (let nx = bx + 6; nx < bx + binW - 4; nx += 8) g.rect(nx, by + 2, 1, binH - 4).fill({ color: 0xffffff, alpha: 0.06 });
          for (let ny = by + 6; ny < by + binH - 4; ny += 8) g.rect(bx + 2, ny, binW - 4, 1).fill({ color: 0xffffff, alpha: 0.06 });
          if (sel) {
            const glow = 0.6 + 0.4 * Math.sin(this.penPulse);
            const arm = 10;
            const t = 3;
            for (const [cx, cy, aw, ah] of [
              [bx + 2, by + 2, arm, t], [bx + 2, by + 2, t, arm],
              [bx + binW - 2 - arm, by + 2, arm, t], [bx + binW - 2 - t, by + 2, t, arm],
              [bx + 2, by + binH - 2 - t, arm, t], [bx + 2, by + binH - 2 - arm, t, arm],
              [bx + binW - 2 - arm, by + binH - 2 - t, arm, t], [bx + binW - 2 - t, by + binH - 2 - arm, t, arm],
            ] as [number, number, number, number][]) {
              g.rect(cx, cy, aw, ah).fill({ color: 0xffd95e, alpha: glow });
            }
          }
        }
      }
      this.penHint.centerAt(w / 2, y0 + frameH + 18);
    }
    // The sprint tank: twelve beveled cells that drain body by body — mint
    // legs, gold taxes, red empty (sprint locks below 5%). The next cell to
    // refill breathes while you recover; the whole rack shudders when locked.
    this.sprintPulse += dt * 7;
    const bx = this.meterX;
    const by = 32;
    const cells = this.stamina * SEGMENTS;
    const full = Math.floor(cells);
    const partial = cells - full;
    const locked = this.stamina < 0.05;
    const color = locked || this.stamina < 0.18 ? 0xff5340 : this.stamina < 0.45 ? 0xffd95e : 0x9ff0b8;
    const g = this.sprintBar;
    g.clear();
    // the rack: a dark tray with a lit top edge and corner notches
    g.rect(bx - 5, by - 4, METER_W + 10, SEG_H + 8).fill({ color: 0x0c1018, alpha: 0.78 });
    g.rect(bx - 5, by - 4, METER_W + 10, 1).fill({ color: 0xfff8e0, alpha: 0.25 });
    g.rect(bx - 5, by + SEG_H + 3, METER_W + 10, 1).fill({ color: 0x000000, alpha: 0.45 });
    for (const nx of [bx - 5, bx + METER_W + 2]) g.rect(nx, by - 4, 3, 3).fill({ color: 0xffd95e, alpha: 0.7 });
    const shake = locked ? Math.round(Math.sin(this.sprintPulse * 3) * 1) : 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const x = bx + i * (SEG_W + SEG_GAP) + shake;
      if (i < full || (i === full && partial > 0.55)) {
        // a lit cell wears a bevel: bright cap, body, dark floor
        g.rect(x, by, SEG_W, SEG_H).fill({ color, alpha: 0.92 });
        g.rect(x, by, SEG_W, 2).fill({ color: 0xffffff, alpha: 0.4 });
        g.rect(x, by + SEG_H - 2, SEG_W, 2).fill({ color: 0x000000, alpha: 0.3 });
      } else {
        g.rect(x, by, SEG_W, SEG_H).fill({ color: 0x1a212e, alpha: 0.85 });
        g.rect(x, by, SEG_W, 1).fill({ color: 0xfff8e0, alpha: 0.07 });
        if (i === full && !this.sprinting && this.stamina < 0.995) {
          // the cell being refilled breathes
          const tip = 0.5 + 0.5 * Math.sin(this.sprintPulse);
          g.rect(x, by, SEG_W, SEG_H).fill({ color, alpha: 0.12 + 0.3 * tip * partial });
        }
      }
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      this.toast.alpha = Math.min(1, this.toastTimer / 0.3);
      if (this.toastTimer <= 0) this.toast.visible = false;
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      // Pop in with overshoot, a beat of hold, fade out
      const t = 1.6 - this.bannerTimer;
      const scale = t < 0.18 ? 0.3 + (t / 0.18) * 0.95 : t < 0.3 ? 1.25 - ((t - 0.18) / 0.12) * 0.25 : 1;
      this.banner.scale.set(scale);
      this.banner.alpha = this.bannerTimer < 0.4 ? this.bannerTimer / 0.4 : 1;
      const half = (this.banner.textWidth * scale) / 2;
      this.banner.position.set(Math.round(w / 2 - half), Math.round(h / 2 - 70));
      if (this.bannerTimer <= 0) this.banner.visible = false;
    }
  }
}
