import { Container, Graphics, Sprite } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';
import { MOODS } from '../render/variants';
import { BeamMotes, Drop, GrassBed, PixelDust, PixelList, Reveal, centerShade, pillarBounds, pitchMark, stepShade } from './kit';
import { Match } from '../match';

// The shell's screens: menu, setup, pause, full-time. The squad builder
// (draft + gamble) lives in draft.ts. Each screen owns a root container;
// the shell shows one at a time and routes keys into it.

export interface Screen {
  root: Container;
  key(code: string): void;
  layout(w: number, h: number): void;
  update?(dt: number): void;
  enter?(): void; // play the entrance — called after layout when shown
}

// One crisp left edge for every shade screen; list markers hang in the gutter
const LEFT = 70;
const HALF_CHOICES = [60, 120, 180, 300];
const SIZE_CHOICES = [5, 7, 11];
const DIFF_NAMES = ['EASY', 'MEDIUM', 'HARD'];
const FPS_CHOICES: (number | null)[] = [null, 120, 60, 30];
export const fmtClock = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// What a play mode gets configured with before kickoff
export type PlayMode = 'quick' | 'draft' | 'gamble';
export interface MatchSetup {
  mode: PlayMode;
  size: number;
  halfLength: number;
  difficulty: 0 | 1 | 2;
}

// ---------------------------------------------------------------- main menu
// A live AI match plays behind this screen; the menu stands CENTERED in a
// stepped spotlight pillar — wordmark up top, options stacked beneath, the
// game's own ball rolling across the bottom of the frame. The stack arrives
// as STADIUM SIGNAGE: heavy plates drop onto the stage, slam through their
// rests, kick up pixel dust — and the wordmark catches the light while idle.
export class MenuScreen implements Screen {
  root = new Container();
  onQuick: () => void = () => {};
  onDraft: () => void = () => {};
  onGamble: () => void = () => {};
  onTraining: () => void = () => {};
  onOnline: () => void = () => {};
  onMood: (moodIdx: number) => void = () => {};
  onFps: (cap: number | null) => void = () => {};
  onAudio: (music: number, sfx: number) => void = () => {};
  moodIdx = 0;
  autoSwitch = false;
  fpsIdx = 0; // into FPS_CHOICES
  musicVol = 7;
  sfxVol = 7;
  private page: 'root' | 'play' | 'settings' = 'root';
  private list: PixelList;
  private title: Sprite;
  private sub: PixelText;
  private ver: PixelText;
  private crumb: PixelText;
  private socials = new Container();
  private socialBox = new Graphics();
  private socialHeader: PixelText;
  private socialRows: Container[];
  private shade = new Graphics();
  private mark = new Graphics();     // the ghosted centre circle in the glass
  private motes = new BeamMotes();   // light motes adrift in the pane
  private grass = new GrassBed();    // the overgrown bed along the pane's foot
  private restBall: Sprite;          // the pixel ball asleep in the blades
  private backdrop = new Container();
  private box = new Graphics();
  private plate = new Container(); // box + options: one piece of signage
  private reveal = new Reveal();
  private drop = new Drop();       // the full entrance
  private pageDrop = new Drop();   // the little hop between menu pages
  private dust = new PixelDust();
  private shine = new Graphics();  // the light band that sweeps the wordmark
  private shineMask: Sprite;
  private shineT = 0;
  private w = 1280;
  private h = 720;

  constructor(private assets: GameAssets) {
    this.title = new Sprite(assets.title);
    this.sub = new PixelText(assets, 3, 0x9ff0b8);
    this.sub.text = 'A NOOT^2 GAME';
    // the build's git ledger, worn small beside the signage
    this.ver = new PixelText(assets, 2, 0x8a91a0, 'micro');
    this.ver.text = `V${__GAME_VERSION__}`;
    // the socials footer: uniform ledger rows — grey LABEL:, then the value.
    // Linked values wear gold with a chalk underline, brighten under the
    // hand, and open in a new tab; the credit line just stands there proud.
    this.socialHeader = new PixelText(assets, 2, 0x8a91a0, 'micro'); // quieter than the crumb
    this.socialHeader.text = 'SOCIALS';
    this.socials.addChild(this.socialBox);
    const socialRow = (label: string, value: string, url?: string) => {
      const row = new Container();
      const l = new PixelText(assets, 2, 0x8a91a0);
      l.text = label;
      const v = new PixelText(assets, 2, url ? 0xffd95e : 0xdfe4ee);
      v.text = value;
      v.position.set(l.width + 8, 0);
      row.addChild(l, v);
      if (url) {
        const bar = new Graphics().rect(0, 16, v.width, 2).fill({ color: 0xffd95e, alpha: 0.55 });
        bar.position.set(l.width + 8, 0);
        row.addChild(bar);
        row.eventMode = 'static';
        row.cursor = 'pointer';
        row.on('pointerover', () => { v.tint = 0xfff3c4; bar.alpha = 1; audio.ui('move', 0.3); });
        row.on('pointerout', () => { v.tint = 0xffd95e; bar.alpha = 0.55; });
        row.on('pointertap', () => { audio.ui('card', 0.5); window.open(url, '_blank'); });
      }
      this.socials.addChild(row);
      return row;
    };
    this.socialRows = [
      socialRow('DEVELOPER:', 'PRANAV MARINGANTI'),
      socialRow('GITHUB:', 'NOOT SQUARED', 'https://github.com/nootsquared'),
      socialRow('INSTA:', 'PRANAVMARINGANTI', 'https://instagram.com/pranavmaringanti'),
      socialRow('LINKEDIN:', 'PRANAV-MARINGANTI', 'https://www.linkedin.com/in/pranav-maringanti'),
    ];
    this.socials.addChild(this.socialHeader);
    this.crumb = new PixelText(assets, 2, 0x8a91a0);
    this.list = new PixelList(assets, 3, 34, 7, 13, true);
    this.list.onPick = (i) => this.act(i);
    this.plate.addChild(this.box, this.list.root);
    this.list.root.position.set(0, 20); // the options sit inside their plate
    // the shine renders only where the wordmark's own pixels are
    this.shineMask = new Sprite(assets.title);
    this.shine.mask = this.shineMask;
    this.shine.blendMode = 'add';
    // the resting ball sleeps INSIDE the bed: behind the front blades,
    // ahead of the back ones — cradled, not placed
    this.restBall = new Sprite(assets.ballFrames[0][0]);
    this.restBall.anchor.set(0.5);
    this.restBall.scale.set(6);
    this.backdrop.addChild(this.shade, this.mark, this.grass.soil, this.grass.back, this.restBall, this.grass.front, this.motes.g);
    this.root.addChild(this.backdrop, this.title, this.shine, this.shineMask, this.sub, this.ver, this.crumb, this.plate, this.socials, this.dust.g);
    this.setPage('root', false);
  }

  // Land on a given page when the screen is (re)shown — back arrows return
  // to where you actually came from, quitting a match returns to the front
  openPage(page: 'root' | 'play' | 'settings') {
    this.setPage(page, false);
  }

  private setPage(page: 'root' | 'play' | 'settings', animate = true) {
    this.page = page;
    this.socials.visible = page === 'root'; // the addresses live on the front door
    this.list.sel = 0; // a fresh page starts at its top
    this.crumb.text = page === 'root' ? 'MAIN MENU' : page === 'play' ? 'PLAY' : 'SETTINGS';
    this.crumb.centerAt(this.w / 2, this.h * 0.42); // a new word, a new center
    this.refresh(animate, 0.08);
    // the plate HOPS to the new page — unless the big entrance still owns it
    if (animate && !this.drop.active) {
      this.reveal.clear();
      this.reveal.add(this.crumb, 0);
      this.reveal.play();
      this.pageDrop.finish(); // a half-flown hop settles before the next one
      this.pageDrop.clear();
      this.pageDrop.add(this.plate, 0, { from: 14, dur: 0.24, onImpact: () => audio.ui('card', 0.4) });
      this.pageDrop.play();
    }
  }

  private refresh(animate = false, stagger = 0) {
    const cap = FPS_CHOICES[this.fpsIdx];
    const rows =
      this.page === 'root' ? [{ label: 'PLAY' }, { label: 'PLAY ONLINE' }, { label: 'SETTINGS' }] :
      this.page === 'play' ? [{ label: 'QUICK MATCH' }, { label: 'DRAFT MODE' }, { label: 'GAMBLE MODE' }, { label: 'TRAINING GROUND' }, { label: 'BACK', gapBefore: true }] :
      [
        { label: 'PITCH', value: MOODS[this.moodIdx].name.toUpperCase() },
        { label: 'AUTO SWITCH', value: this.autoSwitch ? 'ON' : 'OFF' },
        { label: 'FPS CAP', value: cap === null ? 'UNLIMITED' : String(cap) },
        { label: 'MUSIC VOL', value: String(this.musicVol) },
        { label: 'SFX VOL', value: String(this.sfxVol) },
        { label: 'BACK', gapBefore: true },
      ];
    this.list.setRows(rows.map((r) => ({ ...r, enabled: true })), true, animate, stagger);
    this.drawBox();
  }

  // The options live in a proper menu box — a framed panel, drawn in the
  // plate's own space so the whole piece of signage can move as one
  private drawBox() {
    const bw = Math.max(this.list.blockWidth + 110, 330);
    const bh = this.list.totalHeight + 34;
    const bx = -Math.round(bw / 2);
    const g = this.box;
    g.clear();
    g.rect(bx, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.88 });
    g.rect(bx, 0, bw, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    g.rect(bx, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(bx, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(bx + bw - 1, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    // corner studs tie it to the possession-frame language
    for (const [cx, cy] of [[bx + 3, 5], [bx + bw - 6, 5], [bx + 3, bh - 8], [bx + bw - 6, bh - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: 0xffd95e, alpha: 0.55 });
    }
  }

  // The socials plate wears the menu box's exact clothes, sized to its rows
  private drawSocialsBox() {
    const rowsW = Math.max(...this.socialRows.map((r) => r.width));
    const bw = Math.max(rowsW + 70, 300);
    const bh = 20 + this.socialRows.length * 24 + 8;
    const bx = -Math.round(bw / 2);
    const g = this.socialBox;
    // the menu box's cloth without its crown — and a border that exists only
    // at the corners: mint L-brackets, the card slots' own language
    g.clear();
    g.rect(bx, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.88 });
    g.rect(bx, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(bx, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(bx + bw - 1, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    const arm = 9;
    const mint = { color: 0x9ff0b8, alpha: 0.65 };
    g.rect(bx, 0, arm, 2).fill(mint).rect(bx, 0, 2, arm).fill(mint);
    g.rect(bx + bw - arm, 0, arm, 2).fill(mint).rect(bx + bw - 2, 0, 2, arm).fill(mint);
    g.rect(bx, bh - 2, arm, 2).fill(mint).rect(bx, bh - arm, 2, arm).fill(mint);
    g.rect(bx + bw - arm, bh - 2, arm, 2).fill(mint).rect(bx + bw - 2, bh - arm, 2, arm).fill(mint);
  }

  // The plate's footprint in screen space — where its landing dust belongs
  private plateBottom() {
    return { x: this.plate.position.x, y: this.plate.position.y + this.list.totalHeight + 34, w: Math.max(this.list.blockWidth + 110, 330) };
  }

  private act(i: number) {
    if (this.page === 'root') {
      if (i === 0) this.setPage('play');
      else if (i === 1) this.onOnline();
      else this.setPage('settings');
    } else if (this.page === 'play') {
      if (i === 0) this.onQuick();
      else if (i === 1) this.onDraft();
      else if (i === 2) this.onGamble();
      else if (i === 3) this.onTraining();
      else this.setPage('root');
    } else {
      if (i === 0) { this.moodIdx = (this.moodIdx + 1) % MOODS.length; this.onMood(this.moodIdx); }
      else if (i === 1) this.autoSwitch = !this.autoSwitch;
      else if (i === 2) { this.fpsIdx = (this.fpsIdx + 1) % FPS_CHOICES.length; this.onFps(FPS_CHOICES[this.fpsIdx]); }
      else if (i === 3) { this.musicVol = (this.musicVol + 1) % 11; this.onAudio(this.musicVol, this.sfxVol); }
      else if (i === 4) { this.sfxVol = (this.sfxVol + 1) % 11; this.onAudio(this.musicVol, this.sfxVol); }
      else return this.setPage('root');
      this.refresh();
    }
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
    if (code === 'Escape' && this.page !== 'root') { audio.ui('back'); this.setPage('root'); }
  }

  // Shown fresh: the stage lights come up and the signage falls — title
  // first, plate second, each landing in its own dust with its own thud,
  // the words typing themselves out between the slams
  // The backdrop arrives OPAQUE — a fade-in here reads as a bright flash
  // when the previous screen was already dark (online → back)
  enter() {
    this.reveal.clear();
    this.reveal.add(this.sub, 0.3);
    this.reveal.add(this.crumb, 0.4);
    this.reveal.play();
    this.drop.clear();
    this.drop.add(this.title, 0, { from: 46, dur: 0.4, onImpact: () => {
      audio.ui('card');
      this.dust.burst(this.w / 2, this.title.position.y + this.title.height + 2, this.title.width * 0.7, 14);
    } });
    this.drop.add(this.plate, 0.14, { from: 30, dur: 0.36, onImpact: () => {
      audio.ui('card', 0.65);
      const b = this.plateBottom();
      this.dust.burst(b.x, b.y, b.w * 0.55, 12);
    } });
    this.drop.play();
    this.shineT = SHINE_CYCLE - 0.5; // the wordmark glints right after it lands
    this.refresh(true, 0.28);
  }

  update(dt: number) {
    this.grass.update(dt);
    this.list.update(dt);
    this.reveal.update(dt);
    this.drop.update(dt);
    this.pageDrop.update(dt);
    this.dust.update(dt);
    this.motes.update(dt);
    // the idle glint: a slanted light band crosses the wordmark, then rests
    this.shineT += dt;
    const sweep = (this.shineT % SHINE_CYCLE) / 0.55;
    this.shine.visible = sweep <= 1 && !this.drop.active;
    if (this.shine.visible) {
      const span = this.title.width + 120;
      this.shine.position.x = this.title.position.x - 60 + span * sweep;
    }
  }

  layout(w: number, h: number) {
    this.w = w;
    this.h = h;
    centerShade(this.shade, w, h);
    const beam = pillarBounds(w);
    pitchMark(this.mark, w, h, beam.x0, beam.x1);
    this.motes.layout(beam.x0, beam.x1, h);
    // the ball RESTS: its underside on the soil, the short grass lapping
    // over its base, the bed parting around it
    this.restBall.position.set(Math.round(beam.x0 + beam.coreW * 0.3), h - 50);
    this.grass.layout(beam.x0, beam.coreW, h, { x: this.restBall.position.x, y: this.restBall.position.y, r: 42 });
    const scale = Math.max(6, Math.min(12, Math.floor((w * 0.34) / this.assets.manifest.title.w)));
    this.title.scale.set(scale);
    this.title.position.set(Math.round(w / 2 - this.title.width / 2), Math.round(h * 0.1));
    this.shineMask.scale.set(scale);
    this.shineMask.position.copyFrom(this.title.position);
    // the band itself: a leaning stripe taller than the wordmark, drawn once per size
    this.shine.clear();
    const sh = this.title.height + 12;
    this.shine.poly([{ x: 0, y: sh }, { x: 22, y: 0 }, { x: 52, y: 0 }, { x: 30, y: sh }]).fill({ color: 0xfff8e0, alpha: 0.32 });
    this.shine.position.y = this.title.position.y - 6;
    this.sub.centerAt(w / 2, h * 0.1 + this.title.height + 12);
    this.ver.centerAt(w / 2, h * 0.1 + this.title.height + 52); // the ledger, breathing under the studio line
    this.crumb.centerAt(w / 2, h * 0.42);
    // the socials plate: the menu box's little sibling — same header rhythm
    // (SOCIALS perched on the frame exactly like MAIN MENU), same box grammar
    // sunk low on purpose: the addresses are a footer, never the menu's equal
    this.socials.position.set(Math.round(w / 2), Math.min(Math.round(h * 0.47) + 285, h - 132));
    const headGap = Math.max(1, Math.round(h * 0.05) - 38);
    this.socialHeader.centerAt(0, -(headGap + 10));
    this.socialRows.forEach((row, i) => {
      row.position.set(Math.round(-row.width / 2), 20 + i * 24);
    });
    this.drawSocialsBox();
    this.plate.position.set(Math.round(w / 2), Math.round(h * 0.47) - 20);
    this.drawBox();
  }
}

const SHINE_CYCLE = 7; // seconds between wordmark glints

// ------------------------------------------------------------- match setup
// Every play mode passes through here: sides, half length, difficulty, go.
// Centered on the same spotlight pillar as the menu, over the attract match.
export class SetupScreen implements Screen {
  root = new Container();
  onStart: (setup: MatchSetup) => void = () => {};
  onBack: () => void = () => {};
  private mode: PlayMode = 'quick';
  private size = 11;
  private halfLength = HALF_CHOICES[1];
  private difficulty: 0 | 1 | 2 = 1;
  private list: PixelList;
  private crumb: PixelText;
  private title: PixelText;
  private shade = new Graphics();
  private mark = new Graphics();
  private motes = new BeamMotes();
  private grass = new GrassBed();
  private backdrop = new Container();
  private box = new Graphics();
  private plate = new Container();
  private reveal = new Reveal();
  private drop = new Drop();
  private dust = new PixelDust();

  constructor(assets: GameAssets) {
    this.title = new PixelText(assets, 5, 0xffd95e);
    this.crumb = new PixelText(assets, 2, 0x8a91a0);
    this.crumb.text = 'MATCH SETUP';
    this.list = new PixelList(assets, 3, 34, 6, 13, true);
    this.list.onPick = (i) => this.act(i);
    this.plate.addChild(this.box, this.list.root);
    this.list.root.position.set(0, 20);
    this.backdrop.addChild(this.shade, this.mark, this.grass.soil, this.grass.back, this.grass.front, this.motes.g);
    this.root.addChild(this.backdrop, this.title, this.crumb, this.plate, this.dust.g);
  }

  begin(mode: PlayMode) {
    this.mode = mode;
    this.title.text = mode === 'quick' ? 'QUICK MATCH' : mode === 'draft' ? 'DRAFT MODE' : 'GAMBLE MODE';
    this.list.sel = 0;
    this.refresh();
  }

  private refresh(animate = false, stagger = 0) {
    this.list.setRows([
      { label: 'SIDES', value: `${this.size} V ${this.size}`, enabled: true },
      { label: 'HALF LENGTH', value: fmtClock(this.halfLength), enabled: true },
      { label: 'DIFFICULTY', value: DIFF_NAMES[this.difficulty], enabled: true },
      { label: mode0(this.mode), enabled: true, gapBefore: true },
      { label: 'BACK', enabled: true },
    ], true, animate, stagger);
    this.drawBox();
  }

  private drawBox() {
    const bw = Math.max(this.list.blockWidth + 110, 330);
    const bh = this.list.totalHeight + 34;
    const bx = -Math.round(bw / 2);
    const g = this.box;
    g.clear();
    g.rect(bx, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.88 });
    g.rect(bx, 0, bw, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    g.rect(bx, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(bx, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(bx + bw - 1, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    for (const [cx, cy] of [[bx + 3, 5], [bx + bw - 6, 5], [bx + 3, bh - 8], [bx + bw - 6, bh - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: 0xffd95e, alpha: 0.55 });
    }
  }

  private act(i: number) {
    if (i === 0) this.size = SIZE_CHOICES[(SIZE_CHOICES.indexOf(this.size) + 1) % SIZE_CHOICES.length];
    else if (i === 1) this.halfLength = HALF_CHOICES[(HALF_CHOICES.indexOf(this.halfLength) + 1) % HALF_CHOICES.length];
    else if (i === 2) this.difficulty = ((this.difficulty + 1) % 3) as 0 | 1 | 2;
    else if (i === 3) {
      return this.onStart({ mode: this.mode, size: this.size, halfLength: this.halfLength, difficulty: this.difficulty });
    } else {
      return this.onBack();
    }
    this.refresh();
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
    if (code === 'Escape') { audio.ui('back'); this.onBack(); }
  }

  // The same signage language as the front door: words type, the plate
  // drops — over a backdrop that arrives OPAQUE, so nothing ever flashes
  enter() {
    this.reveal.clear();
    this.reveal.add(this.title, 0);
    this.reveal.add(this.crumb, 0.08);
    this.reveal.play();
    this.drop.clear();
    this.drop.add(this.plate, 0.08, { from: 28, dur: 0.34, onImpact: () => {
      audio.ui('card', 0.65);
      const bw = Math.max(this.list.blockWidth + 110, 330);
      this.dust.burst(this.plate.position.x, this.plate.position.y + this.list.totalHeight + 34, bw * 0.55, 12);
    } });
    this.drop.play();
    this.refresh(true, 0.2);
  }

  update(dt: number) {
    this.list.update(dt);
    this.reveal.update(dt);
    this.drop.update(dt);
    this.dust.update(dt);
    this.motes.update(dt);
    this.grass.update(dt);
  }

  layout(w: number, h: number) {
    centerShade(this.shade, w, h);
    const beam = pillarBounds(w);
    pitchMark(this.mark, w, h, beam.x0, beam.x1);
    this.motes.layout(beam.x0, beam.x1, h);
    this.grass.layout(beam.x0, beam.coreW, h);
    this.title.centerAt(w / 2, h * 0.16);
    this.crumb.centerAt(w / 2, h * 0.16 + 52);
    this.plate.position.set(Math.round(w / 2), Math.round(h * 0.36) - 20);
    this.drawBox();
  }
}

const mode0 = (mode: PlayMode) =>
  mode === 'quick' ? 'KICK OFF!' : mode === 'draft' ? 'TO THE DRAFT!' : 'TO THE WHEEL!';

// ------------------------------------------------------------------- pause
// The team talk: the frozen match stays visible on the right while the shade
// column carries the scoreline, your options, and the story of the game so
// far. The board DROPS onto the touchline in a cascade — same signage
// language as the front door — and lifts away again on resume.
export class PauseScreen implements Screen {
  root = new Container();
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onClosed: () => void = () => {}; // fired when the lift-out finishes
  private list: PixelList;
  private shade = new Graphics();
  private tabs = new Graphics();
  private title: PixelText;
  private score: PixelText;
  private clockLine: PixelText;
  private storyCrumb: PixelText;
  private statLines: { label: PixelText; value: PixelText }[] = [];
  private foot: PixelText;
  private drop = new Drop();
  private dust = new PixelDust();
  private shadeIn = 1;
  private closing = false;
  private closeT = 0;

  constructor(assets: GameAssets) {
    this.title = new PixelText(assets, 8, 0xffd95e);
    this.title.text = 'PAUSED';
    this.score = new PixelText(assets, 6, 0xffffff);
    this.clockLine = new PixelText(assets, 3, 0x8f97a8);
    this.storyCrumb = new PixelText(assets, 2, 0x8a91a0);
    this.storyCrumb.text = 'THE STORY SO FAR';
    this.foot = new PixelText(assets, 2, 0x69707f);
    this.foot.text = 'ESC RESUME - W S PICK - ENTER GO';
    this.list = new PixelList(assets, 3, 30, 4);
    this.list.setRows([{ label: 'RESUME', enabled: true }, { label: 'QUIT TO MENU', enabled: true }]);
    this.list.onPick = (i) => (i === 0 ? this.onResume() : this.onQuit());
    for (const label of ['POSSESSION', 'SHOTS', 'ON TARGET', 'PASSES', 'PASS ACC', 'TACKLES', 'SAVES', 'CORNERS']) {
      const l = new PixelText(assets, 2, 0x8f97a8);
      l.text = label;
      const v = new PixelText(assets, 2, 0xd8ab3c);
      this.statLines.push({ label: l, value: v });
      this.root.addChild(l, v);
    }
    this.root.addChild(this.shade, this.tabs, this.title, this.score, this.clockLine, this.storyCrumb, this.list.root, this.foot, this.dust.g);
    this.root.setChildIndex(this.shade, 0);
  }

  // Feed the frozen match in: scoreline, clock, and the running numbers
  begin(match: Match) {
    const s = match.stats;
    this.score.text = `${match.world.score.left} - ${match.world.score.right}`;
    this.clockLine.text = match.halfLength > 0
      ? `${match.half === 1 ? '1ST HALF' : '2ND HALF'} ${fmtClock(match.clock)}`
      : 'KICKABOUT';
    const total = Math.max(1, s.possession[0] + s.possession[1]);
    const pct = Math.round((s.possession[0] / total) * 100);
    const acc = (t: 0 | 1) => (s.passes[t] > 0 ? `${Math.round((s.passesGood[t] / s.passes[t]) * 100)}%` : '-');
    const vals = [
      `${pct}% - ${100 - pct}%`,
      `${s.shots[0]} - ${s.shots[1]}`,
      `${s.onTarget[0]} - ${s.onTarget[1]}`,
      `${s.passes[0]} - ${s.passes[1]}`,
      `${acc(0)} - ${acc(1)}`,
      `${s.tacklesWon[0]} - ${s.tacklesWon[1]}`,
      `${s.saves[0]} - ${s.saves[1]}`,
      `${s.corners[0]} - ${s.corners[1]}`,
    ];
    this.statLines.forEach((line, i) => { line.value.text = vals[i]; });
    this.list.sel = 0;
  }

  // Arm the board; the drop itself plays in enter(), after layout has run
  open() {
    this.closing = false;
    this.closeT = 0;
    this.root.alpha = 1;
    this.root.position.y = 0;
  }
  close() {
    if (!this.closing) this.closing = true;
  }

  // The whole board falls in a cascade, top to bottom — the title slams,
  // the numbers follow, every stat line a beat behind the one above it
  enter() {
    this.shadeIn = 0;
    this.drop.clear();
    this.drop.add(this.title, 0, { from: 34, dur: 0.36, onImpact: () => {
      audio.ui('card');
      this.dust.burst(this.title.position.x + this.title.width / 2, this.title.position.y + this.title.height + 2, this.title.width * 0.8, 12);
    } });
    this.drop.add(this.score, 0.06, { from: 26, dur: 0.32 });
    this.drop.add(this.tabs, 0.06, { from: 26, dur: 0.32 });
    this.drop.add(this.clockLine, 0.09, { from: 24, dur: 0.3 });
    this.drop.add(this.list.root, 0.13, { from: 26, dur: 0.32, onImpact: () => {
      audio.ui('card', 0.55);
      this.dust.burst(this.list.root.position.x + 90, this.list.root.position.y + this.list.totalHeight, 170, 9);
    } });
    this.drop.add(this.storyCrumb, 0.17, { from: 20, dur: 0.28 });
    this.statLines.forEach((line, i) => {
      this.drop.add(line.label, 0.19 + i * 0.014, { from: 18, dur: 0.26 });
      this.drop.add(line.value, 0.19 + i * 0.014, { from: 18, dur: 0.26 });
    });
    this.drop.add(this.foot, 0.3, { from: 14, dur: 0.26 });
    this.drop.play();
  }

  update(dt: number) {
    this.list.update(dt);
    this.drop.update(dt);
    this.dust.update(dt);
    if (this.shadeIn < 1) this.shade.alpha = this.shadeIn = Math.min(1, this.shadeIn + dt / 0.1);
    // resume: the whole board lifts away, quick and light
    if (this.closing) {
      this.closeT = Math.min(1, this.closeT + dt / 0.14);
      const e = this.closeT * this.closeT;
      this.root.alpha = 1 - e;
      this.root.position.y = -14 * e;
      if (this.closeT >= 1) {
        this.closing = false;
        this.onClosed();
      }
    }
  }

  key(code: string) {
    if (this.closing) return; // the board is already on its way out
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
  }

  layout(w: number, h: number) {
    stepShade(this.shade, w, h);
    this.title.position.set(LEFT, h * 0.1);
    const scoreY = h * 0.1 + 90;
    this.score.position.set(LEFT + 30, scoreY);
    // kit tabs flank the scoreline — who's who at a glance
    this.tabs.clear();
    this.tabs.rect(LEFT, scoreY + 14, 20, 20).fill(0xc4432f);
    this.tabs.rect(LEFT, scoreY + 34, 20, 5).fill(0x7e2417);
    const bx = LEFT + 30 + this.score.textWidth + 12;
    this.tabs.rect(bx, scoreY + 14, 20, 20).fill(0x3458a8);
    this.tabs.rect(bx, scoreY + 34, 20, 5).fill(0x1c3260);
    this.clockLine.position.set(LEFT, scoreY + 66); // clear of the score's full glyph height
    this.list.root.position.set(LEFT - 16, h * 0.42);
    const storyY = h * 0.42 + 110;
    this.storyCrumb.position.set(LEFT, storyY);
    this.statLines.forEach((line, i) => {
      line.label.position.set(LEFT, storyY + 26 + i * 18);
      line.value.position.set(LEFT + 13 * 12, storyY + 26 + i * 18);
    });
    this.foot.position.set(LEFT, h - 44);
  }
}

// --------------------------------------------------------------- full time
// The broadcast stat sheet: home number, quiet label, away number down the
// center of the screen — the FotMob read of the match just played.
export class StatsScreen implements Screen {
  root = new Container();
  onDone: () => void = () => {};
  private dim = new Graphics();
  private tabs = new Graphics();
  private lines: PixelText[] = [];
  private table: { home: PixelText; label: PixelText; away: PixelText }[] = [];
  private score: PixelText | null = null;

  constructor(private assets: GameAssets) {
    this.root.addChild(this.dim, this.tabs);
  }

  begin(match: Match) {
    for (const t of this.lines) t.destroy();
    for (const r of this.table) { r.home.destroy(); r.label.destroy(); r.away.destroy(); }
    this.lines = [];
    this.table = [];
    const s = match.stats;
    const world = match.world;
    const total = Math.max(1, s.possession[0] + s.possession[1]);
    const pct = Math.round((s.possession[0] / total) * 100);
    const acc = (t: 0 | 1) => (s.passes[t] > 0 ? `${Math.round((s.passesGood[t] / s.passes[t]) * 100)}%` : '-');
    const scorers = Object.entries(s.goals)
      .map(([idx, n]) => `${match.names[+idx]}${n > 1 ? ` ${n}` : ''}`)
      .join('  ') || 'NOBODY';
    let potm = 0;
    let potmScore = -1;
    world.players.forEach((_, i) => {
      const sc = (s.goals[i] ?? 0) * 100 + (world.players[i].id.role === 'GK' ? s.saves[world.players[i].id.team] * 25 : 0);
      if (sc > potmScore) { potmScore = sc; potm = i; }
    });

    const add = (text: string, scale: number, tint: number) => {
      const t = new PixelText(this.assets, scale, tint);
      t.text = text;
      this.lines.push(t);
      this.root.addChild(t);
      return t;
    };
    add('FULL TIME', 6, 0xffd95e);
    this.score = add(`${world.score.left} - ${world.score.right}`, 8, 0xffffff);
    const row = (label: string, home: string, away: string) => {
      const l = new PixelText(this.assets, 2, 0x8f97a8);
      l.text = label;
      const hv = new PixelText(this.assets, 3, 0xffd95e);
      hv.text = home;
      const av = new PixelText(this.assets, 3, 0xffd95e);
      av.text = away;
      this.table.push({ home: hv, label: l, away: av });
      this.root.addChild(l, hv, av);
    };
    row('POSSESSION', `${pct}%`, `${100 - pct}%`);
    row('SHOTS', `${s.shots[0]}`, `${s.shots[1]}`);
    row('ON TARGET', `${s.onTarget[0]}`, `${s.onTarget[1]}`);
    row('PASSES', `${s.passes[0]}`, `${s.passes[1]}`);
    row('PASS ACCURACY', acc(0), acc(1));
    row('TACKLES WON', `${s.tacklesWon[0]}`, `${s.tacklesWon[1]}`);
    row('SAVES', `${s.saves[0]}`, `${s.saves[1]}`);
    row('CORNERS', `${s.corners[0]}`, `${s.corners[1]}`);
    row('THROW INS', `${s.throwins[0]}`, `${s.throwins[1]}`);
    add(`GOALS ${scorers}`, 2, 0x9ff0b8);
    add(`STAR OF THE MATCH ${match.names[potm]}`, 3, 0xffd95e);
    add('ENTER FOR MENU', 2, 0x8a91a0);
  }

  key(code: string) {
    if (code === 'Enter' || code === 'Space') this.onDone();
  }

  layout(w: number, h: number) {
    this.dim.clear();
    this.dim.rect(0, 0, w, h).fill({ color: 0x05070b, alpha: 0.8 });
    if (!this.lines.length) return;
    this.lines[0].centerAt(w / 2, h * 0.08);   // FULL TIME
    this.lines[1].centerAt(w / 2, h * 0.15);   // the score
    // kit tabs flanking the score
    if (this.score) {
      const sy = h * 0.15 + 14;
      const half = this.score.textWidth / 2;
      this.tabs.clear();
      this.tabs.rect(w / 2 - half - 40, sy, 22, 22).fill(0xc4432f);
      this.tabs.rect(w / 2 - half - 40, sy + 22, 22, 5).fill(0x7e2417);
      this.tabs.rect(w / 2 + half + 18, sy, 22, 22).fill(0x3458a8);
      this.tabs.rect(w / 2 + half + 18, sy + 22, 22, 5).fill(0x1c3260);
    }
    const tableY = h * 0.3;
    this.table.forEach((r, i) => {
      const y = tableY + i * Math.max(26, h * 0.045);
      r.label.centerAt(w / 2, y + 4);
      r.home.position.set(Math.round(w / 2 - 190 - r.home.textWidth), y);
      r.away.position.set(Math.round(w / 2 + 190), y);
    });
    this.lines[2]?.centerAt(w / 2, h * 0.79);  // scorers
    this.lines[3]?.centerAt(w / 2, h * 0.85);  // star of the match
    this.lines[4]?.centerAt(w / 2, h * 0.93);  // enter hint
  }
}
