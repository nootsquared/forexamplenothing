import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';
import { centerShade } from './kit';
import { Screen } from './screens';
import { LobbySnap } from '../net/net';

// The party rooms. Stages on one screen:
//   name  — who are you (asked every visit, no stored defaults)
//   gate  — HOST A PARTY / JOIN A PARTY / CHANGE NAME / BACK
//   code  — the four letters
//   party — the room: code plate, two national boards, seats, host console
// Everything is a real CLICKABLE pixel button with hover; keyboard rides along.

const GOLD = 0xffd95e;
const CREAM = 0xfff8e0;
const INK = 0x0d1119;
const MUTE = 0x8a91a0;
const HALF_NAMES: Record<number, string> = { 60: '1:00', 120: '2:00', 180: '3:00', 300: '5:00' };

// A beveled plate with corner studs — the game's panel grammar
function plate(g: Graphics, x: number, y: number, w: number, h: number, topColor = GOLD) {
  g.rect(x, y, w, h).fill({ color: INK, alpha: 0.9 });
  g.rect(x, y, w, 2).fill({ color: topColor, alpha: 0.55 });
  g.rect(x, y + h - 2, w, 2).fill({ color: 0x000000, alpha: 0.5 });
  g.rect(x, y + 2, 1, h - 4).fill({ color: CREAM, alpha: 0.12 });
  g.rect(x + w - 1, y + 2, 1, h - 4).fill({ color: CREAM, alpha: 0.12 });
  for (const [cx, cy] of [[x + 3, y + 4], [x + w - 6, y + 4], [x + 3, y + h - 7], [x + w - 6, y + h - 7]]) {
    g.rect(cx, cy, 3, 3).fill({ color: topColor, alpha: 0.55 });
  }
}

export type OnlineStage = 'name' | 'gate' | 'code' | 'connecting' | 'party';

export class OnlineScreen implements Screen {
  root = new Container();
  stage: OnlineStage = 'name';
  isHost = false;
  myName = '';
  codeBuffer = '';
  nameBuffer = '';
  renaming = false; // captain typing a team name
  renameBuffer = '';
  lobby: LobbySnap | null = null;
  mySeat = 0; // 0 as host; relay seat as guest

  onHost: () => void = () => {};
  onJoin: (code: string) => void = () => {};
  onNamed: (name: string) => void = () => {};
  onClaim: (team: 0 | 1 | null) => void = () => {};
  onNation: (dir: 1 | -1) => void = () => {};
  onRename: (name: string) => void = () => {};
  onReady: () => void = () => {};
  onMode: () => void = () => {};
  onHalf: () => void = () => {};
  onStart: () => void = () => {};
  onLeave: () => void = () => {};

  private shade = new Graphics();
  private panels = new Graphics();
  private widgets = new Container(); // texts AND buttons — rebuilt whole
  private carets = new Graphics();   // blinking entry markers, drawn on top
  private flagL: Sprite;
  private flagR: Sprite;
  private caret = 0;
  private caretSpots: { x: number; y: number; h: number }[] = [];
  private gateSel = 0;
  private w = 1280;
  private h = 720;

  constructor(private assets: GameAssets) {
    this.flagL = new Sprite();
    this.flagR = new Sprite();
    this.root.addChild(this.shade, this.panels, this.flagL, this.flagR, this.widgets, this.carets);
  }

  begin(stage: OnlineStage, myName: string) {
    this.stage = stage;
    this.myName = myName;
    this.nameBuffer = myName;
    this.codeBuffer = '';
    this.renaming = false;
    this.rebuild();
  }

  setLobby(lobby: LobbySnap, mySeat: number, isHost: boolean) {
    this.lobby = lobby;
    this.mySeat = mySeat;
    this.isHost = isHost;
    if (this.stage !== 'party') this.stage = 'party';
    this.rebuild();
  }

  // Text entry rides raw keydown — menus only forward UI keys
  textKey(e: KeyboardEvent): boolean {
    const typing = this.stage === 'name' || this.stage === 'code' || this.renaming;
    if (!typing) return false;
    const buf = this.stage === 'name' ? 'nameBuffer' : this.stage === 'code' ? 'codeBuffer' : 'renameBuffer';
    if (e.key === 'Backspace') {
      this[buf] = this[buf].slice(0, -1);
      this.rebuild();
      return true;
    }
    if (/^[a-zA-Z0-9 ]$/.test(e.key)) {
      const max = this.stage === 'code' ? 4 : 12;
      if (this[buf].length < max) {
        this[buf] += e.key.toUpperCase();
        this.rebuild();
      }
      return true;
    }
    return false;
  }

  key(code: string) {
    if (this.stage === 'name') {
      if (code === 'Enter') this.confirmName();
      return;
    }
    if (this.stage === 'gate') {
      if (code === 'KeyW' || code === 'ArrowUp' || code === 'KeyS' || code === 'ArrowDown') {
        this.gateSel = this.gateSel === 0 ? 1 : 0;
        audio.ui('move');
        this.rebuild();
      }
      if (code === 'Enter') (this.gateSel === 0 ? this.pickHost : this.pickJoin).call(this);
      return;
    }
    if (this.stage === 'code') {
      if (code === 'Enter') this.confirmCode();
      return;
    }
    if (this.stage !== 'party' || !this.lobby) return;

    if (this.renaming) {
      if (code === 'Enter') this.confirmRename();
      return;
    }
    const me = this.lobby.seats.find((s) => s.seat === this.mySeat);
    if (code === 'KeyA' || code === 'ArrowLeft') { this.onClaim(0); audio.ui('move'); }
    if (code === 'KeyD' || code === 'ArrowRight') { this.onClaim(1); audio.ui('move'); }
    if (code === 'KeyX') { this.onClaim(null); audio.ui('back'); }
    if ((code === 'KeyW' || code === 'ArrowUp') && me?.captain) { this.onNation(-1); audio.ui('move'); }
    if ((code === 'KeyS' || code === 'ArrowDown') && me?.captain) { this.onNation(1); audio.ui('move'); }
    if (code === 'KeyN' && me?.captain) this.startRename();
    if (code === 'KeyF') { this.onReady(); audio.ui('select'); }
    if (code === 'KeyM' && this.isHost) { this.onMode(); audio.ui('move'); }
    if (code === 'Enter' && this.isHost) this.onStart();
  }

  // ---- the actions buttons and keys share --------------------------------
  private confirmName() {
    if (this.nameBuffer.trim().length < 2) return audio.ui('denied');
    this.myName = this.nameBuffer.trim();
    audio.ui('select');
    this.onNamed(this.myName);
  }

  private pickHost() {
    audio.ui('select');
    this.onHost();
    this.stage = 'connecting';
    this.rebuild();
  }

  private pickJoin() {
    audio.ui('select');
    this.stage = 'code';
    this.rebuild();
  }

  private confirmCode() {
    if (this.codeBuffer.length !== 4) return audio.ui('denied');
    audio.ui('select');
    this.onJoin(this.codeBuffer);
    this.stage = 'connecting';
    this.rebuild();
  }

  private startRename() {
    this.renaming = true;
    this.renameBuffer = '';
    audio.ui('select');
    this.rebuild();
  }

  private confirmRename() {
    this.renaming = false;
    this.onRename(this.renameBuffer.trim());
    audio.ui('select');
    this.rebuild();
  }

  update(dt: number) {
    this.caret += dt * 3;
    // the entry caret: a steady gold block, breathing — never lost, never coy
    const on = Math.sin(this.caret * 2.2) > -0.2;
    this.carets.clear();
    if (on) {
      for (const c of this.caretSpots) {
        this.carets.rect(c.x, c.y, 4, c.h).fill({ color: GOLD, alpha: 0.9 });
      }
    }
  }

  layout(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rebuild();
  }

  enter() {
    this.rebuild();
  }

  // ------------------------------------------------------------- rendering
  private put(text: string, size: number, color: number, cx: number, y: number, center = true) {
    const t = new PixelText(this.assets, size, color);
    t.text = text;
    if (center) t.centerAt(cx, y);
    else t.position.set(cx, y);
    this.widgets.addChild(t);
    return t;
  }

  private markCaret(after: PixelText, size: number) {
    // hug the ink rows, not the outline rows — the caret reads as a letter
    this.caretSpots.push({ x: after.position.x + after.textWidth + 5, y: after.position.y + size, h: size * 7 });
  }

  // A pixel button you can actually CLICK: full beveled frame, the label
  // dead-center on its TRUE cell height, a hover glow with the gold chevron,
  // and the same move/select voice as the menus
  private button(label: string, cx: number, y: number, w: number, onTap: (() => void) | null, opts: { size?: number; color?: number } = {}) {
    const size = opts.size ?? 2;
    const textH = this.assets.manifest.font.cellH * size;
    const pad = 7;
    const bh = textH + pad * 2;
    const color = opts.color ?? GOLD;
    const enabled = onTap !== null;
    const b = new Container();
    const g = new Graphics();
    const x = Math.round(cx - w / 2);
    // outline, body, then the bevel: light where the light lands, dark below
    g.rect(x, y, w, bh).fill({ color: 0x05070b, alpha: enabled ? 0.95 : 0.6 });
    g.rect(x + 1, y + 1, w - 2, bh - 2).fill({ color: enabled ? 0x1b2231 : 0x131822, alpha: 1 });
    g.rect(x + 1, y + 1, w - 2, 2).fill({ color: CREAM, alpha: enabled ? 0.2 : 0.07 });
    g.rect(x + 1, y + 1, 2, bh - 2).fill({ color: CREAM, alpha: enabled ? 0.1 : 0.04 });
    g.rect(x + 1, y + bh - 3, w - 2, 2).fill({ color: 0x000000, alpha: 0.5 });
    g.rect(x + w - 3, y + 1, 2, bh - 2).fill({ color: 0x000000, alpha: 0.3 });
    b.addChild(g);
    // hover wash: the whole face warms when the pointer arrives
    const glow = new Graphics();
    glow.rect(x + 1, y + 1, w - 2, bh - 2).fill({ color, alpha: 0.1 });
    glow.visible = false;
    b.addChild(glow);
    const t = new PixelText(this.assets, size, enabled ? 0xe8ecf4 : 0x4a5160);
    t.text = label;
    t.centerAt(cx, y + pad);
    b.addChild(t);
    const chev = new PixelText(this.assets, size, color);
    chev.text = '>';
    chev.position.set(x + 10, y + pad);
    chev.visible = false;
    b.addChild(chev);
    if (enabled) {
      b.eventMode = 'static';
      b.cursor = 'pointer';
      b.hitArea = new Rectangle(x, y, w, bh);
      b.on('pointerover', () => {
        chev.visible = true;
        glow.visible = true;
        t.tint = color;
        audio.ui('move');
      });
      b.on('pointerout', () => {
        chev.visible = false;
        glow.visible = false;
        t.tint = 0xe8ecf4;
      });
      b.on('pointertap', () => onTap());
    }
    this.widgets.addChild(b);
    return bh;
  }

  private rebuild() {
    const { w, h } = this;
    centerShade(this.shade, w, h, Math.min(1360, w - 60));
    this.panels.clear();
    this.carets.clear();
    this.caretSpots = [];
    this.widgets.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.flagL.visible = false;
    this.flagR.visible = false;

    if (this.stage === 'name') {
      this.put('WHO ARE YOU', 5, GOLD, w / 2, h * 0.22);
      this.put('THE NAME YOUR FRIENDS WILL SEE OVER YOUR PLAYER', 2, MUTE, w / 2, h * 0.22 + 58);
      plate(this.panels, w / 2 - 180, h * 0.4, 360, 58);
      const nameText = this.put(this.nameBuffer, 4, 0xf2f5fa, w / 2, h * 0.4 + 11);
      this.markCaret(nameText, 4);
      this.put('TYPE YOUR NAME', 2, MUTE, w / 2, h * 0.4 + 82);
      this.button('CONFIRM', w / 2, h * 0.4 + 116, 240,
        this.nameBuffer.trim().length >= 2 ? () => this.confirmName() : null, { size: 3 });
      this.button('BACK', w / 2, h * 0.4 + 172, 160, () => { audio.ui('back'); this.onLeave(); });
      return;
    }
    if (this.stage === 'gate') {
      this.put('PLAY ONLINE', 5, GOLD, w / 2, h * 0.22);
      this.put(`YOU ARE ${this.myName}`, 2, MUTE, w / 2, h * 0.22 + 58);
      this.button(`HOST A PARTY`, w / 2, h * 0.4, 320, () => this.pickHost(), { size: 3 });
      this.button(`JOIN A PARTY`, w / 2, h * 0.4 + 50, 320, () => this.pickJoin(), { size: 3 });
      this.button('CHANGE NAME', w / 2, h * 0.4 + 104, 240, () => {
        audio.ui('move');
        this.stage = 'name';
        this.nameBuffer = this.myName;
        this.rebuild();
      });
      this.button('BACK', w / 2, h * 0.4 + 146, 160, () => { audio.ui('back'); this.onLeave(); });
      this.put('FRIENDS ON YOUR NETWORK OPEN YOUR ADDRESS AND JOIN WITH THE ROOM CODE', 2, MUTE, w / 2, h * 0.4 + 206);
      return;
    }
    if (this.stage === 'code') {
      this.put('JOIN A PARTY', 5, GOLD, w / 2, h * 0.22);
      this.put('THE FOUR LETTERS ON YOUR FRIENDS SCREEN', 2, MUTE, w / 2, h * 0.22 + 58);
      plate(this.panels, w / 2 - 130, h * 0.4, 260, 62);
      const codeText = this.put(this.codeBuffer, 5, 0xf2f5fa, w / 2, h * 0.4 + 8);
      this.markCaret(codeText, 5);
      this.button('JOIN', w / 2, h * 0.4 + 86, 240, this.codeBuffer.length === 4 ? () => this.confirmCode() : null, { size: 3 });
      this.button('BACK', w / 2, h * 0.4 + 142, 160, () => {
        audio.ui('back');
        this.stage = 'gate';
        this.rebuild();
      });
      return;
    }
    if (this.stage === 'connecting') {
      this.put('CONNECTING' + '.'.repeat(1 + (Math.floor(this.caret) % 3)), 4, GOLD, w / 2, h * 0.45);
      return;
    }

    // ------------------------------------------------------------- party
    const lobby = this.lobby;
    if (!lobby) return;
    const nations = this.assets.manifest.nations;
    const nationOf = (id: string) => nations.find((n) => n.id === id) ?? nations[0];
    const me = lobby.seats.find((s) => s.seat === this.mySeat);

    // the code plate — the invitation itself, with air around the letters
    plate(this.panels, w / 2 - 170, 22, 340, 96, GOLD);
    this.put('ROOM CODE', 2, MUTE, w / 2, 38);
    this.put(lobby.code || '....', 6, GOLD, w / 2, 58);
    this.put(this.isHost ? 'FRIENDS OPEN THIS ADDRESS AND ENTER THE CODE' : `YOU ARE IN ${lobby.code}`, 2, MUTE, w / 2, 132);

    if (lobby.phase === 'draft') {
      this.put('THE CAPTAINS ARE BUILDING THE SQUADS', 3, GOLD, w / 2, h * 0.45);
      this.put('HANG TIGHT - THE MATCH STARTS THE MOMENT THE BOARDS ARE FULL', 2, MUTE, w / 2, h * 0.45 + 40);
      return;
    }

    // two national boards
    const bw = Math.min(440, w * 0.34);
    const by = 162;
    const bh = Math.min(h - by - 24, 580);
    const bx0 = w * 0.055;
    const bx1 = w - w * 0.055 - bw;
    const flagW = this.assets.manifest.flags.w * 6;
    const flagH = this.assets.manifest.flags.h * 6;

    ([0, 1] as const).forEach((team) => {
      const bx = team === 0 ? bx0 : bx1;
      const cx = bx + bw / 2;
      const nation = nationOf(lobby.nations[team]);
      const tint = parseInt(nation.color.slice(1), 16);
      const myTeam = me?.team === team;
      const iAmCaptain = !!me?.captain && myTeam;
      plate(this.panels, bx, by, bw, bh, tint);

      // the flag flies at the top — captains get arrows, and the flag
      // itself is a button that cycles forward
      const flag = team === 0 ? this.flagL : this.flagR;
      flag.texture = this.assets.flagFor[nation.id];
      flag.visible = true;
      flag.scale.set(6);
      flag.position.set(Math.round(cx - flagW / 2), by + 18);
      if (iAmCaptain) {
        flag.eventMode = 'static';
        flag.cursor = 'pointer';
        flag.removeAllListeners();
        flag.on('pointertap', () => { this.onNation(1); audio.ui('move'); });
        this.button('<', cx - flagW / 2 - 46, by + 26, 32, () => { this.onNation(-1); audio.ui('move'); });
        this.button('>', cx + flagW / 2 + 46, by + 26, 32, () => { this.onNation(1); audio.ui('move'); });
      } else {
        flag.eventMode = 'none';
      }

      // team name, then the nation underneath ONLY when a custom name hides it
      const custom = lobby.teamNames[team];
      const naming = this.renaming && iAmCaptain;
      const nameText = this.put(naming ? this.renameBuffer : (custom || nation.name), 4, 0xf2f5fa, cx, by + flagH + 34);
      if (naming) this.markCaret(nameText, 4);
      let rowY = by + flagH + 68;
      if (custom && !naming) {
        this.put(nation.name, 2, MUTE, cx, rowY);
        rowY += 24;
      }
      // kit swatch: shirt and change shirt, a whisper of the wardrobe
      this.panels.rect(cx - 23, rowY + 2, 20, 12).fill({ color: tint, alpha: 0.95 });
      this.panels.rect(cx + 3, rowY + 2, 20, 12).fill({ color: 0xf2f5fa, alpha: 0.8 });
      rowY += 30;

      // the board's own buttons: join/leave, and the captain's rename
      const half = (bw - 56) / 2;
      if (!myTeam) {
        this.button(`JOIN ${nation.name}`, cx, rowY, bw - 44, () => { this.onClaim(team); audio.ui('move'); });
      } else if (iAmCaptain) {
        this.button('LEAVE', bx + 22 + half / 2, rowY, half, () => { this.onClaim(null); audio.ui('back'); });
        this.button(naming ? 'DONE' : 'RENAME', bx + bw - 22 - half / 2, rowY, half,
          () => (naming ? this.confirmRename() : this.startRename()));
      } else {
        this.button('LEAVE', cx, rowY, bw - 44, () => { this.onClaim(null); audio.ui('back'); });
      }
      rowY += 46;

      // eleven chairs, roomy
      const pitch = Math.max(22, Math.min(28, Math.floor((by + bh - rowY - 14) / 11)));
      const humans = lobby.seats.filter((s) => s.team === team);
      for (let i = 0; i < 11; i++) {
        const cy = rowY + i * pitch;
        const seat = humans[i];
        const meHere = seat && seat.seat === this.mySeat;
        this.panels.rect(bx + 16, cy, bw - 32, pitch - 4).fill({ color: seat ? 0x161b26 : 0x10141c, alpha: seat ? 0.95 : 0.5 });
        this.panels.rect(bx + 16, cy, 3, pitch - 4).fill({ color: seat ? (meHere ? GOLD : 0x9cc4f0) : 0x2a3040, alpha: 0.9 });
        if (seat) {
          this.put(`${seat.name}${seat.ready ? '  OK' : ''}`,
            2, meHere ? GOLD : 0xdfe4ee, bx + 30, cy + Math.round((pitch - 4 - 14) / 2), false);
        } else {
          this.put('AI', 2, 0x3d4454, bx + 30, cy + Math.round((pitch - 4 - 14) / 2), false);
        }
      }
    });

    // the unseated, floating in the middle
    const floaters = lobby.seats.filter((s) => s.team === null);
    if (floaters.length) {
      this.put('IN THE TUNNEL', 2, MUTE, w / 2, by + 26);
      floaters.forEach((s, i) => {
        this.put(s.name + (s.seat === this.mySeat ? '  (YOU)' : ''), 2, s.seat === this.mySeat ? GOLD : 0xdfe4ee, w / 2, by + 50 + i * 22);
      });
    }

    // the center console: match settings, ready, and the big gold button
    const allReady = lobby.seats.every((s) => s.seat === 0 || s.team === null || s.ready);
    if (this.isHost) {
      this.button(`MODE  ${lobby.mode.toUpperCase()}`, w / 2 - 128, h - 216, 240, () => { this.onMode(); audio.ui('move'); });
      this.button(`HALF  ${HALF_NAMES[lobby.half] ?? lobby.half + 'S'}`, w / 2 + 128, h - 216, 240, () => { this.onHalf(); audio.ui('move'); });
      this.button(me?.ready ? 'UNREADY' : 'READY UP', w / 2, h - 172, 240, () => { this.onReady(); audio.ui('select'); });
      this.button('KICK THE PARTY OFF', w / 2, h - 124, 320, allReady ? () => this.onStart() : null, { size: 3, color: GOLD });
      if (!allReady) this.put('WAITING FOR EVERYONE TO READY UP', 2, MUTE, w / 2, h - 76);
    } else if (me) {
      this.button(me.ready ? 'UNREADY' : 'READY UP', w / 2, h - 148, 240, () => { this.onReady(); audio.ui('select'); }, { size: 3 });
    }

    const hints = [
      'A JOIN LEFT - D JOIN RIGHT - X STAND DOWN',
      ...(me?.captain ? ['W S NATION - N RENAME'] : []),
      'F READY',
      ...(this.isHost ? ['ENTER STARTS'] : []),
      'ESC LEAVES',
    ];
    this.put(hints.join('   '), 2, 0x565d6d, w / 2, h - 40);
  }
}
