import { Container, Graphics } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { panel, PixelList } from './kit';
import { FORMATIONS } from '../data/formations';
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
}

const HALF_CHOICES = [60, 120, 180, 300];
export const fmtClock = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- main menu
export class MenuScreen implements Screen {
  root = new Container();
  onQuick: () => void = () => {};
  onDraft: () => void = () => {};
  halfLength = HALF_CHOICES[1];
  private list: PixelList;
  private title: PixelText;
  private sub: PixelText;
  private foot: PixelText;
  private backdrop = new Graphics();

  constructor(assets: GameAssets) {
    this.title = new PixelText(assets, 12, 0xffd95e);
    this.title.text = 'GOLAZO';
    this.sub = new PixelText(assets, 4, 0x9ff0b8);
    this.sub.text = 'ARCADE ELEVENS';
    this.foot = new PixelText(assets, 2, 0x8a91a0);
    this.foot.text = 'W S PICK - ENTER GO';
    this.list = new PixelList(assets, 3, 26, 6);
    this.list.onPick = (i) => this.act(i);
    this.root.addChild(this.backdrop, this.title, this.sub, this.list.root, this.foot);
    this.refresh();
  }

  private refresh() {
    this.list.setRows([
      { label: 'QUICK MATCH', enabled: true },
      { label: 'DRAFT MODE', enabled: true },
      { label: `HALF LENGTH ${fmtClock(this.halfLength)}`, enabled: true },
    ], true);
  }

  private act(i: number) {
    if (i === 0) this.onQuick();
    else if (i === 1) this.onDraft();
    else {
      const next = (HALF_CHOICES.indexOf(this.halfLength) + 1) % HALF_CHOICES.length;
      this.halfLength = HALF_CHOICES[next];
      this.refresh();
    }
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
  }

  layout(w: number, h: number) {
    this.backdrop.clear();
    this.backdrop.rect(0, 0, w, h).fill(0x0a0e14);
    for (let y = 0; y < h; y += 44) this.backdrop.rect(0, y, w, 22).fill({ color: 0x101822, alpha: 0.5 });
    this.title.centerAt(w / 2, h * 0.18);
    this.sub.centerAt(w / 2, h * 0.18 + 100);
    this.list.root.position.set(w / 2 - 120, h * 0.5);
    this.foot.centerAt(w / 2, h - 40);
  }
}

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

  begin() {
    const first = Math.random() < 0.5 ? 0 : 1;
    this.draft = createDraft(first as 0 | 1);
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
  private shapes = Object.keys(FORMATIONS);

  constructor(private assets: GameAssets) {
    this.header = new PixelText(assets, 3, 0xffd95e);
    this.header.text = 'PICK YOUR SHAPE';
    this.list = new PixelList(assets, 3, 24, 8);
    this.list.onPick = (i) => this.onDone(this.shapes[i]);
    this.list.onSelect = () => { if (this.picks.length) this.renderPreview(); };
    this.root.addChild(this.backdrop, this.header, this.list.root);
  }

  begin(picks: StarPlayer[]) {
    this.picks = picks;
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
export class PauseScreen implements Screen {
  root = new Container();
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  private list: PixelList;
  private dim = new Graphics();
  private box: Graphics | null = null;
  private title: PixelText;

  constructor(assets: GameAssets) {
    this.title = new PixelText(assets, 5, 0xffd95e);
    this.title.text = 'PAUSED';
    this.list = new PixelList(assets, 3, 26, 4);
    this.list.setRows([{ label: 'RESUME', enabled: true }, { label: 'QUIT TO MENU', enabled: true }]);
    this.list.onPick = (i) => (i === 0 ? this.onResume() : this.onQuit());
    this.root.addChild(this.dim, this.title, this.list.root);
  }

  key(code: string) {
    if (code === 'ArrowUp' || code === 'KeyW') this.list.move(-1);
    if (code === 'ArrowDown' || code === 'KeyS') this.list.move(1);
    if (code === 'Enter' || code === 'Space') this.list.activate();
  }

  layout(w: number, h: number) {
    this.dim.clear();
    this.dim.rect(0, 0, w, h).fill({ color: 0x05070b, alpha: 0.68 });
    if (this.box) this.box.destroy();
    this.box = panel(300, 170);
    this.box.position.set(w / 2 - 150, h / 2 - 90);
    this.root.addChildAt(this.box, 1);
    this.title.centerAt(w / 2, h / 2 - 62);
    this.list.root.position.set(w / 2 - 90, h / 2 - 4);
  }
}

// --------------------------------------------------------------- full time
export class StatsScreen implements Screen {
  root = new Container();
  onDone: () => void = () => {};
  private dim = new Graphics();
  private lines: PixelText[] = [];

  constructor(private assets: GameAssets) {
    this.root.addChild(this.dim);
  }

  begin(match: Match) {
    for (const t of this.lines) t.destroy();
    this.lines = [];
    const s = match.stats;
    const total = Math.max(1, s.possession[0] + s.possession[1]);
    const pct = Math.round((s.possession[0] / total) * 100);
    const world = match.world;
    const scorers = Object.entries(s.goals)
      .map(([idx, n]) => `${match.names[+idx]} ${n}`)
      .join('  ') || 'NOBODY';
    // player of the match: goals loud, saves solid, involvement quiet
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
    };
    add('FULL TIME', 6, 0xffd95e);
    add(`${world.score.left} - ${world.score.right}`, 8, 0xffffff);
    add(`POSSESSION ${pct}% - ${100 - pct}%`, 3, 0xe8ecf4);
    add(`KICKS ${s.kicks[0]} - ${s.kicks[1]}`, 3, 0xe8ecf4);
    add(`SAVES ${s.saves[0]} - ${s.saves[1]}`, 3, 0xe8ecf4);
    add(`GOALS ${scorers}`, 2, 0x9ff0b8);
    add(`STAR OF THE MATCH ${match.names[potm]}`, 3, 0xffd95e);
    add('ENTER FOR MENU', 2, 0x8a91a0);
  }

  key(code: string) {
    if (code === 'Enter' || code === 'Space') this.onDone();
  }

  layout(w: number, h: number) {
    this.dim.clear();
    this.dim.rect(0, 0, w, h).fill({ color: 0x05070b, alpha: 0.78 });
    const ys = [0.16, 0.24, 0.4, 0.46, 0.52, 0.6, 0.7, 0.85];
    this.lines.forEach((t, i) => t.centerAt(w / 2, h * (ys[i] ?? 0.9)));
  }
}
