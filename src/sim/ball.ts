import { Vec2, vec, len, scale } from '../core/math';
import { GRAVITY, Surface } from './constants';
import { SimEvent } from './events';

export class Ball {
  pos: Vec2 = vec(52.5, 34);
  z = 0;
  vel: Vec2 = vec();
  vz = 0;
  // Previous-step state for render interpolation
  prev = { x: 52.5, y: 34, z: 0 };

  savePrev() {
    this.prev.x = this.pos.x;
    this.prev.y = this.pos.y;
    this.prev.z = this.z;
  }

  speed(): number {
    return len(this.vel);
  }

  update(dt: number, surface: Surface, events: SimEvent[]) {
    if (this.z > 0.004 || this.vz > 0) {
      this.vz -= GRAVITY * dt;
      this.z += this.vz * dt;
      this.vel = scale(this.vel, Math.max(0, 1 - 0.12 * dt)); // air drag
      if (this.z <= 0 && this.vz < 0) {
        const impact = -this.vz;
        this.z = 0;
        this.vz = -this.vz * surface.bounce;
        this.vel = scale(this.vel, 0.86); // grass grabs a little on each bounce
        if (this.vz < 1.1) this.vz = 0;   // settle instead of micro-bouncing forever
        if (impact > 3.5) events.push({ kind: 'bounce', x: this.pos.x, y: this.pos.y, impact });
      }
    } else {
      const sp = this.speed();
      if (sp > 0) {
        const decel = (surface.rollFriction + surface.dragK * sp) * dt;
        this.vel = sp <= decel ? vec() : scale(this.vel, (sp - decel) / sp);
      }
    }
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
  }
}
