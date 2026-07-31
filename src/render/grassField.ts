import { Container, ParticleContainer, Particle } from 'pixi.js';
import { Rng } from '../core/rng';
import { PITCH } from '../sim/constants';
import { GameAssets } from './assets';
import { pxPerMeter, squash } from './projection';

// The living turf: ~19k individual grass blades, each with its own spring.
// Wind sways all of them; boots and the ball shove the ones they cross, which
// snap away and wobble back upright over a second — so every run mows a
// visible trail and a resting ball sits in its own parted circle. Blades are
// GPU particles batched into shallow depth bands so bodies sort into them.

export interface GrassActor {
  x: number;
  y: number;
  speed: number;
  press: boolean; // parked on the turf: sustained part instead of a passing shove
}

const BAND_M = 2;            // depth-sort granularity in meters
const CELL = 2;              // spatial hash cell size
const REACH = 0.8;           // shove radius around an actor
const PRESS_REACH = 0.62;    // sustained-press radius
const STIFF = 62;            // spring toward upright
const DAMP = 4.6;            // wobble decay — under-damped on purpose, grass swishes

export class GrassField {
  private particles: Particle[] = [];
  private bend: Float32Array;
  private bendVel: Float32Array;
  private windPhase: Float32Array;
  private wx: Float32Array;
  private wy: Float32Array;
  private active: Uint8Array;
  private activeList: number[] = [];
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private cols: number;
  private rows: number;
  private time = 0;

  constructor(assets: GameAssets, worldSorted: Container) {
    const rng = new Rng(1312);
    const M = pxPerMeter();
    const sq = squash();
    const spots: { x: number; y: number; scale: number; alpha: number }[] = [];

    // Interior carpet, grown-in boundary fringe, wilder apron growth
    const interior = Math.round(PITCH.length * PITCH.width * 2.2);
    for (let i = 0; i < interior; i++) {
      spots.push({ x: rng.range(0.3, PITCH.length - 0.3), y: rng.range(0.3, PITCH.width - 0.3), scale: rng.range(0.8, 1.25), alpha: 0.85 });
    }
    for (let x = -0.3; x < PITCH.length + 0.3; x += rng.range(0.25, 0.5)) {
      spots.push({ x, y: rng.range(-0.25, 0.25), scale: rng.range(1, 1.5), alpha: 1 });
      spots.push({ x, y: PITCH.width + rng.range(-0.25, 0.25), scale: rng.range(1, 1.5), alpha: 1 });
    }
    for (let y = -0.3; y < PITCH.width + 0.3; y += rng.range(0.25, 0.5)) {
      spots.push({ x: rng.range(-0.25, 0.25), y, scale: rng.range(1, 1.5), alpha: 1 });
      spots.push({ x: PITCH.length + rng.range(-0.25, 0.25), y, scale: rng.range(1, 1.5), alpha: 1 });
    }
    for (let i = 0; i < 2600; i++) {
      const x = rng.range(-PITCH.apron + 0.8, PITCH.length + PITCH.apron - 0.8);
      const onSide = rng.next() < 0.5;
      const y = onSide
        ? rng.range(-PITCH.apron + 0.8, -0.5)
        : rng.range(PITCH.width + 0.5, PITCH.width + PITCH.apron - 0.8);
      spots.push({ x, y, scale: rng.range(1.2, 1.8), alpha: 0.95 });
    }

    const n = spots.length;
    this.bend = new Float32Array(n);
    this.bendVel = new Float32Array(n);
    this.windPhase = new Float32Array(n);
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.active = new Uint8Array(n);

    // One ParticleContainer per depth band; only rotation streams per frame
    const bandCount = Math.ceil((PITCH.width + PITCH.apron * 2) / BAND_M);
    const bands: ParticleContainer[] = [];
    for (let b = 0; b < bandCount; b++) {
      const band = new ParticleContainer({
        dynamicProperties: { position: false, vertex: false, rotation: true, uvs: false, color: false },
      });
      band.zIndex = (-PITCH.apron + (b + 0.5) * BAND_M) * 10;
      bands.push(band);
      worldSorted.addChild(band);
    }

    spots.forEach((s, i) => {
      this.wx[i] = s.x;
      this.wy[i] = s.y;
      this.windPhase[i] = rng.range(0, Math.PI * 2);
      const p = new Particle({
        texture: assets.bladeFrames[Math.floor(rng.next() * assets.bladeFrames.length)],
        x: s.x * M,
        y: s.y * M * sq,
        anchorX: 0.5,
        anchorY: 1,
        scaleX: s.scale,
        scaleY: s.scale,
        alpha: s.alpha,
      });
      this.particles.push(p);
      const band = Math.min(bandCount - 1, Math.max(0, Math.floor((s.y + PITCH.apron) / BAND_M)));
      bands[band].addParticle(p);
    });

    // Static spatial hash so actors only touch nearby blades
    this.cols = Math.ceil((PITCH.length + PITCH.apron * 2) / CELL);
    this.rows = Math.ceil((PITCH.width + PITCH.apron * 2) / CELL);
    const counts = new Int32Array(this.cols * this.rows);
    for (let i = 0; i < n; i++) counts[this.cellOf(this.wx[i], this.wy[i])]++;
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    for (let c = 0; c < counts.length; c++) this.cellStart[c + 1] = this.cellStart[c] + counts[c];
    this.cellItems = new Int32Array(n);
    const cursor = this.cellStart.slice(0, -1);
    for (let i = 0; i < n; i++) {
      const c = this.cellOf(this.wx[i], this.wy[i]);
      this.cellItems[cursor[c]++] = i;
    }
  }

  update(dt: number, actors: GrassActor[]) {
    const step = Math.min(dt, 0.05);
    this.time += step;

    for (const a of actors) this.disturb(a, step);

    // Under-damped springs pull shoved blades back upright with a wobble
    for (let k = this.activeList.length - 1; k >= 0; k--) {
      const i = this.activeList[k];
      this.bendVel[i] += (-STIFF * this.bend[i] - DAMP * this.bendVel[i]) * step;
      this.bend[i] += this.bendVel[i] * step;
      if (Math.abs(this.bend[i]) < 0.012 && Math.abs(this.bendVel[i]) < 0.06) {
        this.bend[i] = 0;
        this.bendVel[i] = 0;
        this.active[i] = 0;
        this.activeList[k] = this.activeList[this.activeList.length - 1];
        this.activeList.pop();
      }
    }

    // Everyone gets wind; bent blades add their spring state on top
    const t = this.time;
    const gustAmp = 0.05 + 0.08 * (0.5 + 0.5 * Math.sin(t * 0.31));
    for (let i = 0; i < this.particles.length; i++) {
      this.particles[i].rotation = gustAmp * Math.sin(t * 1.6 + this.windPhase[i]) + this.bend[i];
    }
  }

  private disturb(a: GrassActor, dt: number) {
    const reach = a.press ? PRESS_REACH : REACH;
    const r2 = reach * reach;
    const c0x = Math.max(0, Math.floor((a.x - reach + PITCH.apron) / CELL));
    const c1x = Math.min(this.cols - 1, Math.floor((a.x + reach + PITCH.apron) / CELL));
    const c0y = Math.max(0, Math.floor((a.y - reach + PITCH.apron) / CELL));
    const c1y = Math.min(this.rows - 1, Math.floor((a.y + reach + PITCH.apron) / CELL));

    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cell = cy * this.cols + cx;
        for (let s = this.cellStart[cell]; s < this.cellStart[cell + 1]; s++) {
          const i = this.cellItems[s];
          const dx = this.wx[i] - a.x;
          const dy = this.wy[i] - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const d = Math.sqrt(d2) || 1e-4;
          const falloff = 1 - d2 / r2;
          // Straight-ahead blades split to alternating sides of the run
          let px = dx / d;
          if (px > -0.3 && px < 0.3) px = i % 2 === 0 ? 0.45 : -0.45;

          if (a.press) {
            // Parked body or resting ball: hold the part open, breathing a little
            const target = px * falloff * (0.85 + 0.14 * Math.sin(t3(this.time, i)));
            this.bend[i] += (target - this.bend[i]) * Math.min(1, 9 * dt);
          } else {
            this.bendVel[i] += px * falloff * (5.5 + a.speed * 1.5) * dt * 14;
          }
          if (!this.active[i]) {
            this.active[i] = 1;
            this.activeList.push(i);
          }
        }
      }
    }
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x + PITCH.apron) / CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y + PITCH.apron) / CELL)));
    return cy * this.cols + cx;
  }
}

// Cheap per-blade wobble phase for the resting-ball breathing effect
function t3(time: number, i: number) {
  return time * 2.4 + (i % 7);
}
