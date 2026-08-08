import { dist, len, norm, sub, add, scale, clamp, angleBetween } from '../core/math';
import { World } from '../sim/world';
import { TeamBrain } from '../ai/blackboard';
import { leadTarget } from '../ai/brain';

// The team cursor, possession-first: the ball IS control. Whoever on your
// team HAS it — after your pass, an interception, a loose-ball pickup — is
// instantly you. A ball in flight has nobody: it can be cut out, it can be
// missed, so it never moves you. Off the ball nothing moves on its own: E or a
// click takes the previewed man and OWNS him for a beat, and the T auto-switch
// mode (off by default) lets the best-placed hunter be handed to you without
// the press. The preview is never "whoever stands nearest the ball" — when
// they carry it, it is the man whose legs can still get in FRONT of the run.
// Never the keeper.

const AUTO_COOLDOWN = 0.7;   // auto-mode hunter re-elections never strobe
const SWITCH_GRACE = 1.2;    // seconds a switch YOU asked for outranks the ball
const SWITCH_BEAT = 0.25;    // seconds a body change costs before the legs go
const GOAL_PULL = 2;         // m/s of "he's coming for our goal anyway" in the projection
const ROLL_KEEP = 0.8;       // the pace grass leaves a loose ball over that same beat
const GOAL_SIDE_CREDIT = 0.06; // seconds shaved per meter of head start on our goal
const GOAL_SIDE_CAP = 8;     // ...deep cover is a head start, not a free switch
const TAIL_ANGLE = 2.44;     // rad (~140°): past this off his run, you are behind him
const TAIL_TAX = 3;          // seconds: a chase you cannot win is not a switch
const HOLD_CREDIT = 0.2;     // the chevron keeps its man through a coin-flip

export class TeamCursor {
  idx: number;
  suggested = -1;    // who E switches you into — the white chevron
  autoMode = false;  // T: hunters are handed to you instead of waiting for E
  // Multiplayer seats: a body another human on MY team is wearing is never a
  // switch target. Solo play leaves this oracle empty and nothing changes.
  claimed: (idx: number) => boolean = () => false;
  // Set pieces belong to the captain — with several seats on a team, only
  // one pair of hands reaches for the dead ball
  isCaptain = true;
  private autoT = 0;
  private graceT = 0;       // the deliberate switch's beat of immunity
  private graceTouch = -1;  // ...whose touch it was granted against
  private wearable = new Set<number>(); // every outfield body on my side

  constructor(private team: 0 | 1, world: World, preferIdx = -1) {
    world.players.forEach((p, i) => {
      if (p.id.team === team && p.id.role !== 'GK') this.wearable.add(i);
    });
    this.idx = preferIdx >= 0
      ? preferIdx
      : world.players.findIndex((p) => p.id.team === team && p.id.role === 'FW');
  }

  // E: take the previewed man. With the ball at your feet there is nothing to
  // take — you move control by passing it.
  manualSwitch() {
    if (this.suggested >= 0 && this.take(this.suggested)) this.grantGrace();
  }

  // The shell's click: as deliberate as E, so it earns the same beat. Your
  // side, outfield, nobody else wearing him, and not the body you're already in.
  takeAt(idx: number): boolean {
    if (!this.wearable.has(idx) || idx === this.idx || this.claimed(idx)) return false;
    if (!this.take(idx)) return false;
    this.grantGrace();
    return true;
  }

  update(world: World, bb: TeamBrain, dt: number) {
    this.autoT = Math.max(0, this.autoT - dt);
    // The tick a switch was granted only takes its baseline: whatever the ball
    // was already doing when you pressed is old news, never a reason to snap back
    const graceFresh = this.graceT === SWITCH_GRACE;
    this.graceT = Math.max(0, this.graceT - dt);

    for (const e of world.events) {
      // Our restart: the ceremony beat announces it, the taker becomes you —
      // unless a teammate seat is already wearing him, or you're not the
      // captain (set pieces are the captain's ball). A goal kick stays with
      // the KEEPER and his distribution sight — the cursor never wears him.
      if (e.kind === 'restart' && e.team === this.team && e.taker >= 0 && this.isCaptain &&
          e.restart !== 'goalkick') this.take(e.taker);
      // A kickoff hands you the man nearest the BALL, never the man nearest
      // the formation sheet — the whole squad has just walked back to its
      // marks, and you do not restart a half parked at centre-back. Our own
      // kickoff still lands on the taker: he is the one standing over it.
      if (e.kind === 'kickoff') this.take(this.nearestToBall(world, true));
      // A ball struck or won is genuinely new business — the grace is spent
      if (!graceFresh && (e.kind === 'kick' || e.kind === 'steal')) this.graceT = 0;
    }

    const lt = world.lastTouch;
    const touchIdx = lt?.idx ?? -1;
    if (graceFresh) this.graceTouch = touchIdx;
    else if (touchIdx !== this.graceTouch) this.graceT = 0; // the ball changed hands

    // Control moves on RECEIPT and never a moment sooner: the last teammate to
    // play it, still standing over it, is YOU — no waiting for an arriving ball
    // to stop bouncing into formal 'possession' (the possessor gate ignores
    // airborne balls, which read as switch lag), and equally no being handed a
    // man a pass was merely AIMED at. A ball cut out or a ball missed leaves
    // you exactly where you were, in the body you chose. A carrier another seat
    // is wearing stays THEIRS; the keeper is never taken.
    if (this.graceT <= 0 && world.restartLock <= 0 && lt && lt.team === this.team && lt.idx !== this.idx &&
        world.players[lt.idx].id.role !== 'GK' && !this.claimed(lt.idx) &&
        dist(world.players[lt.idx].pos, world.ball.pos) < 1.7) {
      this.take(lt.idx);
    }
    // ...and a settled ball at a teammate's feet outranks any pass still
    // being called after it
    if (this.graceT <= 0 && bb.phase === 'attack' && bb.possessorIdx !== null &&
        world.players[bb.possessorIdx].id.role !== 'GK' && !this.claimed(bb.possessorIdx)) {
      this.take(bb.possessorIdx);
    }

    // The chevron rides ahead of the switch instead of replacing it: while your
    // pass is in the air it names the man you are ABOUT to become, and E takes
    // him early if you back the ball to get there.
    this.suggested = this.elect(world, bb);

    // Auto-switch mode: the hunt is handed to you, gently — never mid-chase,
    // and never over the top of a switch you just made yourself
    if (this.autoMode && this.suggested >= 0 && bb.phase !== 'attack' && this.autoT <= 0 && this.graceT <= 0) {
      this.take(this.suggested);
      this.suggested = -1;
      this.autoT = AUTO_COOLDOWN;
    }
  }

  // External handoff — the keeper's launch hands you its intended receiver
  assign(idx: number) {
    if (this.take(idx)) this.grantGrace();
  }

  // A switch you asked for outranks the ball for a beat, so E can never flash
  // you into a body and straight back out of it. The baseline touch is read on
  // the next update — the grant can land either side of a tick.
  private grantGrace() {
    this.graceT = SWITCH_GRACE;
  }

  // Who deserves the cursor right now, in football order: our carrier, the
  // called receiver, the man who can actually cut the ball off, then the
  // elected presser — falling back to whoever's nearest. Never you, never the
  // keeper.
  private elect(world: World, bb: TeamBrain): number {
    if (bb.possessorIdx === this.idx) return -1; // you have the ball; pass to move
    const valid = (i: number) =>
      i >= 0 && i !== this.idx && world.players[i].id.team === this.team &&
      world.players[i].id.role !== 'GK' && !this.claimed(i);
    const ours = bb.phase === 'attack' && bb.possessorIdx !== null ? bb.possessorIdx : -1;
    const theirs = bb.phase === 'defend' && bb.possessorIdx !== null ? bb.possessorIdx : -1;
    if (valid(ours)) return ours;
    // a pass of ours still in the air has a named owner; once THEY carry it,
    // that call is a dead letter
    if (theirs < 0 && valid(bb.calledReceiver)) return bb.calledReceiver;
    if (ours < 0) {
      const cutter = this.bestInterceptor(world, bb, theirs, valid);
      if (cutter >= 0) return cutter;
    }
    for (const i of [bb.chaserIdxs[0] ?? -1, bb.presserIdx]) {
      if (valid(i)) return i;
    }
    return this.nearestToBall(world, false);
  }

  // Who can get IN FRONT of it. Every eligible teammate is priced in seconds
  // to where his legs and the projected run MEET — plus the beat a body change
  // costs, minus credit for already standing goal-side, plus a tax on trailing
  // a carrier he cannot outrun. carrierIdx < 0 prices a loose ball's own roll.
  private bestInterceptor(
    world: World, bb: TeamBrain, carrierIdx: number, valid: (i: number) => boolean,
  ): number {
    const carrier = carrierIdx >= 0 ? world.players[carrierIdx] : null;
    const from = carrier ? carrier.pos : world.ball.pos;
    const toGoal = norm(sub(bb.goalWeDefend(), from));
    // a carrier is coming for our goal even between touches; a loose ball only
    // owns the roll the grass leaves it
    const run = carrier ? add(carrier.vel, scale(toGoal, GOAL_PULL)) : scale(world.ball.vel, ROLL_KEEP);
    const runSpeed = carrier ? len(carrier.vel) : 0;
    let best = -1;
    let bestEta = Infinity;
    world.players.forEach((p, i) => {
      if (!valid(i)) return;
      const chase = p.stats.sprintSpeed;
      const meet = leadTarget(p.pos, from, run, chase);
      const toMate = sub(p.pos, from);
      let eta = dist(p.pos, meet) / chase + SWITCH_BEAT;
      if (carrier) {
        const goalSide = toMate.x * toGoal.x + toMate.y * toGoal.y;
        eta -= clamp(goalSide, 0, GOAL_SIDE_CAP) * GOAL_SIDE_CREDIT;
        // the pure tail-chaser: behind his line and no quicker than he is
        if (chase < runSpeed + 0.6 && angleBetween(run, toMate) > TAIL_ANGLE) eta += TAIL_TAX;
      }
      if (i === this.suggested) eta -= HOLD_CREDIT;
      if (eta < bestEta) { bestEta = eta; best = i; }
    });
    return best;
  }

  // Nearest outfield teammate to the ball; with `orMe`, you count too (a
  // blocked kick that stays at your feet should NOT switch you away)
  private nearestToBall(world: World, orMe: boolean): number {
    let best = -1;
    let bestD = Infinity;
    world.players.forEach((p, i) => {
      if (p.id.team !== this.team || p.id.role === 'GK' || this.claimed(i)) return;
      if (!orMe && i === this.idx) return;
      const d = dist(p.pos, world.ball.pos);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best === this.idx ? -1 : best;
  }

  // True when control actually moved — a claimed or invalid body refuses
  private take(idx: number): boolean {
    if (idx >= 0 && idx !== this.idx && !this.claimed(idx)) {
      this.idx = idx;
      return true;
    }
    return idx === this.idx;
  }
}
