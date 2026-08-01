import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';
import { Reveal, centerShade } from './kit';
import { Screen } from './screens';
import { StarPlayer, rarityOf, academyPlayer } from '../data/players';
import { FORMATIONS, Role, STYLES, formationsOf } from '../data/formations';
import { SquadPlayer } from '../data/roster';
import {
  Draft, createDraft, canPick, pick, pickAcademy, aiPickIndex, needsOf,
  fillWithAcademy, toSquad, toSquadOrdered, bestOpenSlot,
} from '../data/draft';

// The war room: coin toss → shape call → the market. FIFA-grade cards on the
// shelf, your XI on a drag-anywhere chalkboard, the CPU building against you
// in real time. Gamble mode swaps the market for the wheel.

const RARITY_TINT: Record<string, number> = { legend: 0xffe27a, epic: 0xd9a6ff, rare: 0x9cc4f0, common: 0xc4ccd8 };
const ROLE_TINT: Record<Role, number> = { GK: 0xf0c552, DF: 0x8ecff0, MF: 0x9ff0b8, FW: 0xff9c8a };
const FILTERS: (Role | 'ALL')[] = ['ALL', 'GK', 'DF', 'MF', 'FW'];
const SHAPE_TIME = 15;
const PICK_TIME = 30;
const REEL_SCALE = 2;   // slot cards ride big
const REEL_GAP = 10;    // air between cards on the strip

const stat99 = (v: number) => String(Math.round(v * 99)).padStart(2, '0');

// ---------------------------------------------------------------- card view
// One player as a collectible: rarity frame, kit figure wearing his number,
// rating up top, the fine print when held close.
class CardView extends Container {
  constructor(assets: GameAssets, p: StarPlayer, s: number, detail: boolean) {
    super();
    const rarity = rarityOf(p.ovr);
    const frame = new Sprite(assets.cardFrames[rarity]);
    frame.scale.set(s);
    this.addChild(frame);
    const fig = new Sprite(assets.cardFigures[rarity]);
    fig.scale.set(s);
    fig.position.set(31 * s, 2 * s);
    this.addChild(fig);
    const num = new PixelText(assets, s, 0x12161f, 'micro');
    num.text = p.number > 0 ? String(p.number) : '';
    num.centerAt(41 * s, 11 * s);
    this.addChild(num);
    const ovr = new PixelText(assets, 2 * s, 0xfff3c4);
    ovr.text = String(p.ovr);
    ovr.position.set(5 * s, 4 * s);
    this.addChild(ovr);
    const role = new PixelText(assets, s, ROLE_TINT[p.role], 'micro');
    role.text = p.role;
    role.position.set(6 * s, 20 * s);
    this.addChild(role);
    const name = new PixelText(assets, s, 0xf2f5fa);
    name.text = p.name;
    name.centerAt(29 * s, 31 * s);
    this.addChild(name);
    const price = new PixelText(assets, s, 0xffd95e);
    price.text = p.price > 0 ? `${p.price}M` : '';
    price.centerAt(29 * s, 69 * s);
    this.addChild(price);
    if (detail) {
      const rows: [string, number][] = [
        ['PAC', (p.stats.sprintSpeed - 6.3) / 1.6],
        ['SHO', p.stats.power],
        ['DRI', p.stats.control],
        ['AGI', p.stats.agility],
      ];
      rows.forEach(([label, v], i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const l = new PixelText(assets, s, 0x8f97a8, 'micro');
        l.text = label;
        l.position.set((8 + col * 26) * s, (43 + row * 9) * s);
        const val = new PixelText(assets, s, 0xdfe4ee, 'micro');
        val.text = stat99(v);
        val.position.set((21 + col * 26) * s, (43 + row * 9) * s);
        this.addChild(l, val);
      });
      const nation = new PixelText(assets, s, 0x8f97a8, 'micro');
      nation.text = p.nation;
      nation.centerAt(29 * s, 61 * s);
      this.addChild(nation);
    }
  }
}

// -------------------------------------------------------------- card board
// The full-height team board: a vertical pitch (your goal at the bottom, the
// attack climbing the screen) where every formation slot is a CARD SLOT.
// Signings stand in their slots as real cards; drag a card onto a teammate
// to swap their jobs — mid-draft, any time.
class CardBoard extends Container {
  onSwap: (a: number, b: number) => void = () => {};
  private board = new Graphics();
  private cardLayer = new Container();
  private slots: { x: number; y: number; role: Role }[] = [];
  private entries: (StarPlayer | null)[] = [];
  private dragging: { view: Container; slot: number } | null = null;
  private W = 300;
  private H = 620;
  private cardS = 1;

  constructor(private assets: GameAssets, private draggable: boolean) {
    super();
    this.addChild(this.board, this.cardLayer);
    this.eventMode = 'static';
    this.on('pointermove', (e) => {
      if (!this.dragging) return;
      const local = this.toLocal(e.global);
      this.dragging.view.position.set(
        Math.round(local.x - (this.cardW * this.cardS) / 2),
        Math.round(local.y - (this.cardH * this.cardS) / 2),
      );
    });
    const drop = (e: { global: { x: number; y: number } }) => {
      if (!this.dragging) return;
      const local = this.toLocal(e.global);
      let best = this.dragging.slot;
      let bestD = Infinity;
      this.slots.forEach((s, i) => {
        const d = Math.hypot(s.x + (this.cardW * this.cardS) / 2 - local.x, s.y + (this.cardH * this.cardS) / 2 - local.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      const from = this.dragging.slot;
      this.dragging = null;
      if (best !== from) {
        audio.ui('card');
        this.onSwap(from, best);
      } else {
        this.rebuild();
      }
    };
    this.on('pointerup', drop);
    this.on('pointerupoutside', drop);
  }

  private get cardW() { return this.assets.manifest.cards.w; }
  private get cardH() { return this.assets.manifest.cards.h; }

  resize(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.hitArea = new Rectangle(0, 0, w, h);
    this.cardS = w >= 4 * (this.cardW + 8) + 16 ? 1 : 1; // cards stay 1:1 pixels — the board flexes around them
    this.drawBoard();
    this.layoutSlots();
    this.rebuild();
  }

  private drawBoard() {
    const g = this.board;
    const { W, H } = this;
    g.clear();
    g.rect(0, 0, W, H).fill({ color: 0x0b1c10, alpha: 0.94 });
    // beveled pixel frame, same grammar as the menu panels
    g.rect(0, 0, W, 2).fill({ color: 0xfff8e0, alpha: 0.16 });
    g.rect(0, H - 2, W, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(0, 0, 2, H).fill({ color: 0xfff8e0, alpha: 0.08 });
    g.rect(W - 2, 0, 2, H).fill({ color: 0x000000, alpha: 0.35 });
    // mown bands sell it as turf, chunky stepped chalk sells it as a pitch
    for (let y = 0; y < H; y += 44) g.rect(2, y, W - 4, 22).fill({ color: 0xffffff, alpha: 0.016 });
    const chalk = (x: number, y: number, w: number, h: number) =>
      g.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).fill({ color: 0xdfe8da, alpha: 0.3 });
    const L = 10, R = W - 10, T = 10, B = H - 10;
    chalk(L, T, R - L, 2); chalk(L, B - 2, R - L, 2);           // goal lines
    chalk(L, T, 2, B - T); chalk(R - 2, T, 2, B - T);           // touchlines
    chalk(L, H / 2 - 1, R - L, 2);                              // halfway
    // the center circle, stepped like a sprite — 2px stones on a squashed ring
    for (let a = 0; a < 48; a++) {
      const th = (a / 48) * Math.PI * 2;
      chalk(W / 2 + Math.cos(th) * 27 - 1, H / 2 + Math.sin(th) * 24 - 1, 2, 2);
    }
    chalk(W / 2 - 1, H / 2 - 1, 2, 2);                          // center spot
    const boxW = Math.min(104, W - 80);
    chalk(W / 2 - boxW / 2, T, 2, 38); chalk(W / 2 + boxW / 2 - 2, T, 2, 38);
    chalk(W / 2 - boxW / 2, T + 36, boxW, 2);                   // their box, up top
    chalk(W / 2 - boxW / 2, B - 38, 2, 38); chalk(W / 2 + boxW / 2 - 2, B - 38, 2, 38);
    chalk(W / 2 - boxW / 2, B - 38, boxW, 2);                   // our box, at the bottom
    chalk(W / 2 - 1, T + 26, 2, 2); chalk(W / 2 - 1, B - 28, 2, 2); // penalty spots
  }

  setShape(shapeId: string) {
    const shape = FORMATIONS[shapeId];
    this.slots = shape.slots.map((s) => ({ x: 0, y: 0, role: s.role }));
    this.shapeSlots = shape.slots;
    this.layoutSlots();
  }

  private shapeSlots: { role: Role; x: number; y: number }[] = [];

  private layoutSlots() {
    const cw = this.cardW * this.cardS;
    const ch = this.cardH * this.cardS;
    this.slots = this.shapeSlots.map((s) => ({
      // slot.x runs own goal → attack: our goal lives at the BOTTOM
      x: Math.round(10 + s.y * (this.W - 20 - cw)),
      y: Math.round(10 + (1 - (s.x - 0.02) / 0.8) * (this.H - 20 - ch)),
      role: s.role,
    }));
    // No two slots may share pixels — narrow shapes (the diamond, stacked
    // pivots) relax apart until every card has air to be grabbed by
    for (let iter = 0; iter < 24; iter++) {
      let moved = false;
      for (let i = 0; i < this.slots.length; i++) {
        for (let j = i + 1; j < this.slots.length; j++) {
          const a = this.slots[i];
          const b = this.slots[j];
          const ox = cw + 10 - Math.abs(a.x - b.x);
          const oy = ch + 10 - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const s = a.x <= b.x ? 1 : -1;
            a.x -= s * Math.ceil(ox / 2);
            b.x += s * Math.ceil(ox / 2);
          } else {
            const s = a.y <= b.y ? 1 : -1;
            a.y -= s * Math.ceil(oy / 2);
            b.y += s * Math.ceil(oy / 2);
          }
          a.x = Math.max(4, Math.min(this.W - 4 - cw, a.x));
          b.x = Math.max(4, Math.min(this.W - 4 - cw, b.x));
          a.y = Math.max(4, Math.min(this.H - 4 - ch, a.y));
          b.y = Math.max(4, Math.min(this.H - 4 - ch, b.y));
        }
      }
      if (!moved) break;
    }
  }

  // entries align to slots; null = an open chair waiting for a signing
  setEntries(entries: (StarPlayer | null)[]) {
    this.entries = entries;
    this.rebuild();
  }

  private rebuild() {
    this.cardLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    const cw = this.cardW * this.cardS;
    const ch = this.cardH * this.cardS;
    this.slots.forEach((slot, i) => {
      const entry = this.entries[i] ?? null;
      if (!entry) {
        // a beveled pixel tile with role-colored corner brackets: the open chair
        const empty = new Graphics();
        const tint = ROLE_TINT[slot.role];
        empty.rect(slot.x, slot.y, cw, ch).fill({ color: 0x0a0f16, alpha: 0.8 });
        empty.rect(slot.x, slot.y, cw, 1).fill({ color: 0xfff8e0, alpha: 0.12 });
        empty.rect(slot.x, slot.y + ch - 1, cw, 1).fill({ color: 0x000000, alpha: 0.55 });
        const arm = 8;
        const brackets: [number, number, number, number][] = [
          [0, 0, arm, 2], [0, 0, 2, arm], [cw - arm, 0, arm, 2], [cw - 2, 0, 2, arm],
          [0, ch - 2, arm, 2], [0, ch - arm, 2, arm], [cw - arm, ch - 2, arm, 2], [cw - 2, ch - arm, 2, arm],
        ];
        for (const [bx, by, bw, bh] of brackets) {
          empty.rect(slot.x + bx, slot.y + by, bw, bh).fill({ color: tint, alpha: 0.9 });
        }
        const role = new PixelText(this.assets, 2, tint);
        role.text = slot.role;
        role.alpha = 0.75;
        role.centerAt(slot.x + cw / 2, slot.y + ch / 2 - 7);
        this.cardLayer.addChild(empty, role);
        return;
      }
      const holder = new Container();
      holder.addChild(new CardView(this.assets, entry, this.cardS, true)); // full fine print, even on the board
      holder.position.set(slot.x, slot.y);
      if (this.draggable) {
        holder.eventMode = 'static';
        holder.cursor = 'grab';
        holder.hitArea = new Rectangle(0, 0, cw, ch);
        // the card under your pointer surfaces — neighbors never trap it
        holder.on('pointerover', () => {
          if (!this.dragging) this.cardLayer.setChildIndex(holder, this.cardLayer.children.length - 1);
        });
        holder.on('pointerdown', () => {
          this.dragging = { view: holder, slot: i };
          this.cardLayer.setChildIndex(holder, this.cardLayer.children.length - 1);
          audio.ui('move');
        });
      }
      this.cardLayer.addChild(holder);
    });
  }
}

// ------------------------------------------------------------ squad builder
type Phase = 'toss' | 'shape' | 'market' | 'done';

export class SquadBuilderScreen implements Screen {
  root = new Container();
  onDone: (home: SquadPlayer[], homeShape: string, away: SquadPlayer[], awayShape: string) => void = () => {};

  private mode: 'draft' | 'gamble' = 'draft';
  private size = 11;
  private draft!: Draft;
  private phase: Phase = 'toss';
  private w = 1280;
  private h = 720;

  // toss
  private tossT = 0;
  private coin: Sprite;
  private caption: PixelText;

  // shape call
  private shapeClock = SHAPE_TIME;
  private styleCol = 1; // start on BALANCED
  private shapeRow = 0;
  private myShape = '';
  private cpuShape = '';
  private shapePanels = new Container();

  // market
  private pickClock = PICK_TIME;
  private cpuTimer = 0;
  private filter: Role | 'ALL' = 'ALL';
  private gridSel = 0;
  private gridScroll = 0;
  private gridCols = 4;
  private gridRows = 2;
  private arrangement: (number | null)[] = []; // my slot → pick index
  private cpuReveal: { view: Container; t: number } | null = null;
  private flyer: { view: Container; t: number; fx: number; fy: number; tx: number; ty: number } | null = null;

  // gamble: the slot reel — a shuffled strip of every player on the shelf
  // scrolling past a needle until it lands. Every man an equal ticket.
  private reelBack = new Graphics();   // dark band behind the strip
  private reelFront = new Graphics();  // rails, needles, edge shade above it
  private reelStrip = new Container();
  private reelMaskG = new Graphics();
  private roll: {
    t: number; dur: number; from: number; to: number;
    strip: { p: StarPlayer; poolIdx: number }[]; winStrip: number;
    forCpu: boolean; role: Role; lastCell: number;
  } | null = null;
  private reelX = 0;
  private reelY = 0;
  private reelW = 700;
  private roleSel = 0;
  private revealCard: { view: Container; t: number } | null = null;

  // chrome
  private shade = new Graphics();
  private header: PixelText;
  private turnText: PixelText;
  private clockBar = new Graphics();
  private foot: PixelText;
  private myPanel = new Container();
  private cpuPanel = new Container();
  private myTitle: PixelText;
  private cpuTitle: PixelText;
  private myBudget: PixelText;
  private cpuBudget: PixelText;
  private myStats: PixelText;
  private myNeeds: PixelText;
  private myBoard: CardBoard;
  private cpuBoard: CardBoard;
  private wheelPrompt: PixelText;
  private promptPulse = 0;
  private market = new Container();
  private gridLayer = new Container();
  private filterRow = new Container();
  private focusLayer = new Container();
  private overlay = new Container();
  private reveal = new Reveal();

  constructor(private assets: GameAssets) {
    this.header = new PixelText(assets, 4, 0xffd95e);
    this.turnText = new PixelText(assets, 3, 0xdfe4ee);
    this.foot = new PixelText(assets, 2, 0x69707f);
    this.caption = new PixelText(assets, 4, 0xf2f5fa);
    this.coin = new Sprite(assets.coinFrames[0]);
    this.coin.anchor.set(0.5);
    this.coin.scale.set(6);
    this.reelStrip.mask = this.reelMaskG;
    this.myTitle = new PixelText(assets, 3, 0xff9c8a);
    this.myTitle.text = 'YOUR SQUAD';
    this.cpuTitle = new PixelText(assets, 3, 0x9cc4f0);
    this.cpuTitle.text = 'CPU SQUAD';
    this.myBudget = new PixelText(assets, 2, 0x9ff0b8);
    this.cpuBudget = new PixelText(assets, 2, 0x8f97a8);
    this.myStats = new PixelText(assets, 2, 0x8f97a8);
    this.myNeeds = new PixelText(assets, 2, 0x8f97a8);
    this.myBoard = new CardBoard(assets, true);
    this.myBoard.onSwap = (a, b) => this.swapSlots(a, b);
    this.cpuBoard = new CardBoard(assets, false);
    this.wheelPrompt = new PixelText(assets, 3, 0xffd95e);
    this.myPanel.addChild(this.myTitle, this.myBudget, this.myBoard, this.myStats, this.myNeeds);
    this.cpuPanel.addChild(this.cpuTitle, this.cpuBudget, this.cpuBoard);
    this.market.addChild(this.filterRow, this.gridLayer, this.focusLayer);
    this.root.addChild(
      this.shade, this.header, this.turnText, this.clockBar, this.myPanel, this.cpuPanel,
      this.market, this.shapePanels, this.coin, this.caption,
      this.reelBack, this.reelStrip, this.reelMaskG, this.reelFront, this.wheelPrompt, this.overlay, this.foot,
    );
  }

  // Every floating showcase, reveal and flyer dies here — no ghosts between
  // phases or sessions
  private clearTransients() {
    this.cpuReveal?.view.destroy({ children: true });
    this.cpuReveal = null;
    this.revealCard?.view.destroy({ children: true });
    this.revealCard = null;
    this.flyer?.view.destroy({ children: true });
    this.flyer = null;
    this.overlay.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.killReel();
  }

  private killReel() {
    this.roll = null;
    this.reelStrip.removeChildren().forEach((c) => c.destroy({ children: true }));
  }

  // ------------------------------------------------------------- lifecycle
  begin(size: number, mode: 'draft' | 'gamble') {
    this.clearTransients();
    this.mode = mode;
    this.size = size;
    this.draft = createDraft(Math.random() < 0.5 ? 0 : 1, size, mode === 'draft');
    this.phase = 'toss';
    this.tossT = 0;
    this.myShape = '';
    this.cpuShape = '';
    this.styleCol = 1;
    this.shapeRow = 0;
    this.shapeClock = SHAPE_TIME;
    this.filter = 'ALL';
    this.gridSel = 0;
    this.gridScroll = 0;
    this.roleSel = 0;
    this.arrangement = [];
    this.header.text = mode === 'draft' ? 'THE DRAFT' : 'THE SLOTS';
    this.foot.text = mode === 'draft'
      ? 'WASD MOVE - ENTER SIGN - F FILTER - X ACADEMY - DRAG CHIPS TO REARRANGE'
      : 'A D PICK A SHELF - ENTER ROLLS - DRAG CHIPS TO REARRANGE';
    audio.ui('coin');
    this.refreshPanels();
    this.layoutPhase();
  }

  private get myTurn(): boolean {
    return this.draft.order[this.draft.turn] === 0;
  }

  // ------------------------------------------------------------- the board
  private swapSlots(a: number, b: number) {
    const tmp = this.arrangement[a];
    this.arrangement[a] = this.arrangement[b];
    this.arrangement[b] = tmp;
    this.refreshPanels();
  }

  private placePick(pickIdx: number, role: Role) {
    if (!this.myShape) return;
    const slot = bestOpenSlot(FORMATIONS[this.myShape].slots, this.arrangement, role);
    if (slot >= 0) this.arrangement[slot] = pickIdx;
  }

  private refreshPanels() {
    const mine = this.draft.sides[0];
    const cpu = this.draft.sides[1];
    if (this.mode === 'draft') {
      this.myBudget.text = `BUDGET ${mine.budget.toFixed(1)}M`;
      this.cpuBudget.text = `BUDGET ${cpu.budget.toFixed(1)}M`;
    } else {
      this.myBudget.text = `PULLS LEFT ${this.size - mine.picks.length}`;
      this.cpuBudget.text = `PULLS LEFT ${this.size - cpu.picks.length}`;
    }
    const needs = needsOf(mine);
    this.myNeeds.text = `NEED GK ${needs.GK} DF ${needs.DF} MF ${needs.MF} FW ${needs.FW}`;
    const avg = (roles: Role[]) => {
      const grp = mine.picks.filter((p) => roles.includes(p.role));
      return grp.length ? String(Math.round(grp.reduce((s, p) => s + p.ovr, 0) / grp.length)) : '--';
    };
    this.myStats.text = `ATT ${avg(['FW'])}  MID ${avg(['MF'])}  DEF ${avg(['DF', 'GK'])}  OVR ${avg(['GK', 'DF', 'MF', 'FW'])}`;
    if (this.myShape) {
      this.myBoard.setShape(this.myShape);
      this.myBoard.setEntries(FORMATIONS[this.myShape].slots.map((_, i) => {
        const pi = this.arrangement[i];
        return pi !== null && pi !== undefined ? mine.picks[pi] : null;
      }));
    }
    if (this.cpuShape) {
      this.cpuBoard.setShape(this.cpuShape);
      // pad with throwaway juniors so the auto-assigner has a full XI, then
      // only the REAL signings earn cards on the board
      const padded = [...cpu.picks];
      let padNo = 90;
      while (padded.length < this.size) padded.push(academyPlayer('MF', padNo++));
      const xi = toSquad(padded, FORMATIONS[this.cpuShape]);
      const signed = new Map(cpu.picks.map((p) => [p.name, p]));
      this.cpuBoard.setEntries(xi.map((sp) => signed.get(sp.name) ?? null));
    }
  }

  // ------------------------------------------------------------ the market
  private pool(): { p: StarPlayer; poolIdx: number }[] {
    return this.draft.pool
      .map((p, poolIdx) => ({ p, poolIdx }))
      .filter(({ p }) => this.filter === 'ALL' || p.role === this.filter);
  }

  private rebuildFilters() {
    this.filterRow.removeChildren().forEach((c) => c.destroy({ children: true }));
    let x = 0;
    for (const f of FILTERS) {
      const active = f === this.filter;
      const chip = new Container();
      const label = new PixelText(this.assets, 2, active ? 0x12161f : 0x9aa2b0);
      label.text = f === 'ALL' ? 'ALL' : f;
      const g = new Graphics();
      const w = label.textWidth + 16;
      g.rect(0, 0, w, 20).fill({ color: active ? 0xffd95e : 0x161b26, alpha: active ? 0.95 : 0.85 });
      g.rect(0, 0, w, 1).fill({ color: 0xfff8e0, alpha: active ? 0.6 : 0.15 });
      label.position.set(8, 4);
      chip.addChild(g, label);
      chip.position.set(x, 0);
      chip.eventMode = 'static';
      chip.cursor = 'pointer';
      chip.on('pointertap', () => { this.filter = f; this.gridSel = 0; this.gridScroll = 0; audio.ui('move'); this.rebuildMarket(); });
      this.filterRow.addChild(chip);
      x += w + 8;
    }
  }

  private rebuildMarket(animate = false) {
    if (this.phase !== 'market' || this.mode !== 'draft') return;
    this.rebuildFilters();
    this.gridLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.reveal.clear();
    const entries = this.pool();
    const mine = this.draft.sides[0];
    const s = 2;
    const cardW = this.assets.manifest.cards.w * s;
    const cardH = this.assets.manifest.cards.h * s;
    const maxSel = entries.length - 1;
    this.gridSel = Math.max(0, Math.min(this.gridSel, maxSel));
    const selRow = Math.floor(this.gridSel / this.gridCols);
    if (selRow < this.gridScroll) this.gridScroll = selRow;
    if (selRow >= this.gridScroll + this.gridRows) this.gridScroll = selRow - this.gridRows + 1;
    const first = this.gridScroll * this.gridCols;
    const visible = entries.slice(first, first + this.gridCols * this.gridRows);
    visible.forEach(({ p, poolIdx }, vi) => {
      const i = first + vi;
      const col = vi % this.gridCols;
      const row = Math.floor(vi / this.gridCols);
      const card = new CardView(this.assets, p, s, true); // stats live ON the card
      card.position.set(col * (cardW + 14), row * (cardH + 14));
      const affordable = this.myTurn && canPick(mine, p);
      card.alpha = affordable ? 1 : 0.45;
      const holder = new Container();
      holder.addChild(card);
      if (i === this.gridSel) {
        const ring = new Graphics();
        ring.rect(-3, -3, cardW + 6, cardH + 6).stroke({ width: 2, color: 0xffe98f, alpha: 0.95 });
        holder.addChild(ring);
        ring.position.copyFrom(card.position);
      }
      holder.eventMode = 'static';
      holder.cursor = 'pointer';
      holder.hitArea = new Rectangle(card.position.x, card.position.y, cardW, cardH);
      holder.on('pointertap', () => {
        if (this.gridSel === i) return this.trySign(poolIdx);
        this.gridSel = i;
        audio.ui('move');
        this.rebuildMarket();
      });
      this.gridLayer.addChild(holder);
      if (animate) this.reveal.add(holder, vi * 0.03);
    });
    if (animate) this.reveal.play();
    // the focus card: the man under the glass
    this.focusLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    const sel = entries[this.gridSel];
    const fw = this.assets.manifest.cards.w;
    if (sel) {
      const focus = new CardView(this.assets, sel.p, 3, true);
      this.focusLayer.addChild(focus);
      const hint = new PixelText(this.assets, 2, this.myTurn && canPick(mine, sel.p) ? 0x9ff0b8 : 0x5a6070);
      hint.text = !this.myTurn ? 'CPU ON THE CLOCK' : canPick(mine, sel.p) ? 'ENTER TO SIGN' : 'OUT OF REACH';
      hint.centerAt(fw * 1.5, this.assets.manifest.cards.h * 3 + 12);
      this.focusLayer.addChild(hint);
    }
    // the academy shelf: an honest journeyman card, always in stock
    const needs = needsOf(mine);
    const role = (['GK', 'DF', 'MF', 'FW'] as Role[]).find((r) => needs[r] > 0) ?? 'MF';
    const junior = academyPlayer(role, mine.picks.length + 1);
    junior.name = 'ACADEMY';
    const juniorCard = new CardView(this.assets, junior, 2, true);
    const jy = this.assets.manifest.cards.h * 3 + 44;
    juniorCard.position.set(Math.round((fw * 3 - fw * 2) / 2), jy);
    juniorCard.alpha = this.myTurn ? 1 : 0.45;
    juniorCard.eventMode = 'static';
    juniorCard.cursor = 'pointer';
    juniorCard.on('pointertap', () => this.signAcademy());
    this.focusLayer.addChild(juniorCard);
    const jHint = new PixelText(this.assets, 2, 0x8f97a8);
    jHint.text = 'X SIGNS THE ACADEMY';
    jHint.centerAt(fw * 1.5, jy + this.assets.manifest.cards.h * 2 + 10);
    this.focusLayer.addChild(jHint);
  }

  private trySign(poolIdx: number) {
    if (this.phase !== 'market' || !this.myTurn) return;
    const mine = this.draft.sides[0];
    const p = this.draft.pool[poolIdx];
    if (!p || !canPick(mine, p)) return audio.ui('denied');
    pick(this.draft, poolIdx);
    audio.ui('buy');
    this.placePick(mine.picks.length - 1, p.role);
    this.launchFlyer(p);
    this.pickClock = PICK_TIME;
    this.advanceTurn();
  }

  private signAcademy() {
    if (this.phase !== 'market' || !this.myTurn || this.mode !== 'draft') return;
    const needs = needsOf(this.draft.sides[0]);
    const role = (['GK', 'DF', 'MF', 'FW'] as Role[]).find((r) => needs[r] > 0);
    if (!role) return audio.ui('denied');
    pickAcademy(this.draft, role);
    audio.ui('card');
    this.placePick(this.draft.sides[0].picks.length - 1, role);
    this.pickClock = PICK_TIME;
    this.advanceTurn();
  }

  // The bought man flies from the shelf onto your board
  private launchFlyer(p: StarPlayer) {
    this.flyer?.view.destroy({ children: true });
    const view = new CardView(this.assets, p, 2, false);
    view.pivot.set(this.assets.manifest.cards.w, this.assets.manifest.cards.h);
    const from = this.market.position;
    this.flyer = {
      view, t: 0,
      fx: from.x + 220, fy: from.y + 220,
      tx: this.myPanel.position.x + this.myBoard.position.x + 140,
      ty: this.myPanel.position.y + this.myBoard.position.y + this.h * 0.3,
    };
    view.position.set(this.flyer.fx, this.flyer.fy);
    this.overlay.addChild(view);
  }

  private advanceTurn() {
    this.refreshPanels();
    if (this.draft.turn >= this.draft.order.length) {
      this.finish();
      return;
    }
    this.cpuTimer = this.myTurn ? 0 : 1.1 + Math.random() * 0.8;
    this.rebuildMarket();
    this.layoutPhase();
  }

  private cpuPick() {
    const cpu = this.draft.sides[1];
    const i = aiPickIndex(this.draft);
    let signed: StarPlayer;
    if (i >= 0) {
      signed = this.draft.pool[i];
      pick(this.draft, i);
    } else {
      const needs = needsOf(cpu);
      const role = (['GK', 'DF', 'MF', 'FW'] as Role[]).find((r) => needs[r] > 0) ?? 'MF';
      pickAcademy(this.draft, role);
      signed = cpu.picks[cpu.picks.length - 1];
    }
    audio.ui('card');
    // a beat of showcase: the signing hangs center-stage
    this.cpuReveal?.view.destroy({ children: true });
    const view = new Container();
    const card = new CardView(this.assets, signed, 3, true);
    card.pivot.set(this.assets.manifest.cards.w * 1.5, 0);
    const cap = new PixelText(this.assets, 3, 0x9cc4f0);
    cap.text = 'CPU SIGNS';
    cap.centerAt(0, -34);
    view.addChild(cap, card);
    view.position.set(this.w / 2, this.h * 0.3);
    this.cpuReveal = { view, t: 1.05 };
    this.overlay.addChild(view);
    this.advanceTurn();
  }

  // -------------------------------------------------------------- the reel
  // The whole shelf shuffled onto one long strip, every man an equal ticket.
  // A flat roll decides the winner up front; the strip decelerates past the
  // needle so you WATCH the near-misses right up until it lands.
  private cellW(): number {
    return this.assets.manifest.cards.w * REEL_SCALE + REEL_GAP;
  }

  private startRoll(role: Role, forCpu: boolean) {
    if (this.roll) return; // one ride at a time — no re-rolling a bad spin
    const side = this.draft.sides[forCpu ? 1 : 0];
    const roster = this.draft.pool.map((p, poolIdx) => ({ p, poolIdx })).filter((e) => e.p.role === role);
    if (!roster.length || needsOf(side)[role] <= 0) return audio.ui('denied');
    this.killReel();
    this.revealCard?.view.destroy({ children: true });
    this.revealCard = null;
    const winner = roster[Math.floor(Math.random() * roster.length)];
    const shuffled = [...roster];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // tile the shuffle until the strip is long enough to really travel, and
    // land on the winner's LAST appearance so the ride uses the whole road
    const travel = forCpu ? 16 : 32;
    const strip: { p: StarPlayer; poolIdx: number }[] = [];
    while (strip.length < travel + shuffled.length) strip.push(...shuffled);
    let winStrip = strip.length - 1;
    for (let i = strip.length - 1; i >= 0; i--) {
      if (strip[i] === winner) { winStrip = i; break; }
    }
    const cell = this.cellW();
    strip.forEach((e, i) => {
      const card = new CardView(this.assets, e.p, REEL_SCALE, false);
      card.position.set(i * cell, 0);
      this.reelStrip.addChild(card);
    });
    this.reelStrip.y = this.reelY;
    // land a touch off-center — a machine stops where physics says, not a ruler
    const jitter = (Math.random() - 0.5) * 0.5 * (cell - REEL_GAP);
    const center = this.w / 2;
    this.roll = {
      t: 0,
      dur: forCpu ? 1.4 : 3.4,
      from: center - (cell - REEL_GAP) / 2,
      to: center - (cell - REEL_GAP) / 2 - winStrip * cell + jitter,
      strip,
      winStrip,
      forCpu,
      role,
      lastCell: -1,
    };
    if (!forCpu) audio.ui('select');
  }

  private resolveRoll() {
    const r = this.roll;
    if (!r) return;
    this.roll = null; // the strip stays frozen on the winner until the next act
    const side = this.draft.sides[r.forCpu ? 1 : 0];
    const won = r.strip[r.winStrip];
    side.picks.push(won.p);
    this.draft.pool.splice(won.poolIdx, 1);
    this.draft.turn++;
    const band = rarityOf(won.p.ovr);
    audio.ui(band === 'legend' || band === 'epic' ? 'wheel-win' : 'buy');
    if (!r.forCpu) this.placePick(side.picks.length - 1, r.role);
    // the landed card steps forward for its close-up
    this.revealCard?.view.destroy({ children: true });
    const view = new Container();
    const card = new CardView(this.assets, won.p, r.forCpu ? 2 : 3, true);
    card.pivot.set((this.assets.manifest.cards.w * (r.forCpu ? 2 : 3)) / 2, 0);
    const cap = new PixelText(this.assets, 3, r.forCpu ? 0x9cc4f0 : RARITY_TINT[band]);
    cap.text = r.forCpu ? 'CPU PULLS' : band.toUpperCase();
    cap.centerAt(0, -34);
    view.addChild(cap, card);
    view.position.set(this.w / 2, this.h * 0.12);
    this.revealCard = { view, t: r.forCpu ? 0.9 : 1.5 };
    this.overlay.addChild(view);
    this.advanceTurn();
  }

  // -------------------------------------------------------------- finishing
  private finish() {
    this.phase = 'done';
    this.clearTransients();
    fillWithAcademy(this.draft.sides[0]);
    fillWithAcademy(this.draft.sides[1]);
    const mine = this.draft.sides[0];
    // any body not yet on the board takes the best open chair
    mine.picks.forEach((p, i) => {
      if (!this.arrangement.includes(i)) this.placePick(i, p.role);
    });
    const shape = FORMATIONS[this.myShape];
    const ordered = shape.slots.map((_, si) => {
      const pi = this.arrangement[si];
      return pi !== null && pi !== undefined ? mine.picks[pi] : mine.picks.find((_, j) => !this.arrangement.includes(j))!;
    });
    this.onDone(
      toSquadOrdered(ordered, shape), this.myShape,
      toSquad(this.draft.sides[1].picks, FORMATIONS[this.cpuShape]), this.cpuShape,
    );
  }

  // ----------------------------------------------------------------- input
  key(code: string) {
    if (this.phase === 'shape') {
      const cols = STYLES.length;
      if (code === 'ArrowLeft' || code === 'KeyA') { this.styleCol = (this.styleCol + cols - 1) % cols; this.shapeRow = 0; audio.ui('move'); this.buildShapePanels(); }
      if (code === 'ArrowRight' || code === 'KeyD') { this.styleCol = (this.styleCol + 1) % cols; this.shapeRow = 0; audio.ui('move'); this.buildShapePanels(); }
      const list = formationsOf(this.size, STYLES[this.styleCol]);
      if (code === 'ArrowUp' || code === 'KeyW') { this.shapeRow = (this.shapeRow + list.length - 1) % list.length; audio.ui('move'); this.buildShapePanels(); }
      if (code === 'ArrowDown' || code === 'KeyS') { this.shapeRow = (this.shapeRow + 1) % list.length; audio.ui('move'); this.buildShapePanels(); }
      if (code === 'Enter' || code === 'Space') this.confirmShape();
      return;
    }
    if (this.phase !== 'market') return;
    if (this.mode === 'draft') {
      const entries = this.pool();
      const cols = this.gridCols;
      if (code === 'ArrowLeft' || code === 'KeyA') { this.gridSel = Math.max(0, this.gridSel - 1); audio.ui('move'); this.rebuildMarket(); }
      if (code === 'ArrowRight' || code === 'KeyD') { this.gridSel = Math.min(entries.length - 1, this.gridSel + 1); audio.ui('move'); this.rebuildMarket(); }
      if (code === 'ArrowUp' || code === 'KeyW') { this.gridSel = Math.max(0, this.gridSel - cols); audio.ui('move'); this.rebuildMarket(); }
      if (code === 'ArrowDown' || code === 'KeyS') { this.gridSel = Math.min(entries.length - 1, this.gridSel + cols); audio.ui('move'); this.rebuildMarket(); }
      if (code === 'KeyF') {
        this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
        this.gridSel = 0;
        this.gridScroll = 0;
        audio.ui('move');
        this.rebuildMarket();
      }
      if (code === 'KeyX') this.signAcademy();
      if ((code === 'Enter' || code === 'Space') && entries[this.gridSel]) this.trySign(entries[this.gridSel].poolIdx);
    } else {
      if (this.roll || !this.myTurn) return;
      const roles: Role[] = ['GK', 'DF', 'MF', 'FW'];
      if (code === 'ArrowLeft' || code === 'KeyA') { this.roleSel = (this.roleSel + 3) % 4; audio.ui('move'); this.layoutPhase(); }
      if (code === 'ArrowRight' || code === 'KeyD') { this.roleSel = (this.roleSel + 1) % 4; audio.ui('move'); this.layoutPhase(); }
      if (code === 'Enter' || code === 'Space') this.startRoll(roles[this.roleSel], false);
    }
  }

  // ----------------------------------------------------------------- phases
  private confirmShape() {
    const list = formationsOf(this.size, STYLES[this.styleCol]);
    this.myShape = list[this.shapeRow] ?? formationsOf(this.size, 'balanced')[0];
    const styles = STYLES[Math.floor(Math.random() * STYLES.length)];
    const cpuList = formationsOf(this.size, styles);
    this.cpuShape = cpuList[Math.floor(Math.random() * cpuList.length)] ?? this.myShape;
    this.arrangement = FORMATIONS[this.myShape].slots.map(() => null);
    this.phase = 'market';
    audio.ui('select');
    this.cpuTimer = this.myTurn ? 0 : 1.2;
    this.refreshPanels();
    this.rebuildMarket(true);
    this.layoutPhase();
  }

  private buildShapePanels() {
    this.shapePanels.removeChildren().forEach((c) => c.destroy({ children: true }));
    const colW = 240;
    const gap = 36;
    const totalW = colW * 3 + gap * 2;
    STYLES.forEach((style, ci) => {
      const col = new Container();
      const active = ci === this.styleCol;
      const title = new PixelText(this.assets, 3, active ? 0xffd95e : 0x8f97a8);
      title.text = style.toUpperCase();
      title.centerAt(colW / 2, 0);
      col.addChild(title);
      formationsOf(this.size, style).forEach((id, ri) => {
        const isSel = active && ri === this.shapeRow;
        const row = new PixelText(this.assets, 3, isSel ? 0xffffff : active ? 0xb8c0ce : 0x5a6070);
        row.text = isSel ? `> ${id}` : id;
        row.centerAt(colW / 2, 44 + ri * 34);
        row.eventMode = 'static';
        row.cursor = 'pointer';
        row.on('pointerover', () => {
          if (this.styleCol === ci && this.shapeRow === ri) return;
          this.styleCol = ci;
          this.shapeRow = ri;
          audio.ui('move');
          this.buildShapePanels();
        });
        row.on('pointertap', () => this.confirmShape());
        col.addChild(row);
      });
      col.position.set(this.w / 2 - totalW / 2 + ci * (colW + gap), this.h * 0.3);
      this.shapePanels.addChild(col);
    });
    // live geometry preview on your board: the slots themselves show the shape
    const previewShape = formationsOf(this.size, STYLES[this.styleCol])[this.shapeRow];
    if (previewShape) {
      this.myBoard.setShape(previewShape);
      this.myBoard.setEntries(FORMATIONS[previewShape].slots.map(() => null));
    }
  }

  // ------------------------------------------------------------------ tick
  update(dt: number) {
    this.reveal.update(dt);

    if (this.phase === 'toss') {
      this.tossT += dt;
      const t = this.tossT;
      if (t < 1.1) {
        // up she goes: a real flip — height on a parabola, faces strobing
        const k = t / 1.1;
        this.coin.position.y = this.h * 0.4 - Math.sin(k * Math.PI) * this.h * 0.18;
        const face = Math.floor(t * 14) % 4;
        this.coin.texture = this.assets.coinFrames[face === 1 || face === 3 ? 2 : face === 0 ? 0 : 1];
        this.coin.scale.set(6, face === 1 || face === 3 ? 4.4 : 6);
      } else {
        const winner = this.draft.order[0];
        this.coin.texture = this.assets.coinFrames[winner];
        this.coin.scale.set(6);
        this.coin.position.y = this.h * 0.4;
        this.caption.text = winner === 0 ? 'YOU PICK FIRST' : 'CPU PICKS FIRST';
        this.caption.centerAt(this.w / 2, this.h * 0.56);
        this.caption.visible = true;
        if (t > 2.4) {
          this.phase = 'shape';
          this.shapeClock = SHAPE_TIME;
          audio.ui('card');
          this.buildShapePanels();
          this.layoutPhase();
        }
      }
      return;
    }

    if (this.phase === 'shape') {
      this.shapeClock -= dt;
      if (this.shapeClock <= 0) this.confirmShape();
      this.drawClock(this.shapeClock / SHAPE_TIME);
      this.turnRefresh();
      return;
    }

    if (this.phase !== 'market') return;

    // showcase and flight animations ride the same clock
    if (this.cpuReveal) {
      this.cpuReveal.t -= dt;
      this.cpuReveal.view.alpha = Math.min(1, this.cpuReveal.t / 0.25);
      if (this.cpuReveal.t <= 0) {
        this.cpuReveal.view.destroy({ children: true });
        this.cpuReveal = null;
      }
    }
    if (this.revealCard) {
      this.revealCard.t -= dt;
      const flip = Math.min(1, (1.5 - this.revealCard.t) * 4);
      this.revealCard.view.scale.x = Math.abs(flip * 2 - 1); // through the thin edge
      if (this.revealCard.t < 0.3) this.revealCard.view.alpha = this.revealCard.t / 0.3;
      if (this.revealCard.t <= 0) {
        this.revealCard.view.destroy({ children: true });
        this.revealCard = null;
      }
    }
    if (this.flyer) {
      this.flyer.t += dt * 2.6;
      const k = Math.min(1, this.flyer.t);
      const e = 1 - Math.pow(1 - k, 3);
      this.flyer.view.position.set(
        Math.round(this.flyer.fx + (this.flyer.tx - this.flyer.fx) * e),
        Math.round(this.flyer.fy + (this.flyer.ty - this.flyer.fy) * e - Math.sin(e * Math.PI) * 60),
      );
      this.flyer.view.scale.set(1 - e * 0.75);
      if (k >= 1) {
        this.flyer.view.destroy({ children: true });
        this.flyer = null;
        this.refreshPanels();
      }
    }

    if (this.mode === 'gamble') {
      // the reel talks you through it: what to do, or whose hands it's in
      this.promptPulse += dt * 4;
      this.wheelPrompt.text = this.roll ? '' :
        this.myTurn ? 'PICK A SHELF - ENTER ROLLS' : 'CPU AT THE SLOTS';
      this.wheelPrompt.alpha = this.myTurn && !this.roll ? 0.7 + 0.3 * Math.sin(this.promptPulse) : 0.7;
      this.wheelPrompt.centerAt(this.w / 2, this.reelY - 36);
    }
    if (this.mode === 'gamble' && this.roll) {
      const r = this.roll;
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      // quartic tail: a screaming start and a long agonizing crawl to the line
      const e = 1 - Math.pow(1 - k, 4);
      this.reelStrip.x = Math.round(r.from + (r.to - r.from) * e);
      const cellNow = Math.floor((this.w / 2 - this.reelStrip.x) / this.cellW());
      if (cellNow !== r.lastCell) {
        r.lastCell = cellNow;
        audio.ui('wheel-tick');
      }
      if (k >= 1) this.resolveRoll();
      return;
    }

    if (this.myTurn) {
      if (this.mode === 'draft') {
        this.pickClock -= dt;
        if (this.pickClock < 5.2 && Math.floor(this.pickClock * 2) !== Math.floor((this.pickClock + dt) * 2)) {
          audio.play('ui-wheel-tick', { vol: 0.7 });
        }
        if (this.pickClock <= 0) {
          // the clock signs for you — best value on the shelf
          const i = aiPickIndex(this.draft);
          if (i >= 0) {
            const p = this.draft.pool[i];
            pick(this.draft, i);
            this.placePick(this.draft.sides[0].picks.length - 1, p.role);
            audio.ui('card');
          } else {
            this.signAcademy();
            return;
          }
          this.pickClock = PICK_TIME;
          this.advanceTurn();
        }
        this.drawClock(this.pickClock / PICK_TIME);
      }
    } else if (!this.cpuReveal && !this.revealCard) {
      this.cpuTimer -= dt;
      if (this.cpuTimer <= 0) {
        if (this.mode === 'draft') this.cpuPick();
        else {
          const needs = needsOf(this.draft.sides[1]);
          const wants = (['FW', 'MF', 'DF', 'GK'] as Role[]).filter((r) => needs[r] > 0);
          const role = wants[Math.floor(Math.random() * wants.length)];
          if (role) this.startRoll(role, true);
        }
      }
    }
    this.turnRefresh();
  }

  private turnRefresh() {
    const pickNo = Math.min(this.draft.turn + 1, this.draft.order.length);
    this.turnText.text = this.phase === 'shape'
      ? 'CALL YOUR SHAPE'
      : this.myTurn ? `PICK ${pickNo} OF ${this.draft.order.length} - YOUR CALL` : `PICK ${pickNo} OF ${this.draft.order.length} - CPU THINKING`;
    this.turnText.centerAt(this.w / 2, 58);
  }

  private drawClock(frac: number) {
    const w = 220;
    const g = this.clockBar;
    g.clear();
    const x = Math.round(this.w / 2 - w / 2);
    g.rect(x, 88, w, 8).fill({ color: 0x10141c, alpha: 0.8 });
    g.rect(x, 88, w, 1).fill({ color: 0xfff8e0, alpha: 0.2 });
    const fill = Math.max(0, Math.round((w - 2) * frac));
    const color = frac < 0.2 ? 0xff5340 : frac < 0.5 ? 0xffd95e : 0x9ff0b8;
    if (fill > 0) g.rect(x + 1, 89, fill, 6).fill({ color, alpha: 0.95 });
  }

  // --------------------------------------------------------------- layout
  private layoutPhase() {
    const market = this.phase === 'market' && this.mode === 'draft';
    this.market.visible = market;
    this.shapePanels.visible = this.phase === 'shape';
    this.coin.visible = this.phase === 'toss';
    this.caption.visible = this.phase === 'toss' && this.tossT >= 1.1;
    const reelOn = this.phase === 'market' && this.mode === 'gamble';
    this.reelBack.visible = reelOn;
    this.reelFront.visible = reelOn;
    this.reelStrip.visible = reelOn;
    this.wheelPrompt.visible = reelOn;
    if (!reelOn && this.reelStrip.children.length) this.killReel();
    this.turnText.visible = this.phase !== 'toss';
    this.myPanel.visible = this.phase !== 'toss';
    this.cpuPanel.visible = this.phase === 'market';
    this.clockBar.visible = this.phase === 'shape' || (this.phase === 'market' && this.mode === 'draft' && this.myTurn);
    if (reelOn) {
      this.buildRoleButtons();
    } else {
      this.roleButtons?.destroy({ children: true });
      this.roleButtons = null;
    }
  }

  // The slot window: dark band the strip rides through, gold rails, a needle
  // top and bottom marking the line of truth, stepped shade at both edges
  private drawReelChrome() {
    const ch = this.assets.manifest.cards.h * REEL_SCALE;
    const x = this.reelX;
    const y = this.reelY;
    const w = this.reelW;
    const back = this.reelBack;
    back.clear();
    back.rect(x, y - 10, w, ch + 20).fill({ color: 0x0a0e14, alpha: 0.88 });
    back.rect(x, y - 10, w, 2).fill({ color: 0xfff8e0, alpha: 0.14 });
    back.rect(x, y + ch + 8, w, 2).fill({ color: 0x000000, alpha: 0.5 });
    const front = this.reelFront;
    front.clear();
    // gold rails
    front.rect(x, y - 6, w, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    front.rect(x, y + ch + 4, w, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    // corner studs
    for (const sx of [x, x + w - 3]) {
      front.rect(sx, y - 10, 3, 3).fill({ color: 0xffd95e, alpha: 0.8 });
      front.rect(sx, y + ch + 7, 3, 3).fill({ color: 0xffd95e, alpha: 0.8 });
    }
    // the needle: stacked pixel chevrons above and below the center line
    const cx = Math.round(this.w / 2);
    for (let i = 0; i < 4; i++) {
      const half = 5 - i;
      front.rect(cx - half, y - 10 + i * 2, half * 2, 2).fill({ color: 0xfff3c4, alpha: 0.95 });
      front.rect(cx - half, y + ch + 8 - i * 2, half * 2, 2).fill({ color: 0xfff3c4, alpha: 0.95 });
    }
    // stepped edge shade so the strip fades into the machine
    for (let i = 0; i < 3; i++) {
      const sw = 30 - i * 9;
      const alpha = 0.55 - i * 0.16;
      front.rect(x, y - 8, sw, ch + 16).fill({ color: 0x0a0e14, alpha });
      front.rect(x + w - sw, y - 8, sw, ch + 16).fill({ color: 0x0a0e14, alpha });
    }
    this.reelMaskG.clear();
    this.reelMaskG.rect(x, y - 8, w, ch + 16).fill(0xffffff);
  }

  private roleButtons: Container | null = null;
  private buildRoleButtons() {
    this.roleButtons?.destroy({ children: true });
    const wrap = new Container();
    const roles: Role[] = ['GK', 'DF', 'MF', 'FW'];
    const needs = needsOf(this.draft.sides[0]);
    // a filled shelf hands the selector to the next open role
    if (needs[roles[this.roleSel]] <= 0) {
      const open = roles.findIndex((r) => needs[r] > 0);
      if (open >= 0) this.roleSel = open;
    }
    const BW = 108;
    const BH = 62;
    const GAP = 18;
    roles.forEach((r, i) => {
      const active = i === this.roleSel;
      const open = needs[r] > 0;
      const b = new Container();
      const g = new Graphics();
      // a shelf slot you can't miss: framed, lit when chosen, stamped shut when full
      g.rect(0, 0, BW, BH).fill({ color: active && open ? 0x2a2410 : 0x11151f, alpha: open ? 0.94 : 0.5 });
      g.rect(0, 0, BW, 2).fill({ color: active && open ? 0xffd95e : 0xfff8e0, alpha: active && open ? 0.95 : 0.16 });
      g.rect(0, BH - 2, BW, 2).fill({ color: 0x000000, alpha: 0.4 });
      if (active && open) {
        g.rect(0, 0, 2, BH).fill({ color: 0xffd95e, alpha: 0.8 });
        g.rect(BW - 2, 0, 2, BH).fill({ color: 0xffd95e, alpha: 0.8 });
      }
      const label = new PixelText(this.assets, 3, open ? ROLE_TINT[r] : 0x4a5160);
      label.text = r;
      label.centerAt(BW / 2, 10);
      const count = new PixelText(this.assets, 2, open ? (active ? 0xffe98f : 0x9aa2b0) : 0x4a5160);
      count.text = open ? `${needs[r]} OPEN` : 'FULL';
      count.centerAt(BW / 2, 38);
      b.addChild(g, label, count);
      b.position.set(i * (BW + GAP), 0);
      b.eventMode = 'static';
      b.cursor = 'pointer';
      b.on('pointertap', () => {
        this.roleSel = i;
        if (open) this.startRoll(r, false);
        else audio.ui('denied');
      });
      wrap.addChild(b);
    });
    const ch = this.assets.manifest.cards.h * REEL_SCALE;
    wrap.position.set(Math.round(this.w / 2 - (4 * BW + 3 * GAP) / 2), Math.round(this.reelY + ch + 42));
    this.roleButtons = wrap;
    this.root.addChild(wrap);
  }

  layout(w: number, h: number) {
    this.w = w;
    this.h = h;
    centerShade(this.shade, w, h, Math.min(1400, w - 80));
    this.header.centerAt(w / 2, 18);
    this.foot.centerAt(w / 2, h - 40);
    this.coin.position.set(w / 2, h * 0.4);
    // The two dugouts: full-height team boards flanking the whole screen
    const boardW = Math.max(264, Math.min(400, Math.round(w * 0.2)));
    const boardTop = 56;
    const boardH = h - 120 - boardTop - 52;
    this.myPanel.position.set(16, 100);
    this.cpuPanel.position.set(w - 16 - boardW, 100);
    this.myTitle.position.set(0, 0);
    this.myBudget.position.set(0, 28);
    this.myBoard.position.set(0, boardTop);
    this.myBoard.resize(boardW, boardH);
    this.myStats.position.set(0, boardTop + boardH + 10);
    this.myNeeds.position.set(0, boardTop + boardH + 32);
    this.cpuTitle.position.set(0, 0);
    this.cpuBudget.position.set(0, 28);
    this.cpuBoard.position.set(0, boardTop);
    this.cpuBoard.resize(boardW, boardH);
    // the slot machine spans the gap between the dugouts
    this.reelX = 16 + boardW + 24;
    this.reelW = w - this.reelX * 2;
    this.reelY = Math.round(h * 0.3);
    this.reelStrip.y = this.reelY;
    this.drawReelChrome();
    // the market between the two dugouts
    const s = 2;
    const cardW = this.assets.manifest.cards.w * s;
    const cardH = this.assets.manifest.cards.h * s;
    const focusW = this.assets.manifest.cards.w * 3;
    const zoneX = 16 + boardW + 28;
    const zoneW = w - zoneX * 2 + 16;
    this.gridCols = Math.max(2, Math.min(4, Math.floor((zoneW - focusW - 56) / (cardW + 14))));
    this.gridRows = Math.max(1, Math.floor((h - 132 - 110) / (cardH + 14)));
    const gridW = this.gridCols * (cardW + 14) - 14;
    const marketX = zoneX + Math.max(0, Math.round((zoneW - (gridW + 44 + focusW)) / 2));
    this.market.position.set(marketX, 132);
    this.filterRow.position.set(0, 0);
    this.gridLayer.position.set(0, 36);
    this.focusLayer.position.set(gridW + 44, 36);
    if (this.phase === 'shape') this.buildShapePanels();
    if (this.phase === 'market' && this.mode === 'draft') this.rebuildMarket();
    this.layoutPhase();
    this.turnRefresh();
  }
}
