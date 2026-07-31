import { Container, Sprite, Graphics } from 'pixi.js';
import { lerp } from './interp';
import { PlayerBody } from '../sim/player';
import { GameAssets } from './assets';
import { project } from './projection';

// Screen row order is ['S','SW','W','NW','N','NE','E','SE']; this maps the
// 8 compass octants of atan2 (0 = east, positive y = south) onto those rows
const OCTANT_TO_ROW = [6, 7, 0, 1, 2, 3, 4, 5];

export class PlayerView {
  root = new Container();
  private shadow: Sprite;
  private body: Sprite;
  private chargeBar = new Graphics();
  private animPhase = 0;
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
    this.root.addChild(this.shadow, this.body, this.chargeBar);
  }

  triggerKick() {
    this.kickTimer = 0.24;
  }

  update(p: PlayerBody, dt: number, alpha: number, charge: number) {
    const x = lerp(p.prev.x, p.pos.x, alpha);
    const y = lerp(p.prev.y, p.pos.y, alpha);
    const proj = project(x, y, 0);
    this.root.position.set(proj.sx, proj.sy);
    this.root.zIndex = proj.depth;
    this.body.scale.set(proj.scale);
    this.shadow.position.set(1.5, 1); // cast down-sun, same key light as everything

    const row = this.directionRow(p);
    const speed = p.speed();
    const anims = this.assets.manifest.player.anims;
    this.kickTimer = Math.max(0, this.kickTimer - dt);

    let frame: number;
    if (this.kickTimer > 0) {
      frame = this.kickTimer > 0.12 ? anims.windup : anims.strike;
    } else if (p.isCharging && speed < 0.7) {
      frame = anims.windup; // planted and wound up; keep running frames while moving
    } else if (speed > 0.7) {
      this.animPhase += dt * (5 + speed * 1.8);
      frame = anims.runStart + (Math.floor(this.animPhase) % anims.runLen);
    } else {
      frame = anims.idle;
      this.animPhase = 0;
    }
    this.body.texture = this.assets.players[this.sheet][row][frame];

    // Charge tell: a small bar filling above the head — readable at couch distance
    this.chargeBar.clear();
    if (charge > 0) {
      const w = 16;
      this.chargeBar.rect(-w / 2, -31, w, 3).fill({ color: 0x1a1626, alpha: 0.7 });
      this.chargeBar.rect(-w / 2 + 0.5, -30.5, (w - 1) * charge, 2).fill(charge > 0.8 ? 0xff5340 : 0xffdf5e);
    }
  }

  private directionRow(p: PlayerBody): number {
    const angle = Math.atan2(p.facing.y, p.facing.x);
    const octant = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    return OCTANT_TO_ROW[octant];
  }
}
