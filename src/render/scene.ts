import { Application, Container, Graphics } from 'pixi.js';
import { GameLoop } from '../core/loop';
import { World } from '../sim/world';
import { SimEvent } from '../sim/events';
import { GameAssets } from './assets';
import { PitchLayer } from './pitchLayer';
import { PlayerView } from './playerSprite';
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
  private playerViews: PlayerView[] = [];
  private ballView: BallView;
  private effects: Effects;
  private camera = new FollowCamera();
  private hud: Hud;
  private overlay = new Graphics();
  private flash = new Graphics();
  private flashAlpha = 0;
  private mood: VariantMood = MOODS[0];

  constructor(private app: Application, private assets: GameAssets, private world: World, loop: GameLoop) {
    this.hud = new Hud(assets);
    this.worldSorted.sortableChildren = true;
    this.pitchLayer = new PitchLayer(assets, this.worldSorted);
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

  handleEvents(events: SimEvent[]) {
    this.effects.consume(events);
    for (const e of events) {
      if (e.kind === 'bounce') this.ballView.triggerBounce();
      if (e.kind === 'kick') this.playerViews[0]?.triggerKick();
      if (e.kind === 'goal') {
        this.hud.goalFlash();
        this.flashAlpha = 0.5; // full-screen white pop on the moment
        this.pitchLayer.rippleGoal(e.side); // and the net takes the hit
      }
    }
  }

  render(alpha: number, dt: number, charge: number) {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;

    this.camera.update(dt, this.world.ball.pos, this.world.ball.vel, this.world.players.map((p) => p.pos), w, h);
    this.world.players.forEach((p, i) => {
      this.playerViews[i]?.update(p, dt, alpha, i === 0 ? charge : 0);
      this.effects.sprintDust(p, dt);
    });
    this.ballView.update(this.world.ball, dt, alpha);
    // Turf reacts to whoever is on it: every player, plus the rolling ball
    const disturbers = this.world.players.map((p) => ({ x: p.pos.x, y: p.pos.y, speed: p.speed() }));
    if (this.world.ball.z < 0.5) {
      disturbers.push({ x: this.world.ball.pos.x, y: this.world.ball.pos.y, speed: this.world.ball.speed() * 0.5 });
    }
    this.pitchLayer.update(dt, disturbers);
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
