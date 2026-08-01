import { Container, Graphics } from 'pixi.js';
import { GameAssets } from './assets';
import { PixelText } from './pixelText';

const CONTROLS: [string, string][] = [
  ['WASD MOVE', 'DRAG PASS'],
  ['SHIFT SPRINT', 'SPACE KICK'],
  ['J L BEND', 'K TACKLE'],
  ['E SWITCH', 'T AUTO'],
  ['1 2 3 PITCH', ''],
];
const BOX_W = 306;
const BOX_H = 5 * 15 + 14;

// All HUD text is baked pixel font — nothing breaks the retro grid
export class Hud {
  root = new Container();
  private controlsBox = new Container();
  private sprintBar = new Graphics();
  private sprintLabel: PixelText;
  private stamina = 1;
  private sprinting = false;
  private sprintPulse = 0;
  private clockText!: PixelText;
  private toast: PixelText;
  private toastTimer = 0;
  private banner: PixelText;
  private bannerTimer = 0;
  private scoreText: PixelText;
  private scoreTabs = new Graphics();
  private lastScore = '';

  constructor(assets: GameAssets) {
    // Compact control card: two tight columns on a dark backing
    const backing = new Graphics();
    backing.rect(0, 0, BOX_W, BOX_H).fill({ color: 0x10141c, alpha: 0.62 });
    backing.rect(0, 0, BOX_W, 1).fill({ color: 0xfff8e0, alpha: 0.18 });
    backing.rect(0, BOX_H - 1, BOX_W, 1).fill({ color: 0x000000, alpha: 0.35 });
    this.controlsBox.addChild(backing);
    CONTROLS.forEach(([left, right], row) => {
      const l = new PixelText(assets, 2, 0xd8dce6);
      l.text = left;
      l.position.set(8, 8 + row * 15);
      this.controlsBox.addChild(l);
      if (right) {
        const r = new PixelText(assets, 2, 0xd8dce6);
        r.text = right;
        r.position.set(164, 8 + row * 15);
        this.controlsBox.addChild(r);
      }
    });
    this.controlsBox.alpha = 0.9;

    this.sprintLabel = new PixelText(assets, 2, 0xd8dce6);
    this.sprintLabel.text = 'SPRINT';

    this.clockText = new PixelText(assets, 3, 0xfff3c4);

    this.toast = new PixelText(assets, 4, 0xffe27a);
    this.toast.visible = false;

    this.banner = new PixelText(assets, 14, 0xffdf5e);
    this.banner.text = 'GOAL!';
    this.banner.visible = false;

    this.scoreText = new PixelText(assets, 4);
    this.root.addChild(this.scoreTabs, this.scoreText, this.clockText, this.controlsBox, this.sprintLabel, this.sprintBar, this.toast, this.banner);
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
    this.controlsBox.position.set(10, h - BOX_H - 10);
    this.sprintLabel.position.set(12, h - BOX_H - 30);
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
    // Sprint tank: mint when full, gold when taxed, red when the legs are
    // gone (sprint locks below 5%) — a bright tip crawls while it refills
    this.sprintPulse += dt * 7;
    const bx = 12 + this.sprintLabel.textWidth + 10;
    const by = h - BOX_H - 31;
    const bw = 96;
    const fill = Math.round((bw - 2) * this.stamina);
    const color = this.stamina < 0.18 ? 0xff5340 : this.stamina < 0.45 ? 0xffd95e : 0x9ff0b8;
    this.sprintBar.clear();
    this.sprintBar.rect(bx, by, bw, 9).fill({ color: 0x10141c, alpha: 0.72 });
    this.sprintBar.rect(bx, by, bw, 1).fill({ color: 0xfff8e0, alpha: 0.18 });
    if (fill > 0) this.sprintBar.rect(bx + 1, by + 1, fill, 7).fill({ color, alpha: 0.92 });
    const recovering = !this.sprinting && this.stamina < 0.995;
    if (recovering && fill > 1) {
      // the leading edge glows as the tank refills
      const tip = 0.5 + 0.5 * Math.sin(this.sprintPulse);
      this.sprintBar.rect(bx + fill - 1, by + 1, 2, 7).fill({ color: 0xffffff, alpha: 0.35 + 0.4 * tip });
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
