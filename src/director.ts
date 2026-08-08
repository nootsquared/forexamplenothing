import { clamp, dist } from './core/math';
import { Match } from './match';
import { World } from './sim/world';
import { SimEvent } from './sim/events';
import { PITCH } from './sim/constants';

// THE TENSION DIRECTOR — one honest number for how big this moment is, plus the
// one place that notices the touches worth a word. Clock, scoreline, where the
// ball lives, how long a siege has lasted, what nearly happened. The crowd bed,
// the chants, the heartbeat, the music, the lens and the HUD all read these
// fields, so the whole stadium agrees on the size of a moment instead of six
// systems each guessing their own.

export type Cue =
  | 'shot'      // the ball is struck: the ground holds its breath
  | 'heart'     // one pulse, late and close
  | 'through' | 'clean' | 'chain' | 'giveaway' | 'beatman' | 'won';

export interface Beat {
  text: string;
  tone: 'gold' | 'mint';
  kick: number;   // how hard the hands should feel it, 0-1
  serial: number; // a beat is shown once, however long it lingers here
}

const HEAT_CAP = 1.4;      // even a mad two minutes only counts for so much
const HEAT_DECAY = 0.42;   // what nearly happened fades over a couple of seconds
const CALLOUT_GAP = 2.2;   // the stadium notices you; it never natters
const LUNGE_TRAVEL = 1.25; // ground a 0.24s burst covers, on top of the poke

// The window a space tackle actually wins: an opponent's ball, loose of him and
// low enough to poke, with your legs free to go. Returns how hot it is, 0 = shut.
export function tackleWindow(world: World, idx: number): number {
  const me = world.players[idx];
  const held = world.carrier;
  if (!me || !held || me.id.role === 'GK' || world.restartLock > 0) return 0;
  const carrier = world.players[held.idx];
  if (!carrier || carrier.id.team === me.id.team) return 0;
  if (!world.ballExposed() || world.ball.z > 0.8) return 0;
  if (me.tackleCooldown > 0 || me.lungeTimer > 0 || me.recoverTimer > 0) return 0;
  const reach = 0.8 + me.stats.defend * 0.45 + LUNGE_TRAVEL;
  const d = dist(me.pos, world.ball.pos);
  return d > reach ? 0 : 0.35 + 0.65 * (1 - d / reach);
}

// How far a body stood off the line of a pass — a shirt three lanes away was
// never in the way of it
function laneOffset(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / Math.max(1e-3, dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export class TensionDirector {
  level = 0;   // 0-1: the size of this moment, smoothed
  hush = 0;    // the held breath after a strike, 1 → 0
  heart = 0;   // the pulse envelope, late and close only
  punch = 0;   // a save worth pushing the lens in on
  chain = 0;   // completed passes in the human team's current run
  end: 1 | -1 = 1; // which goal is taking the pressure: +1 the far end, -1 the near
  beat: Beat = { text: '', tone: 'gold', kick: 0, serial: 0 };
  cues: Cue[] = [];

  private heat = 0;      // near-misses, saves, woodwork — the recent-danger pot
  private siegeT = 0;    // how long the ball has camped in a box
  private shotsSeen = 0;
  private heartPhase = 0;
  private calloutT = 0;
  private throughT = 0;
  private cleanT = 0;
  private beatManT = 0;
  // the pass ledger: who played it and from where, until a boot answers
  private pass: { team: 0 | 1; from: number; x: number; y: number; age: number } | null = null;

  // Between matches the stadium empties — the menu's attract game inherits a
  // director at rest, never the last final's nerves
  reset() {
    this.level = 0;
    this.hush = 0;
    this.heart = 0;
    this.punch = 0;
    this.chain = 0;
    this.heat = 0;
    this.siegeT = 0;
    this.heartPhase = 0;
    this.pass = null;
    this.cues.length = 0;
  }

  update(match: Match, heroIdx: number, events: SimEvent[], dt: number) {
    const world = match.world;
    const heroTeam = world.players[heroIdx]?.id.team ?? 0;
    this.cues.length = 0;
    this.calloutT = Math.max(0, this.calloutT - dt);
    this.throughT = Math.max(0, this.throughT - dt);
    this.cleanT = Math.max(0, this.cleanT - dt);
    this.beatManT = Math.max(0, this.beatManT - dt);

    // The ledger already decided what counted as a shot — we just read it
    const shots = match.stats.shots[0] + match.stats.shots[1];
    const struck = shots > this.shotsSeen;
    this.shotsSeen = shots;
    if (struck) {
      this.hush = 1;
      this.stoke(0.5);
      this.cues.push('shot');
    }

    this.readEvents(world, events, heroIdx, heroTeam, struck);
    this.watchPass(world, events, dt, heroIdx, heroTeam, struck);

    this.heat = Math.max(0, this.heat - dt * HEAT_DECAY);
    this.hush = Math.max(0, this.hush - dt * 1.7);
    this.punch = Math.max(0, this.punch - dt * 2.2);

    // Danger: how near the ball is to a mouth, weighted by how many attackers
    // have actually arrived — a goal kick sits on the line and threatens nobody
    const ball = world.ball.pos;
    const goalX = ball.x < PITCH.length / 2 ? 0 : PITCH.length;
    const atkTeam: 0 | 1 = world.goalXOf(0) === goalX ? 0 : 1;
    this.end = goalX > 0 ? 1 : -1;
    let inBox = 0;
    for (const p of world.players) {
      if (p.id.team === atkTeam && Math.hypot(p.pos.x - goalX, p.pos.y - PITCH.width / 2) < 22) inBox++;
    }
    const near = 1 - clamp(Math.hypot(ball.x - goalX, ball.y - PITCH.width / 2) / 40, 0, 1);
    const danger = Math.pow(near, 1.3) * (0.45 + 0.55 * clamp(inBox / 4, 0, 1));
    this.siegeT = danger > 0.45 ? Math.min(12, this.siegeT + dt) : Math.max(0, this.siegeT - dt * 2);

    // Late and close is the whole game: a two-goal cushion in the first half is
    // a kickabout, a level scoreline in the last minute is a different sport
    const clockT = match.halfLength > 0 ? clamp(match.clock / match.halfLength, 0, 1) : 0;
    const late = match.half === 2 ? clockT * clockT : clockT * 0.2;
    const gap = Math.abs(world.score.left - world.score.right);
    const close = gap === 0 ? 1 : gap === 1 ? 0.75 : gap === 2 ? 0.3 : 0.08;
    const pressure = late * close;
    const target = clamp(0.1 + 0.3 * danger + 0.12 * clamp(this.siegeT / 10, 0, 1) + 0.3 * this.heat + 0.44 * pressure, 0, 1);
    this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 1.5 : 0.5));

    this.beatHeart(pressure, dt);
  }

  // The pulse only exists when the match has earned it, and it quickens with it
  private beatHeart(pressure: number, dt: number) {
    if (this.level < 0.72 || pressure < 0.4) {
      this.heart = Math.max(0, this.heart - dt * 3);
      this.heartPhase = 0;
      return;
    }
    this.heartPhase += (dt * (52 + this.level * 34)) / 60;
    if (this.heartPhase >= 1) {
      this.heartPhase -= 1;
      this.cues.push('heart');
    }
    const lub = Math.max(0, 1 - this.heartPhase / 0.16);
    const dub = Math.max(0, 1 - Math.abs(this.heartPhase - 0.28) / 0.14) * 0.6;
    this.heart = Math.max(lub, dub);
  }

  private readEvents(world: World, events: SimEvent[], heroIdx: number, heroTeam: 0 | 1, struck: boolean) {
    for (const e of events) {
      switch (e.kind) {
        case 'post':
          this.stoke(0.85);
          this.punch = Math.max(this.punch, 0.55);
          break;
        case 'save':
        case 'parry':
          this.stoke(0.6);
          // a fingertip on a live strike is worth the lens; a routine catch isn't
          if (this.hush > 0.15 || struck) this.punch = Math.max(this.punch, 0.9);
          break;
        case 'foul':
          this.stoke(0.35);
          break;
        case 'offside':
          this.stoke(0.3);
          break;
        case 'feint': {
          const beaten = world.carrier;
          if (!beaten || world.players[beaten.idx].id.team !== heroTeam || this.beatManT > 0) break;
          this.beatManT = 4;
          this.cues.push('beatman');
          if (beaten.idx === heroIdx) this.callout('BEAT HIM', 'mint', 0.3);
          break;
        }
        case 'steal': {
          const won = world.lastTouch;
          this.stoke(0.2);
          this.chain = 0; // a duel ends any run, whoever came out of it with the ball
          if (!won || won.team !== heroTeam) break;
          this.cues.push('won');
          if (won.idx === heroIdx) this.callout('BALL WON', 'mint', 0.5);
          break;
        }
        case 'goal':
          this.heat = HEAT_CAP;
          this.hush = 0;
          this.chain = 0;
          this.pass = null;
          break;
      }
    }
  }

  // Every pass is watched to its answer: who took it, how many shirts it went
  // through, and whether the man had a defender breathing on him when it landed
  private watchPass(world: World, events: SimEvent[], dt: number, heroIdx: number, heroTeam: 0 | 1, struck: boolean) {
    for (const e of events) {
      if (e.kind !== 'kick') continue;
      const team = world.players[e.idx]?.id.team;
      this.pass = struck || team === undefined ? null : { team, from: e.idx, x: e.x, y: e.y, age: 0 };
    }
    const held = this.pass;
    if (!held) return;
    held.age += dt;
    const touch = world.lastTouch;
    if (!touch || touch.idx === held.from) {
      if (held.age > 4 || world.restartLock > 0) this.pass = null;
      return;
    }
    this.pass = null;
    const receiver = world.players[touch.idx];
    if (!receiver) return;
    const mine = held.team === heroTeam;
    if (touch.team !== held.team) {
      this.chain = 0;
      if (mine) this.cues.push('giveaway');
      else {
        this.cues.push('won');
        if (touch.idx === heroIdx) this.callout('INTERCEPTED', 'mint', 0.5);
      }
      return;
    }
    // The run is OURS to keep: their passes are not links in your chain
    if (!mine) {
      this.chain = 0;
      return;
    }

    // How much ground it won, how many shirts stood in its lane, and how tight
    // the man was when it arrived — the three facts that make a pass worth a word
    const sign = world.attackSign(held.team);
    const axis = (x: number) => (sign > 0 ? x : PITCH.length - x);
    const from = axis(held.x);
    const to = axis(receiver.pos.x);
    let broke = 0;
    let press = Infinity;
    for (const p of world.players) {
      if (p.id.team === held.team) continue;
      press = Math.min(press, dist(p.pos, receiver.pos));
      if (p.id.role === 'GK') continue;
      const a = axis(p.pos.x);
      if (a > from + 0.5 && a < to - 0.5 && laneOffset(p.pos.x, p.pos.y, held.x, held.y, receiver.pos.x, receiver.pos.y) < 9) broke++;
    }
    this.chain++;
    if (this.chain >= 3) this.cues.push('chain');
    if (broke >= 2 && to - from > 7 && this.throughT <= 0) {
      this.throughT = 5;
      this.cues.push('through');
      this.callout('THROUGH BALL', 'gold', 0.55);
    } else if (press < 3.2 && to - from > 2 && this.cleanT <= 0) {
      this.cleanT = 7;
      this.cues.push('clean');
      this.callout('CLEAN TAKE', 'mint', 0.3);
    }
  }

  // The recent-danger pot, capped: a mad spell raises the roof, never lifts it off
  private stoke(amount: number) {
    this.heat = Math.min(HEAT_CAP, this.heat + amount);
  }

  private callout(text: string, tone: 'gold' | 'mint', kick: number) {
    if (this.calloutT > 0) return;
    this.calloutT = CALLOUT_GAP;
    this.beat = { text, tone, kick, serial: this.beat.serial + 1 };
  }
}

export const director = new TensionDirector();
