import { Container, Sprite } from 'pixi.js';
import { lerp } from './interp';
import { Ball } from '../sim/ball';
import { GameAssets } from './assets';
import { project, SQUASH } from './projection';

const TRAIL_LEN = 7;
const TRAIL_MIN_SPEED = 15;

export class BallView {
  root = new Container(); // sits in the sorted world; children are screen-relative
  private shadow: Sprite;
  private sprite: Sprite;
  private trail: Sprite[] = [];
  private trailTimer = 0;
  private rollPhase = 0;
  private squashTimer = 0;

  constructor(private assets: GameAssets, worldSorted: Container) {
    this.shadow = new Sprite(assets.shadow);
    this.shadow.anchor.set(0.5, 0.5);
    this.shadow.scale.set(0.55);
    this.sprite = new Sprite(assets.ballFrames[0]);
    this.sprite.anchor.set(0.5, 0.78); // resting point sits near the sprite's base
    this.root.addChild(this.shadow, this.sprite);

    for (let i = 0; i < TRAIL_LEN; i++) {
      const ghost = new Sprite(assets.ballFrames[0]);
      ghost.anchor.set(0.5, 0.78);
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
    this.root.zIndex = ground.depth + 2; // shades the player at identical depth
    this.sprite.position.set(0, lifted.sy - ground.sy);

    // Shadow sits down-sun of the ball, shrinking and fading as it climbs
    this.shadow.position.set(1.5 + z * 2, 1);
    this.shadow.scale.set(0.55 / (1 + z * 0.45));
    this.shadow.alpha = 0.75 / (1 + z * 0.8);

    const speed = ball.speed();
    this.rollPhase += speed * dt * 2.4;
    const frame = Math.floor(this.rollPhase) % this.assets.ballFrames.length;
    this.sprite.texture = this.assets.ballFrames[frame];
    // Roll pattern travels along sprite-local +y; rotate so it rolls forward
    if (speed > 0.5) {
      this.sprite.rotation = Math.atan2(ball.vel.y * SQUASH, ball.vel.x) - Math.PI / 2;
    } else {
      this.sprite.rotation *= Math.max(0, 1 - dt * 6); // settle upright at rest
    }

    // Bounce squash, then a springy overshoot back to round;
    // otherwise fast grounded travel stretches the ball along its path
    this.squashTimer = Math.max(0, this.squashTimer - dt);
    if (this.squashTimer > 0.07) this.sprite.scale.set(1.18, 0.72);
    else if (this.squashTimer > 0) this.sprite.scale.set(0.9, 1.14);
    else if (speed > 10 && z < 0.3) this.sprite.scale.set(1 - Math.min(0.12, speed * 0.004), 1 + Math.min(0.18, speed * 0.007));
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
      ghost.position.set(sx, sy);
      ghost.zIndex = depth + 1;
      ghost.alpha = 0.5;
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
