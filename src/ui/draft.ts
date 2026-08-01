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
const WEDGES = ['common', 'rare', 'common', 'epic', 'common', 'rare', 'common', 'legend'];

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

// -------------------------------------------------------------- mini pitch
// The FotMob chalkboard: your shape as chips on a dark board. Chips drag —
// drop one on a teammate to swap their jobs, mid-draft, any time.
interface ChipData {
  name: string;
  ovr: number;
  role: Role;
}

class MiniPitch extends Container {
  onSwap: (a: number, b: number) => void = () => {};
  private board = new Graphics();
  private chipLayer = new Container();
  private slots: { x: number; y: number; role: Role }[] = [];
  private dragging: { chip: Container; slot: number } | null = null;
  private readonly W = 264;
  private readonly H = 172;

  constructor(private assets: GameAssets, private draggable: boolean, private mirror: boolean) {
    super();
    this.addChild(this.board, this.chipLayer);
    this.drawBoard();
    this.eventMode = 'static';
    this.hitArea = new Rectangle(0, 0, this.W, this.H);
    this.on('pointermove', (e) => {
      if (!this.dragging) return;
      const local = this.toLocal(e.global);
      this.dragging.chip.position.set(local.x, local.y);
    });
    const drop = (e: { global: { x: number; y: number } }) => {
      if (!this.dragging) return;
      const local = this.toLocal(e.global);
      let best = this.dragging.slot;
      let bestD = Infinity;
      this.slots.forEach((s, i) => {
        const d = Math.hypot(s.x - local.x, s.y - local.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      const from = this.dragging.slot;
      this.dragging = null;
      if (best !== from) {
        audio.ui('card');
        this.onSwap(from, best);
      } else {
        this.refreshPositions();
      }
    };
    this.on('pointerup', drop);
    this.on('pointerupoutside', drop);
  }

  private drawBoard() {
    const g = this.board;
    const { W, H } = this;
    g.clear();
    g.rect(0, 0, W, H).fill({ color: 0x0c2013, alpha: 0.94 });
    g.rect(0, 0, W, 1).fill({ color: 0xfff8e0, alpha: 0.18 });
    g.rect(0, H - 1, W, 1).fill({ color: 0x000000, alpha: 0.4 });
    const chalk = { width: 1, color: 0xdfe8da, alpha: 0.3 };
    g.rect(6, 6, W - 12, H - 12).stroke(chalk);
    g.moveTo(W / 2, 6).lineTo(W / 2, H - 6).stroke(chalk);
    g.circle(W / 2, H / 2, 18).stroke(chalk);
    for (const bx of [6, W - 40]) g.rect(bx, H / 2 - 34, 34, 68).stroke(chalk);
  }

  setShape(shapeId: string) {
    const shape = FORMATIONS[shapeId];
    this.slots = shape.slots.map((s) => ({
      x: 14 + (this.mirror ? 1 - s.x : s.x) * (this.W - 28),
      y: 12 + s.y * (this.H - 24),
      role: s.role,
    }));
  }

  // entries align to slots; null = an empty chair
  setChips(entries: (ChipData | null)[]) {
    this.chipLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.slots.forEach((slot, i) => {
      const chip = new Container();
      const entry = entries[i] ?? null;
      const g = new Graphics();
      if (entry) {
        const tint = RARITY_TINT[rarityOf(entry.ovr)];
        g.circle(0, 0, 8).fill({ color: 0x141a24, alpha: 0.95 }).stroke({ width: 1.5, color: tint, alpha: 0.95 });
        const ovr = new PixelText(this.assets, 1, 0xffffff, 'micro');
        ovr.text = String(entry.ovr);
        ovr.centerAt(0, -2);
        const name = new PixelText(this.assets, 1, 0xcfd6e2, 'micro');
        name.text = entry.name.length > 9 ? entry.name.slice(0, 9) : entry.name;
        name.centerAt(0, 10);
        chip.addChild(g, ovr, name);
      } else {
        g.circle(0, 0, 7).stroke({ width: 1, color: ROLE_TINT[slot.role], alpha: 0.4 });
        const role = new PixelText(this.assets, 1, ROLE_TINT[slot.role], 'micro');
        role.text = slot.role;
        role.centerAt(0, -2);
        role.alpha = 0.55;
        chip.addChild(g, role);
      }
      chip.position.set(slot.x, slot.y);
      if (this.draggable && entry) {
        chip.eventMode = 'static';
        chip.cursor = 'grab';
        chip.hitArea = new Rectangle(-10, -10, 20, 26);
        chip.on('pointerdown', () => {
          this.dragging = { chip, slot: i };
          this.chipLayer.setChildIndex(chip, this.chipLayer.children.length - 1);
          audio.ui('move');
        });
      }
      this.chipLayer.addChild(chip);
    });
  }

  private refreshPositions() {
    this.chipLayer.children.forEach((chip, i) => {
      const slot = this.slots[i];
      if (slot) chip.position.set(slot.x, slot.y);
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

  // gamble
  private wheel: Sprite;
  private wheelPtr: Sprite;
  private spin: { t: number; dur: number; from: number; to: number; rarity: string; forCpu: boolean } | null = null;
  private lastTickWedge = 0;
  private gambleRole: Role | null = null;
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
  private myPitch: MiniPitch;
  private cpuPitch: MiniPitch;
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
    this.wheel = new Sprite(assets.wheel);
    this.wheel.anchor.set(0.5);
    this.wheel.scale.set(2);
    this.wheelPtr = new Sprite(assets.wheelPointer);
    this.wheelPtr.anchor.set(0.5, 0);
    this.wheelPtr.scale.set(2);
    this.myTitle = new PixelText(assets, 3, 0xff9c8a);
    this.myTitle.text = 'YOUR SQUAD';
    this.cpuTitle = new PixelText(assets, 3, 0x9cc4f0);
    this.cpuTitle.text = 'CPU SQUAD';
    this.myBudget = new PixelText(assets, 2, 0x9ff0b8);
    this.cpuBudget = new PixelText(assets, 2, 0x8f97a8);
    this.myStats = new PixelText(assets, 2, 0x8f97a8);
    this.myNeeds = new PixelText(assets, 2, 0x8f97a8);
    this.myPitch = new MiniPitch(assets, true, false);
    this.myPitch.onSwap = (a, b) => this.swapSlots(a, b);
    this.cpuPitch = new MiniPitch(assets, false, true);
    this.myPanel.addChild(this.myTitle, this.myBudget, this.myPitch, this.myStats, this.myNeeds);
    this.cpuPanel.addChild(this.cpuTitle, this.cpuBudget, this.cpuPitch);
    this.market.addChild(this.filterRow, this.gridLayer, this.focusLayer);
    this.root.addChild(
      this.shade, this.header, this.turnText, this.clockBar, this.myPanel, this.cpuPanel,
      this.market, this.shapePanels, this.coin, this.caption, this.wheel, this.wheelPtr, this.overlay, this.foot,
    );
  }

  // ------------------------------------------------------------- lifecycle
  begin(size: number, mode: 'draft' | 'gamble') {
    this.mode = mode;
    this.size = size;
    this.draft = createDraft(Math.random() < 0.5 ? 0 : 1, size);
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
    this.arrangement = [];
    this.cpuReveal = null;
    this.flyer = null;
    this.spin = null;
    this.revealCard = null;
    this.gambleRole = null;
    this.header.text = mode === 'draft' ? 'THE DRAFT' : 'THE WHEEL';
    this.foot.text = mode === 'draft'
      ? 'WASD MOVE - ENTER SIGN - F FILTER - X ACADEMY - DRAG CHIPS TO REARRANGE'
      : 'A D PICK A ROLE - ENTER SPIN - DRAG CHIPS TO REARRANGE';
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
      this.myPitch.setShape(this.myShape);
      this.myPitch.setChips(FORMATIONS[this.myShape].slots.map((_, i) => {
        const pi = this.arrangement[i];
        const p = pi !== null && pi !== undefined ? mine.picks[pi] : null;
        return p ? { name: p.name, ovr: p.ovr, role: p.role } : null;
      }));
    }
    if (this.cpuShape) {
      this.cpuPitch.setShape(this.cpuShape);
      // pad with throwaway juniors so the auto-assigner has a full XI, then
      // only the REAL signings earn chips on the board
      const padded = [...cpu.picks];
      let padNo = 90;
      while (padded.length < this.size) padded.push(academyPlayer('MF', padNo++));
      const xi = toSquad(padded, FORMATIONS[this.cpuShape]);
      const signed = new Map(cpu.picks.map((p) => [p.name, p.ovr]));
      this.cpuPitch.setChips(FORMATIONS[this.cpuShape].slots.map((slot, i) =>
        signed.has(xi[i].name)
          ? { name: xi[i].name, ovr: signed.get(xi[i].name)!, role: slot.role }
          : null));
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
      const card = new CardView(this.assets, p, s, false);
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
    if (sel) {
      const focus = new CardView(this.assets, sel.p, 3, true);
      this.focusLayer.addChild(focus);
      const hint = new PixelText(this.assets, 2, this.myTurn && canPick(mine, sel.p) ? 0x9ff0b8 : 0x5a6070);
      hint.text = !this.myTurn ? 'CPU ON THE CLOCK' : canPick(mine, sel.p) ? 'ENTER TO SIGN' : 'OUT OF REACH';
      hint.centerAt(this.assets.manifest.cards.w * 1.5, this.assets.manifest.cards.h * 3 + 12);
      this.focusLayer.addChild(hint);
    }
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

  // The bought man flies from the shelf to your board
  private launchFlyer(p: StarPlayer) {
    this.flyer?.view.destroy({ children: true });
    const view = new CardView(this.assets, p, 2, false);
    view.pivot.set(this.assets.manifest.cards.w, this.assets.manifest.cards.h);
    const from = this.market.position;
    this.flyer = {
      view, t: 0,
      fx: from.x + 200, fy: from.y + 200,
      tx: this.myPanel.position.x + 150, ty: this.myPanel.position.y + 140,
    };
    view.position.set(this.flyer.fx, this.flyer.fy);
    this.root.addChild(view);
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
    const card = new CardView(this.assets, signed, 3, false);
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

  // ------------------------------------------------------------- the wheel
  private startSpin(role: Role, forCpu: boolean) {
    const side = this.draft.sides[forCpu ? 1 : 0];
    const roster = this.draft.pool.filter((p) => p.role === role);
    if (!roster.length || needsOf(side)[role] <= 0) return audio.ui('denied');
    // the odds — degraded gracefully when a shelf runs bare
    const wants = Math.random();
    let rarity = wants < 0.06 ? 'legend' : wants < 0.22 ? 'epic' : wants < 0.52 ? 'rare' : 'common';
    const has = (r: string) => roster.some((p) => rarityOf(p.ovr) === r);
    const ladder = ['legend', 'epic', 'rare', 'common'];
    while (!has(rarity)) {
      const next = ladder.indexOf(rarity) + 1;
      if (next >= ladder.length) { rarity = ladder.find(has) ?? 'common'; break; }
      rarity = ladder[next];
    }
    // pick the wedge of that rarity the pointer should stop under
    const options = WEDGES.map((r, i) => ({ r, i })).filter((w) => w.r === rarity);
    const wedge = options[Math.floor(Math.random() * options.length)].i;
    const center = ((wedge + 0.5) / 8) * Math.PI * 2 - Math.PI; // texture-space angle
    const target = -Math.PI / 2 - center; // pointer sits at 12 o'clock
    const spins = forCpu ? 2 : 4;
    this.gambleRole = role;
    this.spin = {
      t: 0,
      dur: forCpu ? 1.0 : 2.3,
      from: this.wheel.rotation % (Math.PI * 2),
      to: target + spins * Math.PI * 2,
      rarity,
      forCpu,
    };
    this.lastTickWedge = -1;
    if (!forCpu) audio.ui('select');
  }

  private resolveSpin() {
    if (!this.spin) return;
    const { rarity, forCpu } = this.spin;
    this.spin = null;
    const role = this.gambleRole!;
    const side = this.draft.sides[forCpu ? 1 : 0];
    const options = this.draft.pool
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.role === role && rarityOf(p.ovr) === rarity);
    const won = options[Math.floor(Math.random() * options.length)];
    side.picks.push(won.p);
    this.draft.pool.splice(won.i, 1);
    this.draft.turn++;
    audio.ui(rarity === 'legend' || rarity === 'epic' ? 'wheel-win' : 'buy');
    if (!forCpu) this.placePick(side.picks.length - 1, role);
    // the reveal: his card blooms center-stage
    this.revealCard?.view.destroy({ children: true });
    const view = new Container();
    const card = new CardView(this.assets, won.p, forCpu ? 2 : 3, !forCpu);
    card.pivot.set((this.assets.manifest.cards.w * (forCpu ? 2 : 3)) / 2, 0);
    const cap = new PixelText(this.assets, 3, forCpu ? 0x9cc4f0 : RARITY_TINT[rarity]);
    cap.text = forCpu ? 'CPU PULLS' : rarity.toUpperCase();
    cap.centerAt(0, -34);
    view.addChild(cap, card);
    view.position.set(this.w / 2, this.h * 0.26);
    this.revealCard = { view, t: forCpu ? 0.9 : 1.5 };
    this.overlay.addChild(view);
    this.gambleRole = null;
    this.advanceTurn();
  }

  // -------------------------------------------------------------- finishing
  private finish() {
    this.phase = 'done';
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
      if (this.spin || !this.myTurn) return;
      const roles: Role[] = ['GK', 'DF', 'MF', 'FW'];
      if (code === 'ArrowLeft' || code === 'KeyA') { this.roleSel = (this.roleSel + 3) % 4; audio.ui('move'); this.layoutPhase(); }
      if (code === 'ArrowRight' || code === 'KeyD') { this.roleSel = (this.roleSel + 1) % 4; audio.ui('move'); this.layoutPhase(); }
      if (code === 'Enter' || code === 'Space') this.startSpin(roles[this.roleSel], false);
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
    // live geometry preview on your board
    const previewShape = formationsOf(this.size, STYLES[this.styleCol])[this.shapeRow];
    if (previewShape) {
      this.myPitch.setShape(previewShape);
      this.myPitch.setChips(FORMATIONS[previewShape].slots.map(() => null));
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

    if (this.mode === 'gamble' && this.spin) {
      this.spin.t += dt;
      const k = Math.min(1, this.spin.t / this.spin.dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.wheel.rotation = this.spin.from + (this.spin.to - this.spin.from) * e;
      const wedgeNow = Math.floor(((this.wheel.rotation % (Math.PI * 2)) / (Math.PI * 2)) * 8);
      if (wedgeNow !== this.lastTickWedge) {
        this.lastTickWedge = wedgeNow;
        audio.ui('wheel-tick');
      }
      if (k >= 1) this.resolveSpin();
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
          if (role) this.startSpin(role, true);
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
    const wheelOn = this.phase === 'market' && this.mode === 'gamble';
    this.wheel.visible = wheelOn;
    this.wheelPtr.visible = wheelOn;
    this.turnText.visible = this.phase !== 'toss';
    this.myPanel.visible = this.phase !== 'toss';
    this.cpuPanel.visible = this.phase === 'market';
    this.clockBar.visible = this.phase === 'shape' || (this.phase === 'market' && this.mode === 'draft' && this.myTurn);
    if (wheelOn) this.buildRoleButtons();
    else this.roleButtons?.destroy({ children: true });
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
    roles.forEach((r, i) => {
      const active = i === this.roleSel;
      const open = needs[r] > 0;
      const b = new Container();
      const g = new Graphics();
      g.rect(0, 0, 74, 30).fill({ color: active ? 0xffd95e : 0x161b26, alpha: open ? 0.92 : 0.4 });
      g.rect(0, 0, 74, 1).fill({ color: 0xfff8e0, alpha: 0.3 });
      const label = new PixelText(this.assets, 2, active ? 0x12161f : open ? ROLE_TINT[r] : 0x5a6070);
      label.text = `${r} ${needs[r]}`;
      label.centerAt(37, 8);
      b.addChild(g, label);
      b.position.set(i * 84, 0);
      b.eventMode = 'static';
      b.cursor = 'pointer';
      b.on('pointertap', () => {
        this.roleSel = i;
        if (open) this.startSpin(r, false);
        else audio.ui('denied');
      });
      wrap.addChild(b);
    });
    wrap.position.set(Math.round(this.w / 2 - (84 * 4 - 10) / 2), Math.round(this.h * 0.68));
    this.roleButtons = wrap;
    this.root.addChild(wrap);
  }

  layout(w: number, h: number) {
    this.w = w;
    this.h = h;
    centerShade(this.shade, w, h, Math.min(1240, w - 120));
    this.header.centerAt(w / 2, 18);
    this.foot.centerAt(w / 2, h - 40);
    this.coin.position.set(w / 2, h * 0.4);
    this.wheel.position.set(w / 2, h * 0.42);
    this.wheelPtr.position.set(w / 2, h * 0.42 - this.wheel.height / 2 - 6);
    const panelW = 300;
    this.myPanel.position.set(Math.round(w * 0.02), 120);
    this.cpuPanel.position.set(Math.round(w * 0.98 - panelW), 120);
    this.myTitle.position.set(0, 0);
    this.myBudget.position.set(0, 34);
    this.myPitch.position.set(0, 58);
    this.myStats.position.set(0, 244);
    this.myNeeds.position.set(0, 268);
    this.cpuTitle.position.set(panelW - 264, 0);
    this.cpuBudget.position.set(panelW - 264, 34);
    this.cpuPitch.position.set(panelW - 264, 58);
    // the market between the two dugouts
    const s = 2;
    const cardW = this.assets.manifest.cards.w * s;
    const cardH = this.assets.manifest.cards.h * s;
    const focusW = this.assets.manifest.cards.w * 3;
    const innerW = w - (panelW + 40) * 2;
    this.gridCols = Math.max(2, Math.min(4, Math.floor((innerW - focusW - 60) / (cardW + 14))));
    this.gridRows = Math.max(1, Math.floor((h - 130 - 150) / (cardH + 14)));
    const gridW = this.gridCols * (cardW + 14) - 14;
    const marketX = Math.round(w / 2 - (gridW + 40 + focusW) / 2);
    this.market.position.set(marketX, 126);
    this.filterRow.position.set(0, 0);
    this.gridLayer.position.set(0, 34);
    this.focusLayer.position.set(gridW + 40, 34);
    if (this.phase === 'shape') this.buildShapePanels();
    if (this.phase === 'market' && this.mode === 'draft') this.rebuildMarket();
    this.layoutPhase();
    this.turnRefresh();
  }
}
