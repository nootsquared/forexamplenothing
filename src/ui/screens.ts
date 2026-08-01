import { Container, Graphics, Sprite } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { MOODS } from '../render/variants';
import { PixelList, stepShade } from './kit';
import { FORMATIONS, formationsOfSize } from '../data/formations';
import { StarPlayer } from '../data/players';
import {
  Draft, createDraft, canPick, pick, pickAcademy, aiPickIndex, needsOf, fillWithAcademy, assignToFormation,
} from '../data/draft';
import { Match } from '../match';

// The game's screens: menu, draft, formation, pause, full-time. Each owns a
// root container; the shell shows one at a time and routes keys into it.

export interface Screen {
  root: Container;
  key(code: string): void;
  layout(w: number, h: number): void;
  update?(dt: number): void;
}

const HALF_CHOICES = [60, 120, 180, 300];
const SIZE_CHOICES = [5, 7, 11];
const DIFF_NAMES = ['EASY', 'MEDIUM', 'HARD'];
const FPS_CHOICES: (number | null)[] = [null, 120, 60, 30];
export const fmtClock = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// What a play mode gets configured with before kickoff
export interface MatchSetup {
  mode: 'quick' | 'draft';
  size: number;
  halfLength: number;
  difficulty: 0 | 1 | 2;
}

// ---------------------------------------------------------------- main menu
// A live AI match plays behind this screen; the menu sits on a pixel-stepped
// shade on the left with the baked wordmark and the game's own rolling ball.
export class MenuScreen implements Screen {
  root = new Container();
  onQuick: () => void = () => {};
  onDraft: () => void = () => {};
  onMood: (moodIdx: number) => void = () => {};
  onFps: (cap: number | null) => void = () => {};
  moodIdx = 0;
  autoSwitch = false;
  fpsIdx = 0; // into FPS_CHOICES
  musicVol = 7;
  sfxVol = 7;
  private page: 'root' | 'play' | 'settings' = 'root';
  private list: PixelList;
  private title: Sprite;
  private ball: Sprite;
  private ballPhase = 0;
  private sub: PixelText;
  private crumb: PixelText;
  private foot: PixelText;
  private shade = new Graphics();
  private h = 720;

  constructor(private assets: GameAssets) {
    this.title = new Sprite(assets.title);
    this.sub = new PixelText(assets, 3, 0x9ff0b8);
    this.sub.text = 'ARCADE ELEVENS';
    this.crumb = new PixelText(assets, 2, 0x8a91a0);
    this.foot = new PixelText(assets, 2, 0x69707f);
    this.foot.text = 'W S PICK - ENTER GO - ESC BACK';
    this.ball = new Sprite(assets.ballFrames[0][0]);
    this.ball.anchor.set(0.5);
    this.ball.scale.set(3);
    this.list = new PixelList(assets, 3, 30, 6);
    this.list.onPick = (i) => this.act(i);
    this.root.addChild(this.shade, this.title, this.sub, this.ball, this.crumb, this.list.root, this.foot);
    this.setPage('root');
  }

  private setPage(page: 'root' | 'play' | 'settings') {
    this.page = page;
    this.list.sel = 0; // a fresh page starts at its top
    this.crumb.text = page === 'root' ? 'MAIN MENU' : page === 'play' ? 'PLAY' : 'SETTINGS';
    this.refresh();
  }

  private refresh() {
    const cap = FPS_CHOICES[this.fpsIdx];
    const rows =
      this.page === 'root' ? [{ label: 'PLAY' }, { label: 'SETTINGS' }] :
      this.page === 'play' ? [{ label: 'QUICK MATCH' }, { label: 'DRAFT MODE' }, { label: 'BACK' }] :
      [
        { label: 'PITCH', value: MOODS[this.moodIdx].name.toUpperCase() },
        { label: 'AUTO SWITCH', value: this.autoSwitch ? 'ON' : 'OFF' },
        { label: 'FPS CAP', value: cap === null ? 'UNLIMITED' : String(cap) },
        { label: 'MUSIC VOL', value: String(this.musicVol) },
        { label: 'SFX VOL', value: String(this.sfxVol) },
        { label: 'BACK' },
      ];
    this.list.setRows(rows.map((r) => ({ ...r, enabled: true })), true);
  }

  private act(i: number) {
    if (this.page === 'root') {
      this.setPage(i === 0 ? 'play' : 'settings');
    } else if (this.page === 'play') {
      if (i === 0) this.onQuick();
      else if (i === 1) this.onDraft();
      else this.setPage('root');
    } else {
      if (i === 0) { this.moodIdx = (this.moodIdx + 1) % MOODS.length; this.onMood(this.moodIdx); }
      else if (i === 1) this.autoSwitch = !this.autoSwitch;
      else if (i === 2) { this.fpsIdx = (this.fpsIdx + 1) % FPS_CHOICES.length; this.onFps(FPS_CHOICES[this.fpsIdx]); }
      else if (i === 3) this.musicVol = (this.musicVol + 1) % 11;
      else if (i === 4) this.sfxVol = (this.sfxVol + 1) % 11;
      else return this.setPage('root');
      this.refresh();
    }
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
    if (code === 'Escape' && this.page !== 'root') this.setPage('root');
  }

  // The ball rolls in place beside the wordmark, breathing on the shade
  update(dt: number) {
    const phases = this.assets.manifest.ball.phases;
    this.ballPhase += dt * 9;
    this.ball.texture = this.assets.ballFrames[0][Math.floor(this.ballPhase) % phases];
    this.ball.position.y = this.h * 0.175 + Math.sin(this.ballPhase * 0.55) * 5;
  }

  layout(w: number, h: number) {
    this.h = h;
    stepShade(this.shade, w, h);
    const scale = Math.max(6, Math.min(11, Math.floor((w * 0.3) / this.assets.manifest.title.w)));
    this.title.scale.set(scale);
    this.title.position.set(64, h * 0.09);
    this.sub.position.set(70, h * 0.09 + this.title.height + 10);
    this.ball.position.set(64 + this.title.width + 46, h * 0.175);
    this.crumb.position.set(70, h * 0.44);
    this.list.root.position.set(70, h * 0.49);
    this.foot.position.set(70, h - 44);
  }
}

// ------------------------------------------------------------- match setup
// Every play mode passes through here: sides, half length, difficulty, go.
// It lives over the same attract match as the menu.
export class SetupScreen implements Screen {
  root = new Container();
  onStart: (setup: MatchSetup) => void = () => {};
  onBack: () => void = () => {};
  private mode: 'quick' | 'draft' = 'quick';
  private size = 11;
  private halfLength = HALF_CHOICES[1];
  private difficulty: 0 | 1 | 2 = 1;
  private list: PixelList;
  private crumb: PixelText;
  private title: PixelText;
  private foot: PixelText;
  private shade = new Graphics();

  constructor(assets: GameAssets) {
    this.title = new PixelText(assets, 5, 0xffd95e);
    this.crumb = new PixelText(assets, 2, 0x8a91a0);
    this.crumb.text = 'MATCH SETUP';
    this.foot = new PixelText(assets, 2, 0x69707f);
    this.foot.text = 'W S PICK - ENTER GO - ESC BACK';
    this.list = new PixelList(assets, 3, 30, 6);
    this.list.onPick = (i) => this.act(i);
    this.root.addChild(this.shade, this.title, this.crumb, this.list.root, this.foot);
  }

  begin(mode: 'quick' | 'draft') {
    this.mode = mode;
    this.title.text = mode === 'quick' ? 'QUICK MATCH' : 'DRAFT MODE';
    this.list.sel = 0;
    this.refresh();
  }

  private refresh() {
    this.list.setRows([
      { label: 'SIDES', value: `${this.size} V ${this.size}`, enabled: true },
      { label: 'HALF LENGTH', value: fmtClock(this.halfLength), enabled: true },
      { label: 'DIFFICULTY', value: DIFF_NAMES[this.difficulty], enabled: true },
      { label: mode0(this.mode), enabled: true },
      { label: 'BACK', enabled: true },
    ], true);
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
    if (code === 'Escape') this.onBack();
  }

  layout(w: number, h: number) {
    stepShade(this.shade, w, h);
    this.title.position.set(66, h * 0.14);
    this.crumb.position.set(70, h * 0.14 + 56);
    this.list.root.position.set(70, h * 0.34);
    this.foot.position.set(70, h - 44);
  }
}

const mode0 = (mode: 'quick' | 'draft') => (mode === 'quick' ? 'KICK OFF!' : 'TO THE DRAFT!');

// ------------------------------------------------------------------- draft
export class DraftScreen implements Screen {
  root = new Container();
  onDone: (draft: Draft) => void = () => {};
  private draft!: Draft;
  private aiTimer = 0;
  private list: PixelList;
  private header: PixelText;
  private budgetLine: PixelText;
  private needsLine: PixelText;
  private squadTitle: PixelText;
  private squadLines: PixelText[] = [];
  private backdrop = new Graphics();
  private squadPanel = new Container();

  constructor(private assets: GameAssets) {
    this.header = new PixelText(assets, 3, 0xffd95e);
    this.budgetLine = new PixelText(assets, 2, 0x9ff0b8);
    this.needsLine = new PixelText(assets, 2, 0x8a91a0);
    this.squadTitle = new PixelText(assets, 2, 0xffd95e);
    this.squadTitle.text = 'YOUR SQUAD';
    this.list = new PixelList(assets, 2, 15, 18);
    this.list.onPick = (i) => this.humanPick(i);
    this.root.addChild(this.backdrop, this.header, this.budgetLine, this.needsLine, this.list.root, this.squadPanel);
    this.squadPanel.addChild(this.squadTitle);
  }

  begin(size = 11) {
    const first = Math.random() < 0.5 ? 0 : 1;
    this.draft = createDraft(first as 0 | 1, size);
    this.aiTimer = 0.8;
    this.refresh();
  }

  private get myTurn(): boolean {
    return this.draft.order[this.draft.turn] === 0;
  }

  private rowsForPool() {
    const side = this.draft.sides[0];
    const rows = this.draft.pool.map((p) => ({
      label: `${p.name.padEnd(12)}${p.role.padEnd(3)}${String(p.ovr).padEnd(4)}${p.price}M`,
      enabled: this.myTurn && canPick(side, p),
    }));
    rows.push({ label: 'ACADEMY PICK  62  0.9M', enabled: this.myTurn });
    return rows;
  }

  private refresh() {
    if (this.draft.turn >= this.draft.order.length) {
      fillWithAcademy(this.draft.sides[0]);
      fillWithAcademy(this.draft.sides[1]);
      this.onDone(this.draft);
      return;
    }
    const pickNo = this.draft.turn + 1;
    this.header.text = this.myTurn
      ? `PICK ${pickNo} OF ${this.draft.order.length} - YOUR CALL`
      : `PICK ${pickNo} OF ${this.draft.order.length} - CPU THINKING`;
    const side = this.draft.sides[0];
    const needs = needsOf(side);
    this.budgetLine.text = `BUDGET ${side.budget.toFixed(1)}M`;
    this.needsLine.text = `NEED GK ${needs.GK} DF ${needs.DF} MF ${needs.MF} FW ${needs.FW}`;
    this.list.setRows(this.rowsForPool(), true);
    for (const line of this.squadLines) line.destroy();
    this.squadLines = side.picks.map((p, i) => {
      const t = new PixelText(this.assets, 2, 0xe8ecf4);
      t.text = `${p.role.padEnd(3)}${p.name}`;
      t.position.set(0, 22 + i * 14);
      this.squadPanel.addChild(t);
      return t;
    });
  }

  private humanPick(i: number) {
    if (!this.myTurn) return;
    if (i >= this.draft.pool.length) {
      const needs = needsOf(this.draft.sides[0]);
      const role = (['GK', 'DF', 'MF', 'FW'] as const).find((r) => needs[r] > 0);
      if (role) pickAcademy(this.draft, role);
    } else {
      pick(this.draft, i);
    }
    this.aiTimer = 0.55;
    this.refresh();
  }

  // CPU turns tick on a small dramatic delay
  update(dt: number) {
    if (!this.draft || this.draft.turn >= this.draft.order.length || this.myTurn) return;
    this.aiTimer -= dt;
    if (this.aiTimer > 0) return;
    const i = aiPickIndex(this.draft);
    if (i >= 0) {
      pick(this.draft, i);
    } else {
      const needs = needsOf(this.draft.sides[1]);
      const role = (['GK', 'DF', 'MF', 'FW'] as const).find((r) => needs[r] > 0);
      if (role) pickAcademy(this.draft, role);
      else this.draft.turn++;
    }
    this.aiTimer = 0.55;
    this.refresh();
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
  }

  layout(w: number, h: number) {
    this.backdrop.clear();
    this.backdrop.rect(0, 0, w, h).fill(0x0a0e14);
    this.backdrop.rect(30, 96, 560, h - 150).fill({ color: 0x10141c, alpha: 0.9 });
    this.backdrop.rect(620, 96, 320, h - 150).fill({ color: 0x10141c, alpha: 0.9 });
    this.header.position.set(30, 26);
    this.budgetLine.position.set(30, 62);
    this.needsLine.position.set(240, 62);
    this.list.root.position.set(44, 110);
    this.squadPanel.position.set(640, 110);
  }
}

// -------------------------------------------------------------- formations
export class FormationScreen implements Screen {
  root = new Container();
  onDone: (shape: string) => void = () => {};
  private picks: StarPlayer[] = [];
  private list: PixelList;
  private header: PixelText;
  private preview: PixelText[] = [];
  private backdrop = new Graphics();
  private shapes = formationsOfSize(11);

  constructor(private assets: GameAssets) {
    this.header = new PixelText(assets, 3, 0xffd95e);
    this.header.text = 'PICK YOUR SHAPE';
    this.list = new PixelList(assets, 3, 24, 8);
    this.list.onPick = (i) => this.onDone(this.shapes[i]);
    this.list.onSelect = () => { if (this.picks.length) this.renderPreview(); };
    this.root.addChild(this.backdrop, this.header, this.list.root);
  }

  begin(picks: StarPlayer[], size = 11) {
    this.picks = picks;
    this.shapes = formationsOfSize(size);
    this.list.setRows(this.shapes.map((s) => ({ label: s, enabled: true })));
    this.renderPreview();
  }

  private renderPreview() {
    for (const t of this.preview) t.destroy();
    const shape = FORMATIONS[this.shapes[this.list.sel]];
    const xi = assignToFormation(this.picks, shape.slots);
    this.preview = xi.map((p, i) => {
      const t = new PixelText(this.assets, 2, 0xe8ecf4);
      t.text = `${shape.slots[i].role.padEnd(3)}${p.name}`;
      t.position.set(430, 120 + i * 15);
      this.root.addChild(t);
      return t;
    });
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') { this.list.move(-1); this.renderPreview(); }
    if (code === 'ArrowDown' || code === 'KeyS') { this.list.move(1); this.renderPreview(); }
    if (code === 'Enter' || code === 'Space') this.list.activate();
  }

  layout(w: number, h: number) {
    this.backdrop.clear();
    this.backdrop.rect(0, 0, w, h).fill(0x0a0e14);
    this.backdrop.rect(60, 96, 300, h - 160).fill({ color: 0x10141c, alpha: 0.9 });
    this.backdrop.rect(400, 96, 340, h - 160).fill({ color: 0x10141c, alpha: 0.9 });
    this.header.position.set(60, 30);
    this.list.root.position.set(80, 116);
  }
}

// ------------------------------------------------------------------- pause
// The team talk: the frozen match stays visible on the right while the shade
// column carries the scoreline, your options, and the story of the game so
// far. It slides in off the touchline and slides back out on resume.
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export class PauseScreen implements Screen {
  root = new Container();
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onClosed: () => void = () => {}; // fired when the slide-out finishes
  private list: PixelList;
  private shade = new Graphics();
  private tabs = new Graphics();
  private title: PixelText;
  private score: PixelText;
  private clockLine: PixelText;
  private storyCrumb: PixelText;
  private statLines: { label: PixelText; value: PixelText }[] = [];
  private foot: PixelText;
  private anim = 1;
  private closing = false;

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
    this.root.addChild(this.shade, this.tabs, this.title, this.score, this.clockLine, this.storyCrumb, this.list.root, this.foot);
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

  // Slide in off the touchline / slide back out
  open() {
    this.anim = 0;
    this.closing = false;
  }
  close() {
    if (!this.closing) this.closing = true;
  }

  update(dt: number) {
    const target = this.closing ? 0 : 1;
    const dir = Math.sign(target - this.anim);
    if (dir !== 0) {
      this.anim = Math.max(0, Math.min(1, this.anim + dir * dt * 6.5));
      const e = easeOutCubic(this.anim);
      this.root.alpha = e;
      this.root.position.x = -70 * (1 - e);
      if (this.closing && this.anim <= 0) {
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
    this.title.position.set(66, h * 0.1);
    const scoreY = h * 0.1 + 90;
    this.score.position.set(70 + 30, scoreY);
    // kit tabs flank the scoreline — who's who at a glance
    this.tabs.clear();
    this.tabs.rect(70, scoreY + 14, 20, 20).fill(0xc4432f);
    this.tabs.rect(70, scoreY + 34, 20, 5).fill(0x7e2417);
    const bx = 70 + 30 + this.score.textWidth + 12;
    this.tabs.rect(bx, scoreY + 14, 20, 20).fill(0x3458a8);
    this.tabs.rect(bx, scoreY + 34, 20, 5).fill(0x1c3260);
    this.clockLine.position.set(70, scoreY + 66); // clear of the score's full glyph height
    this.list.root.position.set(70, h * 0.42);
    const storyY = h * 0.42 + 110;
    this.storyCrumb.position.set(70, storyY);
    this.statLines.forEach((line, i) => {
      line.label.position.set(70, storyY + 26 + i * 18);
      line.value.position.set(70 + 13 * 12, storyY + 26 + i * 18);
    });
    this.foot.position.set(70, h - 44);
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
