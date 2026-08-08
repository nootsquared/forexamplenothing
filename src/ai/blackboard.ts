import { Vec2, vec, clamp, dist, expDecay } from '../core/math';
import { PITCH } from '../sim/constants';
import { World } from '../sim/world';

// The team's shared sheet of paper: phase of play, a formation that breathes
// with the ball, who presses, who marks whom, and how badly the human wants
// this ball. It publishes FACTS — every player still decides for itself what
// those facts mean. Never a movement order.

export type Phase = 'attack' | 'defend' | 'loose';

// How sharp this team's brains are — the difficulty dial lives HERE, not in
// their legs. settle: seconds a fresh possession is held before releasing
// (broken by pressure). pressHold: containing distance the presser keeps
// instead of diving in. error: multiplier on self-inflicted aim scatter.
export interface AiProfile {
  settle: number;
  pressHold: number;
  error: number;
}
export const SHARP: AiProfile = { settle: 0.15, pressHold: 0, error: 0 };
// Easy / Medium / Hard, indexed by the setup screen's difficulty
export const AI_PROFILES: [AiProfile, AiProfile, AiProfile] = [
  { settle: 0.95, pressHold: 2.3, error: 1.6 },
  { settle: 0.5, pressHold: 1.1, error: 0.7 },
  SHARP,
];

const MARK_TICKS = 6;      // the marking auction re-reads at the brains' own 10Hz
const MARK_ZONE = 19;      // a runner further than this from my slot belongs to somebody else
const FLIGHT_OWNS = 1.2;   // seconds a ball in the air still counts as its kicker's

export class TeamBrain {
  phase: Phase = 'loose';
  possessorIdx: number | null = null;
  presserIdx = -1;
  coverIdx = -1;
  chaserIdxs: number[] = []; // my two closest hunters when the ball is loose
  // "That one's for YOU" — a pass in flight has a named receiver. The passer
  // calls it, the named player attacks the ball, everyone else keeps running.
  calledReceiver = -1;
  // Which body a human is wearing this tick (-1 when nobody is) — teammates
  // keep a natural affinity for giving the human the ball
  humanIdx = -1;
  // The team's sharpness (difficulty wears this, never their dignity)
  profile: AiProfile = SHARP;
  // The second-last defender's line in OUR attack axis — the runs live off it
  offsideAxis = PITCH.length;
  // The support auction: in possession the sheet elects the triangle around
  // the carrier — a NEAR man showing at a safe angle behind the ball, and a
  // DEPTH runner stretching the last line. With a HUMAN on the ball both jobs
  // are guaranteed filled: he always has a short out and a ball over the top.
  supportNearIdx = -1;
  supportDepthIdx = -1;
  // Out of possession: who owns which runner. -1 means "play your zone".
  markOf: number[] = [];
  // The human off the ball, sprinting into space, is a CALLED RUN — quality
  // is openness x progress, so good runs get fed and hopeful ones don't.
  humanRun: { idx: number; quality: number; at: Vec2 } | null = null;
  // The carrier with his head up: settled, unhurried, pointed forward. The
  // line-breaking runners wait for exactly this beat before they go.
  carrierLoaded = false;
  private calledFor = 0;
  private anchors: Vec2[] = [];
  private myIdxs: number[] = [];
  private safeAxis = PITCH.length;
  private phaseHold = 0;
  private pushNow = 3;      // the shape's step-up, eased so a pass never yanks it
  private loadedT = 0;
  private loadedIdx = -1;
  private markTick = 0;
  private threats: number[] = [];  // reused scratch — the auction allocates nothing
  private markers: number[] = [];
  private runFact = { idx: -1, quality: 0, at: vec() };

  // Which way is FORWARD this half — refreshed from the world every update,
  // because the teams swap ends at the break
  private sign: 1 | -1 = 1;

  constructor(public team: 0 | 1) {
    this.sign = team === 0 ? 1 : -1;
  }

  attackSign(): 1 | -1 {
    return this.sign;
  }

  // Distance from our own goal line along the attack axis
  axisOf(x: number): number {
    return this.sign > 0 ? x : PITCH.length - x;
  }

  // ...and back: the pitch x that sits that far up our axis
  xAtAxis(axis: number): number {
    return this.sign > 0 ? axis : PITCH.length - axis;
  }

  // The line a receiver may not be beyond when the ball is struck: the
  // second-last defender, the ball itself, or halfway — whichever is deepest
  offsideSafeAxis(): number {
    return this.safeAxis;
  }

  goalWeAttack(): Vec2 {
    return vec(this.sign > 0 ? PITCH.length : 0, PITCH.width / 2);
  }

  goalWeDefend(): Vec2 {
    return vec(this.sign > 0 ? 0 : PITCH.length, PITCH.width / 2);
  }

  anchorOf(idx: number): Vec2 {
    return this.anchors[idx] ?? vec(PITCH.length / 2, PITCH.width / 2);
  }

  update(world: World, dt: number) {
    this.sign = world.attackSign(this.team);
    if (this.myIdxs.length === 0) {
      world.players.forEach((p, i) => { if (p.id.team === this.team) this.myIdxs.push(i); });
      this.markOf = world.players.map(() => -1);
    }
    const possessor = world.possessor();
    this.possessorIdx = possessor;
    this.updatePhase(world, dt, possessor);

    // Second-last opponent up the attack axis — the line runs never cross
    let first = -Infinity;
    let second = -Infinity;
    for (const p of world.players) {
      if (p.id.team === this.team) continue;
      const a = this.axisOf(p.pos.x);
      if (a > first) { second = first; first = a; } else if (a > second) second = a;
    }
    this.offsideAxis = Math.max(PITCH.length / 2, second === -Infinity ? PITCH.length : second);
    this.safeAxis = Math.max(this.offsideAxis, this.axisOf(world.ball.pos.x), PITCH.length / 2);

    this.updateCalledPass(world, dt);
    this.updateAnchors(world, dt);
    this.updatePressAuction(world);
    this.updateSupportAuction(world);
    this.updateHumanRun(world);
    this.updateCarrierLoaded(world, dt);
    if (--this.markTick <= 0) {
      this.markTick = MARK_TICKS;
      this.updateMarks(world);
    }
  }

  // Possession is a STORY, not a sample: a ball flying between two of our
  // boots is still ours, so the shape never unravels and re-forms in the beat
  // between a pass and its reception. That flicker was the robot look.
  private updatePhase(world: World, dt: number, possessor: number | null) {
    const owner: Phase = world.lastTouch
      ? (world.lastTouch.team === this.team ? 'attack' : 'defend')
      : 'loose';
    if (possessor !== null) {
      this.phase = world.players[possessor].id.team === this.team ? 'attack' : 'defend';
      this.phaseHold = 0;
      return;
    }
    this.phaseHold += dt;
    const inFlight = world.ball.speed() > 5 || world.ball.z > 0.6;
    this.phase = inFlight && this.phaseHold < FLIGHT_OWNS ? owner : 'loose';
  }

  // Who owes the carrier an angle, who owes him depth. Sticky by a couple of
  // meters so the jobs don't strobe between neighbors every re-elect — and
  // when a HUMAN carries, both jobs fill no matter what the field looks like.
  private updateSupportAuction(world: World) {
    if (this.phase !== 'attack' || this.possessorIdx === null) {
      this.supportNearIdx = -1;
      this.supportDepthIdx = -1;
      return;
    }
    const carrier = world.players[this.possessorIdx];
    const carrierAxis = this.axisOf(carrier.pos.x);
    const reach = 24 + 26 * carrier.stats.longBall; // how far his boot honestly delivers
    // the man squeezing him: a short option in that shadow is no option
    let shadow: Vec2 | null = null;
    let shadowD = 9;
    for (const p of world.players) {
      if (p.id.team === this.team) continue;
      const d = dist(p.pos, carrier.pos);
      if (d < shadowD) { shadowD = d; shadow = p.pos; }
    }
    let near = -1;
    let nearCost = Infinity;
    let depth = -1;
    let depthScore = -Infinity;
    let fallbackNear = -1;
    let fallbackNearD = Infinity;
    let fallbackDepth = -1;
    let fallbackDepthScore = -Infinity;
    for (const i of this.myIdxs) {
      if (i === this.possessorIdx) continue;
      const p = world.players[i];
      if (p.id.role === 'GK') continue;
      const d = dist(p.pos, carrier.pos);
      const axis = this.axisOf(p.pos.x);
      if (d < reach && d < fallbackNearD) { fallbackNearD = d; fallbackNear = i; }
      if (axis < this.safeAxis + 1 && d < reach && axis > fallbackDepthScore) {
        fallbackDepthScore = axis;
        fallbackDepth = i;
      }
      // the SHORT ball: level or behind the carrier, an easy weight, and off
      // his shoulder rather than square in the presser's shadow
      if (d > 4 && d < 22 && axis <= carrierAxis + 4) {
        const shade = shadow ? Math.max(0, 6 - dist(p.pos, shadow)) : 0;
        const cost = Math.abs(d - 11) + shade * 1.4 + (i === this.supportNearIdx ? -2.5 : 0);
        if (cost < nearCost) { nearCost = cost; near = i; }
      }
      // DEPTH: the most advanced man who is still onside and still in range
      if (p.id.role !== 'DF' && d < reach && axis < this.safeAxis + 1) {
        const s = axis + (p.id.role === 'FW' ? 9 : 0) + (i === this.supportDepthIdx ? 4 : 0);
        if (s > depthScore) { depthScore = s; depth = i; }
      }
    }
    // Nobody on the ball is left staring at eleven strangers: where taste
    // found no short option, the nearest shirt inside delivery range shows
    // anyway and the most advanced legal shirt runs the channel. A human
    // carrier is just the loudest case of a rule the whole team lives by.
    if (near < 0) near = fallbackNear;
    if (depth < 0) depth = fallbackDepth;
    this.supportNearIdx = near;
    this.supportDepthIdx = depth === near ? -1 : depth;
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
      // the training ground has no fallback collector — a called man sees
      // even the longest pass all the way through
      this.calledFor = best >= 0 ? (world.practice ? 3.5 : 1.6) : 0;
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
  private updateAnchors(world: World, dt: number) {
    const ball = world.ball.pos;
    const sgn = this.attackSign();
    // The step-up EASES between phases: a turnover slides the block, it never
    // teleports it, so nobody sprints backwards for a ball that was ours again
    // half a second later
    const pushWant = this.phase === 'attack' ? 11 : this.phase === 'defend' ? -7 : 3;
    this.pushNow = expDecay(this.pushNow, pushWant, 1.5, dt);
    const ballAxis = this.axisOf(ball.x);
    // The back line LIVES with the ball, not with its box: past halfway in
    // possession, still stepped up around it out of possession — space behind
    // is the covering runner's problem, not a reason to camp the six-yard line
    const defLineAxis = clamp(ballAxis - 6, 12, this.phase === 'attack' ? 60 : 48);

    for (const i of this.myIdxs) {
      const p = world.players[i];
      const baseX = this.sign > 0 ? p.id.anchor.x * PITCH.length : (1 - p.id.anchor.x) * PITCH.length;
      const baseY = p.id.anchor.y * PITCH.width;
      if (p.id.role === 'GK') {
        this.anchors[i] = vec(baseX, baseY);
        continue;
      }
      const gain = 0.22 + this.grain(i) * 0.22;                    // personal ball-follow gain
      const myPush = this.pushNow * (0.7 + this.grain(i + 17) * 0.6); // personal step-up appetite
      let x = baseX + clamp((ball.x - PITCH.length / 2) * gain, -16, 16) + myPush * sgn;
      const y = baseY + (ball.y - baseY) * (0.2 + this.grain(i + 5) * 0.14);
      if (p.id.role === 'DF') {
        const fullback = Math.abs(p.id.anchor.y - 0.5) > 0.3;
        // The line is PULLED up with the ball, not just permitted to follow:
        // a defender is never left more than ~13m behind the ball line
        const lineFloor = clamp(ballAxis - 13, 8, this.phase === 'attack' ? 48 : 38);
        let axis = clamp(this.axisOf(x), lineFloor, defLineAxis);
        if (this.phase === 'attack') {
          // Fullbacks bomb on to control the middle third; centre-backs step
          // with the line and keep only a stride of insurance
          axis = fullback ? Math.min(axis + 10, 66) : Math.min(axis, defLineAxis - 2);
        }
        x = this.sign > 0 ? axis : PITCH.length - axis;
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
    // The training ground: the ball is the HUMAN's errand — nobody is
    // elected to hunt it, so every shirt stays a passing option, not a swarm
    if (world.practice || this.phase === 'attack') {
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

  // Man-marking, auctioned: every dangerous runner inside the block gets an
  // owner who tracks him, and the owner keeps him — until he leaves the zone,
  // where the next man picks him up. Nobody stammers waiting for the ball.
  private updateMarks(world: World) {
    for (let i = 0; i < this.markOf.length; i++) this.markOf[i] = -1;
    if (this.phase === 'attack' || world.practice) return;
    const ballAxis = this.axisOf(world.ball.pos.x);
    const blockLimit = Math.min(ballAxis + 16, 62);
    this.threats.length = 0;
    world.players.forEach((p, i) => {
      if (p.id.team === this.team || p.id.role === 'GK') return;
      if (this.axisOf(p.pos.x) < blockLimit) this.threats.push(i);
    });
    // deepest runner first — the man nearest our goal is the one who hurts
    this.threats.sort((a, b) => this.axisOf(world.players[a].pos.x) - this.axisOf(world.players[b].pos.x));
    this.markers.length = 0;
    for (const i of this.myIdxs) {
      const p = world.players[i];
      if (p.id.role === 'GK' || i === this.presserIdx || i === this.coverIdx || i === this.humanIdx) continue;
      if (this.chaserIdxs.includes(i)) continue;
      this.markers.push(i);
    }
    for (const t of this.threats) {
      const man = world.players[t];
      let best = -1;
      let bestCost = Infinity;
      for (const i of this.markers) {
        if (this.markOf[i] >= 0) continue;
        const p = world.players[i];
        const anchor = this.anchorOf(i);
        if (dist(anchor, man.pos) > MARK_ZONE) continue; // not my zone — hand him on
        const role = p.id.role === 'DF' ? 0 : p.id.role === 'MF' ? 3 : 9;
        const cost = dist(p.pos, man.pos) + role - (this.markOf[i] === t ? 4 : 0);
        if (cost < bestCost) { bestCost = cost; best = i; }
      }
      if (best >= 0) this.markOf[best] = t;
    }
  }

  // The human off the ball, sprinting into space, is CALLING for it — and how
  // badly we want to find him is exactly how good the run is: room where he's
  // headed, times ground genuinely being made toward their goal.
  private updateHumanRun(world: World) {
    this.humanRun = null;
    const i = this.humanIdx;
    if (i < 0 || i === this.possessorIdx || this.phase !== 'attack') return;
    const h = world.players[i];
    if (!h.isSprinting) return;
    const forward = h.vel.x * this.sign;
    if (forward < 1.6) return;
    const at = this.runFact.at;
    at.x = h.pos.x + h.vel.x * 0.6;
    at.y = h.pos.y + h.vel.y * 0.6;
    let room = 12;
    for (const p of world.players) {
      if (p.id.team !== this.team) room = Math.min(room, dist(p.pos, at));
    }
    const quality = clamp((room - 2.5) / 7.5, 0, 1) * clamp(forward / Math.max(3, h.stats.sprintSpeed), 0, 1);
    if (quality < 0.12) return;
    this.runFact.idx = i;
    this.runFact.quality = quality;
    this.humanRun = this.runFact;
  }

  // Head up, unhurried, pointed at their goal — the beat the runners leave on
  private updateCarrierLoaded(world: World, dt: number) {
    if (this.phase !== 'attack' || this.possessorIdx === null) {
      this.loadedIdx = -1;
      this.loadedT = 0;
      this.carrierLoaded = false;
      return;
    }
    if (this.possessorIdx !== this.loadedIdx) {
      this.loadedIdx = this.possessorIdx;
      this.loadedT = 0;
    }
    const carrier = world.players[this.possessorIdx];
    let squeezed = 9;
    for (const p of world.players) {
      if (p.id.team !== this.team) squeezed = Math.min(squeezed, dist(p.pos, carrier.pos));
    }
    this.loadedT += dt;
    this.carrierLoaded = this.loadedT > 0.3 && squeezed > 3.2 && carrier.facing.x * this.sign > 0.1;
  }
}
