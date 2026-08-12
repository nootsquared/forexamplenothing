import { Application, Container, Graphics, Sprite } from 'pixi.js';
import { GameLoop } from '../core/loop';
import { Vec2, vec, add, sub, scale, clamp, clampLen, rotate } from '../core/math';
import { director } from '../director';
import { PITCH } from '../sim/constants';
import { pullOf } from '../sim/tuning';
import { World } from '../sim/world';
import { SimEvent } from '../sim/events';
import { GameAssets } from './assets';
import { PitchLayer } from './pitchLayer';
import { GrassField, GrassActor } from './grassField';
import { PlayerView, AimState } from './playerSprite';
import { BallView } from './ballSprite';
import { Effects } from './effects';
import { FollowCamera } from './camera';
import { Hud } from './hud';
import { KeeperAim, KeeperAimState } from './keeperAim';
import { project, pxPerMeter, squash } from './projection';
import { MOODS, VariantMood } from './variants';

// A dead ball is a composed beat, not a survey of the formation: the lens sits
// at playing size on the restart and keeps holding a while into live football,
// so the hand-back is a drift and never a lurch wide.
const RESTART_ZOOM = 2.55;
const RESTART_SETTLE = 2;
const HERO_PULL = 6;        // metres the man you hold may drag the restart shot off the ball
const CELEBRATE_PUSH = 4;   // seconds the goal shot takes to creep all the way in
const WALK_OPEN = 0.35;     // how much wider than a restart the walk home is framed

// The corner sight: where this delivery is going, how honest it is, and the
// marks your box is attacking — each lit while its man is actually breaking.
export interface CornerAimState {
  from: Vec2;
  target: Vec2;
  scatter: number;
  short: boolean; // a flat ball to the man at the flag, not a cross
  marks: { at: Vec2; live: boolean }[];
}

// Owns the display tree; reads sim state, never writes it
export class Scene {
  private viewport = new Container(); // camera-transformed world space
  private worldSorted = new Container();
  private pitchLayer: PitchLayer;
  private grass: GrassField;
  private playerViews: PlayerView[] = [];
  private ballView: BallView;
  private effects: Effects;
  private camera = new FollowCamera();
  private hud: Hud;
  private overlay = new Graphics();
  private flash = new Graphics();
  private flashAlpha = 0;
  private controlledIdx = -1;
  private switchTargetIdx = -1;
  private keeperAim: KeeperAim;
  private keeperAimState: KeeperAimState | null = null;
  private cornerG = new Graphics();   // the corner's ring and the marks it can pick
  private cornerAim: CornerAimState | null = null;
  private cornerPulse = 0;
  private lawRing = new Graphics();   // the restart exclusion, painted on the turf
  private offsideG = new Graphics();  // the flag's line, chalked when it matters
  private offsideFlash = 0;
  private tackleG = new Graphics();   // the red diamond: a lunge would land NOW
  private tackleFade = 0;
  private tacklePulse = 0;
  private foulBy = -1;    // ...and the man who went in after it shut
  private foulT = 0;
  private hoverG = new Graphics();  // the click-to-switch ring, chalked under a body
  private hoverIdx = -1;
  private hoverAt: Vec2 = vec(0, 0);
  private hoverFade = 0;
  private hoverPulse = 0;
  private dragG = new Graphics();   // the slingshot pass sight (chalk dots)
  private wedgeG = new Graphics();  // the honesty wedge, painted INTO the turf under the bodies
  private cometG = new Graphics();  // the smoke a struck ball drags through a replay
  private comet: { x: number; y: number; z: number; a: number; wx: number; wy: number }[] | null = null;
  private replayOn = false;         // the truck has the room: every live aid steps off
  private hudWanted = true;         // ...and the HUD comes back only if it was wanted
  private dragHead: Sprite;         // baked chalk arrowhead, tinted by power
  private kickDrags: { from: Vec2; dir: Vec2; power: number; theta?: number }[] = [];
  // "The ball is YOURS": a gold pixel frame breathing at the screen edge, and
  // under it the red one that only shows up when the match has real teeth
  private possessionGlow = new Graphics();
  private tensionEdge = new Graphics();
  private beatSerial = director.beat.serial;
  private glowOn = false;
  private glowFade = 0;
  private glowPulse = 0;
  private glowW = 0;
  private glowH = 0;
  private mood: VariantMood = MOODS[0];
  // Which lens density V has cycled to — the camera itself owns the number.
  // Starts at CLOSE, the couch's pick.
  private densityIdx = 1;
  // The ceremony's own lens: the shot a goal or a dead ball is being played on
  private staged: { center: Vec2; zoom: number } | null = null;
  private restartHold = 0;
  private celebT = 0;

  constructor(private app: Application, private assets: GameAssets, private world: World, loop: GameLoop) {
    this.hud = new Hud(assets);
    this.keeperAim = new KeeperAim(assets);
    this.worldSorted.sortableChildren = true;
    this.pitchLayer = new PitchLayer(assets, this.worldSorted);
    this.grass = new GrassField(assets, this.worldSorted);
    this.dragHead = new Sprite(assets.aimFrames[0]);
    this.dragHead.anchor.set(0.5, 0.5);
    this.dragHead.visible = false;
    this.viewport.addChild(this.pitchLayer.ground, this.lawRing, this.offsideG, this.hoverG, this.wedgeG, this.cornerG, this.keeperAim.rings, this.cometG, this.worldSorted, this.keeperAim.top, this.dragG, this.dragHead, this.tackleG);

    this.ballView = new BallView(assets, this.worldSorted);
    this.worldSorted.addChild(this.ballView.root);
    this.effects = new Effects(assets, this.worldSorted, this.pitchLayer.groundFx, loop);

    app.stage.addChild(this.viewport, this.overlay, this.flash, this.tensionEdge, this.possessionGlow, this.hud.root);
  }

  addPlayer(sheet: string, name = '', number = 0): PlayerView {
    const view = new PlayerView(this.assets, sheet, name, number);
    this.worldSorted.addChild(view.root);
    this.playerViews.push(view);
    return view;
  }

  setVariant(mood: VariantMood) {
    this.mood = mood;
    this.pitchLayer.setVariant(mood.id);
    this.worldSorted.tint = mood.spriteTint;
    this.hud.showToast(mood.name);
  }

  // V cycles how tight the live game is framed — three densities to taste
  cycleDensity() {
    const modes = [
      { zoom: 1, name: 'LENS: BROADCAST' },
      { zoom: 1.16, name: 'LENS: CLOSE' },
      { zoom: 1.34, name: 'LENS: INTENSE' },
    ];
    this.densityIdx = (this.densityIdx + 1) % modes.length;
    this.camera.density = modes[this.densityIdx].zoom;
    this.hud.showToast(modes[this.densityIdx].name);
  }

  setControlled(idx: number) {
    if (idx === this.controlledIdx) return;
    this.controlledIdx = idx;
    this.playerViews.forEach((v, i) => v.setControlled(i === idx));
  }

  // Keeper distribution sight — non-null while the human is aiming
  setKeeperAim(state: KeeperAimState | null, hands: 'keeper' | 'throwin' = 'keeper') {
    this.keeperAimState = state;
    this.hud.setAimHint(hands, state !== null);
  }

  // The corner sight — non-null while a human stands over a placed corner
  setCornerAim(state: CornerAimState | null) {
    this.cornerAim = state;
  }

  // A pad is driving — hint text speaks its buttons instead of the keys
  setPadHints(on: boolean) {
    this.hud.setPadHints(on);
  }

  // Round-trip to the relay while online; null hides the meter
  setPing(ms: number | null) {
    this.hud.setPing(ms);
  }

  // Match clock for the HUD; empty string hides it (endless kickabout)
  setClock(text: string) {
    this.hud.setClock(text);
  }

  // Tear the whole display tree off the stage between matches
  destroy() {
    for (const r of [this.viewport, this.overlay, this.flash, this.tensionEdge, this.possessionGlow, this.hud.root]) {
      r.destroy({ children: true });
    }
  }

  // The charge sight — non-null while a strike is being wound. theta is the
  // cone's half-angle: the honest wedge this ball may leave through.
  setKickDrag(d: { from: Vec2; dir: Vec2; power: number; theta?: number } | null) {
    this.kickDrags = d ? [d] : [];
  }

  // The couch's version: every charging seat brings its own arrow
  setKickDrags(ds: { from: Vec2; dir: Vec2; power: number; theta?: number }[]) {
    this.kickDrags = ds;
  }

  toast(msg: string) {
    this.hud.showToast(msg);
  }

  // Big broadcast caption with the pop-in — the countdown speaks through this
  announce(msg: string) {
    this.hud.announce(msg);
  }

  // The attract match behind the menu plays with a clean frame — no HUD
  setHudVisible(on: boolean) {
    this.hudWanted = on;
    this.hud.root.visible = on && !this.replayOn;
  }

  // On while the controlled player owns the ball — the frame fades with it
  setBallGlow(on: boolean) {
    this.glowOn = on;
  }

  // The replay takes the room: nothing on screen but football and the truck's
  // own dress — every sight, ring and meter that speaks to live hands is out
  setReplay(on: boolean) {
    this.replayOn = on;
    this.hud.root.visible = this.hudWanted && !on;
  }

  // The struck ball's smoke, owned and aged by the truck; null clears the air
  setBallComet(points: { x: number; y: number; z: number; a: number; wx: number; wy: number }[] | null) {
    this.comet = points;
  }

  // The frame itself: a warm glow BLEEDING in from the edges — three thin
  // stepped bands fading inward, with bright pixel corner brackets. Built
  // once per resize; only its alpha breathes.
  private buildGlow(w: number, h: number) {
    this.glowW = w;
    this.glowH = h;
    const g = this.possessionGlow;
    g.clear();
    const frame = (inset: number, t: number, color: number, alpha: number) => {
      g.rect(inset, inset, w - inset * 2, t).fill({ color, alpha });
      g.rect(inset, h - inset - t, w - inset * 2, t).fill({ color, alpha });
      g.rect(inset, inset + t, t, h - inset * 2 - t * 2).fill({ color, alpha });
      g.rect(w - inset - t, inset + t, t, h - inset * 2 - t * 2).fill({ color, alpha });
    };
    const q = Math.max(3, Math.round(h / 200)); // glow scales with the screen
    frame(0, q, 0xffe98f, 0.6);           // the hot edge
    frame(q, q * 2, 0xffd95e, 0.28);      // the bleed
    frame(q * 3, q * 3, 0xf0b83f, 0.11);  // the last breath of it
    // corner brackets, crisp and bright — the viewfinder that says LIVE
    const L = Math.round(q * 9);
    const t = q + 2;
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]] as const) {
      const x = cx + (dx < 0 ? -L : 0);
      const y = cy + (dy < 0 ? -t : 0);
      g.rect(x, y, L, t).fill({ color: 0xfff3c4, alpha: 0.75 });
      const vx = cx + (dx < 0 ? -t : 0);
      const vy = cy + (dy < 0 ? -L : 0);
      g.rect(vx, vy, t, L).fill({ color: 0xfff3c4, alpha: 0.75 });
    }

    // The nerve frame shares the geometry and none of the confidence: deeper,
    // darker bands of red that never reach the crispness of the gold
    const n = this.tensionEdge;
    n.clear();
    const band = (inset: number, thick: number, alpha: number) => {
      n.rect(0, inset, w, thick).fill({ color: 0xff3b2f, alpha });
      n.rect(0, h - inset - thick, w, thick).fill({ color: 0xff3b2f, alpha });
      n.rect(inset, 0, thick, h).fill({ color: 0xff3b2f, alpha });
      n.rect(w - inset - thick, 0, thick, h).fill({ color: 0xff3b2f, alpha });
    };
    band(0, q * 3, 0.5);
    band(q * 3, q * 4, 0.26);
    band(q * 7, q * 6, 0.12);
  }

  // Screen pixels → pitch meters on the ground plane (mouse targeting)
  screenToWorld(sx: number, sy: number): Vec2 {
    const local = this.viewport.toLocal({ x: sx, y: sy });
    return vec(local.x / pxPerMeter(), local.y / (pxPerMeter() * squash()));
  }

  // Pitch meters → screen pixels (picking a body out from under the pointer)
  worldToScreen(x: number, y: number, z = 0): Vec2 {
    const p = project(x, y, z);
    const g = this.viewport.toGlobal({ x: p.sx, y: p.sy });
    return vec(g.x, g.y);
  }

  // A steady directed shot (the tutorial's field tour); null hands the lens back
  private camOverride: { center: Vec2; zoom: number } | null = null;
  setCameraOverride(o: { center: Vec2; zoom: number } | null) {
    this.camOverride = o;
  }

  // The composed shot the ceremony is already playing on — the goal's two-shot
  // while the party runs, the restart's hold after it. Whoever stages the rest
  // beats sits on THIS instead of cutting to the centre circle and back; null
  // means the lens is live football and nobody should hold it.
  ceremonyFrame(): { center: Vec2; zoom: number } | null {
    const s = this.staged;
    return s ? { center: vec(s.center.x, s.center.y), zoom: s.zoom } : null;
  }

  // Which lens the moment asks for: a goal gets its own framing, and any dead
  // ball — the walk home included — gets held at playing size until the
  // football is genuinely moving again
  private stageCeremony(dt: number, viewW: number, viewH: number) {
    const cel = this.world.celebration;
    this.celebT = cel ? this.celebT + dt : 0;
    const beat = this.world.ceremony === 'walkback' || this.world.restartLock > 0.25;
    // a struck ball spends the hold twice over — the eye is on it already
    this.restartHold = beat
      ? RESTART_SETTLE
      : Math.max(0, this.restartHold - dt * (this.world.ball.speed() > 4 ? 2 : 1));
    if (cel) return this.celebrationShot(cel.team, cel.scorer, viewW, viewH);
    if (this.world.ceremony === 'walkback') return this.walkHomeShot();
    if (this.restartHold <= 0) return null;
    // the ball owns the restart; the man you hold is allowed to tug the frame
    const b = this.world.ball.pos;
    const hero = this.world.players[this.controlledIdx]?.pos;
    const center = hero ? add(b, clampLen(scale(sub(hero, b), 0.34), HERO_PULL)) : vec(b.x, b.y);
    return { center, zoom: RESTART_ZOOM };
  }

  // The walk home. The eye belongs on twenty-two men pacing in, NOT on a ball
  // rolling itself back to the spot — so the frame travels with the bodies and
  // eases onto the centre circle as they arrive. It is already sitting exactly
  // where the kickoff wants it by the time the last man stands on his mark,
  // which is why the ball reaching the spot never moves the lens at all.
  private walkHomeShot(): { center: Vec2; zoom: number } {
    let sx = 0;
    let sy = 0;
    for (const p of this.world.players) { sx += p.pos.x; sy += p.pos.y; }
    const n = Math.max(1, this.world.players.length);
    const k = this.world.ceremonyProgress;
    const ease = k * k * (3 - 2 * k);
    // the first beat is still the goal's: the lens lets go of the net before
    // it travels, so the chapter opens on a drift and not on a swing
    const l = clamp(k / 0.4, 0, 1);
    const lead = l * l * (3 - 2 * l);
    const b = this.world.ball.pos;
    const fx = b.x + (sx / n - b.x) * lead;
    const fy = b.y + (sy / n - b.y) * lead;
    return {
      center: vec(fx + (PITCH.length / 2 - fx) * ease, fy + (PITCH.width / 2 - fy) * ease),
      zoom: RESTART_ZOOM - WALK_OPEN * (1 - ease),
    };
  }

  // The shot a goal deserves: the mouth that was just beaten held at one edge
  // of the frame, the man who beat it at the other, creeping tighter as the
  // party runs. THEIR goal is framed on the net alone — the lens has no
  // business chasing an opponent's scorer around your half.
  private celebrationShot(team: 0 | 1, scorer: number, viewW: number, viewH: number) {
    const mouth = vec(this.world.attackSign(team) < 0 ? 0 : PITCH.length, PITCH.width / 2);
    const man = this.world.players[scorer];
    const ours = !!man && man.id.team === this.world.players[this.controlledIdx]?.id.team;
    const subject = ours ? man.pos : this.world.ball.pos;
    const M = pxPerMeter();
    const spanX = Math.abs(subject.x - mouth.x) / 2 + 11;
    const spanY = Math.abs(subject.y - mouth.y) / 2 + 8;
    const fit = Math.min(viewW / (2 * spanX * M), viewH / (2 * spanY * M * squash()));
    const creep = 1 + 0.07 * clamp(this.celebT / CELEBRATE_PUSH, 0, 1);
    return {
      center: vec((mouth.x + subject.x) / 2, (mouth.y + subject.y) / 2),
      zoom: clamp(fit, 2.1, 3.0) * creep,
    };
  }

  // The tutorial benches bodies entirely — off the stage until they're needed
  setPlayerHidden(idx: number, hidden: boolean) {
    const v = this.playerViews[idx];
    if (v) v.root.visible = !hidden;
  }

  // The mouse is resting on a teammate you could take — -1 clears it. Who is
  // a legal target stays the caller's call; this only whispers "clickable"
  setHoverTarget(idx: number) {
    this.hoverIdx = idx;
  }

  // The establishing shot the tutorial tours on: the whole field, no void
  fitFieldZoom(): number {
    return this.camera.fitFieldZoom(this.app.renderer.width, this.app.renderer.height);
  }

  // The white chevron: who E switches you into
  setSwitchTarget(idx: number) {
    if (idx === this.switchTargetIdx) return;
    this.switchTargetIdx = idx;
    this.playerViews.forEach((v, i) => v.setSwitchTarget(i === idx));
  }

  // Light the open pass options while the human winds up
  setPassHints(idxs: number[]) {
    this.playerViews.forEach((v, i) => v.setOpenHint(idxs.includes(i)));
  }

  // Online: blue chevrons + usernames over every OTHER human's body
  setSeatTags(tags: Record<number, string>) {
    this.playerViews.forEach((v, i) => v.setSeatTag(tags[i] ?? null));
  }

  handleEvents(events: SimEvent[]) {
    this.effects.consume(events);
    for (const e of events) {
      if (e.kind === 'bounce' || e.kind === 'post') this.ballView.triggerBounce();
      if (e.kind === 'post') this.hud.showToast('OFF THE POST!');
      if (e.kind === 'kick') this.playerViews[e.idx]?.triggerKick();
      if (e.kind === 'save') this.hud.showToast('SAVE!');
      if (e.kind === 'parry') this.hud.showToast('STRONG HANDS!');
      if (e.kind === 'kickoff') this.hud.announce('KICK OFF');
      if (e.kind === 'half') this.hud.announce('HALF TIME');
      if (e.kind === 'fulltime') this.hud.announce('FULL TIME');
      // The whistle you can SEE: the banner, a pale pop on the frame, and the
      // man who went in flashing his own name over the sprawl he caused
      if (e.kind === 'foul') {
        this.hud.announce('FOUL!');
        this.flashAlpha = Math.max(this.flashAlpha, 0.22);
        this.foulBy = e.by;
        this.foulT = 2.4;
      }
      // The flag and its free kick can land on the same tick — both say the
      // one word that matters, so the call survives whichever lands last
      if (e.kind === 'offside') {
        this.hud.announce('OFFSIDE');
        this.offsideFlash = 1.4; // the chalk that was already there turns red
      }
      // The keeper's stretch with the sprites we have; the sim's own lunge
      // frame outranks it whenever he truly leaves his feet
      if (e.kind === 'gkDive') this.playerViews[e.idx]?.triggerKick();
      if (e.kind === 'restart') {
        this.hud.announce(
          e.restart === 'corner' ? 'CORNER KICK' :
          e.restart === 'goalkick' ? 'GOAL KICK' :
          e.restart === 'offside' ? 'OFFSIDE' : 'THROW IN',
        );
      }
      if (e.kind === 'goal') {
        // How good was it? A finish squeezed high into a corner buys the
        // freeze frame and a stand full of shutters; a tap-in gets the roar.
        const b = this.world.ball;
        const edge = Math.abs(b.pos.y - PITCH.width / 2) / (PITCH.goalWidth / 2);
        const corner = clamp(Math.min(edge, clamp(b.z / PITCH.goalHeight, 0, 1)) * 1.5, 0, 1);
        this.hud.goalFlash();
        this.flashAlpha = 0.55 + corner * 0.4; // full-screen white pop on the moment
        this.pitchLayer.rippleGoal(e.side);    // and the net takes the hit
        this.effects.goalMoment(e.side, corner, director.level);
        // The one that levels it in the closing minutes: not a punch, a swell
        if (this.world.score.left === this.world.score.right && director.level > 0.7) this.effects.surge(1.4, 4);
      }
    }
  }

  render(alpha: number, dt: number, aim: AimState) {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;

    this.staged = this.stageCeremony(dt, w, h);

    // A keeper lining up his ball sees the field FROM HIS GOAL LINE out to
    // the punt's reach — never the dead half-circle behind the net
    if (this.keeperAimState) {
      const s = this.keeperAimState;
      const M = pxPerMeter();
      const left = s.gk.x < PITCH.length / 2;
      const x0 = left ? -4 : PITCH.length - s.puntR - 10;
      const x1 = left ? s.puntR + 10 : PITCH.length + 4;
      const zoom = clamp(Math.min(w / ((x1 - x0) * M), h / (2 * 38 * M * squash())), 0.7, 2.2);
      this.camera.override = { center: vec((x0 + x1) / 2, PITCH.width / 2), zoom };
    } else if (this.cornerAim) {
      // aiming into a box you cannot see is not a decision: the shot holds the
      // arc, the marks and wherever the ring has wandered, all at once
      const ca = this.cornerAim;
      let x0 = ca.from.x;
      let x1 = ca.from.x;
      let y0 = ca.from.y;
      let y1 = ca.from.y;
      for (const p of [...ca.marks.map((m) => m.at), ca.target]) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const M = pxPerMeter();
      const pad = 9;
      const zoom = clamp(Math.min(w / ((x1 - x0 + pad * 2) * M), h / ((y1 - y0 + pad * 2) * M * squash())), 1.1, 2.4);
      this.camera.override = { center: vec((x0 + x1) / 2, (y0 + y1) / 2), zoom };
    } else if (this.camOverride) {
      // A directed shot is somebody's deliberate choice — the coach's drill or
      // a rest beat — and it outranks the broadcast director every time
      this.camera.override = this.camOverride;
    } else {
      this.camera.override = this.staged;
    }
    this.keeperAim.update(dt, this.keeperAimState);

    // The slingshot sight, in the game's own chalk: a trail of pixel dots
    // that grows longer AND chunkier with the pull, capped by the baked
    // chalk arrowhead. Small pull, small arrow — the arrow IS the meter.
    const live = !this.replayOn;
    this.dragG.clear();
    this.wedgeG.clear();
    const firstKd = this.kickDrags[0] ?? null;
    this.dragHead.visible = live && !!firstKd;
    for (const kd of live ? this.kickDrags : []) {
      // Red is the top of the throw and NOTHING else: a stick buried to the
      // pin. Everything a thumb does on the way there reads mint or amber, so
      // the colour is news about YOUR hand instead of a permanent warning.
      const pull = pullOf(kd.power);
      const color = pull > 0.85 ? 0xff5340 : pull > 0.35 ? 0xffd95e : 0x9ff0b8;
      const reach = 1.4 + kd.power * 5.6;      // meters of arrow
      const q = Math.round(2 + kd.power * 2);  // chalk-dot size, px
      for (let t = 1.0; t < reach - 0.35; t += 0.62) {
        const p = project(kd.from.x + kd.dir.x * t, kd.from.y + kd.dir.y * t, 0);
        this.dragG.rect(Math.round(p.sx - q / 2), Math.round(p.sy - q / 2), q, q)
          .fill({ color, alpha: 0.85 });
      }
      // The wedge: the whole lottery, painted INTO the field like an offside
      // line — a filled sector lying on the grass, bodies walking OVER it.
      // Great feet barely open it; a defender's max-pull rake is a barn door.
      const th = kd.theta ?? 0;
      if (th > 0.012) {
        const wedgeLen = 4 + kd.power * 10;
        const wq = Math.max(2, q - 1);
        const pts: number[] = [];
        const o = project(kd.from.x, kd.from.y, 0);
        pts.push(o.sx, o.sy);
        const steps = Math.max(6, Math.ceil((th * 2) / 0.06));
        for (let i = 0; i <= steps; i++) {
          const edge = rotate(kd.dir, -th + (2 * th * i) / steps);
          const p = project(kd.from.x + edge.x * wedgeLen, kd.from.y + edge.y * wedgeLen, 0);
          pts.push(p.sx, p.sy);
        }
        this.wedgeG.poly(pts).fill({ color, alpha: 0.07 }); // the lottery whispers; the arrow speaks
        for (const side of [-1, 1]) {
          const edge = rotate(kd.dir, side * th);
          for (let t = 1.4; t < wedgeLen; t += 0.62) {
            const p = project(kd.from.x + edge.x * t, kd.from.y + edge.y * t, 0);
            this.wedgeG.rect(Math.round(p.sx - wq / 2), Math.round(p.sy - wq / 2), wq, wq)
              .fill({ color, alpha: 0.28 });
          }
        }
        for (let a = -th; a <= th + 0.001; a += Math.max(th / 3, 0.02)) {
          const edge = rotate(kd.dir, a);
          const p = project(kd.from.x + edge.x * wedgeLen, kd.from.y + edge.y * wedgeLen, 0);
          this.wedgeG.rect(Math.round(p.sx - wq / 2), Math.round(p.sy - wq / 2), wq, wq)
            .fill({ color, alpha: 0.5 });
        }
      }

      if (kd === firstKd) {
        const dirs = this.assets.manifest.fx.aim.frames;
        const bin = Math.round(Math.atan2(kd.dir.y, kd.dir.x) / ((Math.PI * 2) / dirs));
        this.dragHead.texture = this.assets.aimFrames[((bin % dirs) + dirs) % dirs];
        this.dragHead.tint = color;
        this.dragHead.scale.set(0.75 + kd.power * 0.65);
        const tip = project(kd.from.x + kd.dir.x * reach, kd.from.y + kd.dir.y * reach, 0);
        this.dragHead.position.set(Math.round(tip.sx), Math.round(tip.sy));
      }
    }

        // The offside line, chalked into the turf like every other law of this
    // game — but only when a runner is actually flirting with it, and it turns
    // red for a beat when the flag finally goes up
    this.offsideG.clear();
    this.offsideFlash = Math.max(0, this.offsideFlash - dt);
    const atkTeam = this.world.carrier
      ? this.world.players[this.world.carrier.idx]?.id.team
      : this.world.lastTouch?.team;
    if (live && atkTeam !== undefined && this.world.offsideEnabled && !this.world.practice && this.world.restartLock <= 0) {
      const lineX = this.world.offsideLineX(atkTeam);
      const sign = this.world.attackSign(atkTeam);
      let daylight = Infinity;
      for (const p of this.world.players) {
        if (p.id.team !== atkTeam || p.id.role === 'GK') continue;
        daylight = Math.min(daylight, (lineX - p.pos.x) * sign);
      }
      if (daylight < 2.2) {
        const heat = clamp(1 - daylight / 2.2, 0, 1);
        const color = this.offsideFlash > 0 ? 0xff5340 : 0xf2f5fa;
        const alpha = (0.16 + heat * 0.3) * (this.offsideFlash > 0 ? 1 : 0.85) + this.offsideFlash * 0.25;
        for (let y = 1; y < PITCH.width; y += 2.4) {
          const p = project(lineX, y, 0);
          this.offsideG.rect(Math.round(p.sx) - 1, Math.round(p.sy), 2, 3).fill({ color, alpha });
        }
      }
    }

    // The corner, as a decision: the chalk line your ball will travel, the
    // zone it can honestly land in, and the marks your box is attacking — a
    // mark whose man is breaking RIGHT NOW burns mint, so the delivery is
    // timed to a run you can see instead of to a hope.
    this.cornerG.clear();
    if (live && this.cornerAim) {
      const ca = this.cornerAim;
      const M = pxPerMeter();
      const sq = squash();
      const accent = ca.short ? 0x9ff0b8 : 0xffd95e;
      this.cornerPulse += dt * 5;
      const span = Math.hypot(ca.target.x - ca.from.x, ca.target.y - ca.from.y);
      for (let t = 2; t < span - 1; t += 1.4) {
        const p = project(ca.from.x + ((ca.target.x - ca.from.x) * t) / span, ca.from.y + ((ca.target.y - ca.from.y) * t) / span, 0);
        this.cornerG.rect(Math.round(p.sx) - 1, Math.round(p.sy) - 1, 3, 3).fill({ color: accent, alpha: 0.8 });
      }
      for (const m of ca.marks) {
        const p = project(m.at.x, m.at.y, 0);
        const r = m.live ? 1.5 + 0.25 * Math.sin(this.cornerPulse) : 1.1;
        this.cornerG.ellipse(p.sx, p.sy, r * M, r * M * sq)
          .stroke({ width: 1.3, color: m.live ? 0x9ff0b8 : 0xdfe4ee, alpha: m.live ? 0.85 : 0.45 });
      }
      const t = project(ca.target.x, ca.target.y, 0);
      this.cornerG.ellipse(t.sx, t.sy, ca.scatter * M, ca.scatter * M * sq)
        .fill({ color: accent, alpha: 0.13 })
        .stroke({ width: 1.3, color: accent, alpha: 0.8 });
      const tick = 4 + Math.sin(this.cornerPulse) * 1.2;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        this.cornerG.moveTo(t.sx + dx * tick, t.sy + dy * tick * sq)
          .lineTo(t.sx + dx * (tick + 4), t.sy + dy * (tick + 4) * sq)
          .stroke({ width: 1.4, color: 0xffffff, alpha: 0.9 });
      }
    }

    // The law, visible: a restart's mandated space is chalked around the ball
    this.lawRing.clear();
    if (live && this.world.restartLock > 0 && this.world.restartExclusion > 0) {
      const b = project(this.world.ball.pos.x, this.world.ball.pos.y, 0);
      const M = pxPerMeter();
      this.lawRing.ellipse(b.sx, b.sy, this.world.restartExclusion * M, this.world.restartExclusion * M * squash())
        .stroke({ width: 1.2, color: 0xffffff, alpha: 0.28 });
    }

    // The hover ring: a wide dashed circle of mint chalk crawling around the
    // body under the mouse. It sits ON the turf, dimmer and slower than the
    // gold chevron overhead — an invitation, never a claim
    this.hoverG.clear();
    const hovered = live && this.playerViews[this.hoverIdx]?.root.visible ? this.world.players[this.hoverIdx] : null;
    if (hovered) this.hoverAt = hovered.pos; // a benched body never wears one
    this.hoverFade = clamp(this.hoverFade + (hovered ? dt * 7 : -dt * 9), 0, 1);
    if (this.hoverFade > 0.02) {
      this.hoverPulse += dt * 3.2;
      const r = 1.02 + 0.06 * Math.sin(this.hoverPulse);
      const dotAlpha = this.hoverFade * (0.42 + 0.1 * Math.sin(this.hoverPulse));
      const dots = 14;
      for (let i = 0; i < dots; i++) {
        const th = (i / dots) * Math.PI * 2 + this.hoverPulse * 0.15; // the chalk crawls
        const p = project(this.hoverAt.x + Math.cos(th) * r, this.hoverAt.y + Math.sin(th) * r, 0);
        this.hoverG.rect(Math.round(p.sx) - 1, Math.round(p.sy) - 1, 2, 2).fill({ color: 0x9ff0b8, alpha: dotAlpha });
      }
    }

    // The tackle window, made honest: while an opponent's ball is loose of him
    // and your legs are free, a red diamond sits over it. It is a beat long on
    // purpose — defending should be a rhythm you learn, never a button you hold.
    // ...and it is the REFEREE's own number, read straight off the sim, so the
    // diamond can never invite a challenge the whistle then punishes.
    const lunge = live ? this.world.tackleWindow(this.controlledIdx) : 0;
    this.tackleFade = clamp(this.tackleFade + (lunge > 0 ? dt * 18 : -dt * 14), 0, 1);
    this.tackleG.clear();
    if (this.tackleFade > 0.02) {
      this.tacklePulse += dt * 13;
      const b = this.world.ball;
      const foot = project(b.pos.x, b.pos.y, b.z);
      const p = project(b.pos.x, b.pos.y, b.z + 1.35); // it floats clear of the ball, never over it
      const cx = Math.round(p.sx);
      const cy = Math.round(p.sy);
      const r = Math.round(4 + lunge * 2 + Math.sin(this.tacklePulse));
      const ink = 0.55 * this.tackleFade;
      const red = (0.6 + 0.4 * lunge) * this.tackleFade;
      this.tackleG.rect(cx - 1, cy, 3, Math.round(foot.sy - p.sy)).fill({ color: 0x05070b, alpha: ink * 0.6 });
      this.tackleG.rect(cx, cy, 1, Math.round(foot.sy - p.sy)).fill({ color: 0xff5340, alpha: red * 0.55 });
      for (let dy = -r - 1; dy <= r + 1; dy++) {
        const half = r + 1 - Math.abs(dy);
        if (half >= 0) this.tackleG.rect(cx - half, cy + dy, half * 2 + 1, 1).fill({ color: 0x05070b, alpha: ink });
      }
      for (let dy = -r; dy <= r; dy++) {
        const half = r - Math.abs(dy);
        this.tackleG.rect(cx - half, cy + dy, half * 2 + 1, 1).fill({ color: 0xff5340, alpha: red });
      }
    }

    // The replay's smoke: the hot line the ball actually took, and the puffs
    // lifting off it as they cool — the whole reason a strike reads FAST
    this.cometG.clear();
    if (this.replayOn && this.comet) {
      for (const c of this.comet) {
        const a = clamp(c.a, 0, 1);
        const cool = 1 - a;
        const puff = project(c.x + c.wx * cool * 0.9, c.y + c.wy * cool * 0.6, c.z + cool * 1.2);
        const q = 2 + Math.round(cool * 3);
        this.cometG.rect(Math.round(puff.sx - q / 2), Math.round(puff.sy - q / 2), q, q)
          .fill({ color: 0xdfe4ee, alpha: a * 0.32 });
        const hot = project(c.x, c.y, c.z);
        this.cometG.rect(Math.round(hot.sx) - 1, Math.round(hot.sy) - 1, 2, 2)
          .fill({ color: 0xfff3c4, alpha: a * a * 0.85 });
      }
    }

    const heroPos = this.world.players[this.controlledIdx]?.pos ?? null;
    this.camera.update(dt, this.world.ball.pos, this.world.ball.vel, this.world.players.map((p) => p.pos), w, h, heroPos);
    // Who gets a name over his boots: the man you hold, the man E would hand
    // you, and whoever has the ball. Twenty-two labels is not identity, it is
    // static — and they punch straight through every shade the shell draws.
    const carrierIdx = this.world.carrier?.idx ?? -1;
    const labels = this.hud.root.visible;
    this.foulT = Math.max(0, this.foulT - dt); // ...and the offender wears his for a beat
    this.world.players.forEach((p, i) => {
      this.playerViews[i]?.setNamed(labels && (i === this.controlledIdx || i === this.switchTargetIdx ||
        i === carrierIdx || (i === this.foulBy && this.foulT > 0)));
      this.playerViews[i]?.update(p, dt, alpha, i === this.controlledIdx ? aim : null);
      this.effects.sprintDust(p, dt);
    });
    this.ballView.update(this.world.ball, dt, alpha);
    this.effects.rollGrass(this.world.ball, dt);
    // Every body on the turf bends the grass it crosses — parked ones part it
    const actors: GrassActor[] = this.world.players.map((p) => ({
      x: p.pos.x, y: p.pos.y, speed: p.speed(), press: p.speed() < 0.7,
    }));
    const ball = this.world.ball;
    if (ball.z < 0.4) {
      actors.push({ x: ball.pos.x, y: ball.pos.y, speed: ball.speed(), press: ball.speed() < 0.7 });
    }
    this.grass.update(dt, actors);
    this.pitchLayer.update(dt);
    this.effects.update(dt);
    // The lens breathes with the match: a hair tighter on every heartbeat, a
    // real shove in when a keeper claws one away. Only ever INWARD — the
    // camera law's floor is never crossed from here, and the push is handed
    // back so it can't compound across frames.
    const zoomWas = this.camera.zoom;
    this.camera.zoom *= 1 + 0.012 * director.level * director.heart + 0.09 * director.punch * director.punch;
    this.camera.applyTo(this.viewport, w, h, this.effects.shakeX, this.effects.shakeY);
    this.camera.zoom = zoomWas;

    this.overlay.clear();
    if (this.mood.overlayAlpha > 0) {
      this.overlay.rect(0, 0, w, h).fill({ color: this.mood.overlayColor, alpha: this.mood.overlayAlpha });
    }
    this.flash.clear();
    if (this.flashAlpha > 0.01) {
      this.flash.rect(0, 0, w, h).fill({ color: 0xfff8e0, alpha: this.flashAlpha });
      this.flashAlpha *= Math.max(0, 1 - dt * 6);
    }

    // Possession frame: swells in when the ball becomes yours, breathes, lets go
    if (w !== this.glowW || h !== this.glowH) this.buildGlow(w, h);
    this.glowFade = clamp(this.glowFade + (this.glowOn ? dt * 5 : -dt * 3.5), 0, 1);
    this.glowPulse += dt * 2.6;
    this.possessionGlow.visible = live && this.glowFade > 0.01;
    this.possessionGlow.alpha = this.glowFade * (0.8 + 0.2 * Math.sin(this.glowPulse));
    // And under it, the nerves: a red bleed that only exists when it is late
    // and close, thumping on the same pulse the crowd can hear
    const nerve = Math.max(0, (director.level - 0.72) / 0.28);
    this.tensionEdge.visible = live && nerve > 0.02;
    this.tensionEdge.alpha = nerve * (0.1 + 0.35 * director.heart);

    // The moment worth a word lands in the eyes and the hands on the same frame
    if (director.beat.serial !== this.beatSerial) {
      this.beatSerial = director.beat.serial;
      this.hud.showCallout(director.beat.text, director.beat.tone);
      this.effects.felt(director.beat.kick);
    }
    this.hud.setChain(director.chain);
    this.hud.setTension(director.level, director.heart);
    const hero = this.world.players[this.controlledIdx];
    if (hero) this.hud.setSprint(hero.stamina, hero.isSprinting);
    this.hud.layout(w, h, this.world.score);
    this.hud.update(dt, w, h);
  }
}
