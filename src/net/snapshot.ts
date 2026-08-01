import { Match } from '../match';
import { World } from '../sim/world';
import { SimEvent } from '../sim/events';
import { MatchSnap } from './net';

// Truth on the wire: the host's world flattened to numbers ~30 times a
// second, and a guest's world rebuilt from them. Guests never simulate —
// they watch the same match through their own camera.

const q = (v: number) => Math.round(v * 100) / 100;

export function takeSnap(match: Match, tick: number, cursors: Record<number, number>, suggest: Record<number, number>, events: SimEvent[]): MatchSnap {
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
    suggest,
    events,
    sidesSwapped: w.sidesSwapped,
  };
}

// A guest rides a short interpolation BUFFER: it renders the match ~3 sim
// ticks behind the freshest snapshot and glides through the timeline, so
// network jitter never reads as chop. The renderer's own frame alpha
// smooths whatever is left.
const BUFFER_TICKS = 3;   // ~50ms behind truth — invisible, and jitter-proof
const MAX_SNAPS = 24;

export class SnapPlayer {
  private snaps: MatchSnap[] = [];
  private renderTick = -1;
  pendingEvents: SimEvent[] = [];
  latest: MatchSnap | null = null;

  push(snap: MatchSnap) {
    this.snaps.push(snap);
    if (this.snaps.length > MAX_SNAPS) this.snaps.shift();
    this.latest = snap;
    if (this.renderTick < 0) this.renderTick = snap.tick - BUFFER_TICKS;
    this.pendingEvents.push(...(snap.events as SimEvent[]));
  }

  // Advance the guest's clock and pose the world on the buffered timeline
  apply(world: World, dt: number) {
    const newest = this.latest;
    if (!newest || this.snaps.length === 0) return;
    this.renderTick += dt * 60;
    // never run ahead of truth, never trail into stale history
    this.renderTick = Math.min(this.renderTick, newest.tick - 1);
    this.renderTick = Math.max(this.renderTick, newest.tick - BUFFER_TICKS * 3);

    // the pair of snaps bracketing the render clock
    let a = this.snaps[0];
    let b = this.snaps[this.snaps.length - 1];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].tick <= this.renderTick && this.snaps[i + 1].tick >= this.renderTick) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    const span = Math.max(1, b.tick - a.tick);
    const k = Math.min(1, Math.max(0, (this.renderTick - a.tick) / span));
    const lerp = (x: number, y: number) => x + (y - x) * k;

    world.ball.savePrev();
    for (const p of world.players) p.savePrev();

    world.ball.pos.x = lerp(a.ball[0], b.ball[0]);
    world.ball.pos.y = lerp(a.ball[1], b.ball[1]);
    world.ball.z = lerp(a.ball[2], b.ball[2]);
    world.ball.vel.x = b.ball[3];
    world.ball.vel.y = b.ball[4];
    world.ball.vz = b.ball[5];

    world.players.forEach((p, i) => {
      const pa = a.players[i];
      const pb = b.players[i];
      if (!pb || !pa) return;
      p.pos.x = lerp(pa[0], pb[0]);
      p.pos.y = lerp(pa[1], pb[1]);
      p.vel.x = pb[2];
      p.vel.y = pb[3];
      p.facing.x = pb[4];
      p.facing.y = pb[5];
      p.lungeTimer = pb[6] > 0 ? 0.2 : 0;
      p.isCharging = pb[7] > 0;
    });

    world.score.left = newest.score[0];
    world.score.right = newest.score[1];
    world.restartLock = newest.restartLock;
    world.sidesSwapped = newest.sidesSwapped;
  }

  // Events surface exactly once, in arrival order
  drainEvents(): SimEvent[] {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }
}
