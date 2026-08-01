import { Container, Sprite, TilingSprite, Graphics } from 'pixi.js';
import { PITCH } from '../sim/constants';
import { GameAssets } from './assets';
import { project, squash } from './projection';

type Pt = [number, number];

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

// The stage: the baked turf plane, cloud shade, an arena, and box goals with
// nets that actually swish. Living grass lives in GrassField.
export class PitchLayer {
  ground = new Container(); // flat layer, always behind the sorted world
  groundFx = new Container(); // decals stamped by play: skids, scuffs
  private pitchSprite: Sprite;
  private clouds: Sprite[] = [];
  private stand!: TilingSprite;
  private crowdFrame = 0;
  private crowdT = 0;
  private crowdHype = 0; // seconds of goal-frenzy bouncing left
  private flashes = new Graphics(); // phone cameras popping in the terraces
  private flags: { sprite: Sprite; phase: number }[] = [];
  private goals: Record<'left' | 'right', GoalRig> = {
    left: { panels: [], backSign: -1, rippleAge: -1, phase: 0 },
    right: { panels: [], backSign: 1, rippleAge: -1, phase: 2.1 },
  };
  private time = 0;

  constructor(private assets: GameAssets, worldSorted: Container) {
    this.pitchSprite = new Sprite(assets.pitch['day']);
    // The iso squash is baked into the texture; its top-left corner is the
    // far apron corner in world space
    const corner = project(-PITCH.apron, -PITCH.apron, 0);
    this.pitchSprite.position.set(corner.sx, corner.sy);
    this.ground.addChild(this.pitchSprite);

    this.driftClouds();
    this.ground.addChild(this.groundFx); // decals above the turf, below everything alive
    this.buildArena(worldSorted);
    this.buildGoal(worldSorted, 'left');
    this.buildGoal(worldSorted, 'right');
  }

  setVariant(id: string) {
    this.pitchSprite.texture = this.assets.pitch[id];
    for (const c of this.clouds) c.visible = id !== 'night'; // no cloud shade under floodlights
  }

  // The ball just hit this net — set it swinging, and the crowd erupts for
  // the whole celebration window, camera flashes popping down the terraces
  rippleGoal(side: 'left' | 'right') {
    this.goals[side].rippleAge = 0;
    this.crowdHype = 4.6;
  }

  update(dt: number) {
    this.time += dt;
    const t = this.time;

    // The crowd is alive: a slow murmur bob at rest, a bouncing wall on goals
    this.crowdHype = Math.max(0, this.crowdHype - dt);
    this.crowdT += dt;
    const bobEvery = this.crowdHype > 0 ? 0.13 : 0.55;
    if (this.crowdT >= bobEvery) {
      this.crowdT = 0;
      this.crowdFrame = 1 - this.crowdFrame;
      this.stand.texture = this.assets.standFrames[this.crowdFrame];
    }
    // While the hype lasts, camera flashes twinkle at random down the stand
    this.flashes.clear();
    if (this.crowdHype > 0) {
      const density = Math.min(1, this.crowdHype / 3.5) * 12;
      for (let i = 0; i < density; i++) {
        if (Math.random() < 0.55) continue; // pops, not a strobe wall
        const fx = this.stand.position.x + Math.random() * this.stand.width;
        const fy = this.stand.position.y + 8 + Math.random() * (this.assets.manifest.stand.h - 24);
        this.flashes.rect(Math.round(fx), Math.round(fy), 2, 2).fill({ color: 0xffffff, alpha: 0.5 + Math.random() * 0.5 });
      }
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
      cloud.scale.set(p.scale, p.scale * squash());
      this.ground.addChild(cloud);
      this.clouds.push(cloud);
    }
  }

  // Grandstand + boards behind the far touchline, dugouts on the near side,
  // waving corner flags — the pitch lives inside an arena now. Strips take
  // their width from the projection at their own depth row.
  private buildArena(worldSorted: Container) {
    const standL = project(-11, -2.1, 0);
    const standR = project(PITCH.length + 11, -2.1, 0);
    this.stand = new TilingSprite({
      texture: this.assets.standFrames[0],
      width: standR.sx - standL.sx,
      height: this.assets.manifest.stand.h,
    });
    this.stand.position.set(standL.sx, standL.sy - this.assets.manifest.stand.h);
    this.stand.zIndex = standL.depth;
    worldSorted.addChild(this.stand);
    this.flashes.zIndex = standL.depth + 0.1;
    worldSorted.addChild(this.flashes);

    const boardsL = project(-4, -0.8, 0);
    const boardsR = project(PITCH.length + 4, -0.8, 0);
    const boards = new TilingSprite({
      texture: this.assets.boards,
      width: boardsR.sx - boardsL.sx,
      height: this.assets.manifest.boards.h,
    });
    boards.position.set(boardsL.sx, boardsL.sy - this.assets.manifest.boards.h);
    boards.zIndex = boardsL.depth;
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

  // A real goal box in perspective: two distinct posts, a crossbar that runs
  // slanted toward the vanishing point, a raised back frame, and nets strung
  // strand by strand — redrawn live so they sway and swish
  private buildGoal(worldSorted: Container, side: 'left' | 'right') {
    const cx = side === 'left' ? 0 : PITCH.length;
    const sgn = side === 'left' ? -1 : 1;
    const yFar = PITCH.width / 2 - PITCH.goalWidth / 2;
    const yNear = PITCH.width / 2 + PITCH.goalWidth / 2;
    const H = PITCH.goalHeight;
    const LIFT = 7; // extra screen px the box back edge rises — sells the depth
    const bx = cx + sgn * PITCH.goalDepth;

    const fFarT = project(cx, yFar, H);
    const fFarG = project(cx, yFar, 0);
    const fNearT = project(cx, yNear, H);
    const fNearG = project(cx, yNear, 0);
    const bFarT: Pt = [project(bx, yFar, H).sx, project(bx, yFar, H).sy - LIFT];
    const bFarG = project(bx, yFar, 0);
    const bNearT: Pt = [project(bx, yNear, H).sx, project(bx, yNear, H).sy - LIFT];
    const bNearG = project(bx, yNear, 0);

    // Everything at far-post depth draws behind a ball inside the goal;
    // the near-side net and frame hang in front of it
    const farBundle = new Container();
    farBundle.zIndex = fFarG.depth - 0.5;
    const nearBundle = new Container();
    nearBundle.zIndex = fNearG.depth + 0.5;

    // The box interior falls into shadow before the net catches light
    const inner = new Graphics();
    inner.poly([fFarT.sx, fFarT.sy, bFarT[0], bFarT[1], bNearG.sx, bNearG.sy, fNearG.sx, fNearG.sy])
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
    panel([fFarT.sx, fFarT.sy], bFarT, [fNearT.sx, fNearT.sy], bNearT, 0.34, 1, 0.3, farBundle);
    panel([fFarT.sx, fFarT.sy], bFarT, [fFarG.sx, fFarG.sy], [bFarG.sx, bFarG.sy], 0.55, 1.6, 1, farBundle);
    panel([fNearT.sx, fNearT.sy], bNearT, [fNearG.sx, fNearG.sy], [bNearG.sx, bNearG.sy], 0.6, 1.6, 1, nearBundle);

    // Back frame: grey stanchions at both back corners + the top slat
    const backFrame = new Graphics();
    backFrame.rect(bFarT[0] - 1, bFarT[1], 2, bFarG.sy - bFarT[1]).fill({ color: 0x9fa8b0, alpha: 0.95 });
    backFrame.rect(bNearT[0] - 1, bNearT[1], 2, bNearG.sy - bNearT[1]).fill({ color: 0x9fa8b0, alpha: 0.95 });
    backFrame.moveTo(bFarT[0], bFarT[1]).lineTo(bNearT[0], bNearT[1])
      .stroke({ width: 2, color: 0x9fa8b0, alpha: 0.9 });
    farBundle.addChild(backFrame);

    // Roof edges running back from each post top — the lines that sell the box
    const farEdge = new Graphics();
    farEdge.moveTo(fFarT.sx, fFarT.sy).lineTo(bFarT[0], bFarT[1]).stroke({ width: 1.5, color: 0xe4e7de, alpha: 0.9 });
    farBundle.addChild(farEdge);
    const nearEdge = new Graphics();
    nearEdge.moveTo(fNearT.sx, fNearT.sy).lineTo(bNearT[0], bNearT[1]).stroke({ width: 1.5, color: 0xe4e7de, alpha: 0.9 });
    nearBundle.addChild(nearEdge);

    // The frame proper: far post behind play, slanted crossbar + near post in
    // front — finally two posts and a bar, not one flat stripe
    const farPost = new TilingSprite({ texture: this.assets.goalBar, width: 3, height: fFarG.sy - fFarT.sy });
    farPost.position.set(fFarT.sx - 1.5, fFarT.sy);
    farPost.tint = 0xe8e8e2;
    farBundle.addChild(farPost);

    const crossbar = new Graphics();
    crossbar.moveTo(fFarT.sx, fFarT.sy).lineTo(fNearT.sx, fNearT.sy).stroke({ width: 3.5, color: 0xf7f7f2 });
    crossbar.moveTo(fFarT.sx, fFarT.sy + 1.5).lineTo(fNearT.sx, fNearT.sy + 1.5)
      .stroke({ width: 1, color: 0xb9bcb2, alpha: 0.8 });
    nearBundle.addChild(crossbar);

    const nearPost = new TilingSprite({ texture: this.assets.goalBar, width: 4, height: fNearG.sy - fNearT.sy });
    nearPost.position.set(fNearT.sx - 2, fNearT.sy);
    nearBundle.addChild(nearPost);

    const caps = new Graphics();
    caps.rect(fFarT.sx - 2, fFarT.sy - 1, 4, 3).fill(0xffffff);
    caps.rect(fNearT.sx - 2.5, fNearT.sy - 1, 5, 3).fill(0xffffff);
    caps.rect(fFarG.sx - 2, fFarG.sy - 1, 4, 2).fill(0xd9d9cf);
    caps.rect(fNearG.sx - 3, fNearG.sy - 1, 6, 2).fill(0x30352f);
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
