import { Container, Graphics } from 'pixi.js';
import { GameAssets } from './assets';
import { PixelText } from './pixelText';

// All HUD text is baked pixel font — nothing breaks the retro grid
export class Hud {
  root = new Container();
  private hint: PixelText;
  private toast: PixelText;
  private toastTimer = 0;
  private banner: PixelText;
  private bannerTimer = 0;
  private scoreText: PixelText;
  private scoreTabs = new Graphics();
  private lastScore = '';

  constructor(assets: GameAssets) {
    this.hint = new PixelText(assets, 2);
    this.hint.text = 'WASD MOVE - SHIFT SPRINT - SPACE KICK - 1 2 3 PITCH - R BALL';
    this.hint.alpha = 0.72;

    this.toast = new PixelText(assets, 4, 0xffe27a);
    this.toast.visible = false;

    this.banner = new PixelText(assets, 14, 0xffdf5e);
    this.banner.text = 'GOAL!';
    this.banner.visible = false;

    this.scoreText = new PixelText(assets, 4);
    this.root.addChild(this.scoreTabs, this.scoreText, this.hint, this.toast, this.banner);
  }

  layout(w: number, h: number, score: { left: number; right: number }) {
    this.hint.position.set(14, h - 28);
    this.toast.centerAt(w / 2, 54);
    this.banner.centerAt(w / 2, h / 2 - 70);

    const scoreLabel = `${score.left} - ${score.right}`;
    this.scoreText.text = scoreLabel;
    this.scoreText.centerAt(w / 2, 14);
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
    this.banner.visible = true;
    this.banner.scale.set(0.3);
    this.bannerTimer = 1.6;
  }

  update(dt: number, w: number, h: number) {
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
