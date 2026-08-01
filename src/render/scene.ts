import { Application, Container, Graphics, Sprite } from 'pixi.js';
import { GameLoop } from '../core/loop';
import { Vec2, vec, clamp } from '../core/math';
import { PITCH } from '../sim/constants';
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
  private lawRing = new Graphics(); // the restart exclusion, painted on the turf
  private dragG = new Graphics();   // the slingshot pass sight (chalk dots)
  private dragHead: Sprite;         // baked chalk arrowhead, tinted by power
  private kickDrag: { from: Vec2; dir: Vec2; power: number } | null = null;
  // "The ball is YOURS": a gold pixel frame breathing at the screen edge
  private possessionGlow = new Graphics();
  private glowOn = false;
  private glowFade = 0;
  private glowPulse = 0;
  private glowW = 0;
  private glowH = 0;
  private mood: VariantMood = MOODS[0];

  constructor(private app: Application, private assets: GameAssets, private world: World, loop: GameLoop) {
    this.hud = new Hud(assets);
    this.keeperAim = new KeeperAim(assets);
    this.worldSorted.sortableChildren = true;
    this.pitchLayer = new PitchLayer(assets, this.worldSorted);
    this.grass = new GrassField(assets, this.worldSorted);
    this.dragHead = new Sprite(assets.aimFrames[0]);
    this.dragHead.anchor.set(0.5, 0.5);
    this.dragHead.visible = false;
    this.viewport.addChild(this.pitchLayer.ground, this.lawRing, this.keeperAim.rings, this.worldSorted, this.keeperAim.top, this.dragG, this.dragHead);

    this.ballView = new BallView(assets, this.worldSorted);
    this.worldSorted.addChild(this.ballView.root);
    this.effects = new Effects(assets, this.worldSorted, this.pitchLayer.groundFx, loop);

    app.stage.addChild(this.viewport, this.overlay, this.flash, this.possessionGlow, this.hud.root);
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

  setControlled(idx: number) {
    if (idx === this.controlledIdx) return;
    this.controlledIdx = idx;
    this.playerViews.forEach((v, i) => v.setControlled(i === idx));
  }

  // Keeper distribution sight — non-null while the human is aiming
  setKeeperAim(state: KeeperAimState | null) {
    this.keeperAimState = state;
  }

  // Match clock for the HUD; empty string hides it (endless kickabout)
  setClock(text: string) {
    this.hud.setClock(text);
  }

  // Tear the whole display tree off the stage between matches
  destroy() {
    for (const r of [this.viewport, this.overlay, this.flash, this.possessionGlow, this.hud.root]) {
      r.destroy({ children: true });
    }
  }

  // The slingshot sight — non-null while a drag-back is charging a strike
  setKickDrag(d: { from: Vec2; dir: Vec2; power: number } | null) {
    this.kickDrag = d;
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
    this.hud.root.visible = on;
  }

  // On while the controlled player owns the ball — the frame fades with it
  setBallGlow(on: boolean) {
    this.glowOn = on;
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
  }

  // Screen pixels → pitch meters on the ground plane (mouse targeting)
  screenToWorld(sx: number, sy: number): Vec2 {
    const local = this.viewport.toLocal({ x: sx, y: sy });
    return vec(local.x / pxPerMeter(), local.y / (pxPerMeter() * squash()));
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
      if (e.kind === 'restart') {
        this.hud.announce(
          e.restart === 'corner' ? 'CORNER KICK' :
          e.restart === 'goalkick' ? 'GOAL KICK' :
          e.restart === 'offside' ? 'OFFSIDE!' : 'THROW IN',
        );
      }
      if (e.kind === 'goal') {
        this.hud.goalFlash();
        this.flashAlpha = 0.5; // full-screen white pop on the moment
        this.pitchLayer.rippleGoal(e.side); // and the net takes the hit
      }
    }
  }

  render(alpha: number, dt: number, aim: AimState) {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;

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
    } else if (this.world.celebration && this.world.players[this.world.celebration.scorer]) {
      // The broadcast finds the man of the moment and stays with him
      this.camera.override = { center: this.world.players[this.world.celebration.scorer].pos, zoom: 3.4 };
    } else {
      this.camera.override = null;
    }
    this.keeperAim.update(dt, this.keeperAimState);

    // The slingshot sight, in the game's own chalk: a trail of pixel dots
    // that grows longer AND chunkier with the pull, capped by the baked
    // chalk arrowhead. Small pull, small arrow — the arrow IS the meter.
    this.dragG.clear();
    this.dragHead.visible = !!this.kickDrag;
    if (this.kickDrag) {
      const kd = this.kickDrag;
      const color = kd.power > 0.72 ? 0xff5340 : kd.power > 0.38 ? 0xffd95e : 0x9ff0b8;
      const reach = 1.4 + kd.power * 5.6;      // meters of arrow
      const q = Math.round(2 + kd.power * 2);  // chalk-dot size, px
      for (let t = 1.0; t < reach - 0.35; t += 0.62) {
        const p = project(kd.from.x + kd.dir.x * t, kd.from.y + kd.dir.y * t, 0);
        this.dragG.rect(Math.round(p.sx - q / 2), Math.round(p.sy - q / 2), q, q)
          .fill({ color, alpha: 0.85 });
      }
      const dirs = this.assets.manifest.fx.aim.frames;
      const bin = Math.round(Math.atan2(kd.dir.y, kd.dir.x) / ((Math.PI * 2) / dirs));
      this.dragHead.texture = this.assets.aimFrames[((bin % dirs) + dirs) % dirs];
      this.dragHead.tint = color;
      this.dragHead.scale.set(0.75 + kd.power * 0.65);
      const tip = project(kd.from.x + kd.dir.x * reach, kd.from.y + kd.dir.y * reach, 0);
      this.dragHead.position.set(Math.round(tip.sx), Math.round(tip.sy));
    }

    // The law, visible: a restart's mandated space is chalked around the ball
    this.lawRing.clear();
    if (this.world.restartLock > 0 && this.world.restartExclusion > 0) {
      const b = project(this.world.ball.pos.x, this.world.ball.pos.y, 0);
      const M = pxPerMeter();
      this.lawRing.ellipse(b.sx, b.sy, this.world.restartExclusion * M, this.world.restartExclusion * M * squash())
        .stroke({ width: 1.2, color: 0xffffff, alpha: 0.28 });
    }

    this.camera.update(dt, this.world.ball.pos, this.world.ball.vel, this.world.players.map((p) => p.pos), w, h);
    this.world.players.forEach((p, i) => {
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
    this.camera.applyTo(this.viewport, w, h, this.effects.shakeX, this.effects.shakeY);

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
    this.possessionGlow.visible = this.glowFade > 0.01;
    this.possessionGlow.alpha = this.glowFade * (0.8 + 0.2 * Math.sin(this.glowPulse));
    const hero = this.world.players[this.controlledIdx];
    if (hero) this.hud.setSprint(hero.stamina, hero.isSprinting);
    this.hud.layout(w, h, this.world.score);
    this.hud.update(dt, w, h);
  }
}
