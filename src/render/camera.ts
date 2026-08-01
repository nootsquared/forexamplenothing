import { Container } from 'pixi.js';
import { Vec2, vec, add, clampLen, scale, expDecay, clamp, dist } from '../core/math';
import { PITCH } from '../sim/constants';
import { project, pxPerMeter, squash } from './projection';

// One shared broadcast camera: leads the ball, and widens just enough to keep
// the players around the action in frame — nobody plays off-screen
export class FollowCamera {
  center: Vec2 = vec(PITCH.length / 2, PITCH.width / 2);
  zoom = 3.0;
  // A distribution beat pulls the view wide onto a chosen spot (keeper aiming)
  override: { center: Vec2; zoom: number } | null = null;
  private targetZoom = 3.0;

  update(dt: number, ballPos: Vec2, ballVel: Vec2, players: Vec2[], viewW: number, viewH: number) {
    if (this.override) {
      this.center.x = expDecay(this.center.x, this.override.center.x, 4, dt);
      this.center.y = expDecay(this.center.y, this.override.center.y, 4, dt);
      this.zoom = expDecay(this.zoom, this.override.zoom, 4, dt);
      return;
    }
    const lookAhead = clampLen(scale(ballVel, 0.4), 7);
    const focus = add(ballPos, lookAhead);

    // Frame = ball plus everyone near the action, biased toward the ball
    let minX = ballPos.x, maxX = ballPos.x, minY = ballPos.y, maxY = ballPos.y;
    for (const p of players) {
      if (dist(p, ballPos) > 30) continue; // stragglers don't drag the frame
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const target = add(scale(focus, 0.6), scale(vec((minX + maxX) / 2, (minY + maxY) / 2), 0.4));
    this.center.x = expDecay(this.center.x, target.x, 3.2, dt);
    this.center.y = expDecay(this.center.y, target.y, 3.2, dt);

    // Zoom out only as far as the action demands, breathe with ball pace
    const M = pxPerMeter();
    const spanX = (maxX - minX) / 2 + 8;
    const spanY = (maxY - minY) / 2 + 6;
    const fit = Math.min(viewW / (2 * spanX * M), viewH / (2 * spanY * M * squash()));
    const pace = Math.hypot(ballVel.x, ballVel.y) > 15 ? 2.75 : 3.0;
    this.targetZoom = clamp(Math.min(pace, fit), 2.2, 3.0);
    this.zoom = expDecay(this.zoom, this.targetZoom, 1.8, dt);

    // Keep the frame inside the grass world
    const halfW = viewW / 2 / this.zoom / M;
    const halfH = viewH / 2 / this.zoom / (M * squash());
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
