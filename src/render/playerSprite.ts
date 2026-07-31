import { Container, Sprite, Graphics } from 'pixi.js';
import { lerp } from './interp';
import { PlayerBody } from '../sim/player';
import { GameAssets } from './assets';
import { project } from './projection';

export class PlayerView {
  root = new Container();
  private shadow: Sprite;
  private body: Sprite;
  private chargeBar = new Graphics();
  private animPhase = 0;
  private idlePhase = 0;
  private kickTimer = 0;
  private sheet: string;

  constructor(private assets: GameAssets, sheet: string) {
    this.sheet = sheet;
    this.shadow = new Sprite(assets.shadow);
    this.shadow.anchor.set(0.5, 0.5);
    this.shadow.alpha = 0.75;
    this.body = new Sprite(assets.players[sheet][0][0]);
    const { frameH, baseline } = assets.manifest.player;
    this.body.anchor.set(0.5, baseline / frameH);
    this.body.position.y = 1; // boots settle INTO the turf, not on top of it
    this.root.addChild(this.shadow, this.body, this.chargeBar);
  }

  triggerKick() {
    this.kickTimer = 0.26;
  }

  update(p: PlayerBody, dt: number, alpha: number, charge: number) {
    const x = lerp(p.prev.x, p.pos.x, alpha);
    const y = lerp(p.prev.y, p.pos.y, alpha);
    const proj = project(x, y, 0);
    this.root.position.set(proj.sx, proj.sy);
    this.root.zIndex = proj.depth;
    this.shadow.position.set(0.5, 0.5); // pooled right under the feet

    const speed = p.speed();
    const anims = this.assets.manifest.player.anims;
    this.kickTimer = Math.max(0, this.kickTimer - dt);

    let frame: number;
    if (this.kickTimer > 0) {
      // Coil → whip → follow-through, riding the event timer
      frame = anims.kickStart + (this.kickTimer > 0.18 ? 0 : this.kickTimer > 0.09 ? 1 : 2);
    } else if (p.isCharging && speed < 0.7) {
      frame = anims.kickStart; // planted and wound up, ready to strike
    } else if (speed > 0.7) {
      this.animPhase += dt * (5.5 + speed * 1.7);
      frame = anims.runStart + (Math.floor(this.animPhase) % anims.runLen);
    } else {
      this.idlePhase += dt * 1.4;
      frame = anims.idleStart + (Math.floor(this.idlePhase) % anims.idleLen);
      this.animPhase = 0;
    }
    this.body.texture = this.assets.players[this.sheet][this.headingRow(p)][frame];

    // Charge tell: a small bar filling above the head — readable at couch distance
    this.chargeBar.clear();
    if (charge > 0) {
      const w = 16;
      this.chargeBar.rect(-w / 2, -27, w, 3).fill({ color: 0x1a1626, alpha: 0.7 });
      this.chargeBar.rect(-w / 2 + 0.5, -26.5, (w - 1) * charge, 2).fill(charge > 0.8 ? 0xff5340 : 0xffdf5e);
    }
  }

  // Continuous heading → nearest of the 16 baked compass rows
  private headingRow(p: PlayerBody): number {
    const dirs = this.assets.manifest.player.dirs;
    const angle = Math.atan2(p.facing.y, p.facing.x);
    const bin = Math.round(angle / ((Math.PI * 2) / dirs));
    return ((bin % dirs) + dirs) % dirs;
  }
}
