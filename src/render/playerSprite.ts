import { Container, Sprite, Graphics } from 'pixi.js';
import { lerp } from './interp';
import { Vec2, len, norm, rotate } from '../core/math';
import { PlayerBody } from '../sim/player';
import { GameAssets } from './assets';
import { project, pxPerMeter, squash } from './projection';

// Charge + J/L bend state the local player's view needs to draw its aim tell
export interface AimState {
  charge: number;
  offset: number;
  move: Vec2;
}

export class PlayerView {
  root = new Container();
  private shadow: Sprite;
  private body: Sprite;
  private aimArrow: Sprite;
  private marker: Sprite;
  private chargeBar = new Graphics();
  private animPhase = 0;
  private idlePhase = 0;
  private kickTimer = 0;
  private aimPulse = 0;
  private markerPulse = 0;
  private aiCharge = 0; // estimated windup of an AI body, for the charge tell
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
    this.aimArrow = new Sprite(assets.aimFrames[0]);
    this.aimArrow.anchor.set(0.5, 0.5);
    this.aimArrow.visible = false;
    // "You are here": a chalk ring pooled under the controlled player's feet
    this.marker = new Sprite(assets.ringFrames[0]);
    this.marker.anchor.set(0.5, 0.5);
    this.marker.visible = false;
    this.marker.tint = 0xffe27a;
    this.root.addChild(this.marker, this.shadow, this.aimArrow, this.body, this.chargeBar);
  }

  setControlled(on: boolean) {
    this.marker.visible = on;
  }

  triggerKick() {
    this.kickTimer = 0.26;
  }

  update(p: PlayerBody, dt: number, alpha: number, aim: AimState | null) {
    const x = lerp(p.prev.x, p.pos.x, alpha);
    const y = lerp(p.prev.y, p.pos.y, alpha);
    const proj = project(x, y, 0);
    this.root.position.set(proj.sx, proj.sy);
    this.root.zIndex = proj.depth;
    this.shadow.position.set(0.5, 0.5); // pooled right under the feet
    if (this.marker.visible) {
      this.markerPulse += dt * 6;
      this.marker.scale.set(0.62 + 0.05 * Math.sin(this.markerPulse), 0.44 + 0.035 * Math.sin(this.markerPulse));
      this.marker.alpha = 0.85;
    }
    this.updateAimArrow(p, dt, aim);

    const speed = p.speed();
    const anims = this.assets.manifest.player.anims;
    this.kickTimer = Math.max(0, this.kickTimer - dt);

    let frame: number;
    if (p.lungeTimer > 0) {
      frame = anims.lunge; // flying: the slide tackle and the keeper's dive
    } else if (p.recoverTimer > 0.15) {
      frame = anims.recover; // picking himself back up
    } else if (this.kickTimer > 0) {
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

    // Charge tell above EVERY head, human or brain: you can read a wound-up
    // strike coming across the pitch — and brace for it
    this.aiCharge = p.isCharging ? Math.min(0.85, this.aiCharge + dt) : 0;
    const charge = aim ? aim.charge : this.aiCharge / 0.85;
    this.chargeBar.clear();
    if (charge > 0.02) {
      const w = 16;
      this.chargeBar.rect(-w / 2, -30, w, 3).fill({ color: 0x1a1626, alpha: 0.7 });
      this.chargeBar.rect(-w / 2 + 0.5, -29.5, (w - 1) * charge, 2).fill(charge > 0.8 ? 0xff5340 : 0xffdf5e);
    }
  }

  // The shot sight: a chalk arrow orbiting the feet at the FINAL aim — stick
  // line bent by J/L — so you always see where the strike will leave
  private updateAimArrow(p: PlayerBody, dt: number, aim: AimState | null) {
    if (!aim || aim.charge <= 0) {
      this.aimArrow.visible = false;
      return;
    }
    this.aimPulse += dt * 9;
    const base = len(aim.move) > 0.25 ? norm(aim.move) : p.facing;
    const dir = rotate(base, aim.offset);
    const dirs = this.assets.manifest.fx.aim.frames;
    const bin = Math.round(Math.atan2(dir.y, dir.x) / ((Math.PI * 2) / dirs));
    this.aimArrow.texture = this.assets.aimFrames[((bin % dirs) + dirs) % dirs];
    const M = pxPerMeter();
    this.aimArrow.position.set(dir.x * 1.7 * M, dir.y * 1.7 * M * squash() - 2);
    this.aimArrow.visible = true;
    this.aimArrow.alpha = 0.82 + 0.18 * Math.sin(this.aimPulse);
  }

  // Continuous heading → nearest of the 16 baked compass rows
  private headingRow(p: PlayerBody): number {
    const dirs = this.assets.manifest.player.dirs;
    const angle = Math.atan2(p.facing.y, p.facing.x);
    const bin = Math.round(angle / ((Math.PI * 2) / dirs));
    return ((bin % dirs) + dirs) % dirs;
  }
}
