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

  update(world: World) {
    if (this.myIdxs.length === 0) {
      world.players.forEach((p, i) => { if (p.id.team === this.team) this.myIdxs.push(i); });
    }
    const possessor = world.possessor();
    this.possessorIdx = possessor;
    this.phase = possessor === null
      ? 'loose'
      : world.players[possessor].id.team === this.team ? 'attack' : 'defend';

    this.updateAnchors(world);
    this.updatePressAuction(world);
  }

  // The shape is elastic: it slides with the ball, pushes up in possession,
  // and the back line stays a coherent unit behind the ball
  private updateAnchors(world: World) {
    const ball = world.ball.pos;
    const sgn = this.attackSign();
    const push = this.phase === 'attack' ? 9 : this.phase === 'defend' ? -7 : 0;
    const ballAxis = this.axisOf(ball.x);
    const defLineAxis = clamp(ballAxis - 9, 10, 42);

    for (const i of this.myIdxs) {
      const p = world.players[i];
      const baseX = this.team === 0 ? p.id.anchor.x * PITCH.length : (1 - p.id.anchor.x) * PITCH.length;
      const baseY = p.id.anchor.y * PITCH.width;
      if (p.id.role === 'GK') {
        this.anchors[i] = vec(baseX, baseY);
        continue;
      }
      let x = baseX + clamp((ball.x - PITCH.length / 2) * 0.35, -13, 13) + push * sgn;
      const y = baseY + (ball.y - baseY) * 0.26;
      if (p.id.role === 'DF') {
        // Hold the line: no defender sits deeper than the unit needs to be
        const axis = clamp(this.axisOf(x), 8, defLineAxis);
        x = this.team === 0 ? axis : PITCH.length - axis;
      }
      this.anchors[i] = vec(clamp(x, 1, PITCH.length - 1), clamp(y, 1, PITCH.width - 1));
    }
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
