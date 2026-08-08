import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { GameLoop } from '../core/loop';
import { Rng } from '../core/rng';
import { SimEvent } from '../sim/events';
import { Ball } from '../sim/ball';
import { PlayerBody } from '../sim/player';
import { PITCH } from '../sim/constants';
import { pads } from '../input/gamepad';
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

// A single square of falling joy: world meters + height, with a flutter phase
interface Confetto {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  phase: number;
  color: number;
  age: number;
  life: number;
}

// A camera going off in the stand — the crowd's own shutter, not a light show
interface Bulb {
  x: number; y: number;
  at: number;
  life: number;
}

const MAX_DECALS = 90;
const CONFETTI_COLORS = [0xffd95e, 0xfff8e0, 0x9ff0b8, 0xff6a55, 0x5b98cf];
const MAX_SHAKE = 10; // px at full trauma; the fence pad swallows every one

// Value noise, not dice: a frame-to-frame random reads as jitter, a smooth
// lattice reads as a force pushing the lens around
const hash = (i: number) => {
  const s = Math.sin(i * 127.1) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};
function noise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  return hash(i) + (hash(i + 1) - hash(i)) * (f * f * (3 - 2 * f));
}

// All the juice: dust, torn grass, kick rings, turf skids that linger where
// play happened, trauma shake, hitstop, and the moments worth the whole stack
export class Effects {
  shakeX = 0;
  shakeY = 0;
  private particles: Particle[] = [];
  private decals: Decal[] = [];
  private confetti: Confetto[] = [];
  private bulbs: Bulb[] = [];
  private skyG = new Graphics(); // everything that happens above the turf
  private trauma = 0;
  private surgeT = 0;
  private surgeAmp = 0;
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
  ) {
    this.skyG.zIndex = 1e6; // joy falls in front of everything on the pitch
    worldSorted.addChild(this.skyG);
  }

  consume(events: SimEvent[]) {
    for (const e of events) {
      switch (e.kind) {
        case 'kick': {
          this.spawn(this.assets.ringFrames, e.x, e.y, { life: 0.22, fade: 0 });
          this.spawn(this.assets.dustFrames, e.x, e.y, { life: 0.3, vx: -14, vy: -6 });
          this.spawn(this.assets.grassFrames, e.x, e.y, { life: 0.34, vx: this.rng.range(-6, 6) });
          if (e.power > 0.5) this.jolt(0.06 + e.power * 0.14);
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
        case 'tackle':
          // A body launching itself in: turf flies where the slide bites
          this.spawn(this.assets.dustFrames, e.x, e.y, { life: 0.32, vx: this.rng.range(-10, 10), vy: -3 });
          this.spawn(this.assets.grassFrames, e.x, e.y, { life: 0.34, vx: this.rng.range(-8, 8) });
          break;
        case 'steal':
          this.spawn(this.assets.ringFrames, e.x, e.y, { life: 0.18, fade: 0 });
          this.jolt(0.2);
          pads.rumble(0.35, 90);
          break;
        case 'feint':
          // The escape cut: dust kicked off the plant, thrown against the cut
          for (let i = 0; i < 2; i++) {
            this.spawn(this.assets.dustFrames, e.x + this.rng.range(-0.3, 0.3), e.y + this.rng.range(-0.2, 0.2), {
              life: 0.3, vx: -e.dx * 16 + this.rng.range(-4, 4), vy: -e.dy * 9,
            });
          }
          break;
        case 'shrug':
          // Bounced off the shield — the ground takes the hit, not the ball
          this.spawn(this.assets.dustFrames, e.x, e.y, { life: 0.34, vx: this.rng.range(-12, 12), vy: -4 });
          this.jolt(0.24);
          this.loop.hitstop(30, 0.35);
          pads.rumble(0.45, 110);
          break;
        case 'save':
          // Gloves on it: the ring, four frames of held breath, a punch in the
          // hands — no turf torn, because nothing hit the ground
          this.spawn(this.assets.ringFrames, e.x, e.y, { life: 0.2, fade: 0 });
          this.jolt(0.22);
          this.loop.hitstop(60, 0.3);
          pads.rumble(0.5, 130);
          break;
        case 'bounce':
          this.spawn(this.assets.dustFrames, e.x, e.y, { life: 0.28, vx: this.rng.range(-8, 8) });
          this.spawn(this.assets.grassFrames, e.x, e.y, { life: 0.3, vx: this.rng.range(-4, 4) });
          break;
        case 'post':
          // The woodwork says no — the most valuable non-goal in the game, and
          // the only near-miss that gets the slow-motion treatment
          this.spawn(this.assets.ringFrames, e.x, e.y, { life: 0.2, fade: 0 });
          this.jolt(0.42 + e.impact * 0.02);
          this.loop.hitstop(90, 0.25);
          pads.rumble(0.75, 180);
          break;
      }
    }
  }

  // THE GOAL: the whole stack at once, and bigger the more the match had
  // riding on it. A finish tucked into the top corner buys the freeze frame
  // and a stand full of shutters going off.
  goalMoment(side: 'left' | 'right', corner: number, tension: number) {
    this.loop.hitstop(160 + corner * 90, corner > 0.55 ? 0.04 : 0.07);
    this.jolt(0.6 + tension * 0.35);
    pads.rumble(1, 350 + corner * 250);
    const gx = side === 'left' ? 2 : PITCH.length - 2;
    const count = Math.round(90 + tension * 90);
    for (let i = 0; i < count; i++) {
      this.confetti.push({
        x: gx + this.rng.range(-16, 16),
        y: this.rng.range(-2, PITCH.width * 0.55),
        z: this.rng.range(7, 13),
        vx: this.rng.range(-2.5, 2.5),
        vy: this.rng.range(-0.5, 2),
        vz: this.rng.range(-0.5, 0.8),
        phase: this.rng.range(0, Math.PI * 2),
        color: CONFETTI_COLORS[Math.floor(this.rng.next() * CONFETTI_COLORS.length)],
        age: 0,
        life: this.rng.range(2.6, 4.4),
      });
    }
    if (corner <= 0.55) return;
    for (let i = 0; i < 14; i++) {
      this.bulbs.push({
        x: gx + this.rng.range(-30, 30),
        y: this.rng.range(-7.5, -2.6),
        at: this.rng.range(0.1, 1.5),
        life: 0.09,
      });
    }
  }

  // A goal that levels it in the closing minutes: not a punch but a swell —
  // the whole ground on its feet, shaking the lens for a full second
  surge(seconds: number, amp: number) {
    this.surgeT = seconds;
    this.surgeAmp = amp;
  }

  // The hands feel what the eyes just read — every callout lands three ways
  felt(kick: number) {
    pads.rumble(0.2 + kick * 0.5, 60 + kick * 70);
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

    // Confetti flutters down: light gravity, a side-to-side sway, and a
    // wink out on the grass — every square an honest 2px of pixel joy
    this.skyG.clear();
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const c = this.confetti[i];
      c.age += dt;
      if (c.age >= c.life) {
        this.confetti.splice(i, 1);
        continue;
      }
      c.vz -= dt * 3.2;
      c.vz = Math.max(c.vz, -1.9); // drag: paper falls, it doesn't drop
      c.z = Math.max(0, c.z + c.vz * dt);
      c.phase += dt * 7;
      c.x += (c.vx + Math.sin(c.phase) * 2.2) * dt;
      c.y += c.vy * dt;
      if (c.z <= 0) c.age = Math.max(c.age, c.life - 0.4); // grounded: fade out
      const p = project(c.x, c.y, c.z);
      const alpha = c.age > c.life - 0.5 ? (c.life - c.age) / 0.5 : 1;
      const w = Math.sin(c.phase * 1.7) > 0 ? 3 : 2; // the tumble
      this.skyG.rect(Math.round(p.sx), Math.round(p.sy), w, 2).fill({ color: c.color, alpha });
    }

    // Shutters in the stand: a hard white pinprick with a soft halo, gone in
    // five frames. Fourteen of them across a minute-and-a-half of madness.
    for (let i = this.bulbs.length - 1; i >= 0; i--) {
      const b = this.bulbs[i];
      b.at -= dt;
      if (b.at < -b.life) {
        this.bulbs.splice(i, 1);
        continue;
      }
      if (b.at > 0) continue;
      const p = project(b.x, b.y, 0);
      const fade = 1 + b.at / b.life;
      this.skyG.rect(Math.round(p.sx) - 3, Math.round(p.sy) - 3, 7, 7).fill({ color: 0xfff8e0, alpha: 0.22 * fade });
      this.skyG.rect(Math.round(p.sx) - 1, Math.round(p.sy) - 1, 3, 3).fill({ color: 0xffffff, alpha: fade });
    }

    // Trauma, not a sine: impacts add to one pot, it drains in half a second,
    // and the lens rides smooth noise at 19Hz — snapped to whole pixels so the
    // sprite grid never shimmers
    this.shakeT += dt;
    this.trauma = Math.max(0, this.trauma - dt * 2.2);
    this.surgeT = Math.max(0, this.surgeT - dt);
    const amp = this.trauma * this.trauma * MAX_SHAKE + this.surgeAmp * Math.min(1, this.surgeT);
    this.shakeX = Math.round(noise(this.shakeT * 19) * amp);
    this.shakeY = Math.round(noise(this.shakeT * 19 + 37) * amp * 0.6);
  }

  // One pot, clamped: two hits in a frame never stack into an earthquake
  private jolt(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }
}
