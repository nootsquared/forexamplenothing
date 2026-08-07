import { Container, Graphics } from 'pixi.js';
import { Vec2, vec, dist, clamp } from '../core/math';
import { PITCH } from '../sim/constants';
import { PlayerInput, PlayerStats } from '../sim/player';
import { Match } from '../match';
import { Scene } from '../render/scene';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { PixelList } from './kit';
import { audio } from '../audio/engine';

// The tutorial: a coach with a typewriter. Cards explain one thing, then the
// field hands it to you — objectives tick off top-left, a speech bubble rides
// your player, Enter finishes the typing and Enter again turns the page.

type Seg = string | { key: string };
type Card = { kind: 'card'; lines: Seg[][]; link?: { label: string; url: string } };
type Objective = { label: string; done: () => boolean };
type Stage = {
  kind: 'stage';
  bubble: string;
  arrange: () => void;
  objectives: Objective[];
  tick?: (dt: number) => void;
  cleanup?: () => void;
  allowSwitch?: boolean;
};
type Step = Card | Stage | { kind: 'tour' } | { kind: 'choice' };

const IDLE = (): PlayerInput => ({ move: vec(), sprint: false, kickCharging: false, kickReleased: null });
const GRAY_BOOTS: Partial<PlayerStats> = { pass: 0.18, longBall: 0.08, shoot: 0.2, control: 0.4 };
const COACH_PICK: Partial<PlayerStats> = { pass: 0.93, longBall: 0.88, shoot: 0.86, control: 0.92 };

export class Tutorial {
  root = new Container();
  done = false;             // set when the player leaves through the finale
  hideWedge = false;        // early kicks show a plain line, the arc comes later
  capPower = 0;             // 0 = uncapped; early kicks are gentled
  private stepIdx = -1;
  private steps: Step[] = [];
  private mode: 'card' | 'stage' | 'tour' | 'choice' = 'card';
  // typewriter
  private dim = new Graphics();
  private cardBox = new Container();
  private typeBudget = 0;
  private typeTotal = 0;
  private typeDone = false;
  private typeTargets: { obj: PixelText | Container; chars: number }[] = [];
  private prompt: PixelText;
  private promptT = 0;
  // stage UI
  private objPanel = new Container();
  private objViews: { boxG: Graphics; hit: boolean }[] = [];
  private bubble = new Container();
  private bubbleText: PixelText;
  private bubbleBg = new Graphics();
  private advanceBeat = 0;
  // tour
  private tourT = 0;
  private tourCap: PixelText;
  // finale
  private choice: PixelList | null = null;
  // stage scratch
  private heroIdx = 0;
  private actors = new Map<number, PlayerInput>();
  private stash = new Map<number, PlayerStats>();
  private moveSeen = { w: false, a: false, s: false, d: false };
  private carried = 0;
  private prevHero: Vec2 = vec();
  private kicks: number[] = [];
  private myKickFlying = false;
  private crossed = false;
  private survived = 0;
  private startCursor = 0;
  private swapMoved = 0;

  constructor(
    private assets: GameAssets,
    private match: Match,
    private scene: Scene,
    private hooks: { assign: (i: number) => void; cursorIdx: () => number; exit: (kind: 'menu' | 'training' | 'easy') => void },
  ) {
    this.prompt = new PixelText(assets, 2, 0xffd95e);
    this.prompt.text = 'PRESS ENTER';
    this.tourCap = new PixelText(assets, 3, 0xd8e4d2);
    this.bubbleText = new PixelText(assets, 2, 0x12161f);
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.root.addChild(this.dim, this.objPanel, this.bubble, this.cardBox);
    this.steps = this.script();
    this.next();
  }

  destroy() {
    this.restoreStats();
    this.scene.setCameraOverride(null);
    this.root.destroy({ children: true });
  }

  // ------------------------------------------------------------- the script
  private world() { return this.match.world; }
  private hero() { return this.world().players[this.heroIdx]; }
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
  private ballAt(x: number, y: number, vz = 0) {
    const b = this.world().ball;
    b.pos.x = x; b.pos.y = y; b.vel = vec(); b.z = vz > 0 ? 0.01 : 0; b.vz = vz; b.spin = 0; b.savePrev();
  }
  private clearLocks() {
    const w = this.world();
    w.restartLock = 0; w.restartExclusion = 0; w.holdLock = false; w.holdingGk = -1;
    w.abortGoalReset(); // a drill never waits on confetti, and never gets teleported by it
  }
  private setHero(i: number) {
    this.heroIdx = i;
    this.hooks.assign(i);
    this.prevHero = vec(this.world().players[i].pos.x, this.world().players[i].pos.y);
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
  private events() { return this.world().events; }
  // Drills get a clean runway: everyone not in the lesson watches from the
  // touchlines like a real training gallery — no statue ball-graveyards
  private clearField(involved: number[]) {
    const w = this.world();
    let n0 = 0;
    let n1 = 0;
    w.players.forEach((p, i) => {
      if (involved.includes(i)) return;
      if (p.id.team === 0) this.put(i, 22 + n0++ * 7, 71.5);
      else this.put(i, 22 + n1++ * 7, 2.5);
    });
  }
  // The coach fetches: a rocketed ball respots at your feet instead of
  // demanding a hike across the county
  private refetch() {
    const w = this.world();
    const h = this.world().players[this.hooks.cursorIdx()];
    if (dist(w.ball.pos, h.pos) > 22 && w.ball.speed() < 1 && w.ball.z < 0.2) {
      this.ballAt(h.pos.x + h.facing.x * 1.3, h.pos.y + h.facing.y * 1.3);
      this.scene.toast('FRESH BALL');
    }
  }
  // A drill target attacks a ball that comes near — a statue can't complete
  // a pass, and a real receiver wouldn't stand there watching either
  private chase(idx: number, radius = 9) {
    const w = this.world();
    const p = w.players[idx];
    const to = vec(w.ball.pos.x - p.pos.x, w.ball.pos.y - p.pos.y);
    const d = Math.hypot(to.x, to.y);
    // he holds his post until the ball is actually STRUCK his way — then
    // attacks it like a receiver, and stands proud once he has it
    const ballComing = w.ball.speed() > 2.5 || d < 2.5;
    if (d < radius && d > 0.7 && ballComing && w.carrier?.idx !== idx) {
      this.actors.set(idx, { ...IDLE(), move: vec(to.x / d, to.y / d) });
    } else {
      this.actors.set(idx, IDLE());
    }
  }

  private script(): Step[] {
    const K = (k: string) => ({ key: k });
    return [
      { kind: 'card', lines: [
          ['WELCOME TO TOTAL22'],
          ['THIS TUTORIAL PUTS YOUR HANDS ON EVERYTHING THAT MATTERS'],
          ['IT ASSUMES YOU KNOW SOCCER ITSELF'],
        ], link: { label: 'NEW TO SOCCER? THE BASICS LIVE ON WIKIPEDIA', url: 'https://en.wikipedia.org/wiki/Association_football' } },
      { kind: 'card', lines: [
          ['A QUICK RECAP OF THE HOUSE RULES'],
          ['ELEVEN A SIDE INCLUDING A GOALIE'],
          ['TWO HALVES AND THE MOST GOALS WINS'],
          ['WHEN THE CLOCK ENDS THE HALF ENDS'],
          ['NO EXTRA TIME AND NO REFEREE DRAMA'],
        ] },
      { kind: 'tour' },
      { kind: 'card', lines: [
          ['EVERY SHIRT HAS A TRADE'],
          ['DEFENDERS WIN BALLS ALL DAY BUT ARE HEAVY AND FINISH BADLY'],
          ['MIDFIELDERS PASS AND CARRY THE GAME'],
          ['FORWARDS FLY AND FINISH BUT CAN BARELY TACKLE ANYONE'],
        ] },
      { kind: 'card', lines: [
          ['YOU CONTROL EXACTLY ONE PLAYER AT A TIME'],
          ['EVERYONE ELSE THINKS FOR THEMSELVES'],
          [K('W'), K('A'), K('S'), K('D'), ' MOVES YOU AND ', K('SHIFT'), ' SPRINTS'],
        ] },
      {
        kind: 'stage', bubble: 'USE WASD TO MOVE ME AROUND',
        arrange: () => {
          this.setHero(this.homeOf('MF', 1));
          this.clearField([this.heroIdx]);
          this.put(this.heroIdx, 57, 37);
          this.ballAt(4, 4);
          this.moveSeen = { w: false, a: false, s: false, d: false };
        },
        objectives: [
          { label: 'PRESS W', done: () => this.moveSeen.w },
          { label: 'PRESS A', done: () => this.moveSeen.a },
          { label: 'PRESS S', done: () => this.moveSeen.s },
          { label: 'PRESS D', done: () => this.moveSeen.d },
        ],
      },
      {
        kind: 'stage', bubble: 'A BALL! WALK INTO IT AND KEEP MOVING TO KEEP IT',
        arrange: () => {
          this.ballAt(this.hero().pos.x + 5, this.hero().pos.y, 7);
          this.carried = 0;
        },
        objectives: [
          { label: 'TOUCH THE BALL', done: () => this.world().lastTouch?.idx === this.heroIdx },
          { label: 'CARRY IT 12 METERS', done: () => this.carried > 12 },
        ],
      },
      { kind: 'card', lines: [
          ['KICKING IS ONE MOTION'],
          ['CLICK ANYWHERE AND DRAG BACKWARD THEN LET GO'],
          ['THE BALL FLIES THE OPPOSITE WAY LIKE A SLINGSHOT'],
          ['SOFT DRAG SOFT BALL   HARD DRAG ROCKET'],
        ] },
      {
        kind: 'stage', bubble: 'CLICK AND DRAG BACK THEN LET GO',
        arrange: () => {
          this.hideWedge = true;
          this.capPower = 0.55;
          this.ballAt(this.hero().pos.x + 1.2, this.hero().pos.y);
          this.kicks = [];
        },
        objectives: [{ label: 'KICK THE BALL', done: () => this.kicks.length > 0 }],
        cleanup: () => { this.hideWedge = false; this.capPower = 0; },
      },
      { kind: 'card', lines: [
          ['NOW THE HONEST PART'],
          ['HARDER KICKS ARE STRONGER BUT WILDER'],
          ['THE ARC ON THE GRASS IS EVERYWHERE YOUR BALL MIGHT GO'],
          ['BETTER PLAYERS KEEP THAT ARC NARROW'],
        ] },
      {
        kind: 'stage', bubble: 'FEEL THE DIFFERENCE. ONE CALM KICK AND ONE FULL SEND',
        arrange: () => {
          this.dress(this.heroIdx, COACH_PICK);
          this.ballAt(this.hero().pos.x + 1.2, this.hero().pos.y);
          this.kicks = [];
        },
        objectives: [
          { label: 'A CALM KICK', done: () => this.kicks.some((p) => p <= 0.6) },
          { label: 'A FULL SEND', done: () => this.kicks.some((p) => p >= 0.8) },
        ],
        tick: () => this.refetch(),
      },
      {
        kind: 'stage', bubble: 'THIS ONE HAS BRICKS FOR BOOTS. LOOK AT THAT ARC. JUST HIT IT',
        arrange: () => {
          this.restoreStats();
          this.dress(this.heroIdx, GRAY_BOOTS);
          this.ballAt(this.hero().pos.x + 1.2, this.hero().pos.y);
          this.kicks = [];
        },
        objectives: [{ label: 'HIT IT ANYWAY', done: () => this.kicks.length > 0 }],
        tick: () => this.refetch(),
        cleanup: () => this.restoreStats(),
      },
      { kind: 'card', lines: [
          ['SWITCHING BODIES'],
          ['THE GOLD CHEVRON IS ALWAYS YOU'],
          ['THE WHITE CHEVRON IS WHO ', K('E'), ' SWAPS YOU INTO'],
          ['USUALLY WHOEVER IS CLOSEST TO THE BALL THAT IS NOT YOU'],
        ] },
      {
        kind: 'stage', bubble: 'WALK A FEW STEPS THEN PRESS E AND WALK WITH THE NEW MAN', allowSwitch: true,
        arrange: () => {
          const buddy = this.homeOf('MF', 2);
          this.clearField([this.heroIdx, buddy]);
          this.put(this.heroIdx, 54, 37);
          this.put(buddy, 62, 37);
          this.ballAt(58, 33);
          this.startCursor = this.heroIdx;
          this.swapMoved = 0;
          this.carried = 0;
        },
        objectives: [
          { label: 'MOVE A LITTLE', done: () => this.swapMoved > 3 },
          { label: 'PRESS E TO SWAP', done: () => this.hooks.cursorIdx() !== this.startCursor },
          { label: 'MOVE THE NEW MAN', done: () => this.hooks.cursorIdx() !== this.startCursor && this.swapMoved > 8 },
        ],
      },
      { kind: 'card', lines: [
          ['PASSING MOVES YOU TOO'],
          ['COMPLETE A PASS AND YOU BECOME THE RECEIVER'],
          ['DRAG BACK AIM AT YOUR TEAMMATE AND LET GO'],
        ] },
      {
        kind: 'stage', bubble: 'PASS TO YOUR TEAMMATE', allowSwitch: true,
        arrange: () => {
          const mate = this.homeOf('FW', 0);
          this.setHero(this.homeOf('MF', 1));
          this.clearField([this.heroIdx, mate]);
          this.dress(this.heroIdx, COACH_PICK);
          this.put(this.heroIdx, 56, 37);
          this.put(mate, 72, 33);
          this.ballAt(57.2, 37);
        },
        objectives: [
          { label: 'FEED HIM', done: () => this.world().lastTouch?.idx === this.homeOf('FW', 0) },
          { label: 'YOU ARE HIM NOW', done: () => this.hooks.cursorIdx() === this.homeOf('FW', 0) },
        ],
        tick: () => this.chase(this.homeOf('FW', 0)),
        cleanup: () => this.restoreStats(),
      },
      { kind: 'card', lines: [
          ['TIME TO SCORE ONE'],
          ['THIS KEEPER NEVER LEAVES HIS NEAR POST'],
          ['SO MAKE HIM MOVE FIRST'],
          ['CARRY UP THE RIGHT WING CROSS TO THE FAR POST AND FINISH'],
        ] },
      {
        kind: 'stage', bubble: 'UP THE RIGHT WING. CROSS HIM. FINISH IT', allowSwitch: true,
        arrange: () => this.arrangeCross(),
        objectives: [
          { label: 'REACH THE RIGHT WING', done: () => this.hero().pos.x > 94 && this.hero().pos.y > 48 && this.world().carrier?.idx === this.hooks.cursorIdx() },
          { label: 'CROSS TO THE FAR POST', done: () => this.crossed },
          { label: 'SCORE', done: () => this.events().some((e) => e.kind === 'goal') },
        ],
        tick: () => this.tickCross(),
      },
      { kind: 'card', lines: [
          ['DEFENDING IS ON PURPOSE HERE'],
          ['GET CLOSE TO THE CARRIER AND HOLD ', K('SPACE')],
          ['CHALK JAWS CLOSE AROUND THE BALL AND THEN IT IS YOURS'],
          ['A QUICK TAP OF ', K('SPACE'), ' IS A RISKY LUNGE INSTEAD'],
        ] },
      {
        kind: 'stage', bubble: 'HOLD SPACE ON HIM UNTIL THE JAWS CLOSE. THEN GO SCORE',
        arrange: () => this.arrangeSteal(),
        objectives: [
          { label: 'CLAMP THE BALL AWAY', done: () => this.world().carrier?.idx === this.heroIdx },
          { label: 'SCORE ON THEIR GOAL', done: () => this.events().some((e) => e.kind === 'goal') },
        ],
        cleanup: () => this.restoreStats(),
        tick: () => {
          const victim = this.awayOf('MF', 0);
          const w = this.world();
          // the victim stands proud until robbed — the latch stays his
          if (w.carrier?.idx !== this.heroIdx && w.lastTouch?.team !== 0 && dist(w.ball.pos, w.players[victim].pos) < 1.4) {
            w.carrier = { idx: victim, t: 0.8 };
          }
        },
      },
      { kind: 'card', lines: [
          ['LAST DRILL. ONE OF YOU TWO OF THEM'],
          ['A REAL DEFENDER WILL HUNT YOU NOW'],
          ['DRIBBLE AWAY FROM HIM FEED YOUR TEAMMATE AND SCORE'],
        ] },
      {
        kind: 'stage', bubble: 'HE IS COMING. KEEP IT MOVE IT SCORE IT', allowSwitch: true,
        arrange: () => this.arrangeDuel(),
        objectives: [
          { label: 'SURVIVE THE PRESS', done: () => this.survived > 3.5 },
          { label: 'FEED YOUR TEAMMATE', done: () => this.crossed },
          { label: 'SCORE', done: () => this.events().some((e) => e.kind === 'goal') },
        ],
        tick: (dt) => this.tickDuel(dt),
      },
      { kind: 'card', lines: [
          ['HOUSEKEEPING SO NOTHING SURPRISES YOU'],
          ['BALL OFF THE SIDE LINES IS A THROW IN'],
          ['OFF THEIR END LINE OFF THEM IS YOUR CORNER'],
          ['WHEN YOUR KEEPER CATCHES IT HE LAUNCHES BY HAND'],
          ['AND WHEN YOU ARE NEAR A LOOSE BALL YOUR MAN TACKLES ON HIS OWN'],
        ] },
      { kind: 'choice' },
    ];
  }

  // --------------------------------------------------------- stage details
  private arrangeCross() {
    this.setHero(this.homeOf('MF', 1));
    const mate = this.homeOf('FW', 0);
    this.clearField([this.heroIdx, mate, this.awayOf('GK', 0)]);
    this.dress(this.heroIdx, COACH_PICK);
    this.dress(mate, COACH_PICK);
    this.put(this.heroIdx, 84, 56);
    this.put(mate, 102, 24);
    this.put(this.awayOf('GK', 0), PITCH.length - 1.2, PITCH.width / 2 + 3);
    this.ballAt(85.2, 56);
    this.crossed = false;
    this.myKickFlying = false;
  }
  private tickCross() {
    const w = this.world();
    if (this.hooks.cursorIdx() !== this.homeOf('FW', 0)) this.chase(this.homeOf('FW', 0), 8);
    const gk = this.awayOf('GK', 0);
    // the keeper shuffles after the ball but NEVER crosses his mouth's centre
    // and never dives — beat him by moving the ball faster than his feet
    const g = w.players[gk];
    const half = PITCH.goalWidth / 2;
    const targetY = clamp(w.ball.pos.y, PITCH.width / 2 + 0.4, PITCH.width / 2 + half);
    const dy = targetY - g.pos.y;
    this.actors.set(gk, { ...IDLE(), move: vec(0, clamp(dy * 2, -0.55, 0.55)) });
    // a hero kick that a far-post man collects is the cross
    if (this.events().some((e) => e.kind === 'kick' && e.idx === this.heroIdx)) this.myKickFlying = true;
    if (this.myKickFlying && w.lastTouch?.idx === this.homeOf('FW', 0)) this.crossed = true;
    // dead ball or keeper smother: stage resets, checked boxes stay
    if (this.events().some((e) => e.kind === 'restart' || e.kind === 'save') ||
        (w.lastTouch?.team === 1 && w.ball.speed() < 1)) {
      this.scene.toast('AGAIN. MAKE THE KEEPER MOVE FIRST');
      this.arrangeCross();
    }
  }
  private arrangeSteal() {
    this.setHero(this.homeOf('DF', 0));
    const victim = this.awayOf('MF', 0);
    this.clearField([this.heroIdx, victim, this.awayOf('GK', 0)]);
    this.dress(victim, { control: 0.3, phys: 0.35 }); // lesson one: he barely fights the jaws
    this.put(this.heroIdx, 62, 37);
    this.put(victim, 70, 37);
    this.put(this.awayOf('GK', 0), PITCH.length - 2, 12);
    this.ballAt(69.4, 37);
    this.world().carrier = { idx: victim, t: 0.8 };
    this.actors.set(victim, IDLE());
  }
  private arrangeDuel() {
    this.setHero(this.homeOf('MF', 1));
    const mate = this.homeOf('FW', 0);
    this.clearField([this.heroIdx, mate, this.awayOf('DF', 0), this.awayOf('GK', 0)]);
    this.dress(mate, COACH_PICK);
    this.put(this.heroIdx, 68, 40);
    this.put(mate, 100, 30);
    const hunter = this.awayOf('DF', 0);
    this.dress(hunter, { defend: 0.78, phys: 0.72 });
    this.put(hunter, 78, 38);
    this.put(this.awayOf('GK', 0), PITCH.length - 1.2, PITCH.width / 2 + 3);
    this.ballAt(69.2, 40);
    this.survived = 0;
    this.crossed = false;
    this.myKickFlying = false;
  }
  private tickDuel(dt: number) {
    const w = this.world();
    if (this.hooks.cursorIdx() !== this.homeOf('FW', 0)) this.chase(this.homeOf('FW', 0), 8);
    const hunter = this.awayOf('DF', 0);
    const h = w.players[hunter];
    const toBall = vec(w.ball.pos.x - h.pos.x, w.ball.pos.y - h.pos.y);
    const d = Math.hypot(toBall.x, toBall.y) || 1;
    const ours = w.carrier !== null && w.players[w.carrier.idx].id.team === 0;
    this.actors.set(hunter, {
      move: vec(toBall.x / d, toBall.y / d),
      sprint: d > 3,
      kickCharging: false,
      kickReleased: null,
      clamp: ours && d < 2.4,
      tackle: !ours && d < 1.2 && h.tackleCooldown <= 0,
    });
    if (ours && this.hooks.cursorIdx() === (w.carrier?.idx ?? -1)) this.survived += dt;
    if (this.events().some((e) => e.kind === 'kick' && e.idx === this.heroIdx)) this.myKickFlying = true;
    if (this.myKickFlying && w.lastTouch?.idx === this.homeOf('FW', 0)) this.crossed = true;
    const gk = this.awayOf('GK', 0);
    const g = w.players[gk];
    const half = PITCH.goalWidth / 2;
    const targetY = clamp(w.ball.pos.y, PITCH.width / 2 + 0.4, PITCH.width / 2 + half);
    this.actors.set(gk, { ...IDLE(), move: vec(0, clamp((targetY - g.pos.y) * 2, -0.55, 0.55)) });
    // they stole it or it died out there: back to marks, keep your ticks
    if (w.lastTouch?.team === 1 && w.ball.speed() < 1 && !ours) {
      this.scene.toast('HE ATE IT. AGAIN');
      this.arrangeDuel();
    }
    if (this.events().some((e) => e.kind === 'restart')) this.arrangeDuel();
  }

  // ------------------------------------------------------------ the engine
  key(code: string): boolean {
    if (this.mode === 'card') {
      if (code !== 'Enter') return false;
      if (!this.typeDone) { this.typeBudget = this.typeTotal; return true; }
      audio.ui('card', 0.6);
      this.next();
      return true;
    }
    if (this.mode === 'tour') {
      if (code !== 'Enter') return false;
      if (this.tourT < 4.4) { this.tourT = 4.4; return true; }
      audio.ui('card', 0.6);
      this.next();
      return true;
    }
    if (this.mode === 'choice' && this.choice) {
      if (code === 'ArrowUp' || code === 'KeyW') { this.choice.move(-1); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { this.choice.move(1); return true; }
      if (code === 'Enter') { this.choice.activate(); return true; }
      return false;
    }
    return false;
  }

  frame(dt: number, input: PlayerInput, overrides: Record<number, PlayerInput>) {
    const w = this.world();
    const step = this.steps[this.stepIdx];
    // everyone stands where the coach put them — only the hero and the
    // scripted actors are alive, in every mode
    for (let i = 0; i < w.players.length; i++) {
      if (i === this.hooks.cursorIdx()) continue;
      overrides[i] = this.actors.get(i) ?? IDLE();
    }
    if (this.capPower && input.kickReleased) {
      input.kickReleased.power = Math.min(input.kickReleased.power, this.capPower);
    }
    if (this.mode === 'card' || this.mode === 'choice') {
      // the field waits under the card: nobody moves, nothing counts
      overrides[this.hooks.cursorIdx()] = IDLE();
      if (this.mode === 'card') this.tickType(dt);
      return;
    }
    if (this.mode === 'tour') {
      this.tickTour(dt);
      return;
    }
    if (step?.kind !== 'stage') return;
    // trackers
    const hero = this.hero();
    const moved = dist(hero.pos, this.prevHero);
    if (w.carrier?.idx === this.heroIdx) this.carried += moved;
    this.prevHero = vec(hero.pos.x, hero.pos.y);
    const cur = w.players[this.hooks.cursorIdx()];
    this.swapMoved += Math.hypot(cur.vel.x, cur.vel.y) * dt;
    if (input.move.y < -0.3) this.moveSeen.w = true;
    if (input.move.y > 0.3) this.moveSeen.s = true;
    if (input.move.x < -0.3) this.moveSeen.a = true;
    if (input.move.x > 0.3) this.moveSeen.d = true;
    for (const e of this.events()) if (e.kind === 'kick' && e.idx === this.hooks.cursorIdx()) this.kicks.push(e.power);
    // a stage that forbids drifting hands you back to the drill's man
    if (!step.allowSwitch && this.hooks.cursorIdx() !== this.heroIdx) this.hooks.assign(this.heroIdx);
    if (step.allowSwitch) this.heroIdx = this.hooks.cursorIdx() === this.heroIdx ? this.heroIdx : this.heroIdx;
    // dead-ball watchdog: drills never wait on a ceremony
    if (w.restartLock > 0.2) this.clearLocks();
    step.tick?.(dt);
    // objectives
    let all = true;
    step.objectives.forEach((o, i) => {
      const v = this.objViews[i];
      if (!v) return;
      if (!v.hit && o.done()) {
        v.hit = true;
        v.boxG.rect(3, 3, 8, 8).fill({ color: 0x9ff0b8, alpha: 1 });
        audio.ui('select', 0.6);
      }
      all = all && v.hit;
    });
    if (all) {
      this.advanceBeat += dt;
      if (this.advanceBeat > 0.8) { audio.ui('buy', 0.6); this.next(); }
    }
    // the bubble rides the man you actually hold
    const sp = this.scene.worldToScreen(cur.pos.x, cur.pos.y, 2.4);
    this.bubble.position.set(
      Math.round(clamp(sp.x - this.bubble.width / 2, 8, this.app().screen.width - this.bubble.width - 8)),
      Math.round(clamp(sp.y - 34, 8, this.app().screen.height - 60)),
    );
  }

  private app() { return this.scene['app'] as { screen: { width: number; height: number } }; }

  private next() {
    const prev = this.steps[this.stepIdx];
    if (prev?.kind === 'stage') prev.cleanup?.();
    this.actors.clear();
    this.advanceBeat = 0;
    this.stepIdx++;
    const step = this.steps[this.stepIdx];
    if (!step) return this.finish('menu');
    this.cardBox.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.objPanel.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.objViews = [];
    this.bubble.visible = false;
    this.dim.clear();
    this.scene.setCameraOverride(null);
    if (step.kind === 'card') { this.mode = 'card'; this.buildCard(step); }
    else if (step.kind === 'tour') { this.mode = 'tour'; this.tourT = 0; this.buildTour(); }
    else if (step.kind === 'choice') { this.mode = 'choice'; this.buildChoice(); }
    else { this.mode = 'stage'; this.clearLocks(); step.arrange(); this.buildStage(step); }
  }

  private finish(kind: 'menu' | 'training' | 'easy') {
    if (this.done) return;
    this.done = true;
    try { localStorage.setItem('t22.tutorialDone', '1'); } catch { /* headless is fine */ }
    this.hooks.exit(kind);
  }

  // ---------------------------------------------------------------- the UI
  private sw() { return this.app().screen.width; }
  private sh() { return this.app().screen.height; }

  private keycap(label: string): Container {
    const c = new Container();
    const t = new PixelText(this.assets, 2, 0x12161f);
    t.text = label;
    const w = Math.max(22, t.width + 12);
    const g = new Graphics();
    g.rect(0, -2, w, 20).fill({ color: 0x05070b, alpha: 0.9 });
    g.rect(1, -1, w - 2, 18).fill({ color: 0xd8dee9, alpha: 1 });
    g.rect(1, -1, w - 2, 2).fill({ color: 0xffffff, alpha: 0.8 });
    g.rect(1, 14, w - 2, 3).fill({ color: 0x8891a2, alpha: 1 });
    c.addChild(g, t);
    t.position.set(Math.round((w - t.width) / 2), 1);
    return c;
  }

  private buildCard(card: Card) {
    this.dim.rect(0, 0, this.sw(), this.sh()).fill({ color: 0x05080c, alpha: 0.62 });
    const panel = new Container();
    const rows: Container[] = [];
    this.typeTargets = [];
    this.typeTotal = 0;
    let maxW = 380;
    for (const line of card.lines) {
      const row = new Container();
      let x = 0;
      for (const seg of line) {
        if (typeof seg === 'string') {
          const t = new PixelText(this.assets, 2, 0xdfe4ee);
          t.text = seg;
          t.position.set(x, 2);
          row.addChild(t);
          x += t.width + 6;
          this.typeTargets.push({ obj: t, chars: seg.length });
          this.typeTotal += seg.length;
        } else {
          const cap = this.keycap(seg.key);
          cap.position.set(x, 0);
          row.addChild(cap);
          x += cap.width + 6;
          this.typeTargets.push({ obj: cap, chars: 2 });
          this.typeTotal += 2;
        }
      }
      rows.push(row);
      maxW = Math.max(maxW, row.width + 76);
    }
    const lineH = 30;
    let bh = 34 + rows.length * lineH + 30;
    if (card.link) bh += 26;
    const bw = Math.min(maxW, this.sw() - 80);
    const g = new Graphics();
    g.rect(-bw / 2, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.92 });
    g.rect(-bw / 2, 0, bw, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    g.rect(-bw / 2, bh - 2, bw, 2).fill({ color: 0x000000, alpha: 0.5 });
    for (const [cx, cy] of [[-bw / 2 + 3, 5], [bw / 2 - 6, 5], [-bw / 2 + 3, bh - 8], [bw / 2 - 6, bh - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: 0xffd95e, alpha: 0.55 });
    }
    panel.addChild(g);
    rows.forEach((row, i) => {
      row.position.set(Math.round(-row.width / 2), 30 + i * lineH);
      panel.addChild(row);
    });
    if (card.link) {
      const link = new PixelText(this.assets, 2, 0x9ff0b8);
      link.text = card.link.label;
      link.position.set(Math.round(-link.width / 2), 30 + rows.length * lineH + 6);
      const bar = new Graphics().rect(link.position.x, link.position.y + 16, link.width, 1).fill({ color: 0x9ff0b8, alpha: 0.5 });
      link.eventMode = 'static';
      link.cursor = 'pointer';
      const url = card.link.url;
      link.on('pointertap', () => window.open(url, '_blank'));
      panel.addChild(bar, link);
    }
    // a FRESH prompt each card — the old one dies with its panel, and a
    // destroyed transform throws the moment anyone repositions it
    this.prompt = new PixelText(this.assets, 2, 0xffd95e);
    this.prompt.text = 'PRESS ENTER';
    this.prompt.position.set(Math.round(bw / 2 - this.prompt.width - 14), bh - 22);
    panel.addChild(this.prompt);
    panel.position.set(Math.round(this.sw() / 2), Math.round(this.sh() * 0.30));
    this.cardBox.addChild(panel);
    this.typeBudget = 0;
    this.typeDone = false;
    for (const t of this.typeTargets) t.obj.visible = false;
  }

  private tickType(dt: number) {
    if (!this.typeDone) {
      this.typeBudget = Math.min(this.typeTotal, this.typeBudget + dt * 60);
      let used = 0;
      for (const t of this.typeTargets) {
        const show = this.typeBudget >= used + t.chars;
        const partial = !show && this.typeBudget > used;
        if (t.obj instanceof PixelText) {
          // PixelText retypes cheaply: reveal whole segments, letter feel
          // comes from segment granularity and the budget's speed
          t.obj.visible = show || partial;
        } else {
          t.obj.visible = show;
        }
        used += t.chars;
      }
      if (this.typeBudget >= this.typeTotal) this.typeDone = true;
      this.prompt.visible = false;
    } else {
      this.promptT += dt;
      this.prompt.visible = Math.sin(this.promptT * 5) > -0.35;
    }
  }

  private buildTour() {
    this.tourCap.text = 'YOUR STAGE. ALL TWENTY TWO OF THEM';
    this.tourCap.centerAt(this.sw() / 2, this.sh() - 90);
    this.cardBox.addChild(this.tourCap);
    const p = new PixelText(this.assets, 2, 0xffd95e);
    p.text = 'PRESS ENTER';
    p.centerAt(this.sw() / 2, this.sh() - 60);
    this.cardBox.addChild(p);
  }

  private tickTour(dt: number) {
    this.tourT += dt;
    const t = this.tourT;
    const mid = PITCH.width / 2;
    if (t < 1.3) this.scene.setCameraOverride({ center: vec(PITCH.length * 0.25, mid), zoom: 1.45 });
    else if (t < 2.9) {
      const k = (t - 1.3) / 1.6;
      this.scene.setCameraOverride({ center: vec(PITCH.length * (0.25 + 0.5 * k), mid), zoom: 1.45 });
    } else {
      this.scene.setCameraOverride({ center: vec(PITCH.length / 2, mid), zoom: 0.78 });
    }
  }

  private buildStage(stage: Stage) {
    // objectives ledger, top-left, in the game's own cloth
    const panel = new Container();
    const title = new PixelText(this.assets, 2, 0x8a91a0, 'micro');
    title.text = 'OBJECTIVES';
    title.position.set(14, 10);
    panel.addChild(title);
    let y = 26;
    let bw = 150;
    for (const o of stage.objectives) {
      const boxG = new Graphics();
      boxG.rect(0, 0, 14, 14).fill({ color: 0x0d1119, alpha: 0.9 });
      boxG.rect(0, 0, 14, 2).fill({ color: 0x9ff0b8, alpha: 0.4 });
      boxG.rect(0, 12, 14, 2).fill({ color: 0x000000, alpha: 0.5 });
      boxG.position.set(14, y);
      const t = new PixelText(this.assets, 2, 0xdfe4ee);
      t.text = o.label;
      t.position.set(34, y + 1);
      panel.addChild(boxG, t);
      this.objViews.push({ boxG, hit: false });
      bw = Math.max(bw, 34 + t.width + 16);
      y += 22;
    }
    const bg = new Graphics();
    bg.rect(0, 0, bw, y + 8).fill({ color: 0x0d1119, alpha: 0.82 });
    bg.rect(0, 0, bw, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    panel.addChildAt(bg, 0);
    panel.position.set(12, 12);
    this.objPanel.addChild(panel);
    // the speech bubble
    this.bubbleText.text = stage.bubble;
    const tw = this.bubbleText.width;
    this.bubbleBg.clear();
    this.bubbleBg.rect(-8, -6, tw + 16, 26).fill({ color: 0xf2efe4, alpha: 0.96 });
    this.bubbleBg.rect(-8, -6, tw + 16, 2).fill({ color: 0xffffff, alpha: 0.9 });
    this.bubbleBg.rect(-8, 18, tw + 16, 2).fill({ color: 0x9b937d, alpha: 0.9 });
    this.bubbleBg.rect(Math.round(tw / 2) - 3, 20, 6, 5).fill({ color: 0xf2efe4, alpha: 0.96 });
    this.bubbleText.position.set(0, 0);
    this.bubble.visible = true;
  }

  private buildChoice() {
    this.dim.rect(0, 0, this.sw(), this.sh()).fill({ color: 0x05080c, alpha: 0.62 });
    const panel = new Container();
    const head = new PixelText(this.assets, 3, 0xffd95e);
    head.text = 'YOU KNOW THE BASICS NOW';
    const sub = new PixelText(this.assets, 2, 0xdfe4ee);
    sub.text = 'WHERE TO?';
    this.choice = new PixelList(this.assets, 3, 34, 7, 13, true);
    this.choice.setRows([
      { label: 'AN EASY FIVE MINUTE MATCH', enabled: true },
      { label: 'THE TRAINING GROUND', enabled: true },
      { label: 'MAIN MENU', enabled: true },
    ], true, false, 0);
    this.choice.onPick = (i) => {
      audio.ui('select');
      this.finish(i === 0 ? 'easy' : i === 1 ? 'training' : 'menu');
    };
    const bw = 560;
    const bh = 210;
    const g = new Graphics();
    g.rect(-bw / 2, 0, bw, bh).fill({ color: 0x0d1119, alpha: 0.92 });
    g.rect(-bw / 2, 0, bw, 2).fill({ color: 0xffd95e, alpha: 0.5 });
    for (const [cx, cy] of [[-bw / 2 + 3, 5], [bw / 2 - 6, 5], [-bw / 2 + 3, bh - 8], [bw / 2 - 6, bh - 8]]) {
      g.rect(cx, cy, 3, 3).fill({ color: 0xffd95e, alpha: 0.55 });
    }
    panel.addChild(g);
    head.centerAt(0, 26);
    sub.centerAt(0, 58);
    this.choice.root.position.set(0, 92);
    panel.addChild(head, sub, this.choice.root);
    panel.position.set(Math.round(this.sw() / 2), Math.round(this.sh() * 0.3));
    this.cardBox.addChild(panel);
  }

  update(dt: number) {
    this.choice?.update(dt);
  }
}
