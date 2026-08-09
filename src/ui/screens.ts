import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';
import { frontOfHouse } from '../audio/ambience';
import { MOODS } from '../render/variants';
import { BeamMotes, Drop, GOLD, GrassBed, ListRow, MINT, PixelDust, PixelList, Reveal, centerRow, centerShade, cornerMarks, externalLink, pillarBounds, pitchMark } from './kit';
import { Match } from '../match';
import { CompareCard } from './compare';
import { RollingNumber } from './rollup';
import { rateSquad } from '../data/ratings';
import { QUALITY_NAMES, Quality, quickSquads, setQuickQuality } from '../data/quickmatch';
import { BUDGET_TIERS, BudgetTier, quotaFor, setTableBudget, tierBudget } from '../data/draft';
import { pads } from '../input/gamepad';
import { Keyboard } from '../input/keyboard';
import { Seat, SeatDevice, SECOND_JOIN, deviceId, deviceLabel, roster } from '../input/seats';

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

// The menu column's air, top to bottom, and the two blocks it can't measure
// from a text object — one place to tune the whole front door's rhythm
const MENU_GAPS = { sub: 14, ver: 12, crumb: 26, plate: 16, plaque: 18, socials: 30, socialHead: 10 };
type MenuPage = 'root' | 'play' | 'settings';
const MENU_PAGES: MenuPage[] = ['root', 'play', 'settings'];
const MENU_MARGIN = 20;
const MENU_HANG = 0.1; // where the wordmark's top hangs — the shell's house rhythm
const MENU_ROW_H = 34;
const PLAQUE_H = 34;
const HALF_CHOICES = [60, 120, 180, 300];
const SIZE_CHOICES = [5, 7, 11];
const DIFF_NAMES = ['EASY', 'MEDIUM', 'HARD'];
const FPS_CHOICES: (number | null)[] = [null, 120, 60, 30];
// A dial the player set once, remembered. A missing or junk entry falls back
// to 3 — quiet enough that nobody's first boot makes them lunge for the keys.
const storedVol = (key: string, fallback: number) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = Math.round(Number(raw));
    return Number.isFinite(v) && v >= 0 && v <= 10 ? v : fallback;
  } catch { return fallback; }
};
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
  onLocal: () => void = () => {};
  onMood: (moodIdx: number) => void = () => {};
  onFps: (cap: number | null) => void = () => {};
  onAudio: (music: number, sfx: number) => void = () => {};
  moodIdx = 0;
  autoSwitch = false;
  fpsIdx = 0; // into FPS_CHOICES
  musicVol = storedVol('t22.musicVol', 3);
  sfxVol = storedVol('t22.sfxVol', 3);
  private page: MenuPage = 'root';
  private list: PixelList;
  private title: Sprite;
  private sub: PixelText;
  private ver: PixelText;
  private crumb: PixelText;
  private crumbY = 0;          // its own rest, so a waking pad can rewrite it in place
  private padAwake = false;
  private padPulse = 0; // how long a connected-but-sleeping pad has gone unheard
  private socials = new Container();
  private socialBox = new Graphics();
  private socialHeader: PixelText;
  private socialRows: Container[];
  onTutorial: () => void = () => {};
  private tutorBtn = new Container();
  private tutorGlow = new Graphics();
  private tutorLabel: PixelText;
  private tutorFresh = true; // never finished the tutorial: the plaque breathes
  private tutorT = 0;
  private plaqueFocus = false; // the keyboard walk has stepped off the box
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
      let v: Container;
      if (url) v = externalLink(assets, value, url);
      else {
        const plain = new PixelText(assets, 2, 0xdfe4ee);
        plain.text = value;
        v = plain;
      }
      v.position.set(l.width + 8, 0);
      row.addChild(l, v);
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
    // The tutorial beacon: a mint plaque under the menu. It BREATHES until
    // the tutorial has been finished once, then stands quiet forever —
    // impossible to miss on day one, invisible-polite on day fifty.
    this.tutorLabel = new PixelText(assets, 2, 0x9ff0b8);
    this.tutorBtn.eventMode = 'static';
    this.tutorBtn.cursor = 'pointer';
    this.tutorBtn.on('pointerover', () => this.setPlaqueFocus(true));
    this.tutorBtn.on('pointerout', () => this.setPlaqueFocus(false));
    this.tutorBtn.on('pointertap', () => { audio.ui('select'); this.onTutorial(); });
    this.crumb = new PixelText(assets, 2, 0x8a91a0);
    this.list = new PixelList(assets, 3, 34, 7, 13, true);
    this.buildTutorPlaque(); // ...after the list: the plaque measures to its column
    this.list.onPick = (i) => this.act(i);
    this.list.onSelect = () => this.setPlaqueFocus(false); // the box takes the eye back
    this.list.onAdjust = (i, v) => this.setVolume(i, v);
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
    this.root.addChild(this.backdrop, this.title, this.shine, this.shineMask, this.sub, this.ver, this.crumb, this.plate, this.tutorBtn, this.socials, this.dust.g);
    this.setPage('root', false);
  }

  // Land on a given page when the screen is (re)shown — back arrows return
  // to where you actually came from, quitting a match returns to the front
  openPage(page: MenuPage) {
    this.setPage(page, false);
  }

  private setPage(page: MenuPage, animate = true) {
    this.page = page;
    this.padAwake = pads.connected;
    this.socials.visible = page === 'root'; // the addresses live on the front door
    this.tutorBtn.visible = page === 'root'; // and so does the coach's plaque
    this.list.sel = 0; // a fresh page starts at its top
    this.crumb.text = this.crumbText();
    this.refresh(animate, 0.08);
    // the last hop settles FIRST: a finished drop stamps the rest it was born
    // with, so letting it land after the re-measure would paste a stale y — and
    // the next hop would then adopt that as home
    this.pageDrop.finish();
    this.pageDrop.clear();
    this.placeColumn(); // a new word and a new plate: the column re-measures
    // the plate HOPS to the new page — unless the big entrance still owns it
    if (animate && !this.drop.active) {
      this.reveal.clear();
      this.reveal.add(this.crumb, 0);
      this.reveal.play();
      this.pageDrop.add(this.plate, 0, { from: 14, dur: 0.24, onImpact: () => audio.ui('card', 0.4) });
      this.pageDrop.play();
    }
  }

  // Every page's rows in ONE place — layout measures them all, so the column
  // can be centered on the tallest page and nothing above the plate ever hops
  private rowsFor(page: MenuPage): Omit<ListRow, 'enabled'>[] {
    if (page === 'root') return [{ label: 'PLAY' }, { label: 'PLAY ONLINE' }, { label: 'LOCAL MULTIPLAYER' }, { label: 'SETTINGS' }];
    if (page === 'play') {
      return [{ label: 'QUICK MATCH' }, { label: 'DRAFT MODE' }, { label: 'GAMBLE MODE' }, { label: 'TRAINING GROUND' }, { label: 'BACK', gapBefore: true }];
    }
    const cap = FPS_CHOICES[this.fpsIdx];
    return [
      { label: 'PITCH', value: MOODS[this.moodIdx].name.toUpperCase() },
      { label: 'AUTO SWITCH', value: this.autoSwitch ? 'ON' : 'OFF' },
      { label: 'FPS CAP', value: cap === null ? 'UNLIMITED' : String(cap) },
      { label: 'MUSIC VOL', value: String(this.musicVol), slider: { value: this.musicVol, max: 10 } },
      { label: 'SFX VOL', value: String(this.sfxVol), slider: { value: this.sfxVol, max: 10 } },
      { label: 'BACK', gapBefore: true },
    ];
  }

  private plateHeightOf(page: MenuPage): number {
    const rows = this.rowsFor(page);
    return Math.min(rows.length, 7) * MENU_ROW_H + rows.filter((r) => r.gapBefore).length * 14 + 34;
  }

  private refresh(animate = false, stagger = 0) {
    this.list.setRows(this.rowsFor(this.page).map((r) => ({ ...r, enabled: true })), true, animate, stagger);
    this.drawBox();
  }

  // The title stack is ONE column: menu box, the coach's plaque and the
  // addresses all measure to the same width, so the front door has a single
  // clean left edge and a single right one. Three formulas stacked on a
  // centerline is three plates pretending to be a set.
  private columnWidth(): number {
    const addresses = Math.max(0, ...this.socialRows.map((r) => r.width)) + 70;
    const stack = this.page === 'root' ? Math.max(this.tutorLabel.textWidth + 56, addresses) : 0;
    return Math.max(this.list.blockWidth + 110, stack, 330);
  }

  // The options live in a proper menu box — a framed panel, drawn in the
  // plate's own space so the whole piece of signage can move as one
  private drawBox() {
    const bw = this.columnWidth();
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

  // The breadcrumb, plus the one thing a silent pad needs told: the browser
  // hides a controller until a BUTTON wakes it, so a pad that looks dead is
  // usually just asleep. The line disappears the moment one answers.
  private crumbText() {
    const here = this.page === 'root' ? 'MAIN MENU' : this.page === 'play' ? 'PLAY' : 'SETTINGS';
    // A pad that IS awake says so out loud, live. A silent line under a pad
    // you are holding means the browser never woke it — and that is a very
    // different problem from one the game is simply routing wrong.
    // The stick is the one thing that CANNOT wake a pad — the browser hides it
    // until a button is pressed — so the prompt names the button instead of
    // saying "any input" and leaving a man pushing a dead stick.
    return pads.connected ? `${here}  -  ${pads.report()}` : `${here}  -  HOLDING A CONTROLLER? PRESS (A) - A STICK ALONE CANNOT WAKE IT`;
  }

  // The plaque redraws for its two lives: loud rookie beacon, quiet veteran row
  private buildTutorPlaque() {
    let seen = false;
    try { seen = localStorage.getItem('t22.tutorialDone') === '1'; } catch { /* fine */ }
    this.tutorFresh = !seen;
    this.tutorLabel.text = seen ? 'TUTORIAL' : 'NEW HERE?  START WITH THE TUTORIAL';
    this.tutorBtn.removeChildren();
    const bw = this.columnWidth();
    const bh = PLAQUE_H;
    const g = new Graphics();
    g.rect(-bw / 2, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.88 });
    g.rect(-bw / 2, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(-bw / 2, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(bw / 2 - 1, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    cornerMarks(g, -bw / 2, 0, bw, bh, MINT);
    this.tutorGlow.clear();
    this.tutorGlow.rect(-bw / 2 + 1, 1, bw - 2, bh - 2).fill({ color: 0x9ff0b8, alpha: 0.16 });
    this.tutorGlow.alpha = this.tutorFresh ? 0.4 : 0;
    this.tutorLabel.centerAt(0, 10);
    this.tutorBtn.addChild(g, this.tutorGlow, this.tutorLabel);
  }

  private socialsHeight() {
    return 20 + this.socialRows.length * 24 + 8;
  }

  // The socials plate wears the menu box's exact clothes, sized to its rows
  private drawSocialsBox() {
    const bw = this.columnWidth();
    const bh = this.socialsHeight();
    const bx = -Math.round(bw / 2);
    const g = this.socialBox;
    // the menu box's cloth without its crown — and a border that exists only
    // at the corners: mint L-brackets, the card slots' own language
    g.clear();
    g.rect(bx, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.88 });
    g.rect(bx, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(bx, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(bx + bw - 1, 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    cornerMarks(g, bx, 0, bw, bh, MINT);
  }

  // The plate's footprint in screen space — where its landing dust belongs
  private plateBottom() {
    return { x: this.plate.position.x, y: this.plate.position.y + this.list.totalHeight + 34, w: this.columnWidth() };
  }

  private act(i: number) {
    if (this.page === 'root') {
      if (i === 0) this.setPage('play');
      else if (i === 1) this.onOnline();
      else if (i === 2) this.onLocal();
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
      else return this.setPage('root'); // the volume rows are sliders — they never activate
      this.refresh();
    }
  }

  // A dial you can hear yourself turning: the buses move first, then the tick
  // plays THROUGH them, so the sound you get is the level you just chose
  private setVolume(row: number, v: number) {
    if (row === 3) this.musicVol = v;
    else if (row === 4) this.sfxVol = v;
    else return;
    try { localStorage.setItem(row === 3 ? 't22.musicVol' : 't22.sfxVol', String(v)); } catch { /* headless is fine */ }
    this.onAudio(this.musicVol, this.sfxVol);
    audio.ui('tick');
  }

  // Left/right is the value rows' own axis — every row that wears brackets or
  // a track answers it, so the arrows never promise something they can't do
  private step(dir: 1 | -1) {
    if (this.page !== 'settings') return;
    const i = this.list.sel;
    if (i === 0) { this.moodIdx = (this.moodIdx + MOODS.length + dir) % MOODS.length; this.onMood(this.moodIdx); }
    else if (i === 1) this.autoSwitch = !this.autoSwitch;
    else if (i === 2) { this.fpsIdx = (this.fpsIdx + FPS_CHOICES.length + dir) % FPS_CHOICES.length; this.onFps(FPS_CHOICES[this.fpsIdx]); }
    else return this.list.adjust(dir); // the volume rows keep their own value
    audio.ui('move', 0.7);
    this.refresh();
  }

  // The plaque lit and the box quiet, or the other way round — one place owns
  // the eye, and the mouse and the keyboard agree on which
  private setPlaqueFocus(on: boolean) {
    const lit = on && this.tutorBtn.visible;
    if (this.plaqueFocus === lit) return;
    this.plaqueFocus = lit;
    this.tutorLabel.tint = lit ? 0xd8ffe8 : 0x9ff0b8;
    this.tutorGlow.alpha = lit ? 1 : this.tutorFresh ? 0.4 : 0;
    this.list.setActive(!lit);
    if (lit) audio.ui('move', 0.35);
  }

  // One walk down the front door: the option rows first, then the coach's
  // plaque. A button only a mouse can press is a button a couch never finds.
  private walk(dir: 1 | -1) {
    if (this.plaqueFocus) {
      this.setPlaqueFocus(false);
      if (dir > 0) this.list.move(1); // off the bottom and round to the top
      else audio.ui('move');          // back up into the box, where it left off
      return;
    }
    const last = this.rowsFor(this.page).length - 1;
    if (dir > 0 && this.tutorBtn.visible && this.list.sel === last) return this.setPlaqueFocus(true);
    this.list.move(dir);
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.walk(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.walk(1);
    if (code === 'ArrowLeft' || code === 'KeyA') this.step(-1);
    if (code === 'ArrowRight' || code === 'KeyD') this.step(1);
    if (code === 'Enter' || code === 'Space') {
      if (this.plaqueFocus) { audio.ui('select'); this.onTutorial(); } else this.list.activate();
    }
    if (code === 'Escape' && this.page !== 'root') { audio.ui('back'); this.setPage('root'); }
  }

  // Shown fresh: the stage lights come up and the signage falls — title
  // first, plate second, each landing in its own dust with its own thud,
  // the words typing themselves out between the slams
  // The backdrop arrives OPAQUE — a fade-in here reads as a bright flash
  // when the previous screen was already dark (online → back)
  enter() {
    this.buildTutorPlaque(); // a finished tutorial quiets the beacon
    this.setPlaqueFocus(false);
    frontOfHouse.open();     // the ground is already there, humming
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
    // the pad's line is LIVE: waking up, walking off, or just a thumb moving —
    // whatever the pad is doing shows up here the frame it happens
    const padLine = this.crumbText();
    if (pads.connected !== this.padAwake || padLine !== this.crumb.text) {
      this.padAwake = pads.connected;
      this.crumb.text = padLine;
      this.crumb.centerAt(this.w / 2, this.crumbY);
    }
    // A sleeping pad is the one thing worth shouting about: gold and breathing
    // until it wakes, then back to quiet grey furniture the moment it does
    this.padPulse = pads.connected ? 0 : this.padPulse + dt;
    this.crumb.tint = pads.connected ? 0xffffff : GOLD;
    this.crumb.alpha = pads.connected ? 1 : 0.72 + 0.28 * Math.sin(this.padPulse * 3.2);
    // the rookie beacon breathes; a finished tutorial stands still, and a
    // plaque under the walk holds steady so the selection reads as selection
    if (this.tutorFresh && this.tutorBtn.visible && !this.plaqueFocus) {
      this.tutorT += dt;
      this.tutorGlow.alpha = 0.3 + 0.25 * Math.sin(this.tutorT * 2.4);
    }
    frontOfHouse.update(dt);
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

  // One page's ink and one page's AIR, measured apart — a short window can
  // then squeeze the air before it ever shrinks the words. The footer only
  // counts on the front door, where it actually stands.
  private columnParts(scale: number, page: MenuPage): { ink: number; air: number } {
    const g = MENU_GAPS;
    let ink = this.assets.manifest.title.h * scale + this.sub.textHeight
      + this.ver.textHeight + this.crumb.textHeight + this.plateHeightOf(page);
    let air = g.sub + g.ver + g.crumb + g.plate;
    if (page === 'root') {
      ink += PLAQUE_H + this.socialHeader.textHeight + this.socialsHeight();
      air += g.plaque + g.socials + g.socialHead;
    }
    return { ink, air };
  }

  // The page that needs the most room — the one the whole column is sized and
  // centered on, so nothing above the plate moves when a page swaps beneath it
  private tallestColumn(scale: number) {
    return MENU_PAGES.map((p) => this.columnParts(scale, p))
      .reduce((a, b) => (a.ink + a.air >= b.ink + b.air ? a : b));
  }

  // The front door as ONE measured column: wordmark, studio line, ledger,
  // crumb, plate, plaque, footer — stacked on real heights, sized down until
  // the whole group fits. The wordmark HANGS from the top of the frame at the
  // shell's usual tenth; only a short window lifts it toward the margin. It
  // never centers on the block, because the footer is a footer — counting it
  // as ballast drags the title into the middle of a tall screen.
  private placeColumn() {
    const { w, h } = this;
    const room = h - MENU_MARGIN * 2;
    let scale = Math.max(4, Math.min(12, Math.floor((w * 0.34) / this.assets.manifest.title.w)));
    let parts = this.tallestColumn(scale);
    while (scale > 4 && parts.ink + parts.air > room) parts = this.tallestColumn(--scale);
    // out of wordmark to give back: the gaps close instead, down to a third
    const squeeze = Math.max(0.33, Math.min(1, (room - parts.ink) / parts.air));
    const g = Object.fromEntries(
      Object.entries(MENU_GAPS).map(([k, v]) => [k, Math.round(v * squeeze)]),
    ) as typeof MENU_GAPS;
    // measured on the TALLEST page, so the hang is identical on all three
    const stack = parts.ink + Math.round(parts.air * squeeze);
    const top = Math.max(MENU_MARGIN, Math.min(Math.round(h * MENU_HANG), h - MENU_MARGIN - stack));
    this.title.scale.set(scale);
    this.title.position.set(Math.round(w / 2 - this.title.width / 2), top);
    this.shineMask.scale.set(scale);
    this.shineMask.position.copyFrom(this.title.position);
    // the band itself: a leaning stripe taller than the wordmark, redrawn per size
    this.shine.clear();
    const sh = this.title.height + 12;
    this.shine.poly([{ x: 0, y: sh }, { x: 22, y: 0 }, { x: 52, y: 0 }, { x: 30, y: sh }]).fill({ color: 0xfff8e0, alpha: 0.32 });
    this.shine.position.y = this.title.position.y - 6;
    let y = top + this.title.height + g.sub;
    this.sub.centerAt(w / 2, y);
    y += this.sub.textHeight + g.ver;
    this.ver.centerAt(w / 2, y); // the ledger, breathing under the studio line
    y += this.ver.textHeight + g.crumb;
    this.crumbY = y;
    this.crumb.centerAt(w / 2, y);
    y += this.crumb.textHeight + g.plate;
    this.plate.position.set(Math.round(w / 2), y);
    y += this.plateHeightOf(this.page) + g.plaque;
    // the coach's plaque sits right under the menu, first thing below the box
    this.tutorBtn.position.set(Math.round(w / 2), y);
    y += PLAQUE_H + g.socials + this.socialHeader.textHeight + g.socialHead;
    // the socials plate: the menu box's little sibling — SOCIALS perched on
    // the frame exactly like MAIN MENU, the addresses a footer underneath
    this.socials.position.set(Math.round(w / 2), y);
    this.socialHeader.centerAt(0, -(this.socialHeader.textHeight + g.socialHead));
    this.socialRows.forEach((row, i) => centerRow(row, 0, 20 + i * 24));
    this.drawSocialsBox();
    this.drawBox();
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
    // a new window is a hard cut: anything still in the air lands before the
    // column re-measures, or it would keep writing the old size's rest
    this.drop.finish();
    this.pageDrop.finish();
    this.placeColumn();
  }
}

const SHINE_CYCLE = 7; // seconds between wordmark glints

// --------------------------------------------------------------- the couch
// LOCAL MULTIPLAYER, built like the party room online — the same boards, the
// same chairs, the same nod before the whistle, except the friends are in the
// room instead of on the wire. A pad sits down with A, nods with A again and
// stands with B; the keyboard's two pairs of hands do it on their own keys.
// Everybody chooses at once, so nobody queues behind one cursor.
const SIDE_TINT = [0xff9c8a, 0x9cc4f0]; // the compare card's two sides
const SIDE_NAME = ['HOME', 'AWAY'];
const COUCH_PANE = 1360;  // the wide room, same as the online party
const CHAIRS = 11;
const CONSOLE_H = 264;    // the room the whistle console keeps at the foot
// One dialect per line at the foot, exactly where the online party prints its
// hints — the device in gold, its buttons quiet beside it
const COUCH_HANDSHAKE: [string, string][] = [
  ['PAD', 'A SITS DOWN - A AGAIN READIES - B BACKS OUT - START KICKS OFF'],
  ['KEYBOARD', 'BACKSPACE SITS DOWN - A D PICK A SIDE - ENTER READIES'],
  ['SEAT TWO', '. AND / SIT DOWN - ARROWS PICK A SIDE - M READIES'],
];

export class LocalJoinScreen implements Screen {
  root = new Container();
  onStart: () => void = () => {};
  onBack: () => void = () => {};
  openedBy: SeatDevice = { kind: 'keys', hands: 0 }; // the hands that picked this room
  private head = new Container();
  private boards = [new Container(), new Container()];
  private tunnel = new Container();
  private foot = new Container();
  private shade = new Graphics();
  private mark = new Graphics();
  private motes = new BeamMotes();
  private grass = new GrassBed();
  private backdrop = new Container();
  private reveal = new Reveal();
  private drop = new Drop();
  private dust = new PixelDust();
  private nods = new Set<string>();          // devices that have nodded
  private lit = new Map<string, number>();   // how hard a device is being leaned on
  private heard = new Map<string, number>(); // buttons down last frame, per device
  private glows = new Map<string, Graphics>();
  private downKeys = new Set<string>();
  private comboHeld = false;
  private nodHeld = false;
  private settle = false; // the button that OPENED this room never also answers it
  private stamp = '';
  private w = 1280;
  private h = 720;

  constructor(private assets: GameAssets, private kb: Keyboard) {
    this.backdrop.addChild(this.shade, this.mark, this.grass.soil, this.grass.back, this.grass.front, this.motes.g);
    this.root.addChild(this.backdrop, this.head, this.boards[0], this.boards[1], this.tunnel, this.foot, this.dust.g);
  }

  // The devices on the table right now, in couch order — the two pairs of
  // keyboard hands, then every pad by its slot
  private bench(): SeatDevice[] {
    const list: SeatDevice[] = [{ kind: 'keys', hands: 0 }, { kind: 'keys', hands: 1 }];
    for (const pad of pads.devices) list.push({ kind: 'pad', index: pad.index });
    return list;
  }

  // Everything the room could paint differently — one string, so a table full
  // of pads never rebuilds a single plate per frame
  private roomStamp(): string {
    const seats = this.bench().map((d) => {
      const id = deviceId(d);
      const seat = roster.seat(id);
      return `${id}:${seat ? seat.team : '-'}${this.nods.has(id) ? '!' : ''}`;
    });
    return `${this.w}x${this.h}|${seats.join(',')}`;
  }

  // ------------------------------------------------------------ sitting down
  private sit(device: SeatDevice) {
    // the empty side first, so two people never both land on HOME by accident
    const team = roster.forTeam(0).length <= roster.forTeam(1).length ? 0 : 1;
    const seat = roster.join(device, team);
    audio.ui('select');
    seat.rumble(0.55, 130);
    this.lit.set(seat.id, 1);
  }

  private stand(id: string) {
    if (!roster.seat(id)) return;
    roster.leave(id);
    this.nods.delete(id);
    audio.ui('back');
  }

  private toggleSeat(device: SeatDevice) {
    if (roster.has(device)) this.stand(deviceId(device));
    else this.sit(device);
  }

  private side(seat: Seat, team: 0 | 1) {
    if (seat.team === team) return;
    seat.team = team;
    seat.rumble(0.25, 60);
    audio.ui('move', 0.8);
  }

  // The nod: one seat saying it is ready. The whistle waits for all of them.
  private nod(id: string, on: boolean) {
    if (!roster.seat(id) || this.nods.has(id) === on) return;
    if (on) this.nods.add(id);
    else this.nods.delete(id);
    audio.ui(on ? 'select' : 'back', 0.8);
    roster.seat(id)?.rumble(on ? 0.4 : 0.2, 80);
  }

  // Who the room is still waiting on, in plain words
  private blocker(): string | null {
    if (!roster.active) return 'NOBODY IS SITTING DOWN YET';
    if (!roster.ready) return 'EACH SIDE NEEDS A PLAYER';
    const waiting = roster.seats.filter((s) => !this.nods.has(s.id));
    if (!waiting.length) return null;
    return waiting.length === 1
      ? `WAITING ON ${waiting[0].label}`
      : `WAITING ON ${waiting.length} PLAYERS TO READY UP`;
  }

  private go() {
    if (this.blocker()) return audio.ui('denied');
    audio.ui('select');
    this.onStart();
  }

  private back() {
    audio.ui('back');
    roster.clear();
    this.onBack();
  }

  // ------------------------------------------------------------ reading hands
  // Raw key state, edge by edge: the couch's keys (backspace, . and /) never
  // travel through the shell's UI routing
  private edge(code: string): boolean {
    const down = this.kb.has(code);
    const was = this.downKeys.has(code);
    if (down) this.downKeys.add(code);
    else this.downKeys.delete(code);
    return down && !was;
  }

  private readPads() {
    for (const pad of pads.devices) {
      const device: SeatDevice = { kind: 'pad', index: pad.index };
      const id = deviceId(device);
      const seat = roster.seat(id);
      if (!seat) {
        if (pad.down > (this.heard.get(id) ?? 0)) audio.ui('move', 0.3); // heard you
        this.lit.set(id, Math.max(this.lit.get(id) ?? 0, Math.min(1, pad.down * 0.7)));
      }
      this.heard.set(id, pad.down);
      if (!seat) {
        if (pad.pressed('a') || pad.pressed('start')) this.sit(device);
        // B backs out one rung at a time, and from an empty chair the last
        // rung is the door — a pad can always leave the room it walked into
        else if (pad.pressed('b')) this.back();
        continue;
      }
      if (pad.pressed('b')) {
        if (this.nods.has(id)) this.nod(id, false);
        else this.stand(id);
        continue;
      }
      if (pad.pressed('a')) {
        if (this.nods.has(id)) this.go();
        else this.nod(id, true);
        continue;
      }
      if (pad.pressed('start')) { this.go(); continue; }
      for (const code of pad.navCodes()) {
        if (code === 'ArrowLeft') this.side(seat, 0);
        else if (code === 'ArrowRight') this.side(seat, 1);
      }
    }
  }

  private readKeys() {
    if (this.edge('Backspace')) this.toggleSeat({ kind: 'keys', hands: 0 });
    const combo = SECOND_JOIN.every((code) => this.kb.has(code));
    if (combo && !this.comboHeld) this.toggleSeat({ kind: 'keys', hands: 1 });
    this.comboHeld = combo;
    // seat two nods on M, beside its own cluster — the join combo stays the
    // join combo, and nothing it presses to sit down can also mean yes
    const nodKey = this.kb.has('KeyM');
    if (nodKey && !this.nodHeld && roster.has({ kind: 'keys', hands: 1 })) this.nod('keys1', !this.nods.has('keys1'));
    this.nodHeld = nodKey;
    if (!roster.has({ kind: 'keys', hands: 1 })) {
      this.lit.set('keys1', SECOND_JOIN.some((code) => this.kb.has(code)) ? 0.6 : 0);
    }
  }

  key(code: string) {
    const first = roster.seat('keys0');
    const second = roster.seat('keys1');
    if (first && (code === 'KeyA' || code === 'KeyD')) this.side(first, code === 'KeyA' ? 0 : 1);
    if (second && (code === 'ArrowLeft' || code === 'ArrowRight')) this.side(second, code === 'ArrowLeft' ? 0 : 1);
    if (code === 'Enter' || code === 'Space') {
      if (first && !this.nods.has('keys0')) this.nod('keys0', true);
      else this.go();
    }
    if (code === 'Escape') this.back();
  }

  // The room opens with the hands that opened it already seated — whoever
  // walked in here is player one, and the rest of the table joins around them.
  // A pad that picked this room sits in the pad's chair: the keyboard is never
  // seated for somebody who never touched it.
  enter() {
    pads.hold();
    roster.clear();
    this.nods.clear();
    this.lit.clear();
    this.heard.clear();
    this.downKeys.clear();
    this.comboHeld = false;
    this.nodHeld = false;
    this.settle = true;
    // a pad that walked off between menus leaves the keyboard holding the room
    const opener = this.openedBy.kind === 'pad' && !pads.device(this.openedBy.index)
      ? { kind: 'keys' as const, hands: 0 as const }
      : this.openedBy;
    roster.join(opener, 0);
    this.stamp = '';
    this.rebuild();
    this.reveal.play();
    this.drop.clear();
    this.drop.add(this.boards[0], 0.06, { from: 26, dur: 0.3 });
    this.drop.add(this.boards[1], 0.12, { from: 26, dur: 0.3 });
    this.drop.add(this.tunnel, 0.18, { from: 20, dur: 0.28 });
    this.drop.add(this.foot, 0.24, { from: 20, dur: 0.28, onImpact: () => audio.ui('card', 0.5) });
    this.drop.play();
  }

  update(dt: number) {
    pads.hold(); // the claim is refreshed while this room is alive, and only here
    if (this.settle) {
      // the A that picked LOCAL MULTIPLAYER is still down on this very frame —
      // let it go before anybody sits down on it
      this.settle = false;
      for (const pad of pads.devices) this.heard.set(deviceId({ kind: 'pad', index: pad.index }), pad.down);
      for (const code of ['Backspace', ...SECOND_JOIN, 'KeyM']) if (this.kb.has(code)) this.downKeys.add(code);
      this.comboHeld = SECOND_JOIN.every((code) => this.kb.has(code));
      this.nodHeld = this.kb.has('KeyM');
    } else {
      // a pad pulled out of the hub leaves its chair AND its nod behind, or
      // the room would wait forever on hands that walked away
      for (const id of roster.prune()) this.nods.delete(id);
      this.readPads();
      this.readKeys();
    }
    const stamp = this.roomStamp();
    if (stamp !== this.stamp) this.rebuild();
    for (const [id, glow] of this.glows) {
      const lit = Math.max(0, (this.lit.get(id) ?? 0) - dt * 3.2);
      this.lit.set(id, lit);
      glow.alpha = lit;
    }
    this.reveal.update(dt);
    this.drop.update(dt);
    this.dust.update(dt);
    this.motes.update(dt);
    this.grass.update(dt);
  }

  layout(w: number, h: number) {
    this.w = w;
    this.h = h;
    centerShade(this.shade, w, h, Math.min(COUCH_PANE, w - 60));
    const beam = pillarBounds(w, Math.min(COUCH_PANE, w - 60));
    pitchMark(this.mark, w, h, beam.x0, beam.x1);
    this.motes.layout(beam.x0, beam.x1, h);
    this.grass.layout(beam.x0, beam.coreW, h);
    // a resize is a hard cut: anything still in the air lands before the room
    // re-measures, or it would keep writing the old size's rest
    this.drop.finish();
    this.rebuild();
  }

  // ---------------------------------------------------------------- painting
  private put(into: Container, text: string, size: number, color: number, x: number, y: number, center = true, micro = false) {
    const t = new PixelText(this.assets, size, color, micro ? 'micro' : 'main');
    t.text = text;
    if (center) t.centerAt(x, y);
    else t.position.set(x, y);
    into.addChild(t);
    return t;
  }

  // A pixel button that answers the hand: cloth plate, corner studs, the
  // label on its TRUE ink height. The shell's button, without a second dialect.
  private button(into: Container, label: string, cx: number, y: number, bw: number, tone: number, tap: (() => void) | null, size = 3): number {
    const bh = size >= 3 ? 36 : 28;
    const live = tap !== null;
    const box = new Container();
    const g = new Graphics();
    const x = Math.round(cx - bw / 2);
    g.rect(x, y, bw, bh).fill({ color: 0x0d1119, alpha: live ? 0.92 : 0.62 });
    g.rect(x, y, bw, 2).fill({ color: tone, alpha: live ? 0.6 : 0.18 });
    g.rect(x, y + bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(x, y + 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(x + bw - 1, y + 2, 1, bh - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    cornerMarks(g, x, y, bw, bh, tone, live ? 0.68 : 0.18);
    const t = new PixelText(this.assets, size, live ? 0xe8ecf4 : 0x4a5160);
    t.text = label;
    t.centerAt(cx, y + Math.round((bh - t.textHeight) / 2));
    box.addChild(g, t);
    if (live) {
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.hitArea = new Rectangle(x, y, bw, bh);
      box.on('pointerover', () => { t.tint = tone; audio.ui('move', 0.35); });
      box.on('pointerout', () => { t.tint = 0xe8ecf4; });
      box.on('pointertap', tap);
    }
    into.addChild(box);
    return bh;
  }

  private rebuild() {
    const { w, h } = this;
    this.stamp = this.roomStamp();
    this.glows.clear();
    for (const box of [this.head, this.boards[0], this.boards[1], this.tunnel, this.foot]) {
      box.removeChildren().forEach((c) => c.destroy({ children: true }));
    }
    this.reveal.clear();

    // the invitation plate — the couch's answer to the online room code
    const headG = new Graphics();
    this.head.addChild(headG);
    this.plate(headG, w / 2 - 190, 20, 380, 92, GOLD);
    const title = this.put(this.head, 'LOCAL MULTIPLAYER', 4, GOLD, w / 2, 38);
    const crumb = this.put(this.head, 'ONE SCREEN - ONE BALL - EVERYBODY IN THE ROOM', 2, 0x8a91a0, w / 2, 76, true, true);
    const sub = this.put(this.head, 'SIT DOWN - PICK A SIDE - NOD WHEN YOU ARE READY', 2, 0x69707f, w / 2, 126, true, true);
    this.reveal.add(title, 0);
    this.reveal.add(crumb, 0.07);
    this.reveal.add(sub, 0.13);

    const bw = Math.round(Math.min(400, w * 0.3));
    const by = 158;
    // the board is exactly as tall as the eleven shirts it holds — the plate
    // never runs on past its last chair
    const crown = 18 + this.assets.manifest.font.cellH * 5 + 14 + 12 + 24 + 28 + 14;
    const consoleY = h - CONSOLE_H;
    const pitch = Math.max(15, Math.min(28, Math.floor((consoleY - 28 - by - crown) / CHAIRS)));
    const bh = crown + pitch * CHAIRS + 14;
    const bx = [Math.round(w * 0.055), Math.round(w - w * 0.055 - bw)];

    ([0, 1] as const).forEach((team) => {
      const box = this.boards[team];
      const g = new Graphics();
      box.addChild(g);
      const x = bx[team];
      const cx = x + bw / 2;
      const tint = SIDE_TINT[team];
      this.plate(g, x, by, bw, bh, tint);
      const name = this.put(box, SIDE_NAME[team], 5, tint, cx, by + 18);
      let y = by + 18 + name.textHeight + 14;
      // kit swatch: shirt and change shirt, a whisper of the wardrobe
      g.rect(cx - 23, y, 20, 12).fill({ color: tint, alpha: 0.95 });
      g.rect(cx + 3, y, 20, 12).fill({ color: 0xf2f5fa, alpha: 0.8 });
      y += 24;

      // the mouse always speaks for the keyboard — one button, like online
      const keysSeat = roster.seat('keys0');
      const mine = keysSeat?.team === team;
      const label = !keysSeat ? 'SIT HERE' : mine ? 'STAND UP' : 'MOVE HERE';
      const btnH = this.button(box, label, cx, y, bw - 44, mine ? 0x8a91a0 : tint, () => {
        if (!keysSeat) { this.sit({ kind: 'keys', hands: 0 }); return; }
        if (mine) this.stand('keys0');
        else this.side(keysSeat, team);
      }, 2);

      // eleven chairs: the room's humans first, then the shirts the AI wears
      const top = y + btnH + 14;
      const seated = roster.forTeam(team);
      for (let i = 0; i < CHAIRS; i++) {
        const cy = top + i * pitch;
        const seat = seated[i];
        const nodded = seat && this.nods.has(seat.id);
        g.rect(x + 16, cy, bw - 32, pitch - 4).fill({ color: seat ? 0x161b26 : 0x10141c, alpha: seat ? 0.95 : 0.5 });
        g.rect(x + 16, cy, 3, pitch - 4).fill({ color: seat ? (nodded ? MINT : tint) : 0x2a3040, alpha: 0.9 });
        const ty = cy + Math.round((pitch - 4 - 10) / 2);
        if (!seat) {
          this.put(box, 'AI', 2, 0x3d4454, x + 30, ty, false, true);
          continue;
        }
        this.put(box, seat.label, 2, nodded ? MINT : 0xdfe4ee, x + 30, ty, false, true);
        const chip = this.put(box, nodded ? 'READY' : '...', 2, nodded ? MINT : 0x565d6d, 0, ty, false, true);
        chip.position.x = x + bw - 30 - chip.textWidth;
        const glow = new Graphics();
        glow.rect(x + 17, cy + 1, bw - 34, pitch - 6).fill({ color: MINT, alpha: 0.2 });
        glow.alpha = 0;
        box.addChild(glow);
        this.glows.set(seat.id, glow);
      }
    });

    // ------------------------------------------------------- the tunnel
    // everything still on the table, waiting to be picked up
    const tg = new Graphics();
    this.tunnel.addChild(tg);
    const mid = Math.round(w / 2);
    const midW = Math.min(360, Math.max(240, bx[1] - (bx[0] + bw) - 80));
    const waiting = this.bench().filter((d) => !roster.has(d));
    this.put(this.tunnel, 'ON THE TABLE', 2, 0x8a91a0, mid, by + 6, true, true);
    if (!waiting.length) {
      this.put(this.tunnel, 'EVERY DEVICE IS SEATED', 2, MINT, mid, by + 34, true, true);
    }
    waiting.forEach((device, i) => {
      const id = deviceId(device);
      const cy = by + 30 + i * 62;
      tg.rect(mid - midW / 2, cy, midW, 54).fill({ color: 0x0d1119, alpha: 0.72 });
      tg.rect(mid - midW / 2, cy + 52, midW, 2).fill({ color: 0x000000, alpha: 0.5 });
      cornerMarks(tg, mid - midW / 2, cy, midW, 54, 0x8a91a0, 0.24);
      const glow = new Graphics();
      glow.rect(mid - midW / 2 + 1, cy + 1, midW - 2, 52).fill({ color: MINT, alpha: 0.18 });
      glow.alpha = 0;
      this.tunnel.addChild(glow);
      this.glows.set(id, glow);
      this.put(this.tunnel, deviceLabel(device), 3, 0xdfe4ee, mid, cy + 10);
      this.put(this.tunnel, device.kind === 'pad' ? 'PRESS A TO SIT DOWN'
        : device.hands === 0 ? 'PRESS BACKSPACE TO SIT DOWN'
        : 'PRESS . AND / TO SIT DOWN', 2, 0x69707f, mid, cy + 34, true, true);
      const hit = new Container();
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.hitArea = new Rectangle(mid - midW / 2, cy, midW, 54);
      hit.on('pointerover', () => { this.lit.set(id, 0.5); });
      hit.on('pointertap', () => this.sit(device));
      this.tunnel.addChild(hit);
    });

    // ------------------------------------------------------- the console
    // the whistle, the mouse's own nod, and the dialects — the party room's
    // rhythm: what you are waiting for, what you press, then the fine print
    const blocker = this.blocker();
    const keys = roster.seat('keys0');
    const nodded = this.nods.has('keys0');
    this.put(this.foot, blocker ?? 'EVERYBODY IS READY - KICK IT OFF', 2, blocker ? 0x8a91a0 : MINT, w / 2, consoleY, true, true);
    this.button(this.foot, 'KICK OFF!', w / 2, consoleY + 22, 320, GOLD, blocker ? null : () => this.go());
    const half = 168;
    this.button(this.foot, nodded ? 'NOT READY' : 'READY UP', w / 2 - half / 2 - 5, consoleY + 68, half,
      nodded ? 0x8a91a0 : MINT, keys ? () => this.nod('keys0', !nodded) : null, 2);
    this.button(this.foot, 'BACK', w / 2 + half / 2 + 5, consoleY + 68, half, 0x8a91a0, () => this.back(), 2);
    // a legend, not three loose sentences: the device names hang off one
    // gutter and their buttons all start on the next
    const rows = COUCH_HANDSHAKE.map(([device, line], i) => ({
      name: this.put(this.foot, device, 2, GOLD, 0, consoleY + 112 + i * 16, false, true),
      body: this.put(this.foot, line, 2, 0x69707f, 0, consoleY + 112 + i * 16, false, true),
    }));
    const gutter = Math.max(...rows.map((r) => r.name.textWidth));
    const block = gutter + 12 + Math.max(...rows.map((r) => r.body.textWidth));
    for (const r of rows) {
      r.name.position.x = Math.round(w / 2 - block / 2 + gutter - r.name.textWidth);
      r.body.position.x = Math.round(w / 2 - block / 2 + gutter + 12);
    }
  }


  // A beveled plate with corner studs — the game's panel grammar
  private plate(g: Graphics, x: number, y: number, pw: number, ph: number, tone: number) {
    g.rect(x, y, pw, ph).fill({ color: 0x0d1119, alpha: 0.9 });
    g.rect(x, y, pw, 2).fill({ color: tone, alpha: 0.55 });
    g.rect(x, y + ph - 2, pw, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(x, y + 2, 1, ph - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(x + pw - 1, y + 2, 1, ph - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    cornerMarks(g, x, y, pw, ph, tone, 0.55);
  }
}

// ------------------------------------------------------------- match setup
// Every play mode passes through here: sides, half length, difficulty, the
// mode's own dials, go. Centered on the same spotlight pillar as the menu,
// over the attract match — and quick match never kicks off until you have
// seen the two squads measured against each other.
const cycle = <T>(list: T[], cur: T, dir: 1 | -1): T =>
  list[(list.indexOf(cur) + list.length + dir) % list.length];
const BUDGET_CHOICES: (BudgetTier | 'custom')[] = [...BUDGET_TIERS, 'custom'];
const CUSTOM_STEP = 10;   // millions per nudge — the wheel counts in tens
const FLASH_TIME = 2.1;   // how long the head-to-head holds before the whistle

// One dial's row on the plate: what it reads, and what left/right does to it
interface OptionRow {
  label: string;
  value?: string;
  gapBefore?: boolean;
  step?: (dir: 1 | -1) => void;
  go?: boolean;
}

export class SetupScreen implements Screen {
  root = new Container();
  onStart: (setup: MatchSetup) => void = () => {};
  onBack: () => void = () => {};
  private mode: PlayMode = 'quick';
  private size = 11;
  private halfLength = HALF_CHOICES[1];
  private difficulty: 0 | 1 | 2 = 1;
  private quality: [Quality, Quality] = [1, 1];
  private budgetTier: BudgetTier | 'custom' = 'average';
  private budget = tierBudget('average', 11);
  private rows: OptionRow[] = [];
  private list: PixelList;
  private crumb: PixelText;
  private descLines: PixelText[];
  private backBtn = new Container();
  private title: PixelText;
  private shade = new Graphics();
  private mark = new Graphics();
  private motes = new BeamMotes();
  private grass = new GrassBed();
  private backdrop = new Container();
  private box = new Graphics();
  private plate = new Container();
  private money = new Container();     // draft only: the table's rolling ledger
  private moneyPlate = new Graphics();
  private moneyCrumb: PixelText;
  private moneyNum: RollingNumber;
  private moneyNote: PixelText;        // the reset, when the table is off default
  private moneyH = 0;
  private flashDim = new Graphics();   // the pre-kickoff card's own dark
  private compare: CompareCard;
  private flashT = 0;
  private pending: MatchSetup | null = null;
  private reveal = new Reveal();
  private drop = new Drop();
  private flashDrop = new Drop();
  private dust = new PixelDust();
  private w = 1280;
  private h = 720;

  constructor(assets: GameAssets) {
    this.title = new PixelText(assets, 5, 0xffd95e);
    this.crumb = new PixelText(assets, 2, 0x8a91a0);
    this.crumb.text = 'MATCH SETUP';
    // the blurb is the header's SERVANT: micro, dimmer, broken into short
    // lines that sit a clear step below the words they explain
    this.descLines = [0, 1, 2].map(() => new PixelText(assets, 2, 0x69707f, 'micro'));
    this.list = new PixelList(assets, 3, 34, 7, 13, true);
    this.list.onPick = (i) => this.act(i);
    this.plate.addChild(this.box, this.list.root);
    this.list.root.position.set(0, 20);
    this.moneyCrumb = new PixelText(assets, 2, 0x8a91a0, 'micro');
    this.moneyCrumb.text = 'MONEY ON THE TABLE';
    this.moneyNum = new RollingNumber(assets, 4, 0xffd95e, 'M', 0.5);
    this.moneyNote = new PixelText(assets, 2, 0x69707f, 'micro');
    this.moneyNote.on('pointertap', () => this.resetBudget());
    this.money.addChild(this.moneyPlate, this.moneyCrumb, this.moneyNum, this.moneyNote);
    this.compare = new CompareCard(assets, 3);
    this.compare.visible = false;
    this.flashDim.visible = false;
    // BACK steps out of the list and becomes the online screen's kind of
    // button — smaller than the choices, visibly a different sort of thing
    const bw = 120;
    const pad = 6;
    const textH = assets.manifest.font.cellH * 2;
    const bh = textH + pad * 2;
    const bg = new Graphics();
    bg.rect(-bw / 2, 0, bw, bh).fill({ color: 0x05070b, alpha: 0.95 });
    bg.rect(-bw / 2 + 1, 1, bw - 2, bh - 2).fill({ color: 0x1b2231, alpha: 1 });
    bg.rect(-bw / 2 + 1, 1, bw - 2, 2).fill({ color: 0xfff8e0, alpha: 0.2 });
    bg.rect(-bw / 2 + 1, 1, 2, bh - 2).fill({ color: 0xfff8e0, alpha: 0.1 });
    bg.rect(-bw / 2 + 1, bh - 3, bw - 2, 2).fill({ color: 0x000000, alpha: 0.5 });
    bg.rect(bw / 2 - 3, 1, 2, bh - 2).fill({ color: 0x000000, alpha: 0.3 });
    const glow = new Graphics();
    glow.rect(-bw / 2 + 1, 1, bw - 2, bh - 2).fill({ color: 0xffd95e, alpha: 0.1 });
    glow.visible = false;
    const bt = new PixelText(assets, 2, 0xe8ecf4);
    bt.text = 'BACK';
    bt.centerAt(0, pad);
    const chev = new PixelText(assets, 2, 0xffd95e);
    chev.text = '>';
    chev.position.set(-bw / 2 + 10, pad);
    chev.visible = false;
    this.backBtn.addChild(bg, glow, bt, chev);
    this.backBtn.eventMode = 'static';
    this.backBtn.cursor = 'pointer';
    this.backBtn.on('pointerover', () => { glow.visible = true; chev.visible = true; audio.ui('move', 0.4); });
    this.backBtn.on('pointerout', () => { glow.visible = false; chev.visible = false; });
    this.backBtn.on('pointertap', () => { audio.ui('back'); this.onBack(); });
    this.backdrop.addChild(this.shade, this.mark, this.grass.soil, this.grass.back, this.grass.front, this.motes.g);
    this.root.addChild(this.backdrop, this.title, this.crumb, ...this.descLines, this.plate, this.money, this.backBtn, this.dust.g, this.flashDim, this.compare);
  }

  begin(mode: PlayMode) {
    this.mode = mode;
    this.title.text = mode === 'quick' ? 'QUICK MATCH' : mode === 'draft' ? 'DRAFT MODE' : 'GAMBLE MODE';
    // two short lines of plain talk about what you are walking into
    const blurb = mode === 'quick'
      ? ['TWO EQUAL SQUADS - NO NAMES ON THE SHIRTS.', 'SET HOW GOOD EACH SIDE IS AND KICK OFF.']
      : mode === 'draft'
        ? ['TAKE TURNS SIGNING STARS OUT OF ONE POOL.', 'THE MONEY ON THE TABLE IS THE WHOLE GAME.']
        : ['NO SHOPPING - YOU ROLL FOR EVERY SHIRT.', 'THE WHEEL OWES YOU NOTHING.'];
    this.descLines.forEach((line, i) => {
      line.text = blurb[i] ?? '';
      line.visible = i < blurb.length;
    });
    this.flashT = 0;
    this.pending = null;
    this.compare.visible = false;
    this.flashDim.visible = false;
    this.money.visible = mode === 'draft';
    this.syncBudget(true);
    this.list.sel = 0;
    this.refresh();
  }

  // The dials this mode actually has, in the order they are read
  private optionRows(): OptionRow[] {
    const rows: OptionRow[] = [
      { label: 'SIDES', value: `${this.size} V ${this.size}`, step: (d) => { this.size = cycle(SIZE_CHOICES, this.size, d); this.syncBudget(); } },
      { label: 'HALF LENGTH', value: fmtClock(this.halfLength), step: (d) => { this.halfLength = cycle(HALF_CHOICES, this.halfLength, d); } },
      { label: 'DIFFICULTY', value: DIFF_NAMES[this.difficulty], step: (d) => { this.difficulty = ((this.difficulty + 3 + d) % 3) as 0 | 1 | 2; } },
    ];
    if (this.mode === 'quick') {
      rows.push(
        { label: 'YOUR SIDE', value: QUALITY_NAMES[this.quality[0]], step: (d) => { this.quality[0] = this.stepQuality(this.quality[0], d); } },
        { label: 'THEIR SIDE', value: QUALITY_NAMES[this.quality[1]], step: (d) => { this.quality[1] = this.stepQuality(this.quality[1], d); } },
      );
    }
    if (this.mode === 'draft') {
      rows.push({ label: 'BUDGET', value: this.budgetTier.toUpperCase(), step: (d) => this.stepTier(d) });
      if (this.budgetTier === 'custom') rows.push({ label: 'AMOUNT', value: `${this.budget}M`, step: (d) => this.stepAmount(d) });
    }
    rows.push({ label: mode0(this.mode), go: true, gapBefore: true });
    return rows;
  }

  // Three classes, on a ring — Enter cycles and the arrows walk, so neither
  // one ever answers you with nothing
  private stepQuality(q: Quality, dir: 1 | -1): Quality {
    return ((q + 3 + dir) % 3) as Quality;
  }

  // Tiers hand the table a priced number; CUSTOM keeps whatever was there and
  // hands the amount row the keys
  private stepTier(dir: 1 | -1) {
    this.budgetTier = cycle(BUDGET_CHOICES, this.budgetTier, dir);
    this.syncBudget();
  }

  private stepAmount(dir: 1 | -1) {
    this.budget = Math.max(CUSTOM_STEP, Math.min(900, this.budget + dir * CUSTOM_STEP));
    this.moneyNum.set(this.budget);
    this.drawMoney();
  }

  // The table follows the tier and the side size; `instant` is a screen that
  // has only just opened, where there is nothing to watch roll
  private syncBudget(instant = false) {
    if (this.budgetTier !== 'custom') this.budget = tierBudget(this.budgetTier, this.size);
    this.moneyNum.set(this.budget, instant);
    this.drawMoney();
  }

  private resetBudget() {
    if (this.budget === tierBudget('average', this.size)) return;
    audio.ui('back');
    this.budgetTier = 'average';
    this.syncBudget();
    this.refresh();
  }

  private refresh(animate = false, stagger = 0) {
    this.rows = this.optionRows();
    this.list.setRows(this.rows.map((r) => ({ label: r.label, value: r.value, gapBefore: r.gapBefore, enabled: true })), true, animate, stagger);
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

  // The ledger under the plate: what every side gets to spend, counting up to
  // itself like a lottery board, with the shelf's own average underneath it
  private drawMoney() {
    const def = tierBudget('average', this.size);
    const off = this.budget !== def;
    this.moneyNote.text = off ? `RESET TO ${def}M` : `THE SHELF PRICES AN AVERAGE SQUAD AT ${def}M`;
    this.moneyNote.tint = off ? 0x9ff0b8 : 0x69707f;
    this.moneyNote.eventMode = off ? 'static' : 'none';
    this.moneyNote.cursor = 'pointer';
    const bw = Math.max(330, this.moneyNote.textWidth + 64);
    const numY = 14 + this.moneyCrumb.textHeight + 8;
    const noteY = numY + this.moneyNum.textHeight + 10;
    const bh = noteY + this.moneyNote.textHeight + 14;
    this.moneyH = bh;
    this.moneyCrumb.centerAt(0, 14);
    this.moneyNum.centerAt(0, numY);
    this.moneyNote.centerAt(0, noteY);
    const g = this.moneyPlate;
    g.clear();
    g.rect(-bw / 2, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.88 });
    g.rect(-bw / 2, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    cornerMarks(g, -bw / 2, 0, bw, bh, GOLD);
  }

  private act(i: number) {
    const row = this.rows[i];
    if (!row) return;
    if (row.go) return this.go();
    row.step?.(1);
    this.refresh();
  }

  // Left and right own the value rows — every dial answers the same axis
  private step(dir: 1 | -1) {
    const row = this.rows[this.list.sel];
    if (!row?.step) return;
    row.step(dir);
    audio.ui('move', 0.7);
    this.refresh();
  }

  // Kick off — but quick match holds the door for the head-to-head first, so
  // no match ever starts without the question "who wins this?" being asked
  private go() {
    setQuickQuality(this.quality[0], this.quality[1]);
    setTableBudget(this.mode === 'draft' ? this.budget : null);
    const setup: MatchSetup = { mode: this.mode, size: this.size, halfLength: this.halfLength, difficulty: this.difficulty };
    if (this.mode !== 'quick') return this.onStart(setup);
    this.pending = setup;
    this.flashT = FLASH_TIME;
    const [home, away] = quickSquads(quotaFor(this.size), this.quality);
    const zero = { att: 0, mid: 0, def: 0, gk: 0, pace: 0 };
    this.compare.setNames('YOUR SIDE', 'THEIR SIDE');
    this.compare.setRatings(zero, zero, true);
    this.compare.setRatings(rateSquad(home), rateSquad(away)); // ...and they climb
    this.compare.visible = true;
    this.flashDim.visible = true;
    this.placeCompare();
    this.flashDrop.clear();
    this.flashDrop.add(this.compare, 0, { from: 34, dur: 0.34, onImpact: () => {
      audio.ui('card');
      this.dust.burst(this.compare.position.x + this.compare.size.w / 2, this.compare.position.y + this.compare.size.h, this.compare.size.w * 0.6, 14);
    } });
    this.flashDrop.play();
  }

  private finishFlash() {
    const setup = this.pending;
    this.flashT = 0;
    this.pending = null;
    this.compare.visible = false;
    this.flashDim.visible = false;
    if (setup) this.onStart(setup);
  }

  key(code: string) {
    if (this.flashT > 0) {
      if (code === 'Enter' || code === 'Space') this.finishFlash(); // the impatient go now
      return;
    }
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'ArrowLeft' || code === 'KeyA') this.step(-1);
    if (code === 'ArrowRight' || code === 'KeyD') this.step(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
    if (code === 'Escape') { audio.ui('back'); this.onBack(); }
  }

  // The same signage language as the front door: words type, the plate
  // drops — over a backdrop that arrives OPAQUE, so nothing ever flashes
  enter() {
    this.reveal.clear();
    this.reveal.add(this.title, 0);
    this.reveal.add(this.crumb, 0.08);
    this.descLines.forEach((line, i) => this.reveal.add(line, 0.14 + i * 0.06));
    this.reveal.play();
    this.drop.clear();
    this.drop.add(this.plate, 0.08, { from: 28, dur: 0.34, onImpact: () => {
      audio.ui('card', 0.65);
      const bw = Math.max(this.list.blockWidth + 110, 330);
      this.dust.burst(this.plate.position.x, this.plate.position.y + this.list.totalHeight + 34, bw * 0.55, 12);
    } });
    if (this.money.visible) this.drop.add(this.money, 0.16, { from: 22, dur: 0.3 });
    this.drop.play();
    this.refresh(true, 0.2);
  }

  update(dt: number) {
    this.list.update(dt);
    this.reveal.update(dt);
    this.drop.update(dt);
    this.flashDrop.update(dt);
    this.dust.update(dt);
    this.motes.update(dt);
    this.grass.update(dt);
    if (this.money.visible) {
      this.moneyNum.update(dt);
      this.moneyNum.centerAt(0, 14 + this.moneyCrumb.textHeight + 8); // a rolling figure stays centered
    }
    if (this.flashT > 0) {
      this.compare.update(dt);
      this.flashT -= dt;
      if (this.flashT <= 0) this.finishFlash();
    }
  }

  private placeCompare() {
    const { w: cw, h: ch } = this.compare.size;
    this.compare.position.set(Math.round((this.w - cw) / 2), Math.round((this.h - ch) / 2));
  }

  layout(w: number, h: number) {
    this.w = w;
    this.h = h;
    centerShade(this.shade, w, h);
    const beam = pillarBounds(w);
    pitchMark(this.mark, w, h, beam.x0, beam.x1);
    this.motes.layout(beam.x0, beam.x1, h);
    this.grass.layout(beam.x0, beam.coreW, h);
    this.flashDim.clear();
    this.flashDim.rect(0, 0, w, h).fill({ color: 0x05070b, alpha: 0.8 });
    // the setup stacks like the front door does: measured pieces, real gaps,
    // the whole column planted from one top so nothing drifts on a resize
    let y = Math.round(h * 0.13);
    this.title.centerAt(w / 2, y);
    y += this.title.textHeight + 14;
    this.crumb.centerAt(w / 2, y);
    y += this.crumb.textHeight + 20;
    this.descLines.forEach((line) => {
      if (!line.visible) return;
      line.centerAt(w / 2, y);
      y += line.textHeight + 5;
    });
    y += 26;
    this.plate.position.set(Math.round(w / 2), y);
    y += this.list.totalHeight + 34 + 16;
    if (this.money.visible) {
      this.money.position.set(Math.round(w / 2), y);
      y += this.moneyH + 14;
    }
    this.backBtn.position.set(Math.round(w / 2), y);
    this.drawBox();
    this.placeCompare();
  }
}

const mode0 = (mode: PlayMode) =>
  mode === 'quick' ? 'KICK OFF!' : mode === 'draft' ? 'TO THE DRAFT!' : 'TO THE WHEEL!';

// ------------------------------------------------------------------- pause
// The team talk. It wears the same clothes as every other screen in the shell
// — the centered pane over the frozen match — and it reads the numbers in the
// full-time sheet's three columns: home, quiet label, away. The board DROPS in
// a cascade like the front door's signage, and lifts away again on resume.
const PAUSE_COL = 150; // half the gap between the two number columns

export class PauseScreen implements Screen {
  root = new Container();
  onResume: () => void = () => {};
  onControls: () => void = () => {}; // the controls card, called up from the board
  onQuit: () => void = () => {};
  onClosed: () => void = () => {}; // fired when the lift-out finishes
  private list: PixelList;
  private shade = new Graphics();
  private mark = new Graphics();   // the ghosted centre circle in the glass
  private tabs = new Graphics();
  private title: PixelText;
  private score: PixelText;
  private clockLine: PixelText;
  private storyCrumb: PixelText;
  private statLines: { home: PixelText; label: PixelText; away: PixelText }[] = [];
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
    this.list = new PixelList(assets, 3, 30, 4, 13, true);
    this.list.setRows([{ label: 'RESUME', enabled: true }, { label: 'CONTROLS', enabled: true }, { label: 'QUIT TO MENU', enabled: true }]);
    this.list.onPick = (i) => (i === 0 ? this.onResume() : i === 1 ? this.onControls() : this.onQuit());
    for (const label of ['POSSESSION', 'SHOTS', 'ON TARGET', 'PASSES', 'PASS ACC', 'TACKLES', 'SAVES', 'CORNERS']) {
      const l = new PixelText(assets, 2, 0x8f97a8);
      l.text = label;
      const home = new PixelText(assets, 2, 0xd8ab3c);
      const away = new PixelText(assets, 2, 0xd8ab3c);
      this.statLines.push({ home, label: l, away });
      this.root.addChild(l, home, away);
    }
    this.root.addChild(this.shade, this.mark, this.tabs, this.title, this.score, this.clockLine, this.storyCrumb, this.list.root, this.foot, this.dust.g);
    this.root.setChildIndex(this.shade, 0);
    this.root.setChildIndex(this.mark, 1);
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
    const rows: [string, string][] = [
      [`${pct}%`, `${100 - pct}%`],
      [`${s.shots[0]}`, `${s.shots[1]}`],
      [`${s.onTarget[0]}`, `${s.onTarget[1]}`],
      [`${s.passes[0]}`, `${s.passes[1]}`],
      [acc(0), acc(1)],
      [`${s.tacklesWon[0]}`, `${s.tacklesWon[1]}`],
      [`${s.saves[0]}`, `${s.saves[1]}`],
      [`${s.corners[0]}`, `${s.corners[1]}`],
    ];
    this.statLines.forEach((line, i) => {
      line.home.text = rows[i][0];
      line.away.text = rows[i][1];
    });
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
      this.dust.burst(this.list.root.position.x, this.list.root.position.y + this.list.totalHeight, 190, 9);
    } });
    this.drop.add(this.storyCrumb, 0.17, { from: 20, dur: 0.28 });
    this.statLines.forEach((line, i) => {
      for (const part of [line.home, line.label, line.away]) {
        this.drop.add(part, 0.19 + i * 0.014, { from: 18, dur: 0.26 });
      }
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
    centerShade(this.shade, w, h);
    const beam = pillarBounds(w);
    pitchMark(this.mark, w, h, beam.x0, beam.x1);
    const mid = Math.round(w / 2);
    let y = Math.round(h * 0.09);
    this.title.centerAt(mid, y);
    y += this.title.textHeight + 16;
    this.score.centerAt(mid, y);
    // kit tabs flank the scoreline — who's who at a glance
    const half = this.score.textWidth / 2;
    this.tabs.clear();
    this.tabs.rect(mid - half - 46, y + 14, 20, 20).fill(0xc4432f);
    this.tabs.rect(mid - half - 46, y + 34, 20, 5).fill(0x7e2417);
    this.tabs.rect(mid + half + 26, y + 14, 20, 20).fill(0x3458a8);
    this.tabs.rect(mid + half + 26, y + 34, 20, 5).fill(0x1c3260);
    y += this.score.textHeight + 10;
    this.clockLine.centerAt(mid, y);
    y += this.clockLine.textHeight + 26;
    this.list.root.position.set(mid, y);
    y += this.list.totalHeight + 26;
    this.storyCrumb.centerAt(mid, y);
    y += this.storyCrumb.textHeight + 10;
    // the full-time sheet's columns, to the pixel: numbers hard against the
    // gutter on both sides, the label quiet down the middle
    this.statLines.forEach((line, i) => {
      const ry = y + i * 20;
      line.label.centerAt(mid, ry + 2);
      line.home.position.set(Math.round(mid - PAUSE_COL - line.home.textWidth), ry);
      line.away.position.set(mid + PAUSE_COL, ry);
    });
    this.foot.centerAt(mid, h - 44);
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
