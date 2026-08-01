import { dist } from '../core/math';
import { World } from '../sim/world';
import { TeamBrain } from '../ai/blackboard';

// The team cursor, possession-first: the ball IS control. Whoever on your
// team has it — after your pass, an interception, a loose-ball pickup — is
// instantly you. Off the ball nothing moves on its own: E takes the
// previewed man, and the T auto-switch mode (off by default) lets the
// best-placed hunter be handed to you without the press. Never the keeper.

const MY_BALL_WINDOW = 1.8;  // seconds a kick of yours owns the next receiver call
const AUTO_COOLDOWN = 0.7;   // auto-mode hunter re-elections never strobe

export class TeamCursor {
  idx: number;
  suggested = -1;    // who E switches you into — the white chevron
  autoMode = false;  // T: hunters are handed to you instead of waiting for E
  private myBallT = 0;
  private autoT = 0;

  constructor(private team: 0 | 1, world: World) {
    this.idx = world.players.findIndex((p) => p.id.team === team && p.id.role === 'FW');
  }

  // E: take the previewed man. With the ball at your feet there is nothing to
  // take — you move control by passing it.
  manualSwitch() {
    if (this.suggested >= 0) this.take(this.suggested);
  }

  update(world: World, bb: TeamBrain, dt: number) {
    this.myBallT = Math.max(0, this.myBallT - dt);
    this.autoT = Math.max(0, this.autoT - dt);

    for (const e of world.events) {
      // Our restart: the ceremony beat announces it, the taker becomes you
      if (e.kind === 'restart' && e.team === this.team && e.taker >= 0) this.take(e.taker);
      if (e.kind === 'kickoff' && e.team === this.team && e.taker >= 0) this.take(e.taker);
      // A ball leaving YOUR boot is yours to follow
      if (e.kind === 'kick' && e.idx === this.idx) this.myBallT = MY_BALL_WINDOW;
    }

    // The ball is control: our carrier is YOU, the moment he has it — and a
    // settled ball outranks any pass still being called after it
    if (bb.phase === 'attack' && bb.possessorIdx !== null &&
        world.players[bb.possessorIdx].id.role !== 'GK') {
      this.take(bb.possessorIdx);
      this.myBallT = 0;
    }
    // ...and a pass of yours in flight is switched THE SECOND it leaves: to
    // the team's named receiver, else to whoever the ball is heading TOWARDS
    // (the flight-ray prediction). A blocked kick that goes nowhere keeps you.
    if (this.myBallT > 0) {
      if (bb.calledReceiver >= 0 && bb.calledReceiver !== this.idx) {
        this.take(bb.calledReceiver);
        this.myBallT = 0;
      } else {
        const predicted = this.myBallT < MY_BALL_WINDOW - 0.033 && world.ball.speed() > 4
          ? this.receiverOnRay(world)
          : -1;
        if (predicted >= 0) {
          this.take(predicted);
          this.myBallT = 0;
        } else if (this.myBallT < MY_BALL_WINDOW - 0.3) {
          const closest = this.nearestToBall(world, true);
          if (closest >= 0) this.take(closest);
          this.myBallT = 0;
        }
      }
    }

    this.suggested = this.elect(world, bb);

    // Auto-switch mode: the hunt is handed to you, gently — never mid-chase
    if (this.autoMode && this.suggested >= 0 && bb.phase !== 'attack' && this.autoT <= 0) {
      this.take(this.suggested);
      this.suggested = -1;
      this.autoT = AUTO_COOLDOWN;
    }
  }

  // External handoff — the keeper's launch hands you its intended receiver
  assign(idx: number) {
    this.take(idx);
  }

  // Who deserves the cursor right now, in football order: our carrier, the
  // called receiver, the loose-ball chaser, the elected presser — falling
  // back to whoever's nearest. Never you, never the keeper.
  private elect(world: World, bb: TeamBrain): number {
    if (bb.possessorIdx === this.idx) return -1; // you have the ball; pass to move
    const valid = (i: number) =>
      i >= 0 && i !== this.idx && world.players[i].id.team === this.team &&
      world.players[i].id.role !== 'GK';
    const carrier = bb.phase === 'attack' && bb.possessorIdx !== null ? bb.possessorIdx : -1;
    for (const i of [carrier, bb.calledReceiver, bb.chaserIdxs[0] ?? -1, bb.presserIdx]) {
      if (valid(i)) return i;
    }
    return this.nearestToBall(world, false);
  }

  // The teammate my moving ball is heading TOWARDS: closest to the flight
  // ray, ahead of the ball — the predicted receiver of the pass just played
  private receiverOnRay(world: World): number {
    const sp = world.ball.speed();
    if (sp < 1e-4) return -1;
    const dx = world.ball.vel.x / sp;
    const dy = world.ball.vel.y / sp;
    let best = -1;
    let bestScore = Infinity;
    world.players.forEach((p, i) => {
      if (p.id.team !== this.team || p.id.role === 'GK' || i === this.idx) return;
      const tx = p.pos.x - world.ball.pos.x;
      const ty = p.pos.y - world.ball.pos.y;
      const along = tx * dx + ty * dy;
      if (along < 1) return; // behind the ball is not where it's going
      const perp = Math.abs(tx * dy - ty * dx);
      if (perp > 10) return;
      const score = perp * 2 + along * 0.05;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  // Nearest outfield teammate to the ball; with `orMe`, you count too (a
  // blocked kick that stays at your feet should NOT switch you away)
  private nearestToBall(world: World, orMe: boolean): number {
    let best = -1;
    let bestD = Infinity;
    world.players.forEach((p, i) => {
      if (p.id.team !== this.team || p.id.role === 'GK') return;
      if (!orMe && i === this.idx) return;
      const d = dist(p.pos, world.ball.pos);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best === this.idx ? -1 : best;
  }

  private take(idx: number) {
    if (idx >= 0 && idx !== this.idx) this.idx = idx;
  }
}
