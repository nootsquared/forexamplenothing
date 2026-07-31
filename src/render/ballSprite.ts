import { Container, Sprite } from 'pixi.js';
import { lerp } from './interp';
import { Ball } from '../sim/ball';
import { GameAssets } from './assets';
import { project } from './projection';

const TRAIL_LEN = 7;
const TRAIL_MIN_SPEED = 13;

export class BallView {
  root = new Container(); // sits in the sorted world; children are screen-relative
  private shadow: Sprite;
  private sprite: Sprite;
  private trail: Sprite[] = [];
  private trailTimer = 0;
  private rollPhase = 0;
  private headingBin = 0;
  private squashTimer = 0;

  constructor(private assets: GameAssets, worldSorted: Container) {
    this.shadow = new Sprite(assets.shadow);
    this.shadow.anchor.set(0.5, 0.5);
    this.sprite = new Sprite(assets.ballFrames[0][0]);
    this.sprite.anchor.set(0.5, 0.94); // contact point at the sphere's base
    this.root.addChild(this.shadow, this.sprite);

    for (let i = 0; i < TRAIL_LEN; i++) {
      const ghost = new Sprite(assets.ballFrames[0][0]);
      ghost.anchor.set(0.5, 0.94);
      ghost.visible = false;
      this.trail.push(ghost);
      worldSorted.addChild(ghost);
    }
  }

  triggerBounce() {
    this.squashTimer = 0.14;
  }

  update(ball: Ball, dt: number, alpha: number) {
    const x = lerp(ball.prev.x, ball.pos.x, alpha);
    const y = lerp(ball.prev.y, ball.pos.y, alpha);
    const z = lerp(ball.prev.z, ball.z, alpha);
    const ground = project(x, y, 0);
    const lifted = project(x, y, z);

    this.root.position.set(ground.sx, ground.sy);
    this.root.zIndex = ground.depth + 0.5; // wins ties at the boot, loses real depth
    this.sprite.position.set(0, lifted.sy - ground.sy);

    // The anchor shadow: always pooled hard at the ground point, shrinking and
    // drifting down-sun as the ball climbs — height you can read at a glance
    this.shadow.position.set(1 + z * 3, 0.5);
    this.shadow.scale.set(0.85 / (1 + z * 0.5), 0.85 / (1 + z * 0.6));
    this.shadow.alpha = 0.72 / (1 + z * 0.9);

    // A real rolling sphere: the heading picks the baked roll axis, distance
    // traveled spins the pattern around it. Lighting is baked screen-fixed, so
    // the ball reads solid — the pattern moves, the sun never does.
    const speed = ball.speed();
    const { dirs, phases, worldR } = this.assets.manifest.ball;
    if (speed > 0.4) {
      const angle = Math.atan2(ball.vel.y, ball.vel.x);
      const bin = Math.round(angle / ((Math.PI * 2) / dirs));
      this.headingBin = ((bin % dirs) + dirs) % dirs;
    }
    this.rollPhase += ((speed * dt) / (Math.PI * 2 * worldR)) * phases;
    const phase = Math.floor(this.rollPhase) % phases;
    this.sprite.texture = this.assets.ballFrames[this.headingBin][phase];

    // Bounce squash with a springy overshoot back to round
    this.squashTimer = Math.max(0, this.squashTimer - dt);
    if (this.squashTimer > 0.07) this.sprite.scale.set(1.18, 0.72);
    else if (this.squashTimer > 0) this.sprite.scale.set(0.9, 1.14);
    else this.sprite.scale.set(1, 1);

    this.updateTrail(ground.sx, this.sprite.position.y + ground.sy, ground.depth, speed, dt);
  }

  private updateTrail(sx: number, sy: number, depth: number, speed: number, dt: number) {
    this.trailTimer -= dt;
    if (speed > TRAIL_MIN_SPEED && this.trailTimer <= 0) {
      this.trailTimer = 0.028;
      const ghost = this.trail.pop()!;
      this.trail.unshift(ghost);
      ghost.visible = true;
      ghost.texture = this.sprite.texture;
      ghost.position.set(sx, sy);
      ghost.zIndex = depth + 1;
      ghost.alpha = 0.45;
      ghost.scale.set(0.9);
    }
    for (const ghost of this.trail) {
      if (!ghost.visible) continue;
      ghost.alpha -= dt * 3.2;
      ghost.scale.x *= 1 - dt * 1.5;
      ghost.scale.y *= 1 - dt * 1.5;
      if (ghost.alpha <= 0.03) ghost.visible = false;
    }
  }
}
