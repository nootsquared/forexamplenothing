import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Vec2, vec, add, sub, scale, dist, clamp, clampLen } from '../core/math';
import { PITCH } from '../sim/constants';
import { PlayerInput, PlayerStats } from '../sim/player';
import { Match } from '../match';
import { Scene } from '../render/scene';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { pxPerMeter, squash } from '../render/projection';
import { GOLD, MINT, PixelList, centerRow, externalLink } from './kit';
import { pads, PadButton } from '../input/gamepad';
import { audio } from '../audio/engine';

// The tutorial: a coach on the touchline. Cards say one thing at a time, then
// the field hands it to you — the ledger ticks off top-left and the coach talks
// from a bar along the bottom rail, outside the play, where he can never sit on
// the ball or on your man. Nothing here advances on its own: a finished drill
// leaves the ball at your feet until you say you're ready.

type Seg = string | { key: string };
type Card = { kind: 'card'; lines: Seg[][]; link?: { label: string; url: string } };
type Objective = { label: string; done: () => boolean };
type Stage = {
  kind: 'stage';
  line: string;         // what the coach says while you work
  zoom?: number;        // an attacking drill wants a wider lens than a walk
  focus?: () => Vec2;   // ...and a point the lens leans toward
  arrange: () => void;
  objectives: Objective[];
  tick?: (dt: number) => void;
  cleanup?: () => void;
  allowSwitch?: boolean;
  tank?: boolean;       // the legs meter rides the ledger — sprint costs something
};
type Step = Card | Stage | { kind: 'tour' } | { kind: 'choice' };
type Row = { label: string; run: () => void };

// The two hands this game is played with. Every card, coach line and checkbox
// asks here first, so a pad player is never told to press W — and a keyboard
// player is never told about a stick he hasn't got.
const pad = () => pads.connected;
const KEY = {
  sprint: () => (pad() ? 'RB' : 'SHIFT'),
  swap: () => (pad() ? 'LB' : 'E'),
  clamp: () => (pad() ? 'B' : 'SPACE'),
  go: () => (pad() ? 'A' : 'ENTER'),
};
const SAY = {
  move: () => (pad() ? 'THE LEFT STICK' : 'W A S D'),
  moveCaps: (): Seg[] => (pad() ? [{ key: 'LS' }] : [{ key: 'W' }, { key: 'A' }, { key: 'S' }, { key: 'D' }]),
  sprint: () => (pad() ? 'HOLD RB' : 'HOLD SHIFT'),
  sling: () => (pad() ? 'PULL THE RIGHT STICK BACK. LET IT SPRING.' : 'CLICK AND DRAG BACK. THEN LET GO.'),
  slingHow: () => (pad() ? 'PULL THE RIGHT STICK BACK AND LET IT SPRING' : 'CLICK ANYWHERE AND DRAG BACKWARD THEN LET GO'),
  swap: () => (pad() ? 'PRESS LB' : 'PRESS E'),
  clampHow: () => (pad() ? 'HOLD B' : 'HOLD SPACE'),
};
// The four legs of the movement drill, in whichever hand is holding the game
const STEPS_OF_MOVE: [string, string][] = [['W', 'UP'], ['A', 'LEFT'], ['S', 'DOWN'], ['D', 'RIGHT']];
const moveLabel = (i: number) => (pad() ? `PUSH THE STICK ${STEPS_OF_MOVE[i][1]}` : `PRESS ${STEPS_OF_MOVE[i][0]}`);

const IDLE = (): PlayerInput => ({ move: vec(), sprint: false, kickCharging: false, kickReleased: null });
const GRAY_BOOTS: Partial<PlayerStats> = { pass: 0.18, longBall: 0.08, shoot: 0.2, control: 0.4 };
const COACH_PICK: Partial<PlayerStats> = { pass: 0.93, longBall: 0.88, shoot: 0.86, control: 0.92 };
const KEEPER_HANDS: Partial<PlayerStats> = { dive: 0.92, reflex: 0.9, agility: 0.82, handling: 0.9 };
const TYPE_CPS = 44;      // characters a second — quick to read, never a wall
const TICK_EVERY = 3;     // ...and a soft key tick every few of them
const DRILL_ZOOM = 2.6;   // the lens the real match plays at, not a pinned wide shot
const WIDE_ZOOM = 2.15;   // ...opened a notch when a drill spans the box
const REST_BEAT = 1.3;    // stillness before any re-stage moves a body
const GK_REACH = 3.4;     // meters a dive covers — past it the keeper is beaten, honestly
const GK_REACT = 1.2;     // seconds of flight inside which a ball is a SHOT to him
const GK_STEP = 0.28;     // his sideways shuffle: a keeper covers his goal on foot
const DEAD_BEAT = 1.1;    // seconds a ball may lie out of reach before the coach fetches it
const LEAN_CAP = 10;      // meters the lens may drift off your man toward the play
const FRAME_AIR = 5;      // ...and the air kept around whatever the lens must hold
const DRILL_FLOOR = 1.5;  // however far a drill spreads, men still have to read as men
const BALL_WALL = 1.5;    // how far inside each line the drill's soft walls turn the ball back
const BENCH_Y = 0.4;      // ...and how far OUTSIDE it the gallery stands (the sim's own body clamp)
const TOUR_HOLD = 3.6;    // seconds a tour shot holds before it moves on
const TOUR_LAST = 2;      // ...and the shot that waits for you instead
const TOUR_SWEEP = 5;     // seconds the last shot takes to travel the whole length
const TOUR_ZOOM = 1.95;   // ...at a lens close enough that the goals read as goals
const PAGE_COOL = 0.25;   // a turned page is deaf this long — no click storms
const TOP_PAD = 26;       // a card's air above its first line — and below its last
const PROMPT_GAP = 12;    // ...with this beat between the copy and the prompt
const TANK_W = 96;        // the drill's legs meter, in screen pixels
const TANK_CELLS = 8;     // ...drained a cell at a time, like the match HUD's
const LEGS_LOW = 0.45;    // the tank the sprint drill asks you to burn down to
const SPENT = 'THOSE ARE HIS LEGS GONE. JOG A MOMENT AND THEY COME BACK.';
const STEP_KEY = 't22.tutorialStep';
const DONE_KEY = 't22.tutorialDone';
const goodJob = () => `GOOD JOB. PRESS ${KEY.go()} WHEN YOU ARE READY`;
// Keys that are NOT "any button": Enter arrives through the shell (and off the
// pad's A), and a modifier held on its own is not an answer to anything
// ...and the pad buttons that DO turn one. Start is the shell's pause and A
// already arrives dressed as Enter, so neither is listed twice.
const PAD_PAGE: PadButton[] = ['a', 'b', 'x', 'y', 'lb', 'rb'];
const DEAF = new Set([
  'Enter', 'NumpadEnter', 'Escape', 'Tab', 'CapsLock', 'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);
const FAR_POST = vec(PITCH.length - 4.5, PITCH.width / 2 - 4);   // six-yard box, back stick
const DUEL_POST = vec(90, 27);
const INK = 0xdfe4ee;
const DIM_INK = 0x8a91a0;
const CLOTH = 0x0d1119;
const BAR_PAD = 16;
const BAR_MAX = 1120;
const PORTRAIT = 60;      // the manager plate: the 30x28 sprite at 2x
const ROW_H = 22;

// The typewriter: one character at a time across a run of pixel rows, with a
// soft key tick every few of them. Any press fills what's left instantly.
class Typer {
  done = true;
  private budget = 0;
  private total = 0;
  private struck = 0;
  private targets: { obj: PixelText | Container; chars: number }[] = [];

  start(targets: { obj: PixelText | Container; chars: number }[]) {
    this.targets = targets;
    this.total = targets.reduce((n, t) => n + t.chars, 0);
    this.budget = 0;
    this.struck = 0;
    this.done = this.total === 0;
    this.paint();
  }

  fill() {
    this.budget = this.total;
    this.done = true;
    this.paint();
  }

  update(dt: number) {
    if (this.done) return;
    this.budget = Math.min(this.total, this.budget + dt * TYPE_CPS);
    const keys = Math.floor(this.budget / TICK_EVERY);
    if (keys > this.struck) {
      this.struck = keys;
      audio.ui('tick', 0.18);
    }
    if (this.budget >= this.total) this.done = true;
    this.paint();
  }

  // letters bleed in one by one; a keycap is a single glyph and lands whole
  private paint() {
    let used = 0;
    for (const t of this.targets) {
      const shown = clamp((this.budget - used) / Math.max(1, t.chars), 0, 1);
      if (t.obj instanceof PixelText) {
        t.obj.visible = shown > 0;
        t.obj.reveal = shown;
      } else {
        t.obj.visible = shown >= 1;
      }
      used += t.chars;
    }
  }
}

export class Tutorial {
  root = new Container();
  done = false;             // set when the player leaves through the finale
  hideWedge = false;        // early kicks show a plain line, the arc comes later
  capPower = 0;             // 0 = uncapped; early kicks are gentled
  visible = new Set<number>();
  private steps: Step[] = [];
  private stepIdx = -1;
  private mode: 'card' | 'stage' | 'tour' | 'choice' | 'menu' = 'card';
  private t = 0;
  private blinkT = 0;
  private lastW = 0;
  private lastH = 0;
  private typer = new Typer();
  private pageCool = 0;   // a freshly turned page is deaf for a beat
  private wasPad = pad(); // ...and a pad plugged in mid-lesson re-reads the page
  // cards
  private dim = new Graphics();
  private cardBox = new Container();
  private cardPanel: Container | null = null;
  private cardPrompt: PixelText | null = null;
  private cardBounds: { x: number; y: number; w: number; h: number } | null = null;
  private linkBox: { x: number; y: number; w: number; h: number } | null = null;
  // the coach bar
  private bar = new Container();
  private barPlate = new Graphics();
  private barRows = new Container();
  private barPrompt: PixelText;
  private barEsc: PixelText;
  private coachFig: Sprite;
  private coachIdle: Texture[];
  private line = '';
  private linePrompt = false;
  // the ledger
  private objPanel = new Container();
  private objViews: { box: Graphics; label: PixelText; hit: boolean }[] = [];
  private legs: Graphics | null = null; // the drill's own stamina tank
  private legsSaid = 0;                 // 0 not yet, 1 the coach called it, 2 he took it back
  // the finale, the pause board and the resume offer all wear the same panel
  private choice: PixelList | null = null;
  private menuBox = new Container();
  private menuPanel: Container | null = null;
  private menuRows: Row[] = [];
  private menuBack: (() => void) | null = null;
  private modeBeforeMenu: 'card' | 'stage' | 'tour' | 'choice' = 'card';
  // the drill floor
  private heroIdx = 0;
  private cast: number[] = [];
  private wearing = 0;
  private actors = new Map<number, PlayerInput>();
  private stash = new Map<number, PlayerStats>();
  private pending: { redo: () => void; wait: number } | null = null;
  private holding = false;
  private camZoom = DRILL_ZOOM;
  private prevIdx = -1;
  private prevPos: Vec2 = vec();
  private walked = 0;
  private swapWalk = 0;
  private carried = 0;
  private survived = 0;
  private deadT = 0;
  private startCursor = 0;
  private moveSeen = { w: false, a: false, s: false, d: false, sprint: false };
  private kicks: number[] = [];
  private myKickFlying = false;
  private crossed = false;
  private goalAny = false;
  private goalAfterPass = false;
  private tourBeat = 0;
  private tourT = 0;
  private onKey: (e: KeyboardEvent) => void;
  private onPoint: (e: PointerEvent) => void;

  constructor(
    private assets: GameAssets,
    private match: Match,
    private scene: Scene,
    private hooks: { assign: (i: number) => void; cursorIdx: () => number; exit: (kind: 'menu' | 'training' | 'easy') => void },
  ) {
    this.coachIdle = [assets.players.home[4][0], assets.players.home[4][1]]; // front-on, breathing
    this.coachFig = new Sprite(this.coachIdle[0]);
    this.coachFig.scale.set(2);
    this.barPrompt = new PixelText(assets, 2, GOLD);
    this.barPrompt.text = '>';
    // The way out, printed where a stuck player will actually look. An escape
    // hatch nobody has been told about is the same as no escape hatch.
    this.barEsc = new PixelText(assets, 2, DIM_INK, 'micro');
    this.barEsc.text = 'ESC  PAUSE / SKIP';
    this.bar.addChild(this.barPlate, this.coachFig, this.barRows, this.barPrompt, this.barEsc);
    this.bar.visible = false;
    this.root.addChild(this.dim, this.objPanel, this.bar, this.cardBox, this.menuBox);
    match.world.players.forEach((_, i) => this.visible.add(i));
    match.world.offsideEnabled = false; // no flag in school: drills stage men where they help
    match.world.foulsEnabled = false;   // ...and no spot kick either: only the coach moves bodies
    // Letters, Space and the mouse never reach the shell during a match, so the
    // coach listens for them himself — the page really does turn on any button.
    // ESC is his too, and he takes it BEFORE the shell can throw the room away:
    // one stray pause reflex must never cost a rookie the whole lesson.
    this.onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !this.done) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.openPause();
        return;
      }
      if (e.repeat || DEAF.has(e.code)) return;
      if (this.mode === 'card' || this.mode === 'tour') this.advance();
    };
    // ...and a click only turns the page ON the card. Clicking the grass is a
    // kick you were just taught to make, never five pages of reading skipped.
    this.onPoint = (e: PointerEvent) => {
      if (this.mode === 'tour') return this.advance(); // no card out here to miss
      if (this.mode !== 'card') return;
      if (this.inLink(e.clientX, e.clientY) || !this.inCard(e.clientX, e.clientY)) return;
      this.advance();
    };
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerdown', this.onPoint);
    this.steps = this.script();
    // A lesson quit halfway is not lost: the coach offers the page you left on
    const saved = this.savedStep();
    if (saved > 0) this.offerResume(saved);
    else this.next();
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointerdown', this.onPoint);
    this.restoreStats();
    this.match.world.offsideEnabled = true;
    this.match.world.foulsEnabled = true;
    this.scene.setCameraOverride(null);
    this.root.destroy({ children: true });
  }

  // ------------------------------------------------------------ the ground
  private world() { return this.match.world; }
  private events() { return this.world().events; }
  private me() { return this.world().players[this.hooks.cursorIdx()]; }
  private homeOf(role: string, nth = 0): number {
    const w = this.world();
    let seen = 0;
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].id.team === 0 && w.players[i].id.role === role && seen++ === nth) return i;
    }
    return 1;
  }
  private awayOf(role: string, nth = 0): number {
    const w = this.world();
    let seen = 0;
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].id.team === 1 && w.players[i].id.role === role && seen++ === nth) return i;
    }
    return 12;
  }
  private put(i: number, x: number, y: number) {
    const p = this.world().players[i];
    p.pos.x = x; p.pos.y = y; p.vel = vec(); p.savePrev();
  }
  // A ball the coach has just put down: nobody has played it yet, so the last
  // touch of some other lesson never gets to tick a box or claim a latch
  private ballAt(x: number, y: number, vz = 0) {
    const w = this.world();
    const b = w.ball;
    b.pos.x = x; b.pos.y = y; b.vel = vec(); b.z = vz > 0 ? 0.01 : 0; b.vz = vz; b.spin = 0; b.savePrev();
    w.lastTouch = null;
    w.carrier = null;
  }
  private clearLocks() {
    const w = this.world();
    w.restartLock = 0; w.restartExclusion = 0; w.holdLock = false; w.holdingGk = -1;
    w.abortGoalReset(); // a drill never waits on confetti, and never gets teleported by it
  }
  private setHero(i: number) {
    this.heroIdx = i;
    this.wearing = i;
    this.hooks.assign(i);
  }
  // The odometer starts where the drill just put you — being carried to your
  // mark is not walking, and it must never tick a box off on its own
  private baselineStep() {
    this.prevIdx = this.hooks.cursorIdx();
    this.prevPos = vec(this.me().pos.x, this.me().pos.y);
  }
  private dress(i: number, over: Partial<PlayerStats>) {
    const p = this.world().players[i];
    if (!this.stash.has(i)) this.stash.set(i, { ...p.stats });
    p.stats = { ...p.stats, ...over };
  }
  private restoreStats() {
    for (const [i, s] of this.stash) this.world().players[i].stats = s;
    this.stash.clear();
  }
  // Drills get a clean runway: everyone not in the lesson watches from BEYOND
  // the touchlines like a real training gallery — parked past the soft walls,
  // so a benched man can never trap a ball or shoulder you with a body nobody
  // can see. The cast is the only place control is ever allowed to land.
  private clearField(involved: number[]) {
    const w = this.world();
    let n0 = 0;
    let n1 = 0;
    w.players.forEach((p, i) => {
      if (involved.includes(i)) { this.scene.setPlayerHidden(i, false); this.visible.add(i); return; }
      if (p.id.team === 0) this.put(i, 22 + n0++ * 7, PITCH.width + BENCH_Y);
      else this.put(i, 22 + n1++ * 7, -BENCH_Y);
      this.scene.setPlayerHidden(i, true);
      this.visible.delete(i);
    });
    this.cast = involved.filter((i) => w.players[i].id.team === 0 && w.players[i].id.role !== 'GK');
  }
  private showEveryone() {
    this.world().players.forEach((_, i) => { this.scene.setPlayerHidden(i, false); this.visible.add(i); });
  }
  // The coach fetches: a rocketed ball respots at your feet instead of
  // demanding a hike across the county
  private refetch() {
    const w = this.world();
    const h = this.me();
    if (dist(w.ball.pos, h.pos) > 22 && w.ball.speed() < 1 && w.ball.z < 0.2) {
      this.ballAt(h.pos.x + h.facing.x * 1.3, h.pos.y + h.facing.y * 1.3);
      this.scene.toast('FRESH BALL');
    }
  }

  // --------------------------------------------------------------- scripts
  private script(): Step[] {
    const K = (k: string) => ({ key: k });
    return [
      { kind: 'card', lines: [
          ['WELCOME TO TOTAL22'],
          ['THIS TUTORIAL PUTS YOUR HANDS ON EVERYTHING'],
          ['IT ASSUMES YOU ALREADY KNOW SOCCER'],
        ], link: { label: 'NEW TO SOCCER - THE BASICS ON WIKIPEDIA', url: 'https://en.wikipedia.org/wiki/Association_football' } },
      { kind: 'card', lines: [
          ['A QUICK RECAP OF THE RULES HERE'],
          ['ELEVEN A SIDE INCLUDING A GOALIE'],
          ['TWO HALVES AND THE MOST GOALS WINS'],
          ['OFFSIDE IS FLAGGED. STAY BEHIND THEIR LAST MAN'],
          ['A BAD TACKLE IN THE BOX IS A FREE KICK'],
          ['NOWHERE ELSE STOPS THE GAME. PLAY ON'],
          ['THE CLOCK ADDS ON THE TIME THE BALL WAS DEAD'],
        ] },
      { kind: 'tour' },
      { kind: 'card', lines: [
          ['EVERY POSITION PLAYS DIFFERENTLY'],
          ['DEFENDERS TACKLE HARD BUT SHOOT BADLY'],
          ['MIDFIELDERS PASS AND CARRY THE BALL BEST'],
          ['FORWARDS ARE FAST AND FINISH BUT DO NOT DEFEND'],
        ] },
      { kind: 'card', lines: [
          ['YOU CONTROL ONE PLAYER AT A TIME'],
          ['EVERYONE ELSE THINKS FOR THEMSELVES'],
          [...SAY.moveCaps(), ' MOVES YOU AND ', K(KEY.sprint()), ' SPRINTS'],
          ...(pad() ? [] : [['THE ARROW KEYS MOVE YOU TOO' as Seg]]),
        ] },
      {
        kind: 'stage', tank: true,
        line: `USE ${SAY.move()} TO WALK ME AROUND. ${SAY.sprint()} TO SPRINT - HIS LEGS RUN OUT AND COME BACK.`,
        arrange: () => {
          this.setHero(this.homeOf('MF', 1));
          this.clearField([this.heroIdx]);
          this.put(this.heroIdx, 57, 37);
          this.ballAt(57, 11); // parked off camera: this beat is about your feet
          this.moveSeen = { w: false, a: false, s: false, d: false, sprint: false };
          this.legsSaid = 0;
        },
        objectives: [
          { label: moveLabel(0), done: () => this.moveSeen.w },
          { label: moveLabel(1), done: () => this.moveSeen.a },
          { label: moveLabel(2), done: () => this.moveSeen.s },
          { label: moveLabel(3), done: () => this.moveSeen.d },
          { label: `${SAY.sprint()} TO SPRINT`, done: () => this.moveSeen.sprint },
          { label: 'RUN THE LEGS DOWN TO HALF', done: () => this.me().stamina <= LEGS_LOW },
        ],
        tick: () => this.watchLegs(),
      },
      {
        kind: 'stage', line: 'A BALL. WALK INTO IT AND KEEP MOVING TO DRIBBLE.',
        arrange: () => this.ballAt(this.me().pos.x + 5, this.me().pos.y, 7),
        objectives: [
          { label: 'TOUCH THE BALL', done: () => this.world().lastTouch?.idx === this.heroIdx },
          { label: 'CARRY IT 12 METERS', done: () => this.carried > 12 },
        ],
      },
      { kind: 'card', lines: [
          ['KICKING IS ONE MOTION'],
          [SAY.slingHow()],
          ['THE BALL FLIES THE OTHER WAY LIKE A SLINGSHOT'],
          ['SOFT PULL SOFT BALL. HARD PULL ROCKET.'],
        ] },
      {
        kind: 'stage', line: SAY.sling(),
        arrange: () => {
          this.hideWedge = true;
          this.capPower = 0.55;
          this.ballAt(this.me().pos.x + 1.2, this.me().pos.y);
        },
        objectives: [{ label: 'KICK THE BALL', done: () => this.kicks.length > 0 }],
        cleanup: () => { this.hideWedge = false; this.capPower = 0; },
      },
      { kind: 'card', lines: [
          ['POWER COSTS ACCURACY'],
          ['THE HARDER YOU KICK THE LESS ACCURATE IT IS'],
          ['THE ARC ON THE GRASS SHOWS WHERE IT CAN END UP'],
          ['BETTER PLAYERS HAVE A NARROWER ARC'],
        ] },
      {
        kind: 'stage', line: 'TRY ONE SOFT KICK AND ONE AT FULL POWER.',
        arrange: () => {
          this.dress(this.heroIdx, COACH_PICK);
          this.ballAt(this.me().pos.x + 1.2, this.me().pos.y);
        },
        objectives: [
          { label: 'A SOFT KICK', done: () => this.kicks.some((p) => p <= 0.6) },
          { label: 'A FULL POWER KICK', done: () => this.kicks.some((p) => p >= 0.8) },
        ],
        tick: () => this.refetch(),
      },
      {
        kind: 'stage', line: 'THIS MAN IS A BAD KICKER. LOOK HOW WIDE HIS ARC IS. HIT IT ANYWAY.',
        arrange: () => {
          this.restoreStats();
          this.dress(this.heroIdx, GRAY_BOOTS);
          this.ballAt(this.me().pos.x + 1.2, this.me().pos.y);
        },
        objectives: [{ label: 'HIT IT ANYWAY', done: () => this.kicks.length > 0 }],
        tick: () => this.refetch(),
        cleanup: () => this.restoreStats(),
      },
      { kind: 'card', lines: [
          ['SWITCHING BODIES'],
          ['THE GOLD ARROW POINTS AT THE PLAYER YOU ARE'],
          ['THE GREY ARROW IS WHO YOU CAN SWAP TO'],
          ['PRESS ', K(KEY.swap()), ' TO CONTROL THE OTHER PLAYER'],
          ...(pad() ? [] : [['OR CLICK A TEAMMATE TO TAKE HIM' as Seg]]),
        ] },
      {
        kind: 'stage', allowSwitch: true,
        line: `WALK A FEW STEPS. THEN ${SAY.swap()} TO CONTROL THE OTHER PLAYER AND WALK HIM.`,
        arrange: () => this.arrangeSwap(),
        objectives: [
          { label: 'WALK A FEW STEPS', done: () => this.walked > 2.5 },
          { label: `${SAY.swap()} TO CONTROL THE OTHER MAN`, done: () => this.hooks.cursorIdx() !== this.startCursor },
          { label: 'WALK THE NEW MAN', done: () => this.swapWalk > 4 },
        ],
      },
      { kind: 'card', lines: [
          ['WHEN YOU PASS TO A PLAYER'],
          ['YOU AUTOMATICALLY BECOME THAT PLAYER'],
          ['SO YOU CAN MAKE THE PLAYS YOURSELF'],
          [pad() ? 'PULL THE STICK AWAY FROM HIM. LET IT SPRING.' : 'DRAG BACK. AIM AT YOUR TEAMMATE. LET GO.'],
        ] },
      {
        kind: 'stage', allowSwitch: true,
        line: 'COMPLETE A PASS TO YOUR TEAMMATE TO TAKE CONTROL OF YOUR TEAMMATE.',
        focus: () => this.world().players[this.homeOf('FW', 0)].pos,
        arrange: () => this.arrangePass(),
        objectives: [
          { label: 'PASS TO HIM', done: () => this.world().lastTouch?.idx === this.homeOf('FW', 0) },
          { label: 'YOU ARE HIM NOW', done: () => this.hooks.cursorIdx() === this.homeOf('FW', 0) },
        ],
        tick: (dt) => {
          this.tickReceiver(this.homeOf('FW', 0), vec(68, 33));
          if (!this.pending) this.staleBall(dt, 'THAT ONE GOT AWAY. TRY THE PASS AGAIN.', () => this.arrangePass());
        },
        cleanup: () => this.restoreStats(),
      },
      { kind: 'card', lines: [
          ['TIME TO SCORE'],
          ['THE KEEPER COVERS THE SIDE THE BALL IS ON'],
          ['SHOOT FROM THE WING AND HE WILL DIVE ON IT'],
          ['PASS ACROSS TO THE FAR POST FIRST'],
          ['HE CANNOT GET BACK IN TIME AND YOU TAP IT IN'],
        ] },
      {
        kind: 'stage', allowSwitch: true, zoom: WIDE_ZOOM,
        line: 'DRIBBLE UP THE RIGHT WING. PASS ACROSS TO YOUR TEAMMATE. THEN SCORE.',
        focus: () => FAR_POST,
        arrange: () => this.arrangeCross(),
        objectives: [
          { label: 'REACH THE RIGHT WING', done: () => this.me().pos.x > 96 && this.me().pos.y > 44 && this.world().carrier?.idx === this.hooks.cursorIdx() },
          { label: 'PASS ACROSS THE GOAL', done: () => this.crossed },
          { label: 'SCORE AFTER THE PASS', done: () => this.goalAfterPass },
        ],
        tick: (dt) => this.tickCross(dt),
      },
      { kind: 'card', lines: [
          ['HERE IS HOW TO DEFEND AGAINST A PLAYER'],
          ['FIRST GET CLOSE TO THE BALL CARRIER'],
          ['1. TAP ', K(KEY.clamp()), ' TO LUNGE AT HIM'],
          ['A LUNGE OFTEN MISSES AND HE RUNS PAST YOU'],
          ['2. HOLD ', K(KEY.clamp()), ' TO CLAMP HIM INSTEAD'],
          ['IT TAKES LONGER BUT THE BALL IS THEN YOURS'],
        ] },
      {
        kind: 'stage', zoom: 2.45,
        line: `GET CLOSE AND ${SAY.clampHow()} UNTIL THE MARK CLOSES. THEN GO SCORE.`,
        focus: () => vec(this.world().goalXOf(0), PITCH.width / 2),
        arrange: () => this.arrangeSteal(),
        objectives: [
          { label: 'TAKE THE BALL OFF HIM', done: () => this.world().carrier?.idx === this.heroIdx },
          { label: 'SCORE ON THEIR GOAL', done: () => this.goalAny },
        ],
        tick: (dt) => this.tickSteal(dt),
        cleanup: () => this.restoreStats(),
      },
      { kind: 'card', lines: [
          ['LAST DRILL. A REAL DEFENDER CHASES YOU NOW'],
          ['HE WILL CLAMP YOU THE WAY YOU JUST CLAMPED HIM'],
          ['KEEP THE BALL AWAY FROM HIM'],
          ['THEN PASS TO YOUR TEAMMATE AND SCORE'],
        ] },
      {
        kind: 'stage', allowSwitch: true, zoom: WIDE_ZOOM,
        line: 'HE IS COMING FOR THE BALL. KEEP IT. THEN PASS AND SCORE.',
        focus: () => DUEL_POST,
        arrange: () => this.arrangeDuel(),
        objectives: [
          { label: 'KEEP IT FOR FOUR SECONDS', done: () => this.survived > 4 },
          { label: 'PASS TO YOUR TEAMMATE', done: () => this.crossed },
          { label: 'SCORE AFTER THE PASS', done: () => this.goalAfterPass },
        ],
        tick: (dt) => this.tickDuel(dt),
        cleanup: () => this.restoreStats(),
      },
      { kind: 'card', lines: [
          ['A FEW LAST RULES'],
          ['BALL OVER A SIDE LINE IS A THROW IN'],
          ['OVER THEIR END LINE OFF THEM IS YOUR CORNER'],
          ['YOUR KEEPER THROWS OR PUNTS THE BALL BY HAND'],
          ['THROWS AND PUNTS BOTH GET A SIGHT'],
          ['IT TELLS YOU WHICH KEYS TO USE. JUST READ IT'],
          ['AND NOBODY TACKLES FOR YOU. THAT IS YOUR JOB.'],
        ] },
      { kind: 'choice' },
    ];
  }

  // ----------------------------------------------------------- drill setups
  private arrangeSwap() {
    const buddy = this.homeOf('MF', 2);
    this.setHero(this.homeOf('MF', 1));
    this.clearField([this.heroIdx, buddy]);
    this.put(this.heroIdx, 54, 37);
    this.put(buddy, 62, 37);
    // no ball in this one — it is about BODIES. It waits off camera, nearer the
    // buddy than any benched man, so the grey arrow still finds him
    this.ballAt(60, 11);
    this.startCursor = this.heroIdx;
  }
  private arrangePass() {
    const mate = this.homeOf('FW', 0);
    this.setHero(this.homeOf('MF', 1));
    this.clearField([this.heroIdx, mate]);
    this.dress(this.heroIdx, COACH_PICK);
    this.put(this.heroIdx, 54, 37);
    this.put(mate, 68, 33);
    this.ballAt(55.2, 37);
  }
  private arrangeCross() {
    const mate = this.homeOf('FW', 0);
    const gk = this.awayOf('GK', 0);
    this.setHero(this.homeOf('MF', 1));
    this.clearField([this.heroIdx, mate, gk]);
    this.dress(this.heroIdx, COACH_PICK);
    this.dress(mate, COACH_PICK);
    this.dress(gk, KEEPER_HANDS);
    this.put(this.heroIdx, 86, 50);
    this.put(mate, FAR_POST.x, FAR_POST.y);
    this.put(gk, PITCH.length - 0.8, PITCH.width / 2 + 2);
    this.ballAt(87.2, 50);
  }
  private arrangeSteal() {
    const victim = this.awayOf('MF', 0);
    const gk = this.awayOf('GK', 0);
    this.setHero(this.homeOf('DF', 0));
    this.clearField([this.heroIdx, victim, gk]);
    this.dress(victim, { control: 0.18, phys: 0.35 }); // lesson one: he barely fights the jaws
    this.dress(this.heroIdx, { shoot: 0.7, control: 0.8 });
    this.put(this.heroIdx, 74, 37);
    this.put(victim, 82, 37);
    this.put(gk, PITCH.length - 0.8, PITCH.width / 2); // in his mouth, where a keeper lives
    this.ballAt(81.4, 37);
    this.world().carrier = { idx: victim, t: 0.8 };
    this.world().lastTouch = { team: 1, idx: victim }; // it is HIS ball until you take it
  }
  private arrangeDuel() {
    const mate = this.homeOf('FW', 0);
    const hunter = this.awayOf('DF', 0);
    const gk = this.awayOf('GK', 0);
    this.setHero(this.homeOf('MF', 1));
    this.clearField([this.heroIdx, mate, hunter, gk]);
    this.dress(this.heroIdx, COACH_PICK);
    this.dress(mate, COACH_PICK);
    this.dress(hunter, { defend: 0.78, phys: 0.72 });
    this.put(this.heroIdx, 68, 40);
    this.put(mate, DUEL_POST.x, DUEL_POST.y);
    this.put(hunter, 78, 39);
    this.put(gk, PITCH.length - 0.8, PITCH.width / 2);
    this.ballAt(69.2, 40);
  }

  // ------------------------------------------------------- scripted bodies
  // A drill receiver: he holds the post the coach gave him and watches the
  // play — no circles, no wandering — and goes for the ball only once it is
  // struck his way or lying loose at his feet
  private tickReceiver(idx: number, post: Vec2) {
    const w = this.world();
    if (idx === this.hooks.cursorIdx()) return;
    const p = w.players[idx];
    const attend = vec(w.ball.pos.x, w.ball.pos.y);
    const toBall = sub(w.ball.pos, p.pos);
    const dBall = Math.hypot(toBall.x, toBall.y);
    if ((w.ball.speed() > 2.5 || dBall < 5) && dBall < 14 && dBall > 0.4 && w.carrier === null) {
      this.actors.set(idx, { ...IDLE(), move: scale(toBall, 1 / dBall), attend });
      return;
    }
    const home = sub(post, p.pos);
    const d = Math.hypot(home.x, home.y);
    this.actors.set(idx, { ...IDLE(), move: d > 0.7 ? scale(home, Math.min(1, d * 0.6) / d) : vec(), attend });
  }

  // The drill keeper: he holds his mouth and nothing else. He shuffles onto the
  // ball's line on real legs — a keeper's sideways step is not a sprint — and
  // he freezes the moment a shot is struck, because from there it is dive or
  // nothing. Cut in alone and he eats it; play it across his face first and he
  // is still on the wrong post when you tap it in.
  private tickKeeper(idx: number, dives: boolean) {
    const w = this.world();
    const g = w.players[idx];
    const b = w.ball;
    const sign = w.attackSign(0);
    const goalX = w.goalXOf(0);
    const flight = (goalX - b.pos.x) * sign;
    const pace = b.vel.x * sign;
    const shot = flight > 0.2 && pace > 6 && flight / pace < GK_REACT;
    const half = PITCH.goalWidth / 2 - 0.6;
    const holdY = clamp(b.pos.y, PITCH.width / 2 - half, PITCH.width / 2 + half);
    const drift = Math.abs(holdY - g.pos.y) > 0.5 ? clamp((holdY - g.pos.y) * 1.1, -GK_STEP, GK_STEP) : 0;
    const input: PlayerInput = {
      ...IDLE(),
      move: vec(clamp((goalX - sign * 0.8 - g.pos.x) * 1.2, -0.4, 0.4), shot ? 0 : drift),
      attend: vec(b.pos.x, b.pos.y),
    };
    if (dives && shot && g.diveTimer <= 0) {
      const t = flight / pace;
      const at = b.pos.y + b.vel.y * t;
      const gap = at - g.pos.y;
      const onTarget = Math.abs(at - PITCH.width / 2) < PITCH.goalWidth / 2 + 0.5;
      if (onTarget && Math.abs(gap) > 0.4 && Math.abs(gap) < GK_REACH) {
        input.dive = { dirY: gap >= 0 ? 1 : -1, height: b.z + b.vz * t > 1.1 ? 1 : 0 };
      }
    }
    this.actors.set(idx, input);
  }

  // A ball that has died out of your reach ends the rep: the coach fetches it
  // instead of making you walk the length of the pitch after it
  private staleBall(dt: number, line: string, redo: () => void) {
    const w = this.world();
    const loose = w.carrier === null && w.ball.speed() < 1 && w.ball.z < 0.4;
    this.deadT = loose && dist(w.ball.pos, this.me().pos) > 9 ? this.deadT + dt : 0;
    if (this.deadT > DEAD_BEAT) this.restage(line, redo);
  }

  // The chaser: he comes at a jog and only sprints from distance, so a rookie
  // can actually get away — and he wins the ball with the jaws you were just
  // taught, never with a lunge that would put the referee in the lesson
  private tickHunter(idx: number) {
    const w = this.world();
    const h = w.players[idx];
    const attend = vec(w.ball.pos.x, w.ball.pos.y);
    if (this.theirBall()) {
      // he has it: a slow weave back toward his own half, never a shot, never
      // a line crossed — the ball stays on the grass until you ask for a reset
      const home = Math.sign(w.goalXOf(1) - h.pos.x) || -1;
      const drift = clamp((clamp(h.pos.y + Math.sin(this.t * 1.3) * 14, 10, PITCH.width - 10) - h.pos.y) * 0.4, -0.45, 0.45);
      this.actors.set(idx, { ...IDLE(), move: vec(home * 0.5, drift), attend });
      return;
    }
    const to = sub(w.ball.pos, h.pos);
    const d = Math.max(0.001, Math.hypot(to.x, to.y));
    this.actors.set(idx, {
      ...IDLE(),
      move: scale(to, 1 / d),
      sprint: d > 6,
      clamp: this.myBall() && d < 2.4,
      attend,
    });
  }

  private myBall() {
    const w = this.world();
    return w.carrier !== null && w.players[w.carrier.idx].id.team === 0;
  }
  private theirBall() {
    const w = this.world();
    return w.carrier !== null && w.players[w.carrier.idx].id.team === 1;
  }

  // ---------------------------------------------------------- drill ticks
  private tickCross(dt: number) {
    const w = this.world();
    const mate = this.homeOf('FW', 0);
    this.tickReceiver(mate, FAR_POST);
    this.tickKeeper(this.awayOf('GK', 0), true);
    if (this.events().some((e) => e.kind === 'kick' && e.idx === this.wearing)) this.myKickFlying = true;
    if (this.myKickFlying && w.lastTouch?.idx === mate) this.crossed = true;
    if (this.pending) return;
    if (this.events().some((e) => e.kind === 'save' || e.kind === 'parry')) {
      this.restage('HE HAD THAT ONE. PASS ACROSS TO THE FAR POST FIRST.', () => this.arrangeCross());
      return;
    }
    this.staleBall(dt, 'THAT ONE IS DEAD. BACK TO THE WING.', () => this.arrangeCross());
  }

  private tickSteal(dt: number) {
    const w = this.world();
    const victim = this.awayOf('MF', 0);
    this.tickKeeper(this.awayOf('GK', 0), false);
    if (!this.pending && w.lastTouch?.team === 0) {
      this.staleBall(dt, 'THAT ONE IS DEAD. GO AND TAKE IT OFF HIM AGAIN.', () => this.arrangeSteal());
    }
    // he stands over his ball until it is taken — the latch stays his, so the
    // jaws have something honest to bite on
    if (w.lastTouch?.team !== 0 && dist(w.ball.pos, w.players[victim].pos) < 1.5) {
      w.carrier = { idx: victim, t: 0.8 };
    }
    this.actors.set(victim, { ...IDLE(), attend: vec(w.ball.pos.x, w.ball.pos.y) });
  }

  private tickDuel(dt: number) {
    const w = this.world();
    const mate = this.homeOf('FW', 0);
    this.tickReceiver(mate, DUEL_POST);
    this.tickKeeper(this.awayOf('GK', 0), false);
    this.tickHunter(this.awayOf('DF', 0));
    if (this.myBall() && w.carrier?.idx === this.hooks.cursorIdx()) this.survived += dt;
    if (this.events().some((e) => e.kind === 'kick' && e.idx === this.wearing)) this.myKickFlying = true;
    if (this.myKickFlying && w.lastTouch?.idx === mate) this.crossed = true;
    if (this.pending) return;
    if (this.theirBall()) {
      this.retry(`OH. IT LOOKS LIKE THE DEFENDER STOLE YOUR BALL. PRESS ${KEY.go()} TO RETRY.`, () => this.arrangeDuel());
      return;
    }
    this.staleBall(dt, 'THAT ONE IS DEAD. GO AGAIN.', () => this.arrangeDuel());
  }

  // ------------------------------------------------------------ the engine
  // Which body may wear the grey arrow: a drill without switching wears none,
  // and a benched body never earns one
  switchTargetFor(suggested: number): number {
    const step = this.steps[this.stepIdx];
    if (step?.kind !== 'stage' || !step.allowSwitch) return -1;
    return this.cast.includes(suggested) ? suggested : -1;
  }

  // Enter is the shell's — and the pad's A arrives dressed as it. Every other
  // key reaches the coach through his own listener.
  key(code: string): boolean {
    if ((this.mode === 'choice' || this.mode === 'menu') && this.choice) {
      if (this.pageCool > 0) return true; // the press that opened a board never picks a row
      if (code === 'ArrowUp' || code === 'KeyW') { this.choice.move(-1); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { this.choice.move(1); return true; }
      if (code === 'Enter') { this.choice.activate(); return true; }
      return true; // a board is modal: nothing underneath it hears a thing
    }
    if (this.mode === 'card' || this.mode === 'tour') {
      if (code !== 'Enter') return false;
      this.advance();
      return true;
    }
    if (this.mode === 'stage' && code === 'Enter') return this.stageEnter();
    return false;
  }

  // Any button: fill the typing first, then turn the page — and a page that
  // just turned is deaf for a beat, so a click storm can never eat a card
  private advance() {
    if (this.pageCool > 0) return;
    if (!this.typer.done) { this.typer.fill(); this.pageCool = PAGE_COOL; return; }
    audio.ui('card', 0.6);
    this.pageCool = PAGE_COOL;
    if (this.mode === 'tour' && this.tourBeat < TOUR_LAST) {
      this.tourBeat++;
      this.beginTourBeat();
      return;
    }
    this.next();
  }

  // Enter on the field: it takes a finished drill onward, and it is the retry
  // the coach asked you for after a turnover
  private stageEnter(): boolean {
    if (this.pending && this.pending.wait < 0) {
      this.pending = { redo: this.pending.redo, wait: REST_BEAT };
      this.say('HERE WE GO AGAIN.');
      audio.ui('card', 0.6);
      return true;
    }
    if (!this.holding) return false;
    audio.ui('card', 0.6);
    this.next();
    return true;
  }

  frame(dt: number, input: PlayerInput, overrides: Record<number, PlayerInput>) {
    this.t += dt;
    this.blinkT += dt;
    this.pageCool = Math.max(0, this.pageCool - dt);
    const w = this.world();
    // a drill goal is a goal and NOTHING else: no walk home, no confetti lens
    // chasing a benched scorer, no twenty-two bodies teleported to kickoff
    if (w.ceremony !== 'live' || w.celebration) w.abortGoalReset();
    if (this.sw() !== this.lastW || this.sh() !== this.lastH) this.relayout();
    if (pad() !== this.wasPad) { this.wasPad = pad(); this.reword(); }
    this.typer.update(dt);
    if (this.capPower && input.kickReleased) {
      input.kickReleased.power = Math.min(input.kickReleased.power, this.capPower);
    }
    const step = this.steps[this.stepIdx];
    if (this.mode === 'menu') { /* a board holds the lens exactly where it found it */ }
    else if (this.mode === 'tour') this.tickTour(dt);
    else this.drillCamera(step?.kind === 'stage' ? step.focus?.() : undefined);
    if (this.mode === 'stage' && step?.kind === 'stage') this.tickStage(dt, input, step);
    if (this.legs) this.paintLegs();
    // the blinkers: a card waits on any button, the coach on Enter
    if (this.cardPrompt) this.cardPrompt.visible = this.typer.done && Math.sin(this.blinkT * 5) > -0.35;
    this.barPrompt.visible = this.linePrompt && this.typer.done && Math.sin(this.blinkT * 5) > -0.35;
    this.coachFig.texture = this.coachIdle[Math.floor(this.t * (this.typer.done ? 1.6 : 7)) % 2];
    // every body but yours is the coach's: a statue unless the drill scripts it
    // — and under a card, on the tour or inside a rest beat, NOTHING moves
    const still = this.mode !== 'stage' || this.resting();
    const cur = this.hooks.cursorIdx();
    for (let i = 0; i < w.players.length; i++) {
      if (i !== cur) overrides[i] = still ? IDLE() : this.actors.get(i) ?? IDLE();
    }
    if (still) overrides[cur] = IDLE();
  }

  private resting() { return this.pending !== null && this.pending.wait >= 0; }

  private tickStage(dt: number, input: PlayerInput, step: Stage) {
    const w = this.world();
    this.keepCursorOnStage(!!step.allowSwitch);
    this.keepBallInPlay();
    if (w.restartLock > 0.2) this.clearLocks(); // school never plays a dead ball
    if (this.pending && this.pending.wait >= 0) {
      // the rest law: a beat of stillness, the coach's line, and only then
      // does a single body move
      this.pending.wait -= dt;
      w.ball.vel = scale(w.ball.vel, 0.8);
      if (this.pending.wait <= 0) {
        const redo = this.pending.redo;
        this.pending = null;
        this.resetLedger();
        redo();
        this.baselineStep();
        this.resumeLine();
      }
      return;
    }
    // a retry waits on YOU — unless you go and win the ball back yourself
    if (this.pending && this.myBall()) {
      this.pending = null;
      this.resumeLine();
    }
    const cur = this.hooks.cursorIdx();
    const me = w.players[cur];
    // a body change is not a stride: the odometer only counts legs that walked
    const stepped = cur === this.prevIdx ? dist(me.pos, this.prevPos) : 0;
    this.prevIdx = cur;
    this.prevPos = vec(me.pos.x, me.pos.y);
    this.walked += stepped;
    if (cur !== this.startCursor) this.swapWalk += stepped;
    if (w.carrier?.idx === cur) this.carried += stepped;
    if (input.move.y < -0.3) this.moveSeen.w = true;
    if (input.move.y > 0.3) this.moveSeen.s = true;
    if (input.move.x < -0.3) this.moveSeen.a = true;
    if (input.move.x > 0.3) this.moveSeen.d = true;
    if (input.sprint && Math.hypot(input.move.x, input.move.y) > 0.3) this.moveSeen.sprint = true;
    let scored = false;
    for (const e of this.events()) {
      if (e.kind === 'kick' && e.idx === cur) this.kicks.push(e.power);
      if (e.kind === 'goal') scored = true;
    }
    if (scored) {
      this.goalAny = true;
      if (this.crossed) this.goalAfterPass = true;
      this.restage(this.crossed ? 'THAT IS THE PLAY. GO AGAIN WHENEVER YOU LIKE.' : 'GOAL. GO AGAIN.', step.arrange);
    }
    step.tick?.(dt);
    let all = true;
    step.objectives.forEach((o, i) => {
      const v = this.objViews[i];
      if (!v) return;
      if (!v.hit && o.done()) {
        v.hit = true;
        this.paintBox(v.box, true);
        v.label.tint = MINT;
        audio.ui('select', 0.6);
      }
      all = all && v.hit;
    });
    // a finished drill never yanks the screen up: the ball stays yours until
    // you say the word
    if (all && !this.holding) {
      this.holding = true;
      audio.ui('buy', 0.6);
      this.say(goodJob(), true);
    }
  }

  // E and the cursor's own football sense can both point at a benched body,
  // and then your keys are driving a man who is not on the field. The cast is
  // the only place control may land — and E always means "the other man"
  private keepCursorOnStage(allowSwitch: boolean) {
    const cur = this.hooks.cursorIdx();
    if (!allowSwitch) {
      if (cur !== this.heroIdx) this.hooks.assign(this.heroIdx);
      this.wearing = this.heroIdx;
      return;
    }
    if (this.cast.includes(cur)) { this.wearing = cur; return; }
    this.hooks.assign(this.cast.find((i) => i !== this.wearing) ?? this.heroIdx);
  }

  // No throw-ins in school: the ball bounces off soft walls a whisker inside
  // every line, and only the goal mouths are left open
  private keepBallInPlay() {
    const b = this.world().ball;
    const pad = BALL_WALL;
    if (b.pos.y < pad && b.vel.y < 0) b.vel.y = -b.vel.y * 0.55;
    if (b.pos.y > PITCH.width - pad && b.vel.y > 0) b.vel.y = -b.vel.y * 0.55;
    const inMouth = Math.abs(b.pos.y - PITCH.width / 2) < PITCH.goalWidth / 2 - 0.3 && b.z < PITCH.goalHeight - 0.3;
    if (inMouth) return;
    if (b.pos.x < pad && b.vel.x < 0) b.vel.x = -b.vel.x * 0.55;
    if (b.pos.x > PITCH.length - pad && b.vel.x > 0) b.vel.x = -b.vel.x * 0.55;
  }

  // The lens: on your man at match zoom, leaning toward whatever the drill is
  // asking of you — the live ball once it leaves your feet, else the target
  // the coach named. Never a pinned wide shot of an empty field.
  private drillCamera(focus?: Vec2) {
    const w = this.world();
    const me = this.me().pos;
    const dBall = dist(w.ball.pos, me);
    const look = dBall > 3 && dBall < 26 ? w.ball.pos : focus;
    const off = look ? clampLen(scale(sub(look, me), 0.4), LEAN_CAP) : vec();
    const center = add(me, off);
    this.scene.setCameraOverride({ center, zoom: this.zoomToHold(center, me, look) });
  }

  // A drill that says "pass to your teammate" and then frames him off the top
  // of the screen is a riddle, not a lesson. The lens opens by exactly what it
  // takes to hold your man AND whatever you were told to aim at — no wider.
  private zoomToHold(center: Vec2, ...must: (Vec2 | undefined)[]): number {
    const M = pxPerMeter();
    let z = this.camZoom;
    for (const p of must) {
      if (!p) continue;
      z = Math.min(
        z,
        this.sw() / 2 / ((Math.abs(p.x - center.x) + FRAME_AIR) * M),
        this.sh() / 2 / ((Math.abs(p.y - center.y) + FRAME_AIR) * M * squash()),
      );
    }
    return Math.max(z, DRILL_FLOOR);
  }

  // Nothing snaps: the coach picks the ball up, says his line, and the drill
  // re-forms a beat later
  private restage(line: string, redo: () => void) {
    this.ballAt(PITCH.length / 2, PITCH.width / 2);
    this.clearLocks();
    this.deadT = 0;
    this.pending = { redo, wait: REST_BEAT };
    this.say(line);
  }

  // A reset the PLAYER calls: the world stays live behind the line, so you can
  // still chase the man who robbed you and take it straight back
  private retry(line: string, redo: () => void) {
    this.pending = { redo, wait: -1 };
    this.say(line, true);
  }

  private resumeLine() {
    const step = this.steps[this.stepIdx];
    if (step?.kind !== 'stage') return;
    this.say(this.holding ? goodJob() : step.line, this.holding);
  }

  private next() { this.goTo(this.stepIdx + 1); }

  // Every page change lands here — the walk forward, and the jump a RESUME
  // makes back to where the last sitting stopped
  private goTo(idx: number) {
    const prev = this.steps[this.stepIdx];
    if (prev?.kind === 'stage') prev.cleanup?.();
    this.actors.clear();
    this.pending = null;
    this.holding = false;
    this.stepIdx = idx;
    const step = this.steps[this.stepIdx];
    if (!step) return this.finish('menu');
    this.saveStep(this.stepIdx);
    this.cardBox.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.objPanel.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.objViews = [];
    this.legs = null;
    this.cardPanel = null;
    this.cardPrompt = null;
    this.cardBounds = null;
    this.linkBox = null;
    this.dim.clear();
    this.bar.visible = step.kind === 'stage' || step.kind === 'tour';
    if (step.kind === 'card') { this.mode = 'card'; this.buildCard(step); }
    else if (step.kind === 'tour') { this.mode = 'tour'; this.tourBeat = 0; this.showEveryone(); this.beginTourBeat(); }
    else if (step.kind === 'choice') { this.mode = 'choice'; this.buildFinale(); }
    else {
      this.mode = 'stage';
      this.clearLocks();
      this.resetScratch();
      step.arrange();
      this.baselineStep();
      this.camZoom = step.zoom ?? DRILL_ZOOM;
      this.buildLedger(step);
      this.say(step.line);
    }
  }

  // A pad plugged in halfway through must not leave the coach talking about a
  // key you haven't got: the script is re-read and the live page repainted in
  // the other hand's language, ticked boxes and all
  private reword() {
    this.steps = this.script();
    const step = this.steps[this.stepIdx];
    if (step?.kind === 'card') {
      this.cardBox.removeChildren().forEach((c) => c.destroy({ children: true }));
      this.buildCard(step);
      this.typer.fill();
    } else if (step?.kind === 'stage') {
      const hits = this.objViews.map((v) => v.hit);
      this.objPanel.removeChildren().forEach((c) => c.destroy({ children: true }));
      this.objViews = [];
      this.legs = null;
      this.buildLedger(step);
      hits.forEach((hit, i) => {
        const v = this.objViews[i];
        if (!hit || !v) return;
        v.hit = true;
        v.label.tint = MINT;
        this.paintBox(v.box, true);
      });
      this.say(this.holding ? goodJob() : step.line, this.holding, true);
    }
  }

  private resetScratch() {
    this.kicks = [];
    this.walked = 0;
    this.swapWalk = 0;
    this.carried = 0;
    this.survived = 0;
    this.deadT = 0;
    this.startCursor = -1;
    this.myKickFlying = false;
    this.crossed = false;
    this.goalAny = false;
    this.goalAfterPass = false;
  }

  // Walking out through the finale: school is over for good
  private finish(kind: 'menu' | 'training' | 'easy') {
    if (this.done) return;
    this.done = true;
    this.store(DONE_KEY, '1');
    this.store(STEP_KEY, null);
    this.hooks.exit(kind);
  }

  // ...and walking out early keeps your place, so eight drills in is never
  // eight drills wasted
  private quit() {
    if (this.done) return;
    // Leaving from the LAST page is not leaving early — you reached the end,
    // so the front door stops asking whether you are new here
    if (this.stepIdx >= this.steps.length - 1) return this.finish('menu');
    this.done = true;
    this.saveStep(this.stepIdx);
    this.hooks.exit('menu');
  }

  private store(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* headless is fine */ }
  }
  private saveStep(idx: number) {
    this.store(STEP_KEY, idx > 0 && idx < this.steps.length - 1 ? String(idx) : null);
  }
  private savedStep(): number {
    try {
      const at = Number(localStorage.getItem(STEP_KEY));
      return Number.isInteger(at) && at > 0 && at < this.steps.length - 1 ? at : 0;
    } catch { return 0; }
  }

  // ---------------------------------------------------------------- the UI
  private app() { return this.scene['app'] as { screen: { width: number; height: number } }; }
  private sw() { return this.app().screen.width; }
  private sh() { return this.app().screen.height; }

  // A resized window keeps the coach on his rail and the card in the middle
  private relayout() {
    this.lastW = this.sw();
    this.lastH = this.sh();
    if (this.mode !== 'stage' && this.mode !== 'tour') {
      this.dim.clear();
      this.dim.rect(0, 0, this.sw(), this.sh()).fill({ color: 0x05080c, alpha: 0.62 });
    }
    for (const p of [this.cardPanel, this.menuPanel]) {
      p?.position.set(Math.round(this.sw() / 2), Math.round(this.sh() * 0.3));
    }
    if (this.bar.visible) this.say(this.line, this.linePrompt, this.typer.done);
  }

  private inkWidth(s: string): number {
    const widths = this.assets.manifest.font.widths;
    let x = 0;
    for (const ch of s.toUpperCase()) x += ((widths[ch] ?? 3) + 1) * 2; // the bar's face is always 2x
    return Math.max(0, x - 2);
  }

  // Greedy wrap on the pixel font's own metrics
  private wrap(text: string, maxW: number): string[] {
    const rows: string[] = [];
    let row = '';
    for (const word of text.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (row && this.inkWidth(next) > maxW) { rows.push(row); row = word; }
      else row = next;
    }
    if (row) rows.push(row);
    return rows;
  }

  // The coach's voice: a manager plate and one typed line along the bottom
  // rail — it lives outside the play, so it can never cover the ball, the
  // arrows, or your man
  private say(text: string, prompt = false, instant = false) {
    this.line = text;
    this.linePrompt = prompt;
    this.barRows.removeChildren().forEach((c) => c.destroy({ children: true }));
    const bw = Math.min(this.sw() - BAR_PAD * 2, BAR_MAX);
    const textX = 18 + PORTRAIT + 18;
    const rows = this.wrap(text, bw - textX - 44);
    const blockH = 16 + rows.length * ROW_H;
    const bh = Math.max(PORTRAIT + 24, blockH + 26);
    const top = Math.round((bh - blockH) / 2);
    this.barPlate.clear();
    this.barPlate.rect(0, 0, bw, bh).fill({ color: CLOTH, alpha: 0.92 });
    this.barPlate.rect(0, 0, bw, 2).fill({ color: GOLD, alpha: 0.5 });
    this.barPlate.rect(0, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    this.barPlate.rect(16, (bh - PORTRAIT) / 2 - 2, PORTRAIT + 4, PORTRAIT + 4).fill({ color: 0x05070b, alpha: 0.9 });
    this.barPlate.rect(16, (bh + PORTRAIT) / 2, PORTRAIT + 4, 2).fill({ color: MINT, alpha: 0.45 });
    for (const [cx, cy] of [[3, 5], [bw - 6, 5], [3, bh - 8], [bw - 6, bh - 8]]) {
      this.barPlate.rect(cx, cy, 3, 3).fill({ color: GOLD, alpha: 0.55 });
    }
    const name = new PixelText(this.assets, 2, DIM_INK, 'micro');
    name.text = 'COACH';
    name.position.set(textX, top);
    this.barRows.addChild(name);
    const typed = rows.map((r, i) => {
      const t = new PixelText(this.assets, 2, INK);
      t.text = r;
      t.position.set(textX, top + 18 + i * ROW_H);
      this.barRows.addChild(t);
      return { obj: t as PixelText | Container, chars: r.length };
    });
    this.coachFig.position.set(18, Math.round((bh - PORTRAIT) / 2));
    this.barPrompt.position.set(bw - 24, bh - 26);
    this.barEsc.position.set(bw - 18 - this.barEsc.textWidth, top);
    this.bar.position.set(Math.round((this.sw() - bw) / 2), Math.round(this.sh() - bh - BAR_PAD));
    this.typer.start(typed);
    if (instant) this.typer.fill();
  }

  private keycap(label: string): Container {
    // a dark cap with light lettering — the same cloth as every plate here,
    // and the only thing this 7px face stays crisp on
    const c = new Container();
    const t = new PixelText(this.assets, 2, 0xe8ecf4);
    t.text = label;
    const w = Math.max(24, t.textWidth + 14);
    const g = new Graphics();
    g.rect(0, -3, w, 22).fill({ color: 0x05070b, alpha: 0.95 });
    g.rect(1, -2, w - 2, 20).fill({ color: 0x232b3d, alpha: 1 });
    g.rect(1, -2, w - 2, 2).fill({ color: 0xfff8e0, alpha: 0.25 });
    g.rect(1, 16, w - 2, 2).fill({ color: 0x000000, alpha: 0.55 });
    c.addChild(g, t);
    centerRow(t, w / 2, 1);
    return c;
  }

  private buildCard(card: Card) {
    this.dim.rect(0, 0, this.sw(), this.sh()).fill({ color: 0x05080c, alpha: 0.62 });
    const panel = new Container();
    const rows: Container[] = [];
    const typed: { obj: PixelText | Container; chars: number }[] = [];
    let maxW = 380;
    for (const line of card.lines) {
      const row = new Container();
      let x = 0;
      for (const seg of line) {
        if (typeof seg === 'string') {
          const t = new PixelText(this.assets, 2, INK);
          t.text = seg;
          t.position.set(x, 2);
          row.addChild(t);
          x += t.textWidth + 8; // ink to ink — a glyph cell's outline is padding, not a letter
          typed.push({ obj: t, chars: seg.length });
        } else {
          const cap = this.keycap(seg.key);
          cap.position.set(x, 0);
          row.addChild(cap);
          x += cap.width + 6;
          typed.push({ obj: cap, chars: 2 });
        }
      }
      rows.push(row);
      maxW = Math.max(maxW, row.width + 76);
    }
    const lineH = 30;
    // a FRESH prompt each card — the old one dies with its panel, and a
    // destroyed transform throws the moment anyone repositions it
    this.cardPrompt = new PixelText(this.assets, 2, GOLD);
    this.cardPrompt.text = pad() ? 'PRESS ANY BUTTON' : 'PRESS ANY KEY';
    // The card breathes the same above and below: copy block, a beat, the
    // prompt, then exactly the air the first line was given
    const bodyH = rows.length * lineH + (card.link ? 26 : 0);
    const promptY = TOP_PAD + bodyH + PROMPT_GAP;
    const bh = promptY + this.cardPrompt.textHeight + TOP_PAD;
    const bw = Math.min(maxW, this.sw() - 80);
    const g = new Graphics();
    g.rect(-bw / 2, 0, bw, bh).fill({ color: CLOTH, alpha: 0.92 });
    g.rect(-bw / 2, 0, bw, 2).fill({ color: GOLD, alpha: 0.5 });
    g.rect(-bw / 2, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    for (const [cx, cy] of [[-bw / 2 + 3, 5], [bw / 2 - 6, 5], [-bw / 2 + 3, bh - 8], [bw / 2 - 6, bh - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: GOLD, alpha: 0.55 });
    }
    panel.addChild(g);
    rows.forEach((row, i) => {
      centerRow(row, 0, TOP_PAD + i * lineH);
      panel.addChild(row);
    });
    if (card.link) {
      const link = externalLink(this.assets, card.link.label, card.link.url);
      centerRow(link, 0, TOP_PAD + rows.length * lineH + 6);
      panel.addChild(link);
      // ...and the page must NOT turn under a click meant for the link
      this.linkBox = { x: link.position.x, y: link.position.y, w: link.width, h: 20 };
    }
    this.cardPrompt.centerAt(0, promptY); // centered like every other line on the card
    panel.addChild(this.cardPrompt);
    panel.position.set(Math.round(this.sw() / 2), Math.round(this.sh() * 0.30));
    this.cardBox.addChild(panel);
    this.cardPanel = panel;
    this.cardBounds = { x: -bw / 2, y: 0, w: bw, h: bh };
    this.typer.start(typed);
  }

  private inLink(cx: number, cy: number): boolean {
    return this.hits(this.linkBox, cx, cy);
  }
  // A page turns under a click ON THE CARD and nowhere else — the grass belongs
  // to the kick you were just taught, not to five unread pages
  private inCard(cx: number, cy: number): boolean {
    return this.hits(this.cardBounds, cx, cy);
  }
  private hits(box: { x: number; y: number; w: number; h: number } | null, cx: number, cy: number): boolean {
    if (!box || !this.cardPanel) return false;
    const x = this.cardPanel.position.x + box.x;
    const y = this.cardPanel.position.y + box.y;
    return cx >= x && cx <= x + box.w && cy >= y && cy <= y + box.h;
  }

  // The establishing tour: your goal, their goal, and then the lens TRAVELS
  // the length of the ground — a static wide shot can never show a 114 metre
  // pitch without the void leaking in, so the field is something you watch go
  // past instead of something you are told about
  private tourShot(beat: number): { center: Vec2; zoom: number; line: string } {
    const w = this.world();
    const mid = PITCH.width / 2;
    if (beat === 0) return { center: vec(w.goalXOf(1), mid), zoom: 1.5, line: 'THIS IS YOUR GOAL. KEEP THEM OUT OF IT.' };
    if (beat === 1) return { center: vec(w.goalXOf(0), mid), zoom: 1.5, line: 'THAT IS THEIR GOAL. THAT IS WHERE YOU SCORE.' };
    const ride = clamp(this.tourT / TOUR_SWEEP, 0, 1);
    const eased = ride * ride * (3 - 2 * ride); // in and out, so the sweep never jerks
    return {
      center: vec(w.goalXOf(0) + (w.goalXOf(1) - w.goalXOf(0)) * eased, mid),
      zoom: TOUR_ZOOM,
      line: 'AND THIS IS THE WHOLE FIELD. END TO END.',
    };
  }

  private beginTourBeat() {
    this.tourT = 0;
    this.say(this.tourShot(this.tourBeat).line, this.tourBeat === TOUR_LAST);
  }

  private tickTour(dt: number) {
    this.tourT += dt;
    const shot = this.tourShot(this.tourBeat);
    this.scene.setCameraOverride({ center: shot.center, zoom: shot.zoom });
    if (this.tourBeat < TOUR_LAST && this.tourT > TOUR_HOLD) {
      this.tourBeat++;
      this.beginTourBeat();
    }
  }

  private paintBox(g: Graphics, hit: boolean) {
    g.clear();
    g.rect(0, 0, 14, 14).fill({ color: CLOTH, alpha: 0.9 });
    g.rect(0, 0, 14, 2).fill({ color: MINT, alpha: 0.4 });
    g.rect(0, 12, 14, 2).fill({ color: 0x000000, alpha: 0.5 });
    if (hit) g.rect(3, 3, 8, 8).fill({ color: MINT, alpha: 1 });
  }

  // A re-staged drill starts from an honest sheet — every box empty again
  private resetLedger() {
    for (const v of this.objViews) {
      v.hit = false;
      v.label.tint = INK;
      this.paintBox(v.box, false);
    }
  }

  private buildLedger(stage: Stage) {
    const panel = new Container();
    const title = new PixelText(this.assets, 2, DIM_INK, 'micro');
    title.text = 'OBJECTIVES';
    title.position.set(14, 10);
    panel.addChild(title);
    let y = 26;
    let bw = 150;
    for (const o of stage.objectives) {
      const box = new Graphics();
      this.paintBox(box, false);
      box.position.set(14, y);
      const label = new PixelText(this.assets, 2, INK);
      label.text = o.label;
      label.position.set(34, y + 1);
      panel.addChild(box, label);
      this.objViews.push({ box, label, hit: false });
      bw = Math.max(bw, 34 + label.width + 16);
      y += 22;
    }
    // The legs, drawn where the checklist is: a drill that asks for a sprint
    // shows what a sprint costs, because the match HUD is not on screen here
    if (stage.tank) {
      const cap = new PixelText(this.assets, 2, DIM_INK, 'micro');
      cap.text = 'LEGS';
      cap.position.set(14, y + 4);
      this.legs = new Graphics();
      this.legs.position.set(52, y + 4);
      panel.addChild(cap, this.legs);
      bw = Math.max(bw, 52 + TANK_W + 16);
      y += 20;
      this.paintLegs();
    }
    const bg = new Graphics();
    bg.rect(0, 0, bw, y + 8).fill({ color: CLOTH, alpha: 0.82 });
    bg.rect(0, 0, bw, 2).fill({ color: GOLD, alpha: 0.5 });
    panel.addChildAt(bg, 0);
    panel.position.set(12, 12);
    this.objPanel.addChild(panel);
  }

  // Eight cells that drain as he runs — mint legs, gold tired, red spent
  private paintLegs() {
    const g = this.legs;
    if (!g) return;
    const left = this.me().stamina;
    const color = left < 0.12 ? 0xff5340 : left < 0.4 ? GOLD : MINT;
    g.clear();
    g.rect(0, 0, TANK_W, 10).fill({ color: 0x05070b, alpha: 0.9 });
    for (let i = 0; i < TANK_CELLS; i++) {
      const fill = clamp(left * TANK_CELLS - i, 0, 1);
      if (fill <= 0) continue;
      const cw = Math.round((TANK_W / TANK_CELLS - 2) * fill);
      g.rect(2 + i * (TANK_W / TANK_CELLS), 2, Math.max(1, cw), 6).fill({ color, alpha: 1 });
    }
  }

  // The lesson the meter alone cannot teach: below five percent the legs
  // simply refuse. The coach calls it once, and hands the drill's line back
  // the moment the tank has breathed enough to run again.
  private watchLegs() {
    const left = this.me().stamina;
    if (this.legsSaid === 0 && left <= 0.05) { this.legsSaid = 1; this.say(SPENT); }
    else if (this.legsSaid === 1 && left > 0.35) { this.legsSaid = 2; this.resumeLine(); }
  }

  // ------------------------------------------------------------- the boards
  // One plate, three jobs: where to next, the pause, and the offer to pick a
  // half-finished lesson back up
  private board(head: string, sub: string, rows: Row[], back: (() => void) | null) {
    this.menuRows = rows;
    this.menuBack = back;
    this.menuBox.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.dim.clear();
    this.dim.rect(0, 0, this.sw(), this.sh()).fill({ color: 0x05080c, alpha: 0.62 });
    const panel = new Container();
    const title = new PixelText(this.assets, 3, GOLD);
    title.text = head;
    const under = new PixelText(this.assets, 2, DIM_INK);
    under.text = sub;
    this.choice = new PixelList(this.assets, 3, 34, 7, 13, true);
    this.choice.setRows(rows.map((r) => ({ label: r.label, enabled: true })), false, false, 0);
    this.choice.onPick = (i) => {
      audio.ui('select');
      this.menuRows[i]?.run();
    };
    const bw = 560;
    const bh = 108 + rows.length * 34;
    const g = new Graphics();
    g.rect(-bw / 2, 0, bw, bh).fill({ color: CLOTH, alpha: 0.92 });
    g.rect(-bw / 2, 0, bw, 2).fill({ color: GOLD, alpha: 0.5 });
    for (const [cx, cy] of [[-bw / 2 + 3, 5], [bw / 2 - 6, 5], [-bw / 2 + 3, bh - 8], [bw / 2 - 6, bh - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: GOLD, alpha: 0.55 });
    }
    panel.addChild(g);
    title.centerAt(0, 26);
    under.centerAt(0, 58);
    this.choice.root.position.set(0, 92);
    panel.addChild(title, under, this.choice.root);
    panel.position.set(Math.round(this.sw() / 2), Math.round(this.sh() * 0.3));
    this.menuBox.addChild(panel);
    this.menuPanel = panel;
    this.pageCool = PAGE_COOL;
  }

  private buildFinale() {
    this.board('YOU KNOW THE BASICS NOW', 'WHERE TO NEXT', [
      { label: 'AN EASY FIVE MINUTE MATCH', run: () => this.finish('easy') },
      { label: 'THE TRAINING GROUND', run: () => this.finish('training') },
      { label: 'MAIN MENU', run: () => this.finish('menu') },
    ], () => this.finish('menu'));
  }

  // The shell's own retreat — a pad's START — lands here too, so however you
  // ask to stop, you get the same board
  pause() {
    this.openPause();
  }

  // ESC is a pause reflex everywhere else in this game, so here it opens a
  // door rather than kicking you through one
  private openPause() {
    if (this.mode === 'menu') return this.menuBack?.();
    const step = this.steps[this.stepIdx];
    this.modeBeforeMenu = this.mode;
    this.mode = 'menu';
    audio.ui('card');
    const rows: Row[] = [{ label: 'BACK TO THE LESSON', run: () => this.closePause() }];
    if (step?.kind === 'stage') rows.push({ label: 'SKIP THIS DRILL', run: () => { this.closePause(); this.next(); } });
    rows.push({ label: 'QUIT - YOUR PLACE IS KEPT', run: () => this.quit() });
    this.board('PAUSED', `LESSON ${this.stepIdx + 1} OF ${this.steps.length}`, rows, () => this.closePause());
  }

  private closePause() {
    audio.ui('back');
    this.mode = this.modeBeforeMenu;
    this.leaveBoard();
    // The finale is ITSELF a board, and the pause painted straight over it.
    // Without this, one ESC on the last page leaves you on a dimmed empty
    // pitch with no way forward — the reflex that ends the tutorial for good.
    if (this.mode === 'choice') this.buildFinale();
    this.pageCool = PAGE_COOL; // the key that closed the board never turns a page
    this.relayout();
  }

  // Walking back in: the coach remembers the page, and never assumes
  private offerResume(at: number) {
    this.mode = 'menu';
    this.modeBeforeMenu = 'card';
    this.board('WELCOME BACK', `YOU STOPPED AT LESSON ${at + 1} OF ${this.steps.length}`, [
      { label: 'PICK UP WHERE I LEFT OFF', run: () => { this.leaveBoard(); this.goTo(at); } },
      { label: 'START FROM THE TOP', run: () => { this.leaveBoard(); this.goTo(0); } },
      { label: 'MAIN MENU', run: () => this.quit() },
    ], () => this.quit());
  }

  // The board comes down and the page underneath gets its veil back
  private leaveBoard() {
    this.menuBox.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.menuPanel = null;
    this.choice = null;
    this.menuBack = null;
    this.dim.clear();
    if (this.mode === 'card' || this.mode === 'choice') {
      this.dim.rect(0, 0, this.sw(), this.sh()).fill({ color: 0x05080c, alpha: 0.62 });
    }
  }

  // The shell drops pad nav on the floor during a match, so the coach reads
  // the poll himself: the sticks walk his boards, and any face button really
  // does turn his page, exactly as the card promises
  update(dt: number) {
    this.choice?.update(dt);
    if (!pad()) return;
    if (this.choice) {
      for (const code of pads.navCodes()) this.key(code);
    } else if ((this.mode === 'card' || this.mode === 'tour') && PAD_PAGE.some((b) => pads.pressed(b))) {
      this.advance();
    }
  }
}
