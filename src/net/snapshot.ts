import { Match } from '../match';
import { World } from '../sim/world';
import { SimEvent } from '../sim/events';
import { MatchSnap } from './net';

// Truth on the wire: the host's world flattened to numbers ~30 times a
// second, and a guest's world rebuilt from them. Guests never simulate —
// they watch the same match through their own camera.

const q = (v: number) => Math.round(v * 100) / 100;

export function takeSnap(match: Match, tick: number, cursors: Record<number, number>, events: SimEvent[]): MatchSnap {
  const w = match.world;
  return {
    tick,
    ball: [q(w.ball.pos.x), q(w.ball.pos.y), q(w.ball.z), q(w.ball.vel.x), q(w.ball.vel.y), q(w.ball.vz)],
    players: w.players.map((p) => [
      q(p.pos.x), q(p.pos.y), q(p.vel.x), q(p.vel.y),
      q(p.facing.x), q(p.facing.y),
      p.lungeTimer > 0 ? 1 : 0,
      p.isCharging ? 1 : 0,
    ]),
    score: [w.score.left, w.score.right],
    clock: q(match.clock),
    half: match.half,
    restartLock: q(w.restartLock),
    celebration: !!w.celebration,
    cursors,
    events,
    sidesSwapped: w.sidesSwapped,
  };
}

// A guest holds the last two snapshots and glides between them at 60Hz —
// the renderer's own frame interpolation smooths whatever is left.
export class SnapPlayer {
  private prev: MatchSnap | null = null;
  private next: MatchSnap | null = null;
  private t = 0; // seconds since `next` arrived
  pendingEvents: SimEvent[] = [];
  latest: MatchSnap | null = null;

  push(snap: MatchSnap) {
    this.prev = this.next;
    this.next = snap;
    this.latest = snap;
    this.t = 0;
    this.pendingEvents.push(...(snap.events as SimEvent[]));
  }

  // Advance the guest's world one render tick toward the freshest truth
  apply(world: World, dt: number) {
    if (!this.next) return;
    this.t += dt;
    const a = this.prev;
    const b = this.next;
    // two snaps ≈ 1/30s apart; glide across that gap, then hold
    const k = a ? Math.min(1, this.t / (2 / 60)) : 1;
    const lerp = (x: number, y: number) => x + (y - x) * k;

    world.ball.savePrev();
    for (const p of world.players) p.savePrev();

    world.ball.pos.x = a ? lerp(a.ball[0], b.ball[0]) : b.ball[0];
    world.ball.pos.y = a ? lerp(a.ball[1], b.ball[1]) : b.ball[1];
    world.ball.z = a ? lerp(a.ball[2], b.ball[2]) : b.ball[2];
    world.ball.vel.x = b.ball[3];
    world.ball.vel.y = b.ball[4];
    world.ball.vz = b.ball[5];

    world.players.forEach((p, i) => {
      const pa = a?.players[i];
      const pb = b.players[i];
      if (!pb) return;
      p.pos.x = pa ? lerp(pa[0], pb[0]) : pb[0];
      p.pos.y = pa ? lerp(pa[1], pb[1]) : pb[1];
      p.vel.x = pb[2];
      p.vel.y = pb[3];
      p.facing.x = pb[4];
      p.facing.y = pb[5];
      p.lungeTimer = pb[6] > 0 ? 0.2 : 0;
      p.isCharging = pb[7] > 0;
    });

    world.score.left = b.score[0];
    world.score.right = b.score[1];
    world.restartLock = b.restartLock;
    world.sidesSwapped = b.sidesSwapped;
  }

  // Events surface exactly once, in arrival order
  drainEvents(): SimEvent[] {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }
}
