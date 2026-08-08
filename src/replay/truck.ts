import { Application } from 'pixi.js';
import { Vec2, vec, clamp } from '../core/math';
import { World } from '../sim/world';
import { SimEvent } from '../sim/events';
import { GameAssets } from '../render/assets';
import { Scene } from '../render/scene';
import { audio } from '../audio/engine';
import { ReplayRing, ReplayCut, buildCut, poseCut, cutEvents } from './ring';
import { ReplayOverlay, ReplayRoomRow } from './overlay';

// THE OB TRUCK. A goal goes in, the roar gets its beat, and then the truck
// takes the room: two blips, the tape from the turnover, the strike in slow
// motion with smoke off the ball, the net — and afterwards a breath of the
// lens easing wide before the game is handed back. It plays once. The sim is
// frozen the whole time and put back exactly as it was found.

const ARM = 1.5;        // the roar owns the first beat; the truck cuts in after
const BLIP_IN = 0.46;
const BLIP_OUT = 0.34;
const SLOW = 0.35;      // the strike, at a third of life
const HOLD = 0.9;       // ...and a held frame on the ball in the netting
const BREATHE = 1.6;    // the lens easing wide: the game is thinking about it
const WAIT_CAP = 15;    // nobody holds a room hostage
const GUEST_CAP = 25;   // ...and a lost packet never hangs a guest tab
const BUILD_ZOOM = 2.45;
const NEAR_ZOOM = 3.5;  // a tap-in is framed on the boot
const FAR_ZOOM = 2.05;  // a thirty-yarder needs the whole picture
const LONG_SHOT = 32;   // meters at which the frame is fully open
const COMET_LIFE = 0.5;
const COMET_MAX = 44;

type Phase = 'off' | 'armed' | 'blipIn' | 'rolling' | 'hold' | 'wait' | 'blipOut' | 'breathe';

// The live world, held aside while the tape plays over the top of it
interface FrozenPose {
  ball: number[];
  players: number[][];
  clamp: World['clamp'];
}

function capture(world: World): FrozenPose {
  const b = world.ball;
  return {
    ball: [b.pos.x, b.pos.y, b.z, b.vel.x, b.vel.y, b.vz, b.prev.x, b.prev.y, b.prev.z],
    players: world.players.map((p) => [
      p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.facing.x, p.facing.y,
      p.prev.x, p.prev.y, p.lungeTimer, p.isCharging ? 1 : 0, p.isSprinting ? 1 : 0, p.stamina,
    ]),
    clamp: world.clamp,
  };
}

function restore(world: World, pose: FrozenPose) {
  const b = world.ball;
  [b.pos.x, b.pos.y, b.z, b.vel.x, b.vel.y, b.vz, b.prev.x, b.prev.y, b.prev.z] = pose.ball;
  world.players.forEach((p, i) => {
    const s = pose.players[i];
    if (!s) return;
    [p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.facing.x, p.facing.y, p.prev.x, p.prev.y, p.lungeTimer] = s;
    p.isCharging = s[9] > 0;
    p.isSprinting = s[10] > 0;
    p.stamina = s[11];
  });
  world.clamp = pose.clamp;
}

export class ReplayTruck {
  ring = new ReplayRing();
  private overlay: ReplayOverlay;
  private phase: Phase = 'off';
  private phaseT = 0;
  private armT = 0;
  private tapeT = 0;
  private side: 'left' | 'right' = 'left';
  private cut: ReplayCut | null = null;
  private frozen: FrozenPose | null = null;
  private comet: { x: number; y: number; z: number; a: number; wx: number; wy: number }[] = [];
  private lens: { center: Vec2; zoom: number } = { center: vec(), zoom: BUILD_ZOOM };
  // Online: every seat that has to nod before the game moves on, and who has
  private room: { seat: number; name: string }[] | null = null;
  private ready = new Set<number>();
  private mirrored: ReplayRoomRow[] | null = null; // a guest shows the host's list, not his own
  private mySeat = 0;

  constructor(private app: Application, assets: GameAssets) {
    this.overlay = new ReplayOverlay(assets);
  }

  get root() {
    return this.overlay.root;
  }

  // True while the truck owns the room — the sim must hold absolutely still
  get holds(): boolean {
    return this.phase !== 'off' && this.phase !== 'armed';
  }

  // On the way out. Online this is the word every other tab is waiting for, so
  // the whole room blips back to the football on the same beat.
  get closing(): boolean {
    return this.phase === 'blipOut' || this.phase === 'breathe';
  }

  // A goal has gone in; the tape keeps rolling through the roar until the cut
  arm(side: 'left' | 'right') {
    if (this.phase !== 'off') return;
    this.side = side;
    this.armT = ARM;
    this.phase = 'armed';
  }

  // Loaded, and waiting for its beat. The ceremony holds a whole chapter open
  // for this — until it clears, nobody may walk home.
  get arming(): boolean {
    return this.phase === 'armed';
  }

  // Online: who must press before play resumes (one seat, or none, is solo)
  setRoom(seats: { seat: number; name: string }[], mySeat: number) {
    this.room = seats.length > 1 ? seats : null;
    this.mySeat = mySeat;
    if (this.room) for (const s of [...this.ready]) if (!this.room.some((r) => r.seat === s)) this.ready.delete(s);
  }

  // A guest never counts the nods himself — the host's word is the list
  applyRoom(rows: ReplayRoomRow[]) {
    this.mirrored = rows.length > 1 ? rows : null;
  }

  // Enter: your nod. Alone in the room it is simply a skip; in a party it is
  // one vote of several, and only the host's count ends anything.
  press(): boolean {
    if (!this.holds) return false;
    this.ready.add(this.mySeat);
    if (!this.room && !this.mirrored) this.skip();
    else this.counted();
    return true;
  }

  // A friend's Enter arrived over the wire; the host keeps the only tally
  nod(seat: number) {
    if (!this.holds) return;
    this.ready.add(seat);
    this.counted();
  }

  private counted() {
    if (this.room && this.ready.size >= this.room.length) this.skip();
  }

  // The host says the room has seen enough
  release() {
    this.skip();
  }

  // The list a host puts on the wire, and a guest paints
  rows(): ReplayRoomRow[] {
    return (this.room ?? []).map((r) => ({ name: r.name, ready: this.ready.has(r.seat) }));
  }

  // Counted down under every live tick: when the roar has had its beat AND the
  // ceremony says the party is over, the truck cuts in — unless the tape has no
  // story to tell, and then it never interrupts at all. A tab with no ceremony
  // of its own (a guest, watching snapshots) rides the beat alone.
  cue(dt: number, world: World, scene: Scene, ready = true) {
    if (this.phase !== 'armed') return;
    this.armT -= dt;
    if (this.armT > 0 || !ready) return;
    const cut = buildCut(this.ring, this.side, (i) => world.players[i]?.id.team);
    if (!cut) { this.phase = 'off'; return; }
    this.cut = cut;
    this.frozen = capture(world);
    this.tapeT = cut.from;
    this.phase = 'blipIn';
    this.phaseT = 0;
    this.comet.length = 0;
    this.ready.clear();
    scene.setReplay(true);
    scene.setKeeperAim(null);
    scene.setKickDrag(null);
    scene.setPassHints([]);
    scene.setHoverTarget(-1);
    scene.setBallGlow(false);
    scene.setBallComet(this.comet);
    audio.ui('card', 0.9);
    audio.play('ui-tick', { vol: 0.55, delay: 0.18 }); // blip, blip
  }

  // One frame with the room held. Returns true the instant it hands back.
  tick(dt: number, world: World, scene: Scene): boolean {
    const cut = this.cut;
    if (!cut) { this.phase = 'off'; return true; }
    this.phaseT += dt;
    let handedBack = false;

    switch (this.phase) {
      case 'blipIn':
        poseCut(cut, world, this.tapeT);
        if (this.phaseT >= BLIP_IN) { this.phase = 'rolling'; this.phaseT = 0; }
        break;
      case 'rolling': {
        const speed = this.tapeT < cut.shot ? 1 : SLOW;
        const was = this.tapeT;
        this.tapeT = Math.min(cut.until, this.tapeT + dt * speed);
        poseCut(cut, world, this.tapeT);
        this.sound(cutEvents(cut, was, this.tapeT), speed);
        if (this.tapeT >= cut.until) { this.phase = 'hold'; this.phaseT = 0; }
        break;
      }
      case 'hold':
        poseCut(cut, world, this.tapeT);
        if (this.phaseT >= HOLD) this.finishPlayback();
        break;
      case 'wait':
        poseCut(cut, world, this.tapeT);
        if (this.phaseT >= (this.room ? WAIT_CAP : GUEST_CAP)) this.skip();
        break;
      case 'blipOut':
        if (this.frozen && this.phaseT >= BLIP_OUT * 0.45) this.undress(world, scene);
        if (this.phaseT >= BLIP_OUT) { this.phase = 'breathe'; this.phaseT = 0; }
        break;
      case 'breathe':
        if (this.phaseT >= BREATHE) {
          this.phase = 'off';
          this.cut = null;
          this.overlay.hide();
          scene.setCameraOverride(null);
          handedBack = true;
        }
        break;
    }

    if (this.phase === 'off') return handedBack;
    this.frame(world);
    this.driftComet(dt, world);
    scene.setCameraOverride(this.lens);
    this.paint(dt);
    return handedBack;
  }

  // A goal seen twice is a goal that got old — the tape plays exactly once,
  // and everything a match left behind goes with it
  reset(scene: Scene | null) {
    if (this.holds) {
      scene?.setReplay(false);
      scene?.setBallComet(null);
      scene?.setCameraOverride(null);
    }
    this.phase = 'off';
    this.cut = null;
    this.frozen = null;
    this.room = null;
    this.mirrored = null;
    this.ready.clear();
    this.comet.length = 0;
    this.ring.clear();
    this.overlay.hide();
  }

  // Playback is over: alone you go straight to the breath, in a room you wait
  // for the last nod
  private finishPlayback() {
    const owed = this.room ? this.ready.size < this.room.length : !!this.mirrored;
    if (owed) { this.phase = 'wait'; this.phaseT = 0; return; }
    this.skip();
  }

  private skip() {
    if (this.phase === 'blipOut' || this.phase === 'breathe' || this.phase === 'off') return;
    this.phase = 'blipOut';
    this.phaseT = 0;
    audio.ui('back', 0.7);
  }

  private undress(world: World, scene: Scene) {
    restore(world, this.frozen!);
    this.frozen = null;
    this.comet.length = 0;
    scene.setReplay(false);
    scene.setBallComet(null);
  }

  // The lens: the ball through the buildup, then a push off the boot toward
  // the mouth — framed wider the further out the strike was struck from
  private frame(world: World) {
    const cut = this.cut;
    if (!cut) return;
    if (this.phase === 'breathe') {
      // the game thinking it over: the same spot, the picture opening up
      const k = clamp(this.phaseT / BREATHE, 0, 1);
      this.lens = { center: vec(world.ball.pos.x, world.ball.pos.y), zoom: 3.2 - k * 0.95 };
      return;
    }
    const ball = world.ball.pos;
    if (this.tapeT < cut.shot) {
      this.lens = { center: vec(ball.x, ball.y), zoom: BUILD_ZOOM };
      return;
    }
    const p = clamp((this.tapeT - cut.shot) / Math.max(0.25, cut.goal - cut.shot), 0, 1);
    const e = p * p * (3 - 2 * p);
    const px = cut.boot.x + (cut.mouth.x - cut.boot.x) * e;
    const py = cut.boot.y + (cut.mouth.y - cut.boot.y) * e;
    const wide = clamp(cut.range / LONG_SHOT, 0, 1);
    const creep = this.phase === 'hold' ? clamp(this.phaseT / HOLD, 0, 1) * 0.07 : 0;
    this.lens = {
      center: vec(px + (ball.x - px) * 0.45, py + (ball.y - py) * 0.45),
      zoom: (NEAR_ZOOM - wide * (NEAR_ZOOM - FAR_ZOOM)) * (1 + 0.2 * e + creep),
    };
  }

  // The smoke: a hot line where the ball actually went, and puffs that lift and
  // wander off it as they cool. Only ever behind a struck ball. The wander is
  // hashed off the ball's own position, so a frame drawn twice looks the same.
  private driftComet(dt: number, world: World) {
    for (const c of this.comet) c.a -= dt / COMET_LIFE;
    while (this.comet.length && this.comet[this.comet.length - 1].a <= 0) this.comet.pop();
    const live = this.phase === 'rolling' && this.cut !== null && this.tapeT >= this.cut.shot;
    if (!live) return;
    const b = world.ball;
    const seed = Math.sin(b.pos.x * 12.9898 + b.pos.y * 78.233) * 43758.5453;
    const spray = (seed - Math.floor(seed)) * 2 - 1;
    this.comet.unshift({ x: b.pos.x, y: b.pos.y, z: b.z, a: 1, wx: spray, wy: Math.cos(spray * 3.1) });
    if (this.comet.length > COMET_MAX) this.comet.pop();
  }

  private sound(events: SimEvent[], speed: number) {
    const rate = 0.45 + 0.55 * speed;
    for (const e of events) {
      if (e.kind === 'kick') audio.play(e.power < 0.6 ? 'kick-soft' : 'kick-hard', { vol: 0.45, rate });
      else if (e.kind === 'post') audio.play('post-clank', { vol: 0.5, rate });
      else if (e.kind === 'save' || e.kind === 'parry') audio.play('gk-catch', { vol: 0.4, rate });
      else if (e.kind === 'goal') audio.play('net-swish', { vol: 0.6, rate });
    }
  }

  private paint(dt: number) {
    const cut = this.cut;
    const span = cut ? Math.max(0.1, cut.until - cut.from) : 1;
    const blip = this.phase === 'blipIn' ? this.blip(this.phaseT / BLIP_IN)
      : this.phase === 'blipOut' ? this.blip(1 - this.phaseT / BLIP_OUT)
      : { wash: 0, crush: 0 };
    const open = this.phase === 'blipIn' ? clamp((this.phaseT / BLIP_IN - 0.3) / 0.5, 0, 1)
      : this.phase === 'blipOut' ? 1 - clamp(this.phaseT / BLIP_OUT, 0, 1)
      : this.phase === 'breathe' ? 0
      : 1;
    const room = this.phase === 'wait' ? (this.mirrored ?? this.rows()) : null;
    this.overlay.render(dt, this.app.renderer.width, this.app.renderer.height, {
      open,
      progress: cut ? clamp((this.tapeT - cut.from) / span, 0, 1) : 1,
      slow: this.phase === 'rolling' && !!cut && this.tapeT >= cut.shot,
      wash: blip.wash,
      crush: blip.crush,
      hint: this.room || this.mirrored ? 'ENTER WHEN YOU ARE READY' : 'ENTER SKIPS',
      room,
    });
  }

  // Two hard blips and a crush — the punch of a tape hitting the air
  private blip(p: number): { wash: number; crush: number } {
    const k = clamp(p, 0, 1);
    const pulse = (at: number, w: number) => Math.max(0, 1 - Math.abs(k - at) / w);
    return {
      wash: Math.max(pulse(0.05, 0.07), pulse(0.3, 0.09) * 0.8),
      crush: Math.max(pulse(0.17, 0.1) * 0.9, k > 0.4 ? (1 - k) * 0.5 : 0),
    };
  }
}
