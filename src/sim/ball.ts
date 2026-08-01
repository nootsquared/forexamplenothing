import { Vec2, vec, len, scale, rotate } from '../core/math';
import { GRAVITY, Surface } from './constants';
import { SimEvent } from './events';

export class Ball {
  pos: Vec2 = vec(52.5, 34);
  z = 0;
  vel: Vec2 = vec();
  vz = 0;
  spin = 0; // sidespin, rad/s of flight-path curl — the banana in a bent shot
  // A punted ball drops STEEP and dies where it lands instead of skidding on —
  // set for the flight, consumed by the first touchdown
  deadenOnLand = false;
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
    // Magnus curl: sidespin bends the path while the ball carries real pace,
    // washing out as the spin scrubs off
    if (this.spin !== 0) {
      if (this.speed() > 3) this.vel = rotate(this.vel, this.spin * dt);
      this.spin *= Math.max(0, 1 - 1.1 * dt);
      if (Math.abs(this.spin) < 0.02) this.spin = 0;
    }
    if (this.z > 0.004 || this.vz > 0) {
      this.vz -= GRAVITY * dt;
      this.z += this.vz * dt;
      this.vel = scale(this.vel, Math.max(0, 1 - 0.12 * dt)); // air drag
      if (this.z <= 0 && this.vz < 0) {
        const impact = -this.vz;
        this.z = 0;
        this.vz = -this.vz * surface.bounce * (this.deadenOnLand ? 0.45 : 1);
        this.vel = scale(this.vel, this.deadenOnLand ? 0.3 : 0.86); // grass grabs; a punt DIES
        if (this.deadenOnLand && this.speed() > 6) {
          this.vel = scale(this.vel, 6 / this.speed()); // even a missile sits down where it drops
        }
        this.deadenOnLand = false;
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
