import { Container, Graphics } from 'pixi.js';
import { GameAssets } from './assets';
import { PixelText } from './pixelText';

const SEGMENTS = 12;
const SEG_W = 13;
const SEG_H = 16;
const SEG_GAP = 2;
const METER_W = SEGMENTS * (SEG_W + SEG_GAP) - SEG_GAP;
const GOLD = 0xffd95e;
const MINT = 0x9ff0b8;
const CALLOUT_LIFE = 1.5;

// Every aiming mode in the game and the one line that explains it, keys first,
// pad second. A sight without a caption is a puzzle the player did not ask for.
type AimKind = 'keeper' | 'throwin' | null;
const AIM_HINTS: Record<NonNullable<AimKind>, [string, string]> = {
  keeper: ['CLICK WHERE THE BALL SHOULD GO', 'STICK AIMS - A LAUNCHES IT'],
  throwin: ['CLICK A TEAMMATE TO THROW TO', 'STICK AIMS - A THROWS IT IN'],
};

// Two palette colors blended straight in RGB — the only color math the HUD does
const mixTint = (a: number, b: number, t: number) => {
  const k = Math.max(0, Math.min(1, t));
  const ch = (shift: number) => Math.round((((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k)) << shift;
  return ch(16) | ch(8) | ch(0);
};

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
  private bannerPlate = new Graphics();
  private bannerTimer = 0;
  private bannerLife = 1.3;
  private bannerBig = false;
  private scoreText: PixelText;
  private scoreTabs = new Graphics();
  private scoreFlash = new Graphics();
  private lastScore = '';
  private scored: [number, number] = [-1, -1];
  private tabFlash = 0;
  private tabSide: 0 | 1 = 0;
  // One hint line, shared by every sight in the game. Nothing here ever asks
  // you to guess a control you have not been shown.
  private aimHint: PixelText;
  private aimKind: AimKind = null;
  private padHands = false;
  private pingText: PixelText;
  // The stadium noticing you: one line, one rule under it, gone in a breath
  private callout: PixelText;
  private calloutRule = new Graphics();
  private calloutColor = GOLD;
  private calloutT = 0;
  private chainText: PixelText;
  private chainRule = new Graphics();
  private chainCount = 0;
  private chainFade = 0;
  private chainPop = 0;
  private tension = 0;
  private heart = 0;

  constructor(assets: GameAssets) {
    this.sprintLabel = new PixelText(assets, 2, 0x9aa2b0);
    this.sprintLabel.text = 'SPRINT';
    this.aimHint = new PixelText(assets, 2, 0xffe27a);
    this.aimHint.visible = false;

    this.clockText = new PixelText(assets, 3, 0xfff3c4);

    this.toast = new PixelText(assets, 4, 0xffe27a);
    this.toast.visible = false;

    this.banner = new PixelText(assets, 14, 0xffdf5e);
    this.banner.text = 'GOAL!';
    this.banner.visible = false;
    this.bannerPlate.visible = false;

    this.callout = new PixelText(assets, 3, GOLD);
    this.callout.visible = false;
    this.chainText = new PixelText(assets, 2, MINT);
    this.chainText.visible = false;

    this.scoreText = new PixelText(assets, 4);
    this.pingText = new PixelText(assets, 2, 0x9aa2b0);
    this.pingText.visible = false;
    this.root.addChild(
      this.scoreTabs, this.scoreFlash, this.scoreText, this.clockText, this.sprintLabel, this.sprintBar,
      this.calloutRule, this.callout, this.chainRule, this.chainText,
      this.aimHint, this.pingText, this.toast, this.bannerPlate, this.banner,
    );
  }

  // The connection meter, online only: your own round trip to the room
  setPing(ms: number | null) {
    this.pingText.visible = ms !== null;
    if (ms === null) return;
    this.pingText.text = `PING ${Math.max(1, Math.round(ms))}MS`;
    this.pingText.tint = ms < 80 ? 0x9ff0b8 : ms < 150 ? 0xffd95e : 0xff5340;
  }

  // Whichever sight is up says how to use it — spot kick, keeper's launch, or
  // your own throw at the line. A sight only ever speaks for itself, so one
  // going down can never silence another that is still up.
  setAimHint(kind: NonNullable<AimKind>, on: boolean) {
    if (!on && this.aimKind !== kind) return;
    this.aimKind = on ? kind : null;
    this.aimHint.visible = on;
    if (on) this.aimHint.text = AIM_HINTS[kind][this.padHands ? 1 : 0];
  }

  // Hints follow the hands: pad glyphs when a controller drives
  setPadHints(on: boolean) {
    this.padHands = on;
    if (this.aimKind) this.aimHint.text = AIM_HINTS[this.aimKind][on ? 1 : 0];
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
    this.pingText.position.set(14, h - 28);
    // the caption never sits on the clock — it hangs off its bottom edge
    this.toast.centerAt(w / 2, 56 + this.clockText.textHeight);
    this.banner.centerAt(w / 2, this.bannerY(h));

    const scoreLabel = `${score.left} - ${score.right}`;
    this.scoreText.text = scoreLabel;
    this.scoreText.centerAt(w / 2, 14);
    this.clockText.centerAt(w / 2, 52);
    // The tab of whoever just scored burns for a beat — the board reacts too
    if (score.left !== this.scored[0] || score.right !== this.scored[1]) {
      if (this.scored[0] >= 0 && score.left + score.right > this.scored[0] + this.scored[1]) {
        this.tabSide = score.left > this.scored[0] ? 0 : 1;
        this.tabFlash = 1;
      }
      this.scored = [score.left, score.right];
    }
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

  // The stadium saying your name: a short line under the tank, typed on, ruled
  // in gold, gone before it can ever read as a slot machine
  showCallout(text: string, tone: 'gold' | 'mint') {
    this.calloutColor = tone === 'gold' ? GOLD : MINT;
    this.callout.text = text;
    this.callout.tint = this.calloutColor;
    this.callout.visible = true;
    this.calloutT = CALLOUT_LIFE;
  }

  // Passes strung together, counted plainly — the rule under it fills as the
  // run grows, and the number flares white on every new link
  setChain(count: number) {
    if (count === this.chainCount) return;
    if (count > this.chainCount) this.chainPop = 1;
    this.chainCount = count;
    if (count >= 3) this.chainText.text = `${count} IN A ROW`;
  }

  // How big this moment is (0-1) and where its pulse sits — the clock alone
  // wears it, reddening and breathing as the match tightens
  setTension(level: number, heart: number) {
    this.tension = level;
    this.heart = heart;
  }

  // The word lands hard, reads, and gets off the party: a lower third, not a
  // plate parked over the man wheeling away
  goalFlash() {
    this.banner.text = 'GOAL!';
    this.banner.visible = true;
    this.bannerBig = true;
    this.bannerLife = 1.2;
    this.bannerTimer = 1.2;
  }

  // Broadcast caption for a dead-ball moment: THROW IN, CORNER KICK, KICK OFF…
  announce(text: string) {
    this.banner.text = text;
    this.banner.visible = true;
    this.bannerBig = false;
    this.bannerLife = 1.3;
    this.bannerTimer = 1.3;
  }

  update(dt: number, w: number, h: number) {
    if (this.aimKind) this.aimHint.centerAt(w / 2, h - 54); // a sight on the turf keeps its caption on the rail
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

    this.drawCallout(dt, w);
    this.drawChain(dt, w);

    // The board answers the net: the scorer's tab burns white for a beat
    this.scoreFlash.clear();
    if (this.tabFlash > 0) {
      this.tabFlash = Math.max(0, this.tabFlash - dt * 1.4);
      const half = this.scoreText.textWidth / 2;
      const x = this.tabSide === 0 ? w / 2 - half - 26 : w / 2 + half + 10;
      this.scoreFlash.rect(x, 16, 16, 20).fill({ color: 0xfff8e0, alpha: 0.9 * this.tabFlash * this.tabFlash });
    }

    // The clock is the only thing on screen allowed to show fear: it warms
    // toward red as the match tightens and lifts a pixel on every heartbeat
    const nerve = Math.max(0, (this.tension - 0.65) / 0.35);
    this.clockText.tint = nerve <= 0 ? 0xfff3c4 : mixTint(0xfff3c4, 0xff7a5e, nerve);
    this.clockText.position.y -= this.heart * nerve > 0.5 ? 1 : 0;

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      this.toast.alpha = Math.min(1, this.toastTimer / 0.3);
      if (this.toastTimer <= 0) this.toast.visible = false;
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      this.drawBanner(w, h);
      if (this.bannerTimer <= 0) {
        this.banner.visible = false;
        this.bannerPlate.visible = false;
      }
    }
  }

  // A goal takes the lower third — the celebration owns the middle of the
  // screen, and the word never parks on the man wheeling away. Every other
  // call keeps the broadcast centre.
  private bannerY(h: number): number {
    if (!this.bannerBig) return Math.round(h / 2 - 70);
    return Math.round(Math.max(h * 0.58, h - this.banner.textHeight - 92));
  }

  // The caption: a cloth band that wipes open from the middle, letters typed
  // onto it, and — when a goal put it there — a gold sheen running across
  private drawBanner(w: number, h: number) {
    const age = this.bannerLife - this.bannerTimer;
    this.banner.reveal = Math.min(1, age / (this.bannerBig ? 0.26 : 0.14));
    const fade = Math.min(1, this.bannerTimer / 0.4);
    this.banner.alpha = fade;
    const y = this.bannerY(h);
    this.banner.position.set(Math.round((w - this.banner.textWidth) / 2), y);

    const open = Math.min(1, age / 0.16);
    const bandW = Math.round((this.banner.textWidth + (this.bannerBig ? 120 : 60)) * open);
    const padY = this.bannerBig ? 16 : 10;
    const bandH = this.banner.textHeight + padY * 2;
    const x0 = Math.round(w / 2 - bandW / 2);
    const g = this.bannerPlate;
    this.bannerPlate.visible = true;
    g.clear();
    g.rect(x0 - 2, y - padY - 2, bandW + 4, bandH + 4).fill({ color: 0x05070b, alpha: 0.75 * fade });
    g.rect(x0, y - padY, bandW, bandH).fill({ color: 0x0d1119, alpha: 0.92 * fade });
    g.rect(x0, y - padY, bandW, 3).fill({ color: GOLD, alpha: 0.95 * fade });
    g.rect(x0, y - padY + bandH - 3, bandW, 3).fill({ color: GOLD, alpha: 0.6 * fade });
    // mint crop marks, the game's own corner language
    for (const [cx, dx] of [[x0, 1], [x0 + bandW, -1]] as [number, number][]) {
      for (const [cy, dy] of [[y - padY, 1], [y - padY + bandH, -1]] as [number, number][]) {
        g.rect(dx > 0 ? cx : cx - 14, dy > 0 ? cy : cy - 3, 14, 3).fill({ color: MINT, alpha: 0.85 * fade });
        g.rect(dx > 0 ? cx : cx - 3, dy > 0 ? cy : cy - 11, 3, 11).fill({ color: MINT, alpha: 0.85 * fade });
      }
    }
    if (!this.bannerBig) return;
    // the sheen: one bright pass across the letters, done before the fade
    const sweep = age / (this.bannerLife * 0.5);
    if (sweep > 1) return;
    const sx = Math.round(x0 + sweep * bandW);
    g.rect(sx - 3, y - padY + 2, 6, bandH - 4).fill({ color: 0xfff8e0, alpha: 0.16 * fade });
  }

  private drawCallout(dt: number, w: number) {
    if (this.calloutT <= 0) return;
    this.calloutT -= dt;
    const age = CALLOUT_LIFE - this.calloutT;
    const fade = Math.min(1, this.calloutT / 0.35);
    const rise = Math.round(Math.max(0, age - 1.05) * 12);
    const x = Math.round(w - 18 - this.callout.textWidth);
    const y = 62 - rise;
    this.callout.reveal = Math.min(1, age / 0.12);
    this.callout.alpha = fade;
    this.callout.position.set(x, y);
    this.calloutRule.clear();
    if (this.calloutT <= 0) {
      this.callout.visible = false;
      return;
    }
    this.calloutRule
      .rect(x, y + this.callout.textHeight - 3, Math.round(this.callout.textWidth * Math.min(1, age / 0.22)), 2)
      .fill({ color: this.calloutColor, alpha: 0.8 * fade });
  }

  // The run, counted: the rule underneath fills as the passes stack, and the
  // number flares white on every link — the tally the ear hears rising
  private drawChain(dt: number, w: number) {
    this.chainFade = Math.max(0, Math.min(1, this.chainFade + (this.chainCount >= 3 ? dt * 6 : -dt * 5)));
    this.chainPop = Math.max(0, this.chainPop - dt * 4);
    this.chainText.visible = this.chainFade > 0.02;
    this.chainRule.clear();
    if (!this.chainText.visible) return;
    const x = Math.round(w - 18 - this.chainText.textWidth);
    this.chainText.position.set(x, 96);
    this.chainText.alpha = this.chainFade;
    this.chainText.tint = mixTint(MINT, 0xffffff, this.chainPop);
    this.chainRule
      .rect(x, 96 + this.chainText.textHeight - 3, Math.round(this.chainText.textWidth * Math.min(1, this.chainCount / 8)), 2)
      .fill({ color: MINT, alpha: 0.5 * this.chainFade });
  }
}
