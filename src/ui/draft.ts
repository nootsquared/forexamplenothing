import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';
import { Rng } from '../core/rng';
import { Reveal, centerShade } from './kit';
import { Screen } from './screens';
import { StarPlayer, rarityOf, academyPlayer } from '../data/players';
import { FORMATIONS, Role, STYLES, formationsOf } from '../data/formations';
import { SquadPlayer } from '../data/roster';
import { DraftCtl, DraftIntent, DraftOp } from '../net/net';
import {
  Draft, createDraft, canPick, pick, pickAcademy, aiPickIndex, needsOf, quotaOfShape,
  fillWithAcademy, toSquadOrdered, bestOpenSlot,
} from '../data/draft';

// The war room: coin toss → shape call → the market. FIFA-grade cards on the
// shelf, your XI on a drag-anywhere chalkboard, the other bench building
// against you in real time. Gamble mode swaps the market for the slot reel.
//
// Online, the room is OP-DRIVEN: the host is the only referee — every turn
// (his own, a guest captain's intent, a CPU pick) becomes an op he applies
// and broadcasts, and every guest replays the same ops on an identical
// replica. Captains act, everyone else watches the same boards fill.

const RARITY_TINT: Record<string, number> = { legend: 0xffe27a, epic: 0xd9a6ff, rare: 0x9cc4f0, common: 0xc4ccd8 };
const ROLE_TINT: Record<Role, number> = { GK: 0xf0c552, DF: 0x8ecff0, MF: 0x9ff0b8, FW: 0xff9c8a };
const FILTERS: (Role | 'ALL')[] = ['ALL', 'GK', 'DF', 'MF', 'FW'];
const ROLES: Role[] = ['GK', 'DF', 'MF', 'FW'];
const SHAPE_TIME = 15;
const PICK_TIME = 30;
const REMOTE_TIME = 35;  // an absent captain's clock — the room never stalls
const REEL_SCALE = 2;    // slot cards ride big
const REEL_GAP = 10;     // air between cards on the strip

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

// Everything one sitting of the war room needs to know about who's playing it
interface WarRoomSetup {
  mode: 'draft' | 'gamble';
  size: number;
  first: 0 | 1;
  ctl: [DraftCtl, DraftCtl];
  teamNames: [string, string];
  capNames: [string, string];
  mySide: 0 | 1;
  iAmCaptain: boolean;
  authority: boolean;
  sendOp: ((op: DraftOp) => void) | null;
  sendIntent: ((a: DraftIntent) => void) | null;
}

export class SquadBuilderScreen implements Screen {
  root = new Container();
  onDone: (home: SquadPlayer[], homeShape: string, away: SquadPlayer[], awayShape: string) => void = () => {};
  onBack: () => void = () => {}; // Esc and the BACK plate share one exit

  private mode: 'draft' | 'gamble' = 'draft';
  private size = 11;
  private draft!: Draft;
  private phase: Phase = 'toss';
  private w = 1280;
  private h = 720;

  // who's who: my view side, the controllers, and whether I referee or mirror
  private mySide: 0 | 1 = 0;
  private iAmCaptain = true;
  private authority = true;
  private ctl: [DraftCtl, DraftCtl] = [{ kind: 'local' }, { kind: 'cpu' }];
  private teamNames: [string, string] = ['YOUR SQUAD', 'CPU SQUAD'];
  private capNames: [string, string] = ['YOU', 'CPU'];
  private sendOp: ((op: DraftOp) => void) | null = null;
  private sendIntent: ((a: DraftIntent) => void) | null = null;
  private opQueue: DraftOp[] = []; // mirror ops parked behind a live reel

  // toss
  private tossT = 0;
  private coin: Sprite;
  private caption: PixelText;

  // shape call
  private shapeClock = SHAPE_TIME;
  private styleCol = 1; // start on BALANCED
  private shapeRow = 0;
  private shapes: [string, string] = ['', ''];
  private shapePanels = new Container();

  // market
  private pickClock = PICK_TIME;
  private cpuTimer = 0;
  private remoteClock = REMOTE_TIME;
  private doneT = 0; // boards full: the last reveal's beat before finish()
  private filter: Role | 'ALL' = 'ALL';
  private gridSel = 0;
  private gridScroll = 0;
  private gridCols = 4;
  private gridRows = 2;
  private arrangements: [(number | null)[], (number | null)[]] = [[], []]; // per side: slot → pick index
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
    side: 0 | 1; role: Role; lastCell: number;
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
  private backBtn = new Container();
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
    this.cpuTitle = new PixelText(assets, 3, 0x9cc4f0);
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
    this.buildBackBtn();
    this.root.addChild(
      this.shade, this.header, this.turnText, this.clockBar, this.myPanel, this.cpuPanel,
      this.market, this.shapePanels, this.coin, this.caption,
      this.reelBack, this.reelStrip, this.reelMaskG, this.reelFront, this.wheelPrompt, this.overlay,
      this.backBtn, this.foot,
    );
  }

  // The one visible exit — Esc rides the same door
  private buildBackBtn() {
    const label = new PixelText(this.assets, 2, 0xdfe4ee);
    label.text = '< BACK';
    const w = label.textWidth + 22;
    const h = 26;
    const g = new Graphics();
    g.rect(0, 0, w, h).fill({ color: 0x05070b, alpha: 0.95 });
    g.rect(1, 1, w - 2, h - 2).fill({ color: 0x1b2231 });
    g.rect(1, 1, w - 2, 2).fill({ color: 0xfff8e0, alpha: 0.2 });
    g.rect(1, h - 3, w - 2, 2).fill({ color: 0x000000, alpha: 0.5 });
    label.position.set(11, 6);
    this.backBtn.addChild(g, label);
    this.backBtn.eventMode = 'static';
    this.backBtn.cursor = 'pointer';
    this.backBtn.hitArea = new Rectangle(0, 0, w, h);
    this.backBtn.on('pointerover', () => { label.tint = 0xffd95e; });
    this.backBtn.on('pointerout', () => { label.tint = 0xdfe4ee; });
    this.backBtn.on('pointertap', () => this.onBack());
    this.backBtn.position.set(16, 14);
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
  // The couch game, exactly as it always was: you against the CPU bench
  begin(size: number, mode: 'draft' | 'gamble') {
    this.configure({
      mode, size, first: Math.random() < 0.5 ? 0 : 1,
      ctl: [{ kind: 'local' }, { kind: 'cpu' }],
      teamNames: ['YOUR SQUAD', 'CPU SQUAD'], capNames: ['YOU', 'CPU'],
      mySide: 0, iAmCaptain: true, authority: true, sendOp: null, sendIntent: null,
    });
  }

  // The host opens the room's war room and deals everyone in
  beginOnlineHost(opts: {
    mode: 'draft' | 'gamble'; first: 0 | 1; ctl: [DraftCtl, DraftCtl];
    teamNames: [string, string]; capNames: [string, string];
    seatSides: Record<number, 0 | 1>; sendOp: (op: DraftOp) => void;
  }) {
    const localSide = opts.ctl.findIndex((c) => c.kind === 'local');
    this.configure({
      mode: opts.mode, size: 11, first: opts.first, ctl: opts.ctl,
      teamNames: opts.teamNames, capNames: opts.capNames,
      mySide: (localSide >= 0 ? localSide : 0) as 0 | 1, iAmCaptain: localSide >= 0,
      authority: true, sendOp: opts.sendOp, sendIntent: null,
    });
    opts.sendOp({
      k: 'begin', mode: opts.mode, size: 11, first: opts.first,
      ctl: opts.ctl, teamNames: opts.teamNames, capNames: opts.capNames, seatSides: opts.seatSides,
    });
  }

  // A guest joins the same room as a mirror: captains act, everyone watches
  beginMirror(op: Extract<DraftOp, { k: 'begin' }>, mySeat: number, sendIntent: (a: DraftIntent) => void) {
    const capSide = op.ctl.findIndex((c) => c.kind === 'remote' && c.seat === mySeat);
    const side = (capSide >= 0 ? capSide : op.seatSides[mySeat] ?? 0) as 0 | 1;
    this.configure({
      mode: op.mode, size: op.size, first: op.first, ctl: op.ctl,
      teamNames: op.teamNames, capNames: op.capNames,
      mySide: side, iAmCaptain: capSide >= 0,
      authority: false, sendOp: null, sendIntent,
    });
  }

  private configure(setup: WarRoomSetup) {
    this.clearTransients();
    this.mode = setup.mode;
    this.size = setup.size;
    this.mySide = setup.mySide;
    this.iAmCaptain = setup.iAmCaptain;
    this.authority = setup.authority;
    this.ctl = setup.ctl;
    this.teamNames = setup.teamNames;
    this.capNames = setup.capNames;
    this.sendOp = setup.sendOp;
    this.sendIntent = setup.sendIntent;
    this.opQueue = [];
    this.draft = createDraft(setup.first, setup.size, setup.mode === 'draft');
    this.phase = 'toss';
    this.tossT = 0;
    this.shapes = ['', ''];
    this.arrangements = [[], []];
    this.styleCol = 1;
    this.shapeRow = 0;
    this.shapeClock = SHAPE_TIME;
    this.filter = 'ALL';
    this.gridSel = 0;
    this.gridScroll = 0;
    this.roleSel = 0;
    this.doneT = 0;
    this.myTitle.text = this.teamNames[this.mySide];
    this.cpuTitle.text = this.teamNames[1 - this.mySide];
    this.header.text = setup.mode === 'draft' ? 'THE DRAFT' : 'THE SLOTS';
    this.foot.text = !this.iAmCaptain
      ? 'YOUR CAPTAIN RUNS THE WAR ROOM - DRAG CHIPS TO PREVIEW - THE MATCH STARTS WHEN THE BOARDS FILL'
      : setup.mode === 'draft'
        ? 'WASD MOVE - ENTER SIGN - F FILTER - X ACADEMY - DRAG CHIPS TO REARRANGE'
        : 'A D PICK A SHELF - ENTER ROLLS - DRAG CHIPS TO REARRANGE';
    this.backBtn.visible = this.authority;
    audio.ui('coin');
    this.refreshPanels();
    this.layoutPhase();
  }

  private get curSide(): 0 | 1 {
    return this.draft.order[this.draft.turn] ?? 0;
  }

  private get myTurn(): boolean {
    return this.iAmCaptain && this.phase === 'market' && this.curSide === this.mySide;
  }

  private get myShape(): string { return this.shapes[this.mySide]; }
  private get oppShape(): string { return this.shapes[1 - this.mySide]; }
  private get arrangement(): (number | null)[] { return this.arrangements[this.mySide]; }

  // Whose hands hold the current pick — for every 'on the clock' line
  private clockLabel(side: 0 | 1): string {
    return this.ctl[side].kind === 'cpu' ? 'CPU THINKING' : `${this.capNames[side]} ON THE CLOCK`;
  }

  // --------------------------------------------------------- the op pipeline
  // Authority decides → applies + broadcasts. Mirrors receive → replay.
  private issue(op: DraftOp) {
    this.applyOp(op);
    this.sendOp?.(op);
  }

  // Guest entry: ops arriving mid-reel park until the ride lands
  applyRemoteOp(op: DraftOp) {
    if (op.k === 'begin' || op.k === 'abort') return; // the shell handles these
    if (this.roll) {
      this.opQueue.push(op);
      return;
    }
    this.applyOp(op);
  }

  private drainOps() {
    while (this.opQueue.length && !this.roll) this.applyOp(this.opQueue.shift()!);
  }

  private applyOp(op: DraftOp) {
    switch (op.k) {
      case 'shape': {
        this.shapes[op.side] = op.id;
        this.draft.sides[op.side].quota = quotaOfShape(FORMATIONS[op.id]);
        this.arrangements[op.side] = FORMATIONS[op.id].slots.map(() => null);
        if (this.phase === 'shape' && this.shapes[0] && this.shapes[1]) {
          this.enterMarket();
        } else {
          this.refreshPanels();
          if (this.phase === 'shape') this.buildShapePanels(); // locked → waiting line
        }
        break;
      }
      case 'sign': {
        const p = this.draft.pool[op.poolIdx];
        if (!p) break;
        pick(this.draft, op.poolIdx);
        this.autoPlace(op.side, this.draft.sides[op.side].picks.length - 1, p.role);
        if (op.side === this.mySide && this.iAmCaptain) {
          audio.ui('buy');
          this.launchFlyer(p);
        } else {
          audio.ui('card');
          this.showcase(op.side, p);
        }
        this.afterTurn();
        break;
      }
      case 'academy': {
        pickAcademy(this.draft, op.role as Role);
        const side = this.draft.sides[op.side];
        const junior = side.picks[side.picks.length - 1];
        this.autoPlace(op.side, side.picks.length - 1, junior.role);
        audio.ui('card');
        if (op.side !== this.mySide || !this.iAmCaptain) this.showcase(op.side, junior);
        this.afterTurn();
        break;
      }
      case 'roll':
        this.beginRoll(op);
        break;
      case 'cpu': {
        this.ctl[op.side] = { kind: 'cpu' };
        this.capNames[op.side] = 'CPU';
        if (this.authority && this.curSide === op.side) this.cpuTimer = 0.9;
        this.turnRefresh();
        break;
      }
      case 'begin':
      case 'abort':
        break;
    }
  }

  // The host's referee desk: validate a guest captain's intent, turn it into law
  remoteIntent(seat: number, intent: DraftIntent) {
    if (!this.authority) return;
    const sideIdx = this.ctl.findIndex((c) => c.kind === 'remote' && c.seat === seat);
    if (sideIdx < 0) return;
    const side = sideIdx as 0 | 1;
    if (intent.k === 'shape') {
      const shape = FORMATIONS[intent.id];
      if ((this.phase === 'toss' || this.phase === 'shape') && !this.shapes[side] &&
          shape && shape.slots.length === this.size) {
        this.issue({ k: 'shape', side, id: intent.id });
      }
      return;
    }
    if (intent.k === 'arrange') {
      // his board, his layout — sanitized so a torn packet can't corrupt the XI
      const shapeId = this.shapes[side];
      if (!shapeId) return;
      const picks = this.draft.sides[side].picks.length;
      const seen = new Set<number>();
      this.arrangements[side] = FORMATIONS[shapeId].slots.map((_, i) => {
        const v = intent.slots[i];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < picks && !seen.has(v)) {
          seen.add(v);
          return v;
        }
        return null;
      });
      return;
    }
    if (this.phase !== 'market' || this.roll || this.curSide !== side) return;
    if (intent.k === 'sign' && this.mode === 'draft') {
      const p = this.draft.pool[intent.poolIdx];
      if (p && canPick(this.draft.sides[side], p)) this.issue({ k: 'sign', side, poolIdx: intent.poolIdx });
    } else if (intent.k === 'academy' && this.mode === 'draft') {
      const needs = needsOf(this.draft.sides[side]);
      const role = ROLES.find((r) => needs[r] > 0);
      if (role) this.issue({ k: 'academy', side, role });
    } else if (intent.k === 'roll' && this.mode === 'gamble') {
      const role = intent.role as Role;
      if (ROLES.includes(role)) this.issueRoll(side, role);
    }
  }

  // A captain walked out mid-draft: his chair goes to the CPU, the room rolls on
  seatLeft(seat: number) {
    if (!this.authority) return;
    ([0, 1] as const).forEach((side) => {
      const c = this.ctl[side];
      if (c.kind === 'remote' && c.seat === seat) this.issue({ k: 'cpu', side });
    });
  }

  // The host walking out takes the room with him — mirrors return to the lobby
  abortOnline() {
    if (this.authority) this.sendOp?.({ k: 'abort' });
  }

  // ------------------------------------------------------------- the board
  private swapSlots(a: number, b: number) {
    const arr = this.arrangement;
    const tmp = arr[a];
    arr[a] = arr[b];
    arr[b] = tmp;
    this.shareArrangement();
    this.refreshPanels();
  }

  // Every signing takes the best open chair on its side's board — the same
  // rule on every machine, so the replicas never argue
  private autoPlace(side: 0 | 1, pickIdx: number, role: Role) {
    const shapeId = this.shapes[side];
    if (!shapeId) return;
    const arr = this.arrangements[side];
    const slot = bestOpenSlot(FORMATIONS[shapeId].slots, arr, role);
    if (slot >= 0) arr[slot] = pickIdx;
    if (side === this.mySide) this.shareArrangement();
  }

  // A guest captain's drag-and-drop rides up to the host, where the XI is built
  private shareArrangement() {
    if (!this.authority && this.iAmCaptain) this.sendIntent?.({ k: 'arrange', slots: [...this.arrangement] });
  }

  private refreshPanels() {
    const mine = this.draft.sides[this.mySide];
    const opp = this.draft.sides[1 - this.mySide];
    if (this.mode === 'draft') {
      this.myBudget.text = `BUDGET ${mine.budget.toFixed(1)}M`;
      this.cpuBudget.text = `BUDGET ${opp.budget.toFixed(1)}M`;
    } else {
      this.myBudget.text = `PULLS LEFT ${this.size - mine.picks.length}`;
      this.cpuBudget.text = `PULLS LEFT ${this.size - opp.picks.length}`;
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
    if (this.oppShape) {
      this.cpuBoard.setShape(this.oppShape);
      const arr = this.arrangements[1 - this.mySide];
      this.cpuBoard.setEntries(FORMATIONS[this.oppShape].slots.map((_, i) => {
        const pi = arr[i];
        return pi !== null && pi !== undefined ? opp.picks[pi] ?? null : null;
      }));
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
    const mine = this.draft.sides[this.mySide];
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
      hint.text = !this.myTurn ? this.clockLabel(this.curSide) : canPick(mine, sel.p) ? 'ENTER TO SIGN' : 'OUT OF REACH';
      hint.centerAt(fw * 1.5, this.assets.manifest.cards.h * 3 + 12);
      this.focusLayer.addChild(hint);
    }
    // the academy shelf: an honest journeyman card, always in stock
    const needs = needsOf(mine);
    const role = ROLES.find((r) => needs[r] > 0) ?? 'MF';
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
    if (!this.myTurn || this.mode !== 'draft') return;
    const mine = this.draft.sides[this.mySide];
    const p = this.draft.pool[poolIdx];
    if (!p || !canPick(mine, p)) return audio.ui('denied');
    if (this.authority) {
      this.pickClock = PICK_TIME;
      this.issue({ k: 'sign', side: this.mySide, poolIdx });
    } else {
      this.sendIntent?.({ k: 'sign', poolIdx });
    }
  }

  private signAcademy() {
    if (!this.myTurn || this.mode !== 'draft') return;
    const needs = needsOf(this.draft.sides[this.mySide]);
    const role = ROLES.find((r) => needs[r] > 0);
    if (!role) return audio.ui('denied');
    if (this.authority) {
      this.pickClock = PICK_TIME;
      this.issue({ k: 'academy', side: this.mySide, role });
    } else {
      this.sendIntent?.({ k: 'academy' });
    }
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

  // Another bench signed: the man hangs center-stage under his captain's name
  private showcase(side: 0 | 1, p: StarPlayer) {
    this.cpuReveal?.view.destroy({ children: true });
    const view = new Container();
    const card = new CardView(this.assets, p, 3, true);
    card.pivot.set(this.assets.manifest.cards.w * 1.5, 0);
    const cap = new PixelText(this.assets, 3, 0x9cc4f0);
    cap.text = `${this.capNames[side]} SIGNS`;
    cap.centerAt(0, -34);
    view.addChild(cap, card);
    view.position.set(this.w / 2, this.h * 0.3);
    this.cpuReveal = { view, t: 1.05 };
    this.overlay.addChild(view);
  }

  private afterTurn() {
    this.refreshPanels();
    if (this.draft.turn >= this.draft.order.length) {
      this.doneT = 2.2; // the final close-up breathes before the boots go on
      this.turnRefresh();
      this.layoutPhase();
      return;
    }
    this.cpuTimer = 1.1 + Math.random() * 0.8;
    this.remoteClock = REMOTE_TIME;
    this.pickClock = PICK_TIME;
    this.rebuildMarket();
    this.layoutPhase();
  }

  // The clock (or an empty chair) makes the current side's call
  private cpuAct(side: 0 | 1) {
    if (this.mode === 'draft') {
      const i = aiPickIndex(this.draft);
      if (i >= 0) {
        this.issue({ k: 'sign', side, poolIdx: i });
      } else {
        const needs = needsOf(this.draft.sides[side]);
        const role = ROLES.find((r) => needs[r] > 0) ?? 'MF';
        this.issue({ k: 'academy', side, role });
      }
    } else {
      const needs = needsOf(this.draft.sides[side]);
      const wants = (['FW', 'MF', 'DF', 'GK'] as Role[]).filter((r) => needs[r] > 0);
      const role = wants[Math.floor(Math.random() * wants.length)];
      if (role) this.issueRoll(side, role);
    }
  }

  // -------------------------------------------------------------- the reel
  // The whole shelf shuffled onto one long strip, every man an equal ticket.
  // The authority rolls the winner UP FRONT and ships it with a strip seed;
  // every screen then rides the same deceleration past the needle.
  private cellW(): number {
    return this.assets.manifest.cards.w * REEL_SCALE + REEL_GAP;
  }

  private issueRoll(side: 0 | 1, role: Role): boolean {
    if (this.roll) return false; // one ride at a time — no re-rolling a bad spin
    const roster = this.draft.pool.map((p, poolIdx) => ({ p, poolIdx })).filter((e) => e.p.role === role);
    if (!roster.length || needsOf(this.draft.sides[side])[role] <= 0) return false;
    const winner = roster[Math.floor(Math.random() * roster.length)];
    this.issue({ k: 'roll', side, role, winnerPoolIdx: winner.poolIdx, seed: Math.floor(Math.random() * 0x7fffffff) });
    return true;
  }

  private requestRoll(role: Role) {
    if (this.roll) return;
    if (!this.myTurn || this.mode !== 'gamble') return audio.ui('denied');
    if (needsOf(this.draft.sides[this.mySide])[role] <= 0) return audio.ui('denied');
    if (this.authority) {
      if (!this.issueRoll(this.mySide, role)) audio.ui('denied');
    } else {
      this.sendIntent?.({ k: 'roll', role });
    }
  }

  private beginRoll(op: Extract<DraftOp, { k: 'roll' }>) {
    const role = op.role as Role;
    const roster = this.draft.pool.map((p, poolIdx) => ({ p, poolIdx })).filter((e) => e.p.role === role);
    const winner = roster.find((e) => e.poolIdx === op.winnerPoolIdx) ?? roster[0];
    if (!winner) return;
    this.killReel();
    this.revealCard?.view.destroy({ children: true });
    this.revealCard = null;
    const rng = new Rng(op.seed);
    const shuffled = [...roster];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // tile the shuffle until the strip is long enough to really travel, and
    // land on the winner's LAST appearance so the ride uses the whole road.
    // Every screen rides the SAME length for a given roll — host and guests
    // resolve together, so the last pull is never cut mid-spin by kickoff.
    const myRide = op.side === this.mySide && this.iAmCaptain;
    const humanRoll = this.ctl[op.side].kind !== 'cpu';
    const travel = humanRoll ? 32 : 16;
    const strip: { p: StarPlayer; poolIdx: number }[] = [];
    while (strip.length < travel + shuffled.length) strip.push(...shuffled);
    let winStrip = strip.length - 1;
    for (let i = strip.length - 1; i >= 0; i--) {
      if (strip[i] === winner) { winStrip = i; break; }
    }
    const cell = this.cellW();
    strip.forEach((e, i) => {
      const card = new CardView(this.assets, e.p, REEL_SCALE, true); // the fine print rides the reel
      card.position.set(i * cell, 0);
      this.reelStrip.addChild(card);
    });
    this.reelStrip.y = this.reelY;
    // land a touch off-center — a machine stops where physics says, not a ruler
    const jitter = (rng.next() - 0.5) * 0.5 * (cell - REEL_GAP);
    const center = this.w / 2;
    this.roll = {
      t: 0,
      dur: humanRoll ? 3.4 : 1.8,
      from: center - (cell - REEL_GAP) / 2,
      to: center - (cell - REEL_GAP) / 2 - winStrip * cell + jitter,
      strip,
      winStrip,
      side: op.side,
      role,
      lastCell: -1,
    };
    if (myRide) audio.ui('select');
  }

  private resolveRoll() {
    const r = this.roll;
    if (!r) return;
    this.roll = null; // the strip stays frozen on the winner until the next act
    const side = this.draft.sides[r.side];
    const won = r.strip[r.winStrip];
    side.picks.push(won.p);
    this.draft.pool.splice(won.poolIdx, 1);
    this.draft.turn++;
    this.autoPlace(r.side, side.picks.length - 1, r.role);
    const band = rarityOf(won.p.ovr);
    const mine = r.side === this.mySide && this.iAmCaptain;
    audio.ui(mine ? (band === 'legend' || band === 'epic' ? 'wheel-win' : 'buy') : 'card');
    // the landed card steps forward for its close-up
    this.revealCard?.view.destroy({ children: true });
    const view = new Container();
    const card = new CardView(this.assets, won.p, mine ? 3 : 2, true);
    card.pivot.set((this.assets.manifest.cards.w * (mine ? 3 : 2)) / 2, 0);
    const cap = new PixelText(this.assets, 3, mine ? RARITY_TINT[band] : 0x9cc4f0);
    cap.text = mine ? band.toUpperCase() : `${this.capNames[r.side]} PULLS`;
    cap.centerAt(0, -34);
    view.addChild(cap, card);
    view.position.set(this.w / 2, this.h * 0.12);
    this.revealCard = { view, t: mine ? 1.5 : 0.9 };
    this.overlay.addChild(view);
    this.afterTurn();
    this.drainOps();
  }

  // -------------------------------------------------------------- finishing
  private finish() {
    this.phase = 'done';
    this.clearTransients();
    if (!this.authority) {
      // a mirror holds the boards up until the host raises the curtain
      this.turnText.text = 'SQUADS LOCKED - BOOTS ON';
      this.turnText.centerAt(this.w / 2, 58);
      this.layoutPhase();
      return;
    }
    const squadOf = (side: 0 | 1): SquadPlayer[] => {
      const ds = this.draft.sides[side];
      fillWithAcademy(ds);
      const shape = FORMATIONS[this.shapes[side]];
      const arr = this.arrangements[side];
      // any body not yet on the board takes the best open chair
      ds.picks.forEach((p, i) => {
        if (!arr.includes(i)) {
          const slot = bestOpenSlot(shape.slots, arr, p.role);
          if (slot >= 0) arr[slot] = i;
        }
      });
      const ordered = shape.slots.map((_, si) => {
        const pi = arr[si];
        return pi !== null && pi !== undefined ? ds.picks[pi] : ds.picks.find((_, j) => !arr.includes(j))!;
      });
      return toSquadOrdered(ordered, shape);
    };
    this.onDone(squadOf(0), this.shapes[0], squadOf(1), this.shapes[1]);
  }

  // ----------------------------------------------------------------- input
  key(code: string) {
    if (this.phase === 'shape') {
      if (!this.iAmCaptain || this.myShape) return;
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
      if (code === 'ArrowLeft' || code === 'KeyA') { this.roleSel = (this.roleSel + 3) % 4; audio.ui('move'); this.layoutPhase(); }
      if (code === 'ArrowRight' || code === 'KeyD') { this.roleSel = (this.roleSel + 1) % 4; audio.ui('move'); this.layoutPhase(); }
      if (code === 'Enter' || code === 'Space') this.requestRoll(ROLES[this.roleSel]);
    }
  }

  // ----------------------------------------------------------------- phases
  private confirmShape() {
    if (!this.iAmCaptain || this.myShape) return;
    const list = formationsOf(this.size, STYLES[this.styleCol]);
    const id = list[this.shapeRow] ?? formationsOf(this.size, 'balanced')[0];
    audio.ui('select');
    if (this.authority) this.issue({ k: 'shape', side: this.mySide, id });
    else this.sendIntent?.({ k: 'shape', id });
  }

  private enterMarket() {
    this.phase = 'market';
    this.cpuTimer = 1.2;
    this.remoteClock = REMOTE_TIME;
    this.pickClock = PICK_TIME;
    audio.ui('select');
    this.refreshPanels();
    this.rebuildMarket(true);
    this.layoutPhase();
  }

  // CPU benches call their shape the moment the coin settles; slow humans
  // get the shape clock, then the authority calls balanced for them
  private autoShapes(deadline: boolean) {
    if (!this.authority) return;
    ([0, 1] as const).forEach((side) => {
      if (this.shapes[side]) return;
      const c = this.ctl[side];
      if (c.kind === 'cpu') {
        const style = STYLES[Math.floor(Math.random() * STYLES.length)];
        const list = formationsOf(this.size, style);
        this.issue({ k: 'shape', side, id: list[Math.floor(Math.random() * list.length)] ?? formationsOf(this.size, 'balanced')[0] });
      } else if (deadline) {
        if (c.kind === 'local') {
          const list = formationsOf(this.size, STYLES[this.styleCol]);
          this.issue({ k: 'shape', side, id: list[this.shapeRow] ?? formationsOf(this.size, 'balanced')[0] });
        } else {
          this.issue({ k: 'shape', side, id: formationsOf(this.size, 'balanced')[0] });
        }
      }
    });
  }

  private buildShapePanels() {
    this.shapePanels.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!this.iAmCaptain || this.myShape) {
      const wait = new PixelText(this.assets, 3, 0x8f97a8);
      wait.text = this.myShape ? 'SHAPE LOCKED - WAITING ON THE OTHER BENCH' : 'THE CAPTAINS ARE CALLING THEIR SHAPES';
      wait.centerAt(this.w / 2, this.h * 0.42);
      this.shapePanels.addChild(wait);
      return;
    }
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
        this.caption.text = winner === this.mySide && this.iAmCaptain
          ? 'YOU PICK FIRST'
          : `${this.capNames[winner]} PICKS FIRST`;
        this.caption.centerAt(this.w / 2, this.h * 0.56);
        this.caption.visible = true;
        if (t > 2.4) {
          this.phase = 'shape';
          this.shapeClock = SHAPE_TIME;
          audio.ui('card');
          this.autoShapes(false); // CPU benches answer instantly
          if (this.phase === 'shape') {
            if (this.shapes[0] && this.shapes[1]) this.enterMarket();
            else {
              this.buildShapePanels();
              this.layoutPhase();
            }
          }
        }
      }
      return;
    }

    if (this.phase === 'shape') {
      this.shapeClock -= dt;
      if (this.shapeClock <= 0) this.autoShapes(true);
      this.drawClock(Math.max(0, this.shapeClock) / SHAPE_TIME);
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
      // the reel talks you through it: what to do, or whose hands it's in —
      // and it steps aside while a landed card takes its close-up
      this.promptPulse += dt * 4;
      this.wheelPrompt.text = this.roll || this.revealCard || this.draft.turn >= this.draft.order.length ? '' :
        this.myTurn ? 'PICK A SHELF - ENTER ROLLS' : `${this.capNames[this.curSide]} AT THE SLOTS`;
      this.wheelPrompt.alpha = this.myTurn && !this.roll ? 0.7 + 0.3 * Math.sin(this.promptPulse) : 0.7;
      this.wheelPrompt.centerAt(this.w / 2, this.reelY - 36);
    }
    if (this.mode === 'gamble' && this.roll) {
      this.clockBar.visible = false; // the ride owns the stage
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

    // boards full: hold the last close-up on every screen, then the whistle
    if (this.doneT > 0) {
      this.clockBar.visible = false;
      this.doneT -= dt;
      if (this.doneT <= 0) this.finish();
      return;
    }

    // the referee's clocks: his own pick timer, the CPU's think, and the
    // grace an absent captain gets before the clock signs for him
    if (this.authority && this.draft.turn < this.draft.order.length && !this.roll) {
      const side = this.curSide;
      const c = this.ctl[side];
      if (c.kind === 'local') {
        if (this.mode === 'draft') {
          this.pickClock -= dt;
          if (this.pickClock <= 0) {
            this.pickClock = PICK_TIME;
            this.cpuAct(side); // the clock signs for you — best value on the shelf
          }
        }
      } else if (!this.cpuReveal && !this.revealCard) {
        if (c.kind === 'remote') {
          this.remoteClock -= dt;
          if (this.remoteClock <= 0) {
            this.remoteClock = REMOTE_TIME;
            this.cpuAct(side);
          }
        } else {
          this.cpuTimer -= dt;
          if (this.cpuTimer <= 0) this.cpuAct(side);
        }
      }
    }
    // Mirrors run the SAME sand cosmetically — every op resets it, so every
    // screen watches one clock whether it referees, picks, or just spectates
    if (!this.authority && this.draft.turn < this.draft.order.length && !this.roll) {
      const c = this.ctl[this.curSide];
      if (c.kind === 'local' && this.mode === 'draft') this.pickClock = Math.max(0, this.pickClock - dt);
      else if (c.kind === 'remote' && !this.cpuReveal && !this.revealCard) this.remoteClock = Math.max(0, this.remoteClock - dt);
    }
    this.updateTurnClock(dt);
    this.turnRefresh();
  }

  // The turn clock every screen shows: a captain on the host's tab burns
  // PICK_TIME, a captain on the wire burns his REMOTE_TIME grace, and the
  // CPU thinks unbarred. Null means no sand to show.
  private turnClockFrac(): number | null {
    if (this.draft.turn >= this.draft.order.length || this.doneT > 0 || this.roll) return null;
    const c = this.ctl[this.curSide];
    if (c.kind === 'local' && this.mode === 'draft') return Math.max(0, this.pickClock) / PICK_TIME;
    if (c.kind === 'remote') return Math.max(0, this.remoteClock) / REMOTE_TIME;
    return null;
  }

  private updateTurnClock(dt: number) {
    const frac = this.turnClockFrac();
    this.clockBar.visible = frac !== null;
    if (frac === null) return;
    this.drawClock(frac);
    // the last grains rattle — but only in the hands they're falling for
    if (this.myTurn) {
      const t = this.ctl[this.mySide].kind === 'remote' ? this.remoteClock : this.pickClock;
      if (t < 5.2 && t > 0 && Math.floor(t * 2) !== Math.floor((t + dt) * 2)) {
        audio.play('ui-wheel-tick', { vol: 0.7 });
      }
    }
  }

  private turnRefresh() {
    if (this.phase === 'done') return; // the lock line stands
    if (this.draft.turn >= this.draft.order.length) {
      this.turnText.text = 'SQUADS LOCKED - BOOTS ON';
      this.turnText.centerAt(this.w / 2, 58);
      return;
    }
    const pickNo = Math.min(this.draft.turn + 1, this.draft.order.length);
    this.turnText.text = this.phase === 'shape'
      ? (this.iAmCaptain ? 'CALL YOUR SHAPE' : 'THE CAPTAINS CALL THE SHAPES')
      : this.myTurn
        ? `PICK ${pickNo} OF ${this.draft.order.length} - YOUR CALL`
        : `PICK ${pickNo} OF ${this.draft.order.length} - ${this.clockLabel(this.curSide)}`;
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
    this.cpuPanel.visible = this.phase === 'market' || this.phase === 'done';
    // the market bar manages itself every frame (updateTurnClock)
    this.clockBar.visible = this.phase === 'shape';
    this.backBtn.visible = this.authority && this.phase !== 'done';
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
    const needs = needsOf(this.draft.sides[this.mySide]);
    // a filled shelf hands the selector to the next open role
    if (needs[ROLES[this.roleSel]] <= 0) {
      const open = ROLES.findIndex((r) => needs[r] > 0);
      if (open >= 0) this.roleSel = open;
    }
    const BW = 108;
    const BH = 62;
    const GAP = 18;
    ROLES.forEach((r, i) => {
      const active = i === this.roleSel && this.myTurn;
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
        this.requestRoll(r); // the turn gate answers — nobody rolls out of turn
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
