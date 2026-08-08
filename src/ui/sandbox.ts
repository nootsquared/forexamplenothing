import { Container, Graphics } from 'pixi.js';
import { Vec2, vec, dist, clamp } from '../core/math';
import { Rng } from '../core/rng';
import { GRAVITY, PITCH } from '../sim/constants';
import { World } from '../sim/world';
import { GameAssets } from '../render/assets';
import { PixelText } from '../render/pixelText';
import { audio } from '../audio/engine';
import { GOLD, GOLD_LIT, MINT, cornerMarks } from './kit';

// The training ground's rail: number keys that take whole groups of players
// off the field and put them back, float a fresh ball to your feet, and
// re-stage the whole thing. Nobody ever pops in or out — every arrival and
// every exit is pixel dust, feet first.

export type SandboxRow = 'teammates' | 'opponents' | 'keepers' | 'ball' | 'field' | 'panel';

// Everything the rail needs from the shell, all of it lying around the match
// already. Five functions and the world; nothing here reaches back into UI.
export interface SandboxHooks {
  world: World;
  toScreen(x: number, y: number, z: number): Vec2; // scene.worldToScreen
  fade(idx: number, alpha: number): void;          // playerViews[idx].root.alpha
  hidden(idx: number, on: boolean): void;          // scene.setPlayerHidden
  heldIdx(): number;                               // cursor.idx — this one man never leaves
}

interface Row { row: SandboxRow; cap: string; label: string; toggle: boolean }

const ROWS: Row[] = [
  { row: 'teammates', cap: '1', label: 'TEAMMATES', toggle: true },
  { row: 'opponents', cap: '2', label: 'OPPONENTS', toggle: true },
  { row: 'keepers', cap: '3', label: 'KEEPERS', toggle: true },
  { row: 'ball', cap: '4', label: 'NEW BALL', toggle: false },
  { row: 'field', cap: '5', label: 'RESET FIELD', toggle: false },
  { row: 'panel', cap: '6', label: 'HIDE', toggle: false },
];

const DISSOLVE = 0.44;    // seconds a body spends becoming dust, or coming back out of it
const WAVE = 0.05;        // ...and the beat between men, so a group goes as a ripple
const WAVE_SPAN = 0.55;   // the whole ripple, capped — twenty-two men still snap smartly
const BODY_H = 1.8;       // how tall the ash column climbs
const BENCH_OUT = 0.4;    // the sim's own body clamp: this is as far out as anyone can stand
const ASH = [0xdfe4ee, 0x8a91a0, 0x5a6070];
const SHIRT = [0xff9c8a, 0x9cc4f0]; // the dust remembers which side it wore

// The rail's grid: one keycap column, then the words, then what they are doing
const CAP_X = 11;
const CAP_W = 22;
const ROW_H = 27;
const HEAD_H = 42;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// The shell's pixel step-in: alpha only ever lands on quarters, never between
const ladder = (v: number) => Math.ceil(clamp01(v) * 4) / 4;
// A group goes man by man; a big group just goes faster, never slower
const waveBeat = (count: number) => Math.min(WAVE, WAVE_SPAN / Math.max(1, count));

// One square of a person, mid-air. Entry ash flies a solved line and lands on
// him exactly; exit ash is buoyant and drags to a stop.
interface Ash {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  buoy: number; drag: number;
  age: number; life: number;
  color: number; size: number;
}

// A body on its way out of the world or back into it
interface Melt {
  idx: number;
  dir: 1 | -1;      // 1 assembles, -1 crumbles
  u: number;        // 0..1 through the ramp
  delay: number;
  step: number;     // the quarter of himself last painted — a new one puffs
  bench: boolean;   // does the exit end on the bench, or is he only blinking?
  home: Vec2 | null; // where he re-forms; null means he is already standing there
}

interface RowView {
  band: Graphics;
  cap: Container;
  label: PixelText;
  value: PixelText;
  flash: number;
}

export class SandboxPanel {
  root = new Container();
  // The shell's ear: a modifier moved. `on` is meaningless for the actions.
  onChange: (row: SandboxRow, on: boolean) => void = () => {};

  private dust = new Graphics();
  private full = new Container();
  private stub = new Container();
  private plate = new Graphics();
  private stubPlate = new Graphics();
  private views: RowView[] = [];
  private title: PixelText;
  private state: Record<'teammates' | 'opponents' | 'keepers', boolean> =
    { teammates: true, opponents: true, keepers: true };
  private bench = new Map<number, Vec2>();
  private melts: Melt[] = [];
  private ash: Ash[] = [];
  private rng = new Rng(2211);
  private open = true;
  private openT = 1;      // seconds since the panel last changed its mind
  private resetT = -1;    // counts down to the moment the field re-stages under the dust
  private panelW = 0;
  private panelH = 0;
  private stubW = 0;
  private dead = false;

  constructor(private assets: GameAssets, private hooks: SandboxHooks) {
    this.title = new PixelText(assets, 2, GOLD);
    this.title.text = 'MODIFIERS';
    this.build();
    this.stub.visible = false; // the rail opens the session up, not folded away
    this.root.addChild(this.dust, this.full, this.stub);
    this.refresh();
  }

  // The session opens with the sparring side already dust — the field is
  // yours until you ask for company, and nobody watched them leave
  begin() {
    this.state.opponents = false;
    for (const idx of this.membersOf('opponents')) this.park(idx);
    this.refresh();
  }

  // True when the rail swallowed the press. Closed, it only answers for the
  // key that brings it back — the pitch variants get their numbers again.
  key(code: string): boolean {
    const i = ROWS.findIndex((r) => `Digit${r.cap}` === code);
    if (i < 0) return false;
    if (!this.open && ROWS[i].row !== 'panel') return false;
    this.press(i);
    return true;
  }

  // Wire into cursor.claimed: control never lands on a man who isn't here
  benched(idx: number): boolean {
    return this.bench.has(idx);
  }

  // Bottom-left, clear of the ping line and of every eye in the game: the
  // ball lives at the middle of the screen and the HUD owns the top rail
  layout(_w: number, h: number) {
    const y = Math.max(this.panelH + 10, Math.round(h - 46));
    this.full.position.set(18, y - this.panelH);
    this.stub.position.set(18, y - 30);
  }

  // Called once a frame AFTER the scene renders, so the dust is projected
  // through the lens the player is actually looking through
  update(dt: number) {
    if (this.dead) return;
    this.openT += dt;
    this.stageReset(dt);
    for (let i = this.melts.length - 1; i >= 0; i--) {
      if (this.stepMelt(this.melts[i], dt)) this.melts.splice(i, 1);
    }
    this.holdBench();
    this.stepAsh(dt);
    this.draw(dt);
  }

  destroy() {
    this.dead = true;
    this.root.destroy({ children: true });
  }

  // ------------------------------------------------------------- the presses

  private press(i: number) {
    const row = ROWS[i];
    // nothing lands while the whole field is dust, and the field only re-stages
    // once every last mote has settled
    if (this.resetT >= 0 || (row.row === 'field' && this.melts.length > 0)) return audio.ui('denied', 0.5);
    this.views[i].flash = 1;
    if (row.toggle) {
      const group = row.row as 'teammates' | 'opponents' | 'keepers';
      const on = !this.state[group];
      this.state[group] = on;
      audio.ui(on ? 'select' : 'back', 0.6);
      this.melt(on ? this.revive(row.row) : this.membersOf(group), on ? 1 : -1, true);
      this.refresh();
      return this.onChange(row.row, on);
    }
    if (row.row === 'ball') {
      audio.ui('card', 0.55);
      this.newBall();
    } else if (row.row === 'field') {
      audio.ui('buy', 0.5);
      this.resetField();
    } else {
      this.open = !this.open;
      this.openT = 0;
      audio.ui(this.open ? 'card' : 'back', 0.45);
    }
    this.onChange(row.row, row.row === 'panel' ? this.open : true);
  }

  // The coach floats one in: the ball never jumps, it LEAVES where it lies
  // and lands at your feet like a pass you didn't have to ask for
  private newBall() {
    const w = this.hooks.world;
    const me = w.players[this.hooks.heldIdx()];
    if (!me) return;
    w.abortGoalReset();
    w.holdingGk = -1;
    w.holdLock = false;
    w.restartLock = 0;
    w.restartExclusion = 0;
    const b = w.ball;
    const to = vec(me.pos.x + me.facing.x * 1.4, me.pos.y + me.facing.y * 1.4);
    const flight = clamp(dist(b.pos, to) / 24, 0.45, 1.5);
    b.vel = vec((to.x - b.pos.x) / flight, (to.y - b.pos.y) / flight);
    b.vz = (GRAVITY * flight) / 2 - b.z / flight; // solved to touch down exactly on his boot
    b.spin = 0;
  }

  // Everything back where it started, under cover of dust: every man still on
  // the field crumbles, the world re-stages while nobody can see it, and they
  // all reassemble on their kickoff marks. The bench sleeps through it.
  private resetField() {
    const live = this.onField();
    this.melt(live, -1);
    this.resetT = DISSOLVE + waveBeat(live.length) * live.length + 0.1;
  }

  private onField(): number[] {
    return this.hooks.world.players.reduce<number[]>((list, _, i) => {
      if (!this.bench.has(i)) list.push(i);
      return list;
    }, []);
  }

  private stageReset(dt: number) {
    if (this.resetT < 0) return;
    this.resetT -= dt;
    if (this.resetT >= 0) return;
    this.resetT = -1;
    const w = this.hooks.world;
    w.abortGoalReset();
    w.kickoffReset();
    this.melt(this.onField(), 1);
  }

  // --------------------------------------------------------------- the dust

  // Who a group is right now. The man you are wearing is never in it — the
  // rail empties the field around you, it never leaves you controlling air.
  private membersOf(group: 'teammates' | 'opponents' | 'keepers'): number[] {
    const held = this.hooks.heldIdx();
    return this.hooks.world.players.reduce<number[]>((list, p, i) => {
      const keeper = p.id.role === 'GK';
      const mine = p.id.team === 0;
      const match = group === 'keepers' ? keeper : !keeper && (group === 'teammates' ? mine : !mine);
      if (match && i !== held && !this.bench.has(i)) list.push(i);
      return list;
    }, []);
  }

  // Which switch owns a body — the same answer whichever end you ask from
  private rowOf(idx: number): SandboxRow {
    const p = this.hooks.world.players[idx];
    return p.id.role === 'GK' ? 'keepers' : p.id.team === 0 ? 'teammates' : 'opponents';
  }

  // Everyone this row put away: the bench, plus anyone still on his way to it —
  // change your mind halfway and he re-forms out of his own falling dust
  private revive(row: SandboxRow): number[] {
    const back = this.melts
      .filter((m) => m.dir === -1 && m.bench && this.rowOf(m.idx) === row)
      .map((m) => m.idx);
    for (const idx of this.bench.keys()) if (this.rowOf(idx) === row) back.push(idx);
    for (const idx of back) this.bench.delete(idx);
    return back;
  }

  private melt(idxs: number[], dir: 1 | -1, bench = false) {
    const beat = waveBeat(idxs.length);
    idxs.forEach((idx, n) => {
      const running = this.melts.findIndex((m) => m.idx === idx);
      const carried = running >= 0 ? 1 - this.melts[running].u : 0; // a turnaround resumes, never restarts
      if (running >= 0) this.melts.splice(running, 1);
      const p = this.hooks.world.players[idx];
      // Only a man nobody can see may be moved to his mark. Carried progress
      // means he is still half-drawn out there, so he re-forms where he stands.
      this.melts.push({
        idx, dir, u: carried, delay: n * beat, step: -1, bench,
        home: dir === 1 && bench && carried === 0 ? vec(p.home.x, p.home.y) : null,
      });
    });
  }

  // One body's ramp. Returns true when it is finished with the world.
  private stepMelt(m: Melt, dt: number): boolean {
    if (m.delay > 0) {
      m.delay -= dt;
      return false;
    }
    if (m.step < 0) {
      if (m.dir === 1) {
        const p = this.hooks.world.players[m.idx];
        if (m.home) { p.pos = vec(m.home.x, m.home.y); p.vel = vec(); p.savePrev(); }
        this.hooks.fade(m.idx, 0);
        this.hooks.hidden(m.idx, false);
      }
      audio.ui('tick', 0.16); // the crackle, once per man — a group reads as a rattle
    }
    m.u = Math.min(1, m.u + dt / DISSOLVE);
    const solid = m.dir === 1 ? m.u : 1 - m.u;
    const step = Math.round(solid * 4);
    this.hooks.fade(m.idx, step / 4);
    if (step !== m.step) {
      m.step = step;
      this.puff(m, step);
    }
    if (m.u < 1) return false;
    if (m.dir === -1) {
      this.hooks.hidden(m.idx, true);
      if (m.bench) this.park(m.idx);
    }
    return true;
  }

  // A quarter of a man leaving or arriving: ash spat off the erosion line,
  // which climbs from the boots to the head either way round
  private puff(m: Melt, step: number) {
    const p = this.hooks.world.players[m.idx];
    const at = m.dir === 1 && m.home ? m.home : p.pos;
    const z0 = (m.dir === -1 ? 1 - step / 4 : step / 4) * BODY_H;
    for (let i = 0; i < 9; i++) {
      const roll = this.rng.next();
      const color = roll < 0.62 ? ASH[Math.floor(this.rng.next() * ASH.length)]
        : roll < 0.9 ? SHIRT[p.id.team]
        : GOLD;
      const size = this.rng.next() < 0.68 ? 2 : 3;
      const life = this.rng.range(0.6, 1.05);
      const x = at.x + this.rng.range(-0.34, 0.34);
      const y = at.y + this.rng.range(-0.26, 0.26);
      const z = Math.max(0.05, z0 + this.rng.range(-0.18, 0.3));
      if (m.dir === 1) {
        // he pulls his own dust back in: spawn it out in the air and solve the
        // line so every mote lands on him at the exact tick he goes solid
        const fx = x + this.rng.range(-1.6, 1.6);
        const fy = y + this.rng.range(-1.3, 1.3);
        const fz = z + this.rng.range(1.4, 2.7);
        this.ash.push({
          x: fx, y: fy, z: fz,
          vx: (x - fx) / life, vy: (y - fy) / life, vz: (z - fz) / life,
          buoy: 0, drag: 0, age: 0, life, color, size,
        });
      } else {
        this.ash.push({
          x, y, z,
          vx: p.vel.x * 0.2 + this.rng.range(-1.3, 1.3),
          vy: p.vel.y * 0.2 + this.rng.range(-1, 1),
          vz: this.rng.range(0.8, 2.4),
          buoy: 1.1, drag: 1.25, age: 0, life, color, size,
        });
      }
    }
  }

  private stepAsh(dt: number) {
    for (let i = this.ash.length - 1; i >= 0; i--) {
      const a = this.ash[i];
      a.age += dt;
      if (a.age >= a.life) {
        this.ash.splice(i, 1);
        continue;
      }
      a.vz += a.buoy * dt;
      const keep = Math.max(0, 1 - a.drag * dt);
      a.vx *= keep;
      a.vy *= keep;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.z += a.vz * dt;
    }
  }

  // ------------------------------------------------------------- the bench

  // Out of the way and out of play: the sim clamps every body to a whisker
  // outside the touchline, so the bench sits ON that whisker — past the line
  // where a live ball is already dead. Home side one flank, visitors the other.
  private park(idx: number) {
    const w = this.hooks.world;
    const p = w.players[idx];
    let seat = 0;
    for (let i = 0; i < idx; i++) if (w.players[i].id.team === p.id.team) seat++;
    const at = vec(12 + seat * 8, p.id.team === 0 ? PITCH.width + BENCH_OUT : -BENCH_OUT);
    this.bench.set(idx, at);
    this.hooks.hidden(idx, true);
    this.pin(idx, at);
  }

  // A benched body is still in the sim every tick: hold him on his mark and
  // keep his feet off the ball for as long as he sits there
  private pin(idx: number, at: Vec2) {
    const p = this.hooks.world.players[idx];
    p.pos = vec(at.x, at.y);
    p.vel = vec();
    p.playLock = 1;
    p.touchCooldown = 1;
    p.pendingKick = null;
    p.savePrev();
  }

  private holdBench() {
    const w = this.hooks.world;
    for (const [idx, at] of this.bench) {
      const p = w.players[idx];
      // The referee can still call a benched man's number for a dead ball —
      // he is off his mark and standing over it. Nobody walks out of the dust
      // to take it: the ball just goes live where it lies, which is what
      // "every restart is yours" meant on this field all along.
      if (dist(p.pos, at) > 0.9 && dist(p.pos, w.ball.pos) < 2) {
        if (w.holdingGk === idx) { w.holdingGk = -1; w.holdLock = false; }
        w.restartLock = 0;
        w.restartExclusion = 0;
      }
      this.pin(idx, at);
    }
  }

  // --------------------------------------------------------------- the rail

  private build() {
    const labelX = CAP_X + CAP_W + 12;
    let labelW = 0;
    ROWS.forEach((r) => {
      const probe = new PixelText(this.assets, 2);
      probe.text = r.label;
      labelW = Math.max(labelW, probe.textWidth);
      probe.destroy();
    });
    const valueX = labelX + labelW + 20;
    this.panelW = Math.max(216, valueX + 42);
    this.panelH = HEAD_H + ROWS.length * ROW_H + 10;
    this.title.position.set(CAP_X + 2, 12);
    this.full.addChild(this.plate, this.title);
    ROWS.forEach((r, i) => {
      const y = HEAD_H + i * ROW_H;
      const band = new Graphics();
      const cap = this.keycap(r.cap, CAP_X, y - 3);
      const label = new PixelText(this.assets, 2);
      label.text = r.label;
      label.position.set(labelX, y);
      const value = new PixelText(this.assets, 2);
      value.text = r.toggle ? 'ON' : '>';
      value.position.set(valueX, y);
      this.full.addChild(band, cap, label, value);
      this.views.push({ band, cap, label, value, flash: 0 });
    });
    this.dressPlate(this.plate, this.panelW, this.panelH);
    this.plate.rect(CAP_X, HEAD_H - 12, this.panelW - CAP_X * 2, 1).fill({ color: GOLD, alpha: 0.3 });
    // the way back, and the only thing left on screen once the rail is down:
    // one keycap and the word it opens
    const word = new PixelText(this.assets, 2, 0x8f97a8);
    word.text = 'MODIFIERS';
    word.position.set(CAP_X + CAP_W + 12, 9);
    this.stubW = CAP_X + CAP_W + 12 + word.textWidth + 14;
    this.stub.addChild(this.stubPlate, this.keycap('6', CAP_X, 6), word);
    this.dressPlate(this.stubPlate, this.stubW, 32);
  }

  private dressPlate(g: Graphics, w: number, h: number) {
    g.clear();
    g.rect(0, 0, w, h).fill({ color: 0x0d1119, alpha: 0.9 });
    g.rect(0, 0, w, 2).fill({ color: GOLD, alpha: 0.5 });
    g.rect(0, h - 2, w, 2).fill({ color: 0x000000, alpha: 0.5 });
    cornerMarks(g, 0, 0, w, h, MINT, 0.5);
  }

  // A dark cap with a light numeral — the same key the coach's cards wear
  private keycap(label: string, x: number, y: number): Container {
    const c = new Container();
    const t = new PixelText(this.assets, 2, 0xe8ecf4);
    t.text = label;
    const w = CAP_W;
    const g = new Graphics();
    g.rect(0, -3, w, 22).fill({ color: 0x05070b, alpha: 0.95 });
    g.rect(1, -2, w - 2, 20).fill({ color: 0x232b3d, alpha: 1 });
    g.rect(1, -2, w - 2, 2).fill({ color: 0xfff8e0, alpha: 0.25 });
    g.rect(1, 16, w - 2, 2).fill({ color: 0x000000, alpha: 0.55 });
    c.addChild(g, t);
    t.position.set(Math.round((w - t.textWidth) / 2), 1);
    c.position.set(x, y);
    return c;
  }

  // What every row says right now. A setting keeps its label quiet and lets
  // the value speak; an action IS its label, so the word carries the light.
  private refresh() {
    ROWS.forEach((r, i) => {
      const v = this.views[i];
      if (!r.toggle) {
        v.label.tint = 0xe8ecf4;
        v.value.tint = 0x5a6070;
        return;
      }
      const on = this.state[r.row as 'teammates' | 'opponents' | 'keepers'];
      v.label.tint = 0x8f97a8;
      v.value.text = on ? 'ON' : 'OFF';
      v.value.tint = on ? MINT : 0x5a6070;
    });
  }

  private draw(dt: number) {
    const t = this.openT;
    const last = ROWS.length - 1;
    const plateAlpha = this.open ? ladder(t / 0.1) : 1 - ladder((t - 0.14) / 0.12);
    this.full.visible = plateAlpha > 0;
    this.plate.alpha = plateAlpha;
    this.title.alpha = plateAlpha;
    this.views.forEach((v, i) => {
      // rows step in top-down and step out bottom-up: the rail rolls, never blinks
      const local = this.open
        ? clamp01((t - i * 0.045) / 0.14)
        : 1 - clamp01((t - (last - i) * 0.03) / 0.1);
      const step = ladder(local);
      const y = HEAD_H + i * ROW_H + (step < 1 ? Math.round((1 - step) * 3) : 0);
      v.label.alpha = step;
      v.value.alpha = step;
      v.cap.alpha = step;
      v.label.position.y = y;
      v.value.position.y = y;
      v.cap.position.y = y - 3;
      v.flash = Math.max(0, v.flash - dt * 3.6);
      v.band.clear();
      if (v.flash > 0) v.band.rect(4, y - 4, this.panelW - 8, 22).fill({ color: GOLD, alpha: 0.22 * v.flash });
      if (!ROWS[i].toggle) v.value.tint = v.flash > 0 ? GOLD_LIT : 0x5a6070;
    });
    const stubAlpha = this.open ? 1 - ladder(t / 0.1) : ladder((t - 0.12) / 0.12);
    this.stub.visible = stubAlpha > 0;
    this.stub.alpha = stubAlpha;
    // the ash rides world space and is projected fresh every frame, so it
    // holds its place on the turf however the lens moves under it
    this.dust.clear();
    for (const a of this.ash) {
      const s = this.hooks.toScreen(a.x, a.y, a.z);
      this.dust.rect(Math.round(s.x), Math.round(s.y), a.size, a.size)
        .fill({ color: a.color, alpha: ladder(1 - a.age / a.life) * 0.92 });
    }
  }
}
