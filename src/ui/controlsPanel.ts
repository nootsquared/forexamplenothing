import { Container, Graphics } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { GOLD, MINT, cornerMarks } from './kit';
import { PadButton, pads } from '../input/gamepad';
import { roster } from '../input/seats';

// The card that answers "what does this button do". It speaks the language of
// whoever asked for it: pad badges when a pad called it up, key caps when it
// was hands on a board, and a second block for the friend sharing the
// keyboard. It never takes a click and never eats a key — you can leave it up
// and keep playing underneath it.

// What the shell binds to open and close the card, on each kind of hands
export const CONTROLS_KEY = 'KeyC';
export const CONTROLS_PAD_BUTTON: PadButton = 'back';

const PLATE = 0x0d1119;
const INK = 0x05070b;
const TEXT = 0xdfe4ee;
const DIM = 0x8a91a0;
const FAINT = 0x69707f;
const CORAL = 0xff9c8a;
const SKY = 0x9cc4f0;

const ROW_H = 21;
const PAD_X = 14;
const PANEL_W = 306;

type Token = { cap: string; tone: number } | { word: string };
const k = (cap: string, tone = DIM): Token => ({ cap, tone });
const w = (word: string): Token => ({ word });

interface ControlLine {
  action: string;
  keys: Token[];
  pad: Token[];
  gap?: boolean; // a hairline of air above this row
  head?: boolean; // a gold section label instead of a binding
}

// Everything a player can do, in the order they learn it
const LINES: ControlLine[] = [
  { action: 'MOVE', keys: [k('W'), k('A'), k('S'), k('D')], pad: [w('LEFT STICK')] },
  { action: 'SPRINT', keys: [k('SHIFT')], pad: [k('RB'), w('/'), k('RT')] },
  { action: 'PASS', keys: [w('DRAG MOUSE')], pad: [w('FLICK'), k('RS', GOLD)], gap: true },
  { action: 'SHOOT', keys: [w('DRAG FAR')], pad: [w('HOLD'), k('A', MINT)] },
  { action: 'BEND IT', keys: [k('J'), k('L')], pad: [w('AIM'), k('RS', GOLD)] },
  { action: 'TACKLE', keys: [w('TAP'), k('SPACE')], pad: [w('TAP'), k('B', CORAL)], gap: true },
  { action: 'HOLD HIM OFF', keys: [w('HOLD'), k('SPACE')], pad: [w('HOLD'), k('B', CORAL)] },
  { action: 'BREAK ON A CORNER', keys: [k('SPACE')], pad: [k('B', CORAL)] },
  { action: 'SWITCH MAN', keys: [k('E')], pad: [k('LB'), w('/'), k('X', SKY)], gap: true },
  { action: 'AUTO SWITCH', keys: [k('T')], pad: [k('Y', GOLD)] },
  { action: 'CELEBRATE', keys: [k('X')], pad: [k('X', SKY)] },
  { action: 'PAUSE', keys: [k('ESC')], pad: [k('START')], gap: true },
  { action: 'THIS CARD', keys: [k('C')], pad: [k('SELECT')] },
  { action: 'PITCH MOOD', keys: [k('1'), k('2'), k('3')], pad: [w('KEYS ONLY')] },
];

// The friend sharing one board: his half of the keys, in the same grammar.
// The pixel font has no comma, so the switch key wears its name.
const SEAT_TWO: ControlLine[] = [
  { action: 'SEAT TWO', keys: [], pad: [], gap: true, head: true },
  { action: 'MOVE', keys: [k('ARROWS')], pad: [k('ARROWS')] },
  { action: 'SPRINT', keys: [k('/')], pad: [k('/')] },
  { action: 'TACKLE', keys: [k('.')], pad: [k('.')] },
  { action: 'SWITCH MAN', keys: [k('COMMA')], pad: [k('COMMA')] },
];

export type ControlsDevice = 'pad' | 'keys';
export type ControlsSpot = 'corner' | 'center';

export class ControlsPanel {
  root = new Container();
  private plate = new Graphics();
  private body = new Container();
  private title: PixelText;
  private chip: PixelText;
  private foot: PixelText;
  private shown = false;
  private slide = 0;           // 0 stowed, 1 fully out
  private device: ControlsDevice = 'keys';
  private pinned: ControlsDevice | null = null;
  private stamp = '';          // what the card last drew — rebuild only on a change
  private spot: ControlsSpot = 'corner';
  private h = 0;               // measured once the rows are laid
  private vw = 1280;
  private vh = 720;

  constructor(private assets: GameAssets) {
    this.title = new PixelText(assets, 3, GOLD);
    this.title.text = 'CONTROLS';
    this.chip = new PixelText(assets, 2, MINT, 'micro');
    this.foot = new PixelText(assets, 2, FAINT, 'micro');
    this.root.addChild(this.plate, this.title, this.chip, this.body, this.foot);
    this.root.eventMode = 'none'; // a card you can read THROUGH — it never takes a click
    this.root.visible = false;
    this.root.alpha = 0;
  }

  get open(): boolean {
    return this.shown;
  }

  // The one call a binding needs. Naming the hands that asked pins the card to
  // their language — and if it is already up in somebody else's, those hands
  // take it over instead of slamming it shut on them.
  toggle(device: ControlsDevice | null = null): boolean {
    if (this.shown && device && device !== this.device) {
      this.pinned = device;
      return true;
    }
    this.show(!this.shown, device);
    return this.shown;
  }

  show(on: boolean, device: ControlsDevice | null = null) {
    if (on) this.pinned = device;
    if (on === this.shown) return;
    this.shown = on;
    if (on) {
      this.root.visible = true;
      this.device = this.reading();
      this.rebuild();
      this.place();
    }
  }

  // Corner while the ball is live, dead-centre when a screen is holding still
  place(spot: ControlsSpot = this.spot) {
    this.spot = spot;
    this.layout(this.vw, this.vh);
  }

  // Whose hands the card should be speaking for right now
  private reading(): ControlsDevice {
    if (this.pinned) return this.pinned;
    const seat = roster.primary;
    if (seat) return seat.device.kind === 'pad' ? 'pad' : 'keys';
    return pads.connected ? 'pad' : 'keys';
  }

  update(dt: number) {
    if (!this.root.visible) return;
    const want = this.reading();
    if (want !== this.device) {
      this.device = want;
      this.rebuild();
      this.layout(this.vw, this.vh);
    }
    // the card rides in on a short ease and stows the same way; nothing snaps
    const to = this.shown ? 1 : 0;
    this.slide += (to - this.slide) * Math.min(1, dt * 13);
    if (Math.abs(to - this.slide) < 0.004) this.slide = to;
    this.root.alpha = this.slide;
    this.root.position.y = this.baseY() + Math.round((1 - this.slide) * 16);
    if (!this.shown && this.slide === 0) this.root.visible = false;
  }

  layout(vw: number, vh: number) {
    this.vw = vw;
    this.vh = vh;
    if (!this.root.visible) return;
    this.rebuild();
    const x = this.spot === 'center'
      ? Math.round(vw / 2 - PANEL_W / 2)
      : Math.round(vw - PANEL_W - 22);
    this.root.position.set(x, this.baseY());
  }

  private baseY(): number {
    return this.spot === 'center'
      ? Math.round(this.vh / 2 - this.h / 2)
      : Math.round(this.vh - this.h - 22);
  }

  // ---------------------------------------------------------------- drawing
  // One key cap or one pad badge: a small bevelled pixel button with its
  // label sat on the cell's true ink height
  private cap(label: string, tone: number): Container {
    const box = new Container();
    const g = new Graphics();
    const t = new PixelText(this.assets, 2, 0xf2f5fa, 'micro');
    t.text = label;
    const bw = t.textWidth + 11;
    const bh = 15;
    g.rect(0, 0, bw, bh).fill({ color: INK, alpha: 0.95 });
    g.rect(1, 1, bw - 2, bh - 2).fill({ color: 0x1b2231, alpha: 1 });
    g.rect(1, 1, bw - 2, 1).fill({ color: tone, alpha: 0.55 });
    g.rect(1, bh - 2, bw - 2, 1).fill({ color: 0x000000, alpha: 0.5 });
    t.tint = tone;
    t.position.set(Math.round((bw - t.textWidth) / 2), Math.round((bh - t.textHeight) / 2));
    box.addChild(g, t);
    return box;
  }

  // A binding, laid out right to left so the whole run ends flush with the edge
  private tokens(list: Token[], right: number, y: number) {
    const pieces: Container[] = [];
    let width = 0;
    for (const item of list) {
      const node = 'cap' in item ? this.cap(item.cap, item.tone) : (() => {
        const t = new PixelText(this.assets, 2, DIM, 'micro');
        t.text = item.word;
        return t;
      })();
      pieces.push(node);
      width += ('cap' in item ? node.width : (node as PixelText).textWidth) + 5;
    }
    let x = right - (width - 5);
    for (let i = 0; i < pieces.length; i++) {
      const node = pieces[i];
      const isCap = 'cap' in list[i];
      node.position.set(Math.round(x), Math.round(y + (isCap ? 0 : 4)));
      x += (isCap ? node.width : (node as PixelText).textWidth) + 5;
      this.body.addChild(node);
    }
  }

  private rebuild() {
    const secondSeat = roster.seat('keys1');
    const stamp = `${this.device}|${this.spot}|${secondSeat ? 1 : 0}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.body.removeChildren().forEach((c) => c.destroy({ children: true }));

    const pad = this.device === 'pad';
    this.chip.text = pad ? 'PAD' : 'KEYBOARD';
    this.chip.tint = pad ? MINT : GOLD;
    this.foot.text = pad ? 'SELECT PUTS THIS AWAY' : 'C PUTS THIS AWAY';

    let y = 46;
    for (const line of secondSeat ? [...LINES, ...SEAT_TWO] : LINES) {
      if (line.gap) y += 6;
      const label = new PixelText(this.assets, 2, line.head ? GOLD : TEXT, 'micro');
      label.text = line.action;
      label.position.set(PAD_X, y + 4);
      this.body.addChild(label);
      if (!line.head) this.tokens(pad ? line.pad : line.keys, PANEL_W - PAD_X, y);
      y += ROW_H;
    }
    y += 6;
    this.foot.position.set(PAD_X, y);
    this.h = y + this.foot.textHeight + 12;

    this.title.position.set(PAD_X, 15);
    this.chip.position.set(PANEL_W - PAD_X - this.chip.textWidth, 20);

    const g = this.plate;
    g.clear();
    g.rect(0, 0, PANEL_W, this.h).fill({ color: PLATE, alpha: 0.94 });
    g.rect(0, 0, PANEL_W, 2).fill({ color: GOLD, alpha: 0.5 });
    g.rect(0, this.h - 2, PANEL_W, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(0, 2, 1, this.h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(PANEL_W - 1, 2, 1, this.h - 4).fill({ color: 0xfff8e0, alpha: 0.12 });
    g.rect(PAD_X, 38, PANEL_W - PAD_X * 2, 1).fill({ color: GOLD, alpha: 0.22 });
    cornerMarks(g, 0, 0, PANEL_W, this.h, GOLD, 0.6);
  }
}
