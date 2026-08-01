import { Vec2, vec, clamp, dist } from '../core/math';
import { PITCH } from '../sim/constants';
import { World } from '../sim/world';

// The team's shared sheet of paper: phase of play, a formation that breathes
// with the ball, and who's pressing. It publishes FACTS — every player still
// decides for itself what those facts mean. Never a movement order.

export type Phase = 'attack' | 'defend' | 'loose';

export class TeamBrain {
  phase: Phase = 'loose';
  possessorIdx: number | null = null;
  presserIdx = -1;
  coverIdx = -1;
  chaserIdxs: number[] = []; // my two closest hunters when the ball is loose
  // "That one's for YOU" — a pass in flight has a named receiver. The passer
  // calls it, the named player attacks the ball, everyone else keeps running.
  calledReceiver = -1;
  private calledFor = 0;
  private anchors: Vec2[] = [];
  private myIdxs: number[] = [];

  constructor(public team: 0 | 1) {}

  // +x for the left team, -x for the right: "forward" in world terms
  attackSign(): 1 | -1 {
    return this.team === 0 ? 1 : -1;
  }

  // Distance from our own goal line along the attack axis
  axisOf(x: number): number {
    return this.team === 0 ? x : PITCH.length - x;
  }

  goalWeAttack(): Vec2 {
    return vec(this.team === 0 ? PITCH.length : 0, PITCH.width / 2);
  }

  goalWeDefend(): Vec2 {
    return vec(this.team === 0 ? 0 : PITCH.length, PITCH.width / 2);
  }

  anchorOf(idx: number): Vec2 {
    return this.anchors[idx] ?? vec(PITCH.length / 2, PITCH.width / 2);
  }

  update(world: World, dt: number) {
    if (this.myIdxs.length === 0) {
      world.players.forEach((p, i) => { if (p.id.team === this.team) this.myIdxs.push(i); });
    }
    const possessor = world.possessor();
    this.possessorIdx = possessor;
    this.phase = possessor === null
      ? 'loose'
      : world.players[possessor].id.team === this.team ? 'attack' : 'defend';

    this.updateCalledPass(world, dt);
    this.updateAnchors(world);
    this.updatePressAuction(world);
  }

  // The moment one of ours kicks it, name the teammate closest to the ball's
  // actual flight line as the receiver — for the next second and a half,
  // that ball has an owner and nobody else on the team dives at it
  private updateCalledPass(world: World, dt: number) {
    this.calledFor -= dt;
    if (this.calledFor <= 0) this.calledReceiver = -1;
    for (const e of world.events) {
      if (e.kind !== 'kick') continue;
      const kicker = world.players[e.idx];
      if (kicker.id.team !== this.team) continue;
      const dir = world.ball.speed() > 1 ? vec(world.ball.vel.x, world.ball.vel.y) : null;
      if (!dir) continue;
      const dLen = Math.hypot(dir.x, dir.y);
      let best = -1;
      let bestScore = Infinity;
      for (const i of this.myIdxs) {
        if (i === e.idx || world.players[i].id.role === 'GK') continue;
        const mate = world.players[i];
        const to = vec(mate.pos.x - world.ball.pos.x, mate.pos.y - world.ball.pos.y);
        const along = (to.x * dir.x + to.y * dir.y) / dLen;
        if (along < 2) continue; // behind or on top of the kick
        const perp = (to.x * dir.y - to.y * dir.x) / dLen;
        // A runner whose stride is CLOSING on the ball line owns a led pass —
        // the ball ahead of him is for HIM, not for whoever stands nearest
        const closingSpeed = -(perp >= 0 ? 1 : -1) * (mate.vel.x * dir.y - mate.vel.y * dir.x) / dLen;
        const score = Math.abs(perp) * 2 + along * 0.05 - Math.max(0, closingSpeed) * 1.1;
        if (Math.abs(perp) < 7 && score < bestScore) { bestScore = score; best = i; }
      }
      this.calledReceiver = best;
      this.calledFor = best >= 0 ? 1.6 : 0;
    }
    // The call dies as soon as anyone actually takes a touch
    if (this.calledReceiver >= 0 && world.lastTouch && world.lastTouch.idx === this.calledReceiver) {
      this.calledReceiver = -1;
      this.calledFor = 0;
    }
  }

  // The shape is elastic but never SYNCHRONIZED: every player follows the
  // ball with his own gain and his own push, so the block breathes instead of
  // sliding as one welded wall. In possession the line steps UP — fullbacks
  // join the midfield, centre-backs keep the insurance.
  private updateAnchors(world: World) {
    const ball = world.ball.pos;
    const sgn = this.attackSign();
    const push = this.phase === 'attack' ? 9 : this.phase === 'defend' ? -7 : 0;
    const ballAxis = this.axisOf(ball.x);
    const defLineAxis = clamp(ballAxis - 9, 10, this.phase === 'attack' ? 54 : 44);

    for (const i of this.myIdxs) {
      const p = world.players[i];
      const baseX = this.team === 0 ? p.id.anchor.x * PITCH.length : (1 - p.id.anchor.x) * PITCH.length;
      const baseY = p.id.anchor.y * PITCH.width;
      if (p.id.role === 'GK') {
        this.anchors[i] = vec(baseX, baseY);
        continue;
      }
      const gain = 0.22 + this.grain(i) * 0.22;          // personal ball-follow gain
      const myPush = push * (0.7 + this.grain(i + 17) * 0.6); // personal step-up appetite
      let x = baseX + clamp((ball.x - PITCH.length / 2) * gain, -13, 13) + myPush * sgn;
      const y = baseY + (ball.y - baseY) * (0.2 + this.grain(i + 5) * 0.14);
      if (p.id.role === 'DF') {
        const fullback = Math.abs(p.id.anchor.y - 0.5) > 0.3;
        let axis = clamp(this.axisOf(x), 8, defLineAxis);
        if (this.phase === 'attack') {
          // Fullbacks bomb on to control the middle third; centre-backs stay home
          axis = fullback ? Math.min(axis + 9, 58) : Math.min(axis, defLineAxis - 3);
        }
        x = this.team === 0 ? axis : PITCH.length - axis;
      }
      this.anchors[i] = vec(clamp(x, 1, PITCH.length - 1), clamp(y, 1, PITCH.width - 1));
    }
  }

  // Stable per-player grain in [0,1) — the personality of a shape without personalities
  private grain(i: number): number {
    return (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
  }

  // Press auction: nearest hunts the carrier, next covers behind. Sticky by
  // 20% so two defenders never flicker over the job.
  private updatePressAuction(world: World) {
    if (this.phase === 'attack') {
      this.presserIdx = -1;
      this.coverIdx = -1;
      this.chaserIdxs = [];
      return;
    }
    const ball = world.ball.pos;
    const costs = this.myIdxs
      .filter((i) => world.players[i].id.role !== 'GK')
      .map((i) => ({ i, cost: dist(world.players[i].pos, ball) }))
      .sort((a, b) => a.cost - b.cost);
    if (costs.length === 0) return;

    const current = costs.find((c) => c.i === this.presserIdx);
    this.presserIdx = current && current.cost < costs[0].cost * 1.2 ? current.i : costs[0].i;
    this.coverIdx = costs.find((c) => c.i !== this.presserIdx)?.i ?? -1;
    this.chaserIdxs = this.phase === 'loose' ? costs.slice(0, 2).map((c) => c.i) : [];
  }
}
