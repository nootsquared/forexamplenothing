import { Container } from 'pixi.js';
import { Vec2, vec, add, clampLen, scale, expDecay, clamp } from '../core/math';
import { PITCH } from '../sim/constants';
import { project, pxPerMeter, SQUASH } from './projection';

// One shared broadcast camera: follows the ball with look-ahead, breathes with pace
export class FollowCamera {
  center: Vec2 = vec(PITCH.length / 2, PITCH.width / 2);
  zoom = 2.8;
  private targetZoom = 2.8;

  update(dt: number, ballPos: Vec2, ballVel: Vec2, viewW: number, viewH: number) {
    const lookAhead = clampLen(scale(ballVel, 0.4), 7);
    const target = add(ballPos, lookAhead);
    this.center.x = expDecay(this.center.x, target.x, 3.2, dt);
    this.center.y = expDecay(this.center.y, target.y, 3.2, dt);

    const speed = Math.hypot(ballVel.x, ballVel.y);
    this.targetZoom = speed > 17 ? 2.5 : 2.8;
    this.zoom = expDecay(this.zoom, this.targetZoom, 1.6, dt);

    // Keep the frame inside the grass world
    const M = pxPerMeter();
    const halfW = viewW / 2 / this.zoom / M;
    const halfH = viewH / 2 / this.zoom / (M * SQUASH);
    const a = PITCH.apron - 1;
    this.center.x = clamp(this.center.x, halfW - a, PITCH.length + a - halfW);
    this.center.y = clamp(this.center.y, halfH - a, PITCH.width + a - halfH);
  }

  applyTo(world: Container, viewW: number, viewH: number, shakeX: number, shakeY: number) {
    const p = project(this.center.x, this.center.y, 0);
    world.scale.set(this.zoom);
    world.pivot.set(p.sx, p.sy);
    world.position.set(viewW / 2 + shakeX, viewH / 2 + shakeY);
  }
}
