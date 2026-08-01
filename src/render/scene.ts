import { Application, Container, Graphics } from 'pixi.js';
import { GameLoop } from '../core/loop';
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
  private mood: VariantMood = MOODS[0];

  constructor(private app: Application, private assets: GameAssets, private world: World, loop: GameLoop) {
    this.hud = new Hud(assets);
    this.worldSorted.sortableChildren = true;
    this.pitchLayer = new PitchLayer(assets, this.worldSorted);
    this.grass = new GrassField(assets, this.worldSorted);
    this.viewport.addChild(this.pitchLayer.ground, this.worldSorted);

    this.ballView = new BallView(assets, this.worldSorted);
    this.worldSorted.addChild(this.ballView.root);
    this.effects = new Effects(assets, this.worldSorted, this.pitchLayer.groundFx, loop);

    app.stage.addChild(this.viewport, this.overlay, this.flash, this.hud.root);
  }

  addPlayer(sheet: string): PlayerView {
    const view = new PlayerView(this.assets, sheet);
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

  handleEvents(events: SimEvent[]) {
    this.effects.consume(events);
    for (const e of events) {
      if (e.kind === 'bounce') this.ballView.triggerBounce();
      if (e.kind === 'kick') this.playerViews[e.idx]?.triggerKick();
      if (e.kind === 'save') this.hud.showToast('SAVE!');
      if (e.kind === 'kickoff') this.hud.announce('KICK OFF');
      if (e.kind === 'restart') {
        this.hud.announce(e.restart === 'corner' ? 'CORNER KICK' : e.restart === 'goalkick' ? 'GOAL KICK' : 'THROW IN');
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
    this.hud.layout(w, h, this.world.score);
    this.hud.update(dt, w, h);
  }
}
