import { Container, Sprite, Texture } from 'pixi.js';
import { GameLoop } from '../core/loop';
import { Rng } from '../core/rng';
import { SimEvent } from '../sim/events';
import { Ball } from '../sim/ball';
import { PlayerBody } from '../sim/player';
import { GameAssets } from './assets';
import { project, squash } from './projection';

interface Particle {
  sprite: Sprite;
  frames: Texture[] | null;
  age: number;
  life: number;
  vx: number;
  vy: number;
  fade: number;
}

interface Decal {
  sprite: Sprite;
  age: number;
  life: number;
  alpha: number;
}

const MAX_DECALS = 90;

// All the juice: dust, torn grass, kick rings, turf skids that linger where
// play happened, screen kick, hitstop
export class Effects {
  shakeX = 0;
  shakeY = 0;
  private particles: Particle[] = [];
  private decals: Decal[] = [];
  private shakeAmp = 0;
  private shakeT = 0;
  private sprintDustTimer = 0;
  private sprintScuffTimer = 0;
  private rollGrassTimer = 0;
  private rng = new Rng(555);

  constructor(
    private assets: GameAssets,
    private worldSorted: Container,
    private groundFx: Container,
    private loop: GameLoop,
  ) {}

  consume(events: SimEvent[]) {
    for (const e of events) {
      switch (e.kind) {
        case 'kick': {
          this.spawn(this.assets.ringFrames, e.x, e.y, { life: 0.22, fade: 0 });
          this.spawn(this.assets.dustFrames, e.x, e.y, { life: 0.3, vx: -14, vy: -6 });
          this.spawn(this.assets.grassFrames, e.x, e.y, { life: 0.34, vx: this.rng.range(-6, 6) });
          if (e.power > 0.5) this.kickShake(1.5 + e.power * 4);
          // Hitstop is reserved for true screamers so shooting never feels laggy
          if (e.power > 0.85) this.loop.hitstop(50, 0.3);
          break;
        }
        case 'cut':
          // A planted boot tears turf: dust, flying clippings, a skid gouged in
          for (let i = 0; i < 2; i++) {
            this.spawn(this.assets.dustFrames, e.x + this.rng.range(-0.3, 0.3), e.y + this.rng.range(-0.2, 0.2), {
              life: 0.35, vx: this.rng.range(-18, 18), vy: this.rng.range(-10, 2),
            });
            this.spawn(this.assets.grassFrames, e.x + this.rng.range(-0.2, 0.2), e.y, {
              life: 0.4, vx: -e.dx * 14 + this.rng.range(-5, 5), vy: -e.dy * 8,
            });
          }
          this.stampSkid(e.x, e.y, e.dx, e.dy, 0.55, 8, 1.1);
          break;
        case 'touch':
          if (e.sprint) {
            const bits = this.rng.next() < 0.5 ? this.assets.grassFrames : this.assets.dustFrames;
            this.spawn(bits, e.x, e.y, { life: 0.25, vy: -4 });
          }
          break;
        case 'bounce':
          this.spawn(this.assets.dustFrames, e.x, e.y, { life: 0.28, vx: this.rng.range(-8, 8) });
          this.spawn(this.assets.grassFrames, e.x, e.y, { life: 0.3, vx: this.rng.range(-4, 4) });
          break;
        case 'goal':
          this.loop.hitstop(130, 0.08);
          this.kickShake(9);
          break;
      }
    }
  }

  // Sprint feet drum up dust and leave faint scuffs pressed into the turf
  sprintDust(player: PlayerBody, dt: number) {
    this.sprintDustTimer -= dt;
    this.sprintScuffTimer -= dt;
    if (!player.isSprinting || player.speed() <= 5.5) return;
    const backX = player.pos.x - player.facing.x * 0.5;
    const backY = player.pos.y - player.facing.y * 0.5;
    if (this.sprintDustTimer <= 0) {
      this.sprintDustTimer = 0.15;
      this.spawn(this.assets.dustFrames, backX, backY, { life: 0.32, vx: -player.vel.x * 1.6, vy: -player.vel.y * 1.0 });
    }
    if (this.sprintScuffTimer <= 0) {
      this.sprintScuffTimer = 0.32;
      this.stampSkid(backX, backY, player.facing.x, player.facing.y, 0.24, 5, 0.7);
    }
  }

  // A ball tearing across the turf flicks clippings up behind itself
  rollGrass(ball: Ball, dt: number) {
    this.rollGrassTimer -= dt;
    if (ball.z > 0.05 || ball.speed() <= 7 || this.rollGrassTimer > 0) return;
    this.rollGrassTimer = 0.07;
    this.spawn(this.assets.grassFrames, ball.pos.x, ball.pos.y, {
      life: 0.3,
      vx: -ball.vel.x * 0.35 + this.rng.range(-4, 4),
      vy: -ball.vel.y * 0.25 - this.rng.range(2, 7),
    });
  }

  // Press a skid mark into the ground layer; oldest marks make way
  private stampSkid(x: number, y: number, dirX: number, dirY: number, alpha: number, life: number, scale: number) {
    const sprite = new Sprite(this.assets.skid);
    const p = project(x, y, 0);
    sprite.anchor.set(1, 0.5); // streak trails behind the plant point
    sprite.position.set(p.sx, p.sy);
    sprite.rotation = Math.atan2(dirY * squash(), dirX);
    sprite.scale.set(scale, scale);
    sprite.alpha = alpha;
    this.groundFx.addChild(sprite);
    this.decals.push({ sprite, age: 0, life, alpha });
    if (this.decals.length > MAX_DECALS) {
      const oldest = this.decals.shift()!;
      oldest.sprite.destroy();
    }
  }

  private spawn(frames: Texture[], x: number, y: number, opts: Partial<Particle> = {}) {
    const sprite = new Sprite(frames[0]);
    this.setup(sprite, x, y);
    this.particles.push({ sprite, frames, age: 0, life: opts.life ?? 0.3, vx: opts.vx ?? 0, vy: opts.vy ?? 0, fade: opts.fade ?? 0 });
  }

  private setup(sprite: Sprite, x: number, y: number) {
    const p = project(x, y, 0);
    sprite.anchor.set(0.5, 0.6);
    sprite.position.set(p.sx, p.sy);
    sprite.zIndex = p.depth + 0.4;
    this.worldSorted.addChild(sprite);
  }

  update(dt: number) {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age += dt;
      if (d.age >= d.life) {
        d.sprite.destroy();
        this.decals.splice(i, 1);
        continue;
      }
      // Marks hold, then the grass slowly stands back up
      const t = d.age / d.life;
      d.sprite.alpha = d.alpha * (t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45);
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.age += dt;
      if (pt.age >= pt.life) {
        pt.sprite.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      const t = pt.age / pt.life;
      pt.sprite.position.x += pt.vx * dt;
      pt.sprite.position.y += pt.vy * dt;
      if (pt.frames) pt.sprite.texture = pt.frames[Math.min(pt.frames.length - 1, Math.floor(t * pt.frames.length))];
      if (pt.fade > 0) pt.sprite.alpha = Math.max(0, 1 - t * pt.fade);
    }

    this.shakeT += dt * 55;
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 26);
    this.shakeX = Math.sin(this.shakeT) * this.shakeAmp;
    this.shakeY = Math.cos(this.shakeT * 1.3) * this.shakeAmp * 0.6;
  }

  private kickShake(amp: number) {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  }
}
