import { Vec2, vec, clamp, dist } from '../core/math';
import { Match } from '../match';
import { World } from '../sim/world';
import { PITCH } from '../sim/constants';
import { SimEvent } from '../sim/events';
import { MatchSnap } from '../net/net';
import { takeSnap, poseWorld } from '../net/snapshot';

// The tape is always rolling. It holds the last ten seconds of the very same
// snapshots the netcode puts on the wire — one serialization, one truth — so
// any goal can be played back without the sim ever knowing it happened.

const HZ = 20;           // twenty frames a second; the pose lerp hides the gaps
const SPAN = 10;         // seconds of tape — the longest buildup worth showing
const LOOKBACK = 7;      // where a cut opens: pass, pass, pass, then the strike
const MIN_BUILDUP = 1.2; // even a turnover finish gets a breath before the boot
const TAIL = 0.55;       // ...and enough past the line to watch the net take it

const at = (snap: MatchSnap) => snap.tick / 60;
const eventsOf = (snap: MatchSnap) => snap.events as SimEvent[];

export class ReplayRing {
  private frames: MatchSnap[] = [];
  private pending: SimEvent[] = []; // everything since the last frame rides the next one
  private tick = 0;
  private since = 0;

  get tape(): MatchSnap[] {
    return this.frames;
  }

  // Solo and host: the live world, sampled. Cheap enough to never switch off.
  record(match: Match, dt: number, events: SimEvent[]) {
    this.tick += Math.max(1, Math.round(dt * 60));
    if (events.length) this.pending.push(...events);
    this.since += dt;
    if (this.since < 1 / HZ) return;
    this.since = 0;
    this.keep(takeSnap(match, this.tick, {}, {}, this.pending));
    this.pending = [];
  }

  // A guest never simulates — the host's stream already IS his tape
  push(snap: MatchSnap) {
    this.keep(snap);
  }

  clear() {
    this.frames = [];
    this.pending = [];
    this.tick = 0;
    this.since = 0;
  }

  private keep(snap: MatchSnap) {
    this.frames.push(snap);
    const oldest = snap.tick - SPAN * 60;
    while (this.frames.length > 2 && this.frames[0].tick < oldest) this.frames.shift();
  }
}

// Everything the truck needs to tell the story: where it opens, the instant
// the boot went through it, where the ball crossed, and how far the strike
// travelled — the frame widens with that last number.
export interface ReplayCut {
  frames: MatchSnap[];
  from: number;   // tape seconds the cut opens on
  shot: number;   // ...the strike leaves the boot
  goal: number;   // ...the ball crosses the line
  until: number;  // ...and the tape runs out
  boot: Vec2;
  mouth: Vec2;
  range: number;
}

// Read the story backwards out of the tape: the goal, the boot that put it
// there, and the turnover the whole move was born from
export function buildCut(ring: ReplayRing, side: 'left' | 'right', teamOf: (idx: number) => 0 | 1 | undefined): ReplayCut | null {
  const f = ring.tape;
  if (f.length < 6) return null;

  let goalIdx = -1;
  for (let i = f.length - 1; i >= 0 && goalIdx < 0; i--) {
    if (eventsOf(f[i]).some((e) => e.kind === 'goal')) goalIdx = i;
  }
  if (goalIdx < 3) return null;

  // the strike: the last boot on the ball before it crossed — an own goal is
  // still somebody's strike, and it deserves the same slow motion
  let shotIdx = -1;
  let boot: Vec2 | null = null;
  let shooter = -1;
  for (let i = goalIdx; i >= 0 && shotIdx < 0; i--) {
    for (const e of eventsOf(f[i])) {
      if (e.kind === 'kick') { shotIdx = i; boot = vec(e.x, e.y); shooter = e.idx; }
    }
  }
  if (shotIdx < 1 || !boot) return null;
  const shooterTeam = teamOf(shooter);
  const shotT = at(f[shotIdx]);
  const goalT = at(f[goalIdx]);

  // ...and the possession it came from: back to the last touch the other
  // shirts had, never further than the seven seconds that hold an eye
  let openT = goalT - LOOKBACK;
  for (let i = shotIdx - 1; i >= 0; i--) {
    const theirs = eventsOf(f[i]).some((e) =>
      (e.kind === 'kick' && teamOf(e.idx) !== shooterTeam) || e.kind === 'save' || e.kind === 'parry');
    if (theirs) { openT = Math.max(openT, at(f[i])); break; }
  }

  const mouth = vec(side === 'left' ? 0 : PITCH.length, PITCH.width / 2);
  return {
    frames: f.slice(),
    from: clamp(Math.min(openT, shotT - MIN_BUILDUP), at(f[0]), shotT),
    shot: shotT,
    goal: goalT,
    until: Math.min(goalT + TAIL, at(f[f.length - 1])),
    boot,
    mouth,
    range: dist(boot, mouth),
  };
}

// Paint the tape's instant onto the world — the same pose a guest rides live,
// scrubbed by hand instead of streamed
export function poseCut(cut: ReplayCut, world: World, t: number) {
  const f = cut.frames;
  let i = 0;
  while (i < f.length - 2 && at(f[i + 1]) <= t) i++;
  const a = f[i];
  const b = f[Math.min(i + 1, f.length - 1)];
  const span = Math.max(1e-6, at(b) - at(a));
  poseWorld(world, a, b, clamp((t - at(a)) / span, 0, 1));
}

// Every boot and every post the tape caught between two instants — the replay
// gets to sound again, an octave down
export function cutEvents(cut: ReplayCut, from: number, to: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (const frame of cut.frames) {
    const t = at(frame);
    if (t > from && t <= to) out.push(...eventsOf(frame));
  }
  return out;
}
