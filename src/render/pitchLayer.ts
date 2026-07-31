import { Container, Sprite, TilingSprite, Graphics } from 'pixi.js';
import { Rng } from '../core/rng';
import { PITCH } from '../sim/constants';
import { GameAssets } from './assets';
import { project, pxPerMeter, SQUASH } from './projection';

type Pt = [number, number];

// Anything moving across the turf that grass should react to
export interface TurfDisturber {
  x: number;
  y: number;
  speed: number;
}

interface BladeState {
  sprite: Sprite;
  wx: number;
  wy: number;
  phase: number;
  base: number;
  disturb: number;
  pushSign: number;
}

interface NetPanel {
  g: Graphics;
  tl: Pt; tr: Pt; bl: Pt; br: Pt;
  alpha: number;
  sag: number;
  warp: number; // how much of the goal's swish this panel takes
}

interface GoalRig {
  panels: NetPanel[];
  backSign: number; // screen direction the net bulges (away from the pitch)
  rippleAge: number; // -1 idle, else seconds since the ball hit the net
  phase: number;
}

// The stage: turf that moves in the wind AND under boots, grown-over boundary
// fringes, cloud shade, an arena, and box goals with nets that actually swish
export class PitchLayer {
  ground = new Container(); // flat layer, always behind the sorted world
  groundFx = new Container(); // decals stamped by play: skids, scuffs
  private pitchSprite: Sprite;
  private clouds: Sprite[] = [];
  private blades: BladeState[] = [];
  private flags: { sprite: Sprite; phase: number }[] = [];
  private goals: Record<'left' | 'right', GoalRig> = {
    left: { panels: [], backSign: -1, rippleAge: -1, phase: 0 },
    right: { panels: [], backSign: 1, rippleAge: -1, phase: 2.1 },
  };
  private time = 0;

  constructor(private assets: GameAssets, worldSorted: Container) {
    const M = pxPerMeter();
    this.pitchSprite = new Sprite(assets.pitch['day']);
    this.pitchSprite.position.set(-PITCH.apron * M, -PITCH.apron * M * SQUASH);
    this.pitchSprite.scale.y = SQUASH;
    this.ground.addChild(this.pitchSprite);

    this.driftClouds();
    this.ground.addChild(this.groundFx); // decals above the turf, below everything alive
    this.buildArena(worldSorted);
    this.plantGrass(worldSorted);
    this.buildGoal(worldSorted, 'left');
    this.buildGoal(worldSorted, 'right');
  }

  setVariant(id: string) {
    this.pitchSprite.texture = this.assets.pitch[id];
    for (const c of this.clouds) c.visible = id !== 'night'; // no cloud shade under floodlights
  }

  // The ball just hit this net — set it swinging
  rippleGoal(side: 'left' | 'right') {
    this.goals[side].rippleAge = 0;
  }

  update(dt: number, disturbers: TurfDisturber[]) {
    this.time += dt;
    const t = this.time;

    // One wind field for the whole ground: gusts swell slowly while a bend
    // wave travels down-pitch — and boots flatten whatever they run over
    const gust = 0.55 + 0.45 * Math.sin(t * 0.37 + 1.3);
    for (const b of this.blades) {
      b.disturb = Math.max(0, b.disturb - dt * 2.6); // trampled grass springs back
      for (const a of disturbers) {
        const dx = b.wx - a.x;
        if (dx > 1.15 || dx < -1.15) continue;
        const dy = b.wy - a.y;
        if (dy > 1.15 || dy < -1.15) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1.32) continue;
        const strength = (1 - d2 / 1.32) * Math.min(1, 0.35 + a.speed / 6);
        if (strength > b.disturb) {
          b.disturb = strength;
          b.pushSign = dx >= 0 ? 1 : -1; // bent away from the boot
        }
      }
      const wind = 0.05 + gust * 0.16 * Math.sin(t * 1.6 - b.wx * 0.12 - b.wy * 0.07 + b.phase);
      b.sprite.skew.x = wind + b.pushSign * 0.55 * b.disturb;
      b.sprite.scale.y = b.base * (1 - 0.45 * b.disturb); // flattened underfoot
    }

    for (const side of ['left', 'right'] as const) {
      const rig = this.goals[side];
      let swish = 0;
      if (rig.rippleAge >= 0) {
        rig.rippleAge += dt;
        if (rig.rippleAge > 1.2) rig.rippleAge = -1;
        else swish = 8 * Math.sin(rig.rippleAge * 13) * Math.exp(-rig.rippleAge * 4.2);
      }
      const ambient = 0.8 * Math.sin(t * 1.2 + rig.phase); // nets are never dead still
      for (const p of rig.panels) this.drawPanel(p, rig.backSign * (ambient + swish) * p.warp);
    }

    for (const f of this.flags) {
      f.sprite.texture = this.assets.flagFrames[Math.floor(t * 3 + f.phase) % 2];
      f.sprite.rotation = Math.sin(t * 1.3 + f.phase) * 0.05;
    }
    for (const c of this.clouds) {
      c.position.x += dt * 9;
      if (c.position.x > 2300) c.position.x = -800;
    }
  }

  // Slow cloud shadows crossing the grass — the cheapest way to feel the sky
  private driftClouds() {
    const placements = [
      { x: 150, y: 60, scale: 3.2 },
      { x: 1400, y: 520, scale: 4.1 },
    ];
    for (const p of placements) {
      const cloud = new Sprite(this.assets.cloud);
      cloud.position.set(p.x, p.y);
      cloud.scale.set(p.scale, p.scale * SQUASH);
      this.ground.addChild(cloud);
      this.clouds.push(cloud);
    }
  }

  // Grandstand + boards behind the far touchline, dugouts on the near side,
  // waving corner flags — the pitch lives inside an arena now
  private buildArena(worldSorted: Container) {
    const M = pxPerMeter();
    const standBaseY = project(0, -2.1, 0).sy;
    const stand = new TilingSprite({
      texture: this.assets.stand,
      width: (PITCH.length + 22) * M,
      height: this.assets.manifest.stand.h,
    });
    stand.position.set(project(-11, 0, 0).sx, standBaseY - this.assets.manifest.stand.h);
    stand.zIndex = project(0, -2.1, 0).depth;
    worldSorted.addChild(stand);

    const boardsBaseY = project(0, -0.8, 0).sy;
    const boards = new TilingSprite({
      texture: this.assets.boards,
      width: (PITCH.length + 8) * M,
      height: this.assets.manifest.boards.h,
    });
    boards.position.set(project(-4, 0, 0).sx, boardsBaseY - this.assets.manifest.boards.h);
    boards.zIndex = project(0, -0.8, 0).depth;
    worldSorted.addChild(boards);

    for (const dx of [35, 62]) {
      const dugout = new Sprite(this.assets.dugout);
      const p = project(dx, PITCH.width + 1.6, 0);
      dugout.anchor.set(0.5, 1);
      dugout.position.set(p.sx, p.sy);
      dugout.zIndex = p.depth;
      worldSorted.addChild(dugout);
    }

    const corners: [number, number][] = [[0, 0], [PITCH.length, 0], [0, PITCH.width], [PITCH.length, PITCH.width]];
    corners.forEach(([cx, cy], i) => {
      const flag = new Sprite(this.assets.flagFrames[0]);
      const p = project(cx, cy, 0);
      flag.anchor.set(0.25, 1);
      flag.position.set(p.sx, p.sy);
      flag.zIndex = p.depth + 0.2;
      worldSorted.addChild(flag);
      this.flags.push({ sprite: flag, phase: i * 1.7 });
    });
  }

  // ~1200 blade clusters in three populations: subtle motion inside the lines,
  // a grown-in fringe hugging every boundary, wilder growth on the apron
  private plantGrass(worldSorted: Container) {
    const rng = new Rng(99);
    const plant = (x: number, y: number, scale: number, alpha = 1) => {
      const sprite = new Sprite(this.assets.tuftFrames[Math.floor(rng.next() * this.assets.tuftFrames.length)]);
      const p = project(x, y, 0);
      sprite.anchor.set(0.5, 1);
      sprite.position.set(p.sx, p.sy);
      sprite.zIndex = p.depth;
      sprite.scale.set(scale);
      sprite.alpha = alpha;
      worldSorted.addChild(sprite);
      this.blades.push({ sprite, wx: x, wy: y, phase: rng.range(0, 6.28), base: scale, disturb: 0, pushSign: 1 });
    };
    for (let i = 0; i < 420; i++) {
      plant(rng.range(0.5, PITCH.length - 0.5), rng.range(0.5, PITCH.width - 0.5), rng.range(0.55, 0.9), 0.8);
    }
    for (let x = -0.2; x < PITCH.length + 0.2; x += rng.range(0.4, 0.9)) {
      plant(x, rng.range(-0.3, 0.2), rng.range(0.8, 1.2));
      plant(x, PITCH.width + rng.range(-0.2, 0.3), rng.range(0.8, 1.2));
    }
    for (let y = -0.2; y < PITCH.width + 0.2; y += rng.range(0.4, 0.9)) {
      plant(rng.range(-0.3, 0.2), y, rng.range(0.8, 1.2));
      plant(PITCH.length + rng.range(-0.2, 0.3), y, rng.range(0.8, 1.2));
    }
    for (let i = 0; i < 260; i++) {
      const x = rng.range(-PITCH.apron + 1, PITCH.length + PITCH.apron - 1);
      const y = rng.next() < 0.5
        ? rng.range(-PITCH.apron + 1, -0.6)
        : rng.range(PITCH.width + 0.6, PITCH.width + PITCH.apron - 1);
      plant(x, y, rng.range(1.3, 2));
    }
  }

  // A real goal box: aluminium frame on the line, back frame raised a few px
  // (a faked second oblique axis so the camera "sees into" the box), and nets
  // strung strand by strand — redrawn live so they sway and swish
  private buildGoal(worldSorted: Container, side: 'left' | 'right') {
    const cx = side === 'left' ? 0 : PITCH.length;
    const sgn = side === 'left' ? -1 : 1;
    const yFar = PITCH.width / 2 - PITCH.goalWidth / 2;
    const yNear = PITCH.width / 2 + PITCH.goalWidth / 2;
    const H = PITCH.goalHeight;
    const LIFT = 7; // screen px the box back edge rises — sells the depth

    const frontX = project(cx, yFar, 0).sx;
    const backX = project(cx + sgn * PITCH.goalDepth, yFar, 0).sx;
    const farTopY = project(cx, yFar, H).sy;
    const farGroundY = project(cx, yFar, 0).sy;
    const nearTopY = project(cx, yNear, H).sy;
    const nearGroundY = project(cx, yNear, 0).sy;

    // Everything at far-post depth draws behind a ball inside the goal;
    // the near-side net and frame hang in front of it
    const farBundle = new Container();
    farBundle.zIndex = project(cx, yFar, 0).depth - 0.5;
    const nearBundle = new Container();
    nearBundle.zIndex = project(cx, yNear, 0).depth + 0.5;

    // The box interior falls into shadow before the net catches light
    const inner = new Graphics();
    inner.poly([frontX, farTopY, backX, farTopY - LIFT, backX, nearGroundY, frontX, nearGroundY])
      .fill({ color: 0x081209, alpha: 0.3 });
    farBundle.addChild(inner);

    const rig = this.goals[side];
    const panel = (tl: Pt, tr: Pt, bl: Pt, br: Pt, alpha: number, sag: number, warp: number, target: Container) => {
      const g = new Graphics();
      target.addChild(g);
      const p: NetPanel = { g, tl, tr, bl, br, alpha, sag, warp };
      rig.panels.push(p);
      this.drawPanel(p, 0);
    };
    panel([frontX, farTopY], [backX, farTopY - LIFT], [frontX, nearTopY], [backX, nearTopY - LIFT], 0.34, 1, 0.3, farBundle);
    panel([frontX, farTopY], [backX, farTopY - LIFT], [frontX, farGroundY], [backX, farGroundY], 0.55, 1.6, 1, farBundle);
    panel([frontX, nearTopY], [backX, nearTopY - LIFT], [frontX, nearGroundY], [backX, nearGroundY], 0.6, 1.6, 1, nearBundle);

    // Back frame: grey stanchion bar the net hangs from
    const backBar = new TilingSprite({ texture: this.assets.goalBar, width: 3, height: nearGroundY - (farTopY - LIFT) });
    backBar.position.set(backX - 1.5, farTopY - LIFT);
    backBar.tint = 0x9fa8b0;
    farBundle.addChild(backBar);

    // Roof edges running back from each post top — the lines that sell the box
    const farEdge = new Graphics();
    farEdge.moveTo(frontX, farTopY).lineTo(backX, farTopY - LIFT).stroke({ width: 1.5, color: 0xe4e7de, alpha: 0.9 });
    farBundle.addChild(farEdge);
    const nearEdge = new Graphics();
    nearEdge.moveTo(frontX, nearTopY).lineTo(backX, nearTopY - LIFT).stroke({ width: 1.5, color: 0xe4e7de, alpha: 0.9 });
    nearBundle.addChild(nearEdge);

    // Mouth frame seen edge-on: posts + crossbar form one aluminium bar,
    // with cap blocks marking the joints
    const mouthBar = new TilingSprite({ texture: this.assets.goalBar, width: 4, height: nearGroundY - farTopY + 1 });
    mouthBar.position.set(frontX - 2, farTopY);
    nearBundle.addChild(mouthBar);
    const caps = new Graphics();
    caps.rect(frontX - 2.5, farTopY - 1, 5, 3).fill(0xffffff);
    caps.rect(frontX - 2.5, nearTopY - 1, 5, 3).fill(0xffffff);
    caps.rect(frontX - 2.5, farGroundY - 1, 5, 2).fill(0xd9d9cf);
    caps.rect(frontX - 3, nearGroundY - 1, 6, 2).fill(0x30352f);
    nearBundle.addChild(caps);

    worldSorted.addChild(farBundle);
    worldSorted.addChild(nearBundle);
  }

  // Strands interpolated across a panel. Horizontal runs bow with sag like
  // knotted cord; `disp` bulges the whole panel mid-span — wind sway when
  // small, the full swish of a goal when the ball slams in
  private drawPanel(p: NetPanel, disp: number) {
    const g = p.g;
    g.clear();
    const lerp2 = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const cols = Math.max(2, Math.round(Math.hypot(p.tr[0] - p.tl[0], p.tr[1] - p.tl[1]) / 6));
    const rows = Math.max(2, Math.round(Math.hypot(p.bl[0] - p.tl[0], p.bl[1] - p.tl[1]) / 6));
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const a = lerp2(p.tl, p.tr, u);
      const b = lerp2(p.bl, p.br, u);
      const mid = lerp2(a, b, 0.5);
      g.moveTo(a[0], a[1]).quadraticCurveTo(mid[0] + disp * Math.sin(Math.PI * u), mid[1], b[0], b[1]);
    }
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const a = lerp2(p.tl, p.bl, t);
      const b = lerp2(p.tr, p.br, t);
      const mid = lerp2(a, b, 0.5);
      g.moveTo(a[0], a[1]).quadraticCurveTo(mid[0] + disp * 0.85, mid[1] + p.sag * (0.35 + 0.65 * t), b[0], b[1]);
    }
    g.stroke({ width: 1, color: 0xf2f3ee, alpha: p.alpha });
  }
}
