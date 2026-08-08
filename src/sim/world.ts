import { vec, len, dist, norm, sub, scale, add, rotate, clamp, angleBetween, signedAngle, perpRight, Vec2 } from '../core/math';
import { Rng } from '../core/rng';
import { GRAVITY, PITCH, SURFACES, Surface } from './constants';
import { Ball } from './ball';
import { PlayerBody, PlayerInput } from './player';
import { SimEvent } from './events';
import { CLAMP, clampCloseRate, coneHalfAngle, duelScores, goalness, keeperCentering, kickAccuracy } from './tuning';

const KICK_RANGE = 2.0;
const KICK_BUFFER = 0.28;    // released kick fires as soon as the ball is in reach
const BALL_KEEPOUT = 0.52;   // body ring past the ball's DRAWN edge — sprites never interpenetrate
const CONTACT_RANGE = 0.6;   // a real foot's reach — the ball is NEVER played from further
const STEER_RANGE = 1.0;     // toe-stretch reach while veering onto a new line
const SPRINT_REACH = 1.0;    // the full-pace toe stretch — sprinting never shrinks your feet
const COLLECT_RANGE = 1.35;  // the sole-drag around the body on a hard turn reaches further
const CHOP_RANGE = 0.85;     // planting a cut stretches the leg a touch further
const CUSHION_RANGE = 1.0;   // stretching to kill a ball arriving with pace
const MOMENTUM_KEPT = 0.22;  // slice of the ball's old velocity surviving a touch
const FOOT_LANE = 0.16;      // the dominant foot's lane sits this far right of the run line
const KNOCK_CONE = 0.8;      // a touch can redirect at most this far off the run (rad)
const AIM_BEND_MAX = 1.31;   // ~75°: shots angle across the body, never backward
const PLAYER_R = 0.28;       // body radius against goal frames
const BALL_R = 0.13;
const BODY_R = 0.45;         // the shoulder ring — two bodies never share ground
const BODY_DAMP = 0.86;      // slice of the closing speed contact eats: weight, not bounce
const BODY_BRACE = 0.4;      // a standing man's share of a shove — low, so he holds his spot
const SHOULDER_RANGE = 1.25; // close enough to be ON the man, ball or no ball
const SHIELD_WATCH = 2.4;    // how near an opponent must be to be shielded FROM
const ATTEND_RANGE = 25;     // how far a human's eyes stay on the ball at a walk
const OFFSIDE_GRACE = 0.35;  // level is onside — the flag needs daylight
export const DIVE_TIME = 0.42; // the keeper's beat in the air — his brain times the leap against it
const RESTART_PATIENCE = 5;  // seconds a placed ball may sit before the referee gets on with it
// The goal ceremony: the party, then the long walk back. Nothing teleports.
const CEREMONY = { celebrate: 4.2, walk: 6, grace: 2.5, ball: [9, 18] as const };

// How often the gloves beat the strike. Hands first — slower, closer, more
// agile is safer — then the thing that makes football football: he has to have
// SEEN it. A ball struck from eight meters is at him inside a third of a
// second, and no reflex closes that gap. This is why the six-yard finish is
// the best chance in the game and a thirty-yarder is a keeper's afternoon.
export function saveChance(pace: number, reachFrac: number, agility: number, flight = 1): number {
  const hands = clamp(1.3 - pace * 0.034 - reachFrac * 0.38 + (agility - 0.8) * 0.5, 0.05, 0.985);
  const hurry = clamp((pace - 8) / 11, 0, 1);   // under a jog's pace there is time to simply go and get it
  const read = clamp((flight - 0.16) / 0.62, 0, 1); // 0.16s is a blink; 0.78s is a good look
  return clamp(hands * (1 - hurry * (1 - read) * 0.92), 0.02, 0.985);
}

// What a keeper covers without leaving his feet: his own body, no more. The
// mouth of the goal is bought with the dive. His brain reads this exact number
// so "I cannot reach that standing" is one fact, not two guesses.
export function keeperStandingReach(agility: number): number {
  return 0.5 + agility * 0.3;
}

// One capped step along the line home — motion you can always watch happen
function moveToward(from: Vec2, to: Vec2, step: number): Vec2 {
  const away = sub(to, from);
  const d = len(away);
  return d <= step ? vec(to.x, to.y) : add(from, scale(away, step / d));
}

export class World {
  ball = new Ball();
  players: PlayerBody[] = [];
  surface: Surface = SURFACES.grass;
  events: SimEvent[] = [];
  score = { left: 0, right: 0 };
  // Who last played the ball — feeds restarts and pass-follow control
  lastTouch: { team: 0 | 1; idx: number } | null = null;
  // The possession war: who OWNS the ball right now. Latched by controlled
  // touches, dropped when the ball is played away or drifts out of his bubble.
  // An opponent inside the protect ring cannot osmose it — only clamp or lunge.
  carrier: { idx: number; t: number } | null = null;
  // One defender's jaws squeezing the carrier's ball — the hold-to-take duel
  clamp: { idx: number; close: number; graceT: number; feintRolled: boolean } | null = null;
  private looseClaimIdx: number | null = null; // loose balls go to whoever is genuinely FIRST
  restartLock = 0; // dead-ball beat after a restart is placed
  // The restart law: the other team gives the dead ball this much space
  restartExclusion = 0;
  private restartWait = 0; // how long the taker has been standing over it
  // Who takes the next kickoff — the toss winner opens, the conceder resumes
  kickoffTeam: 0 | 1 = 0;
  // Halftime fairness: teams swap ends at the break. EVERY direction in the
  // sim asks attackSign() — nobody hardcodes "team 0 goes right" anymore.
  sidesSwapped = false;
  // The training ground: one team on an open field — every restart and
  // kickoff is theirs, so the session never waits on a side that isn't there
  practice = false;
  // The flag. Staged sessions (drills, sandboxes) switch it off; a real match
  // never does.
  offsideEnabled = true;
  // The whistle. A spot kick re-stages the whole box, so a lesson that scripts
  // its own bodies switches it off rather than have the referee move them.
  foulsEnabled = true;
  // Which bodies a human is wearing this tick — the match sheet writes it.
  // The world reads it to know whose eyes need an attend point and whose legs
  // it may borrow for the walk back.
  humanIdxs = new Set<number>();
  // A goal is a chapter, not a cut: 'celebrate' is the window the scorers own,
  // 'walkback' walks all 22 to the kickoff arrangement on their own legs.
  ceremony: 'live' | 'celebrate' | 'walkback' = 'live';
  // Who is turning his back on whom right now — the FX read it, the clamp and
  // the lunge both pay for it
  shielding: { idx: number; from: number } | null = null;

  attackSign(team: 0 | 1): 1 | -1 {
    return (team === 0) !== this.sidesSwapped ? 1 : -1;
  }

  // The goal this team ATTACKS
  goalXOf(team: 0 | 1): number {
    return this.attackSign(team) > 0 ? PITCH.length : 0;
  }

  // The turnover: ends swap, and every body's home mirrors with them
  swapSides() {
    this.sidesSwapped = !this.sidesSwapped;
    for (const p of this.players) p.home.x = PITCH.length - p.home.x;
  }
  // An aiming keeper pins the beat open (capped — nobody stalls a match)
  holdLock = false;
  // Which keeper has the ball IN HAND right now (-1 = nobody) — set by a
  // catch or a pickup, cleared by his launch or the beat lapsing
  holdingGk = -1;
  private holdT = 0;
  private rng: Rng;
  private goalScored = false;
  private goalResetT = 0;
  // A goal buys the scorers a window to lose their minds before the spot
  celebration: { team: 0 | 1; scorer: number; t: number } | null = null;
  private foulCooldown = 0;      // the whistle stays occasional, never a fest
  private foulPending: { spot: Vec2; team: 0 | 1 } | null = null; // awarded at tick's end
  private lungeRolled = new Set<number>(); // one foul roll per lunge, not per tick
  private walkT = 0;             // how long the walk home has been going
  private walkTaker = -1;        // he walks to the SPOT instead of his slot
  // The flag, latched at the kick and only read by the FIRST touch of the flight
  private offsideLatch: { team: 0 | 1; kicker: number; flagged: { idx: number; x: number; y: number }[] } | null = null;
  private throwInPending = false; // a ball thrown back in can never play anyone offside

  // Every coin this world will ever flip comes from one seed: same seed, same
  // match, forever. Replays and headless tests both live on that promise.
  constructor(seed = 20260731) {
    this.rng = new Rng(seed);
  }

  step(dt: number, inputs: PlayerInput[]) {
    this.events.length = 0;
    this.foulCooldown = Math.max(0, this.foulCooldown - dt);
    this.ball.savePrev();
    for (const p of this.players) p.savePrev();

    // The walk home owns time — the ball is furniture until everyone is placed
    if (this.ceremony === 'walkback') this.restartLock = Math.max(this.restartLock, 0.08);

    const ballLive = this.restartLock <= 0;
    // The latch breathes: standing over your ball keeps it YOURS indefinitely;
    // knock it past the protect ring and the latch only survives the chase
    if (this.carrier) {
      const cb = this.players[this.carrier.idx];
      const dBall = dist(this.ball.pos, cb.pos);
      if (dBall <= CLAMP.protect && this.ball.z <= 1.2) this.carrier.t = 0.8;
      else this.carrier.t -= dt;
      if (this.carrier.t <= 0 || this.ball.z > 1.2 || dBall > 1.9) this.carrier = null;
    }
    this.looseClaimIdx = null;
    if (!this.carrier && ballLive) {
      let bestD = 1.7;
      this.players.forEach((p, i) => {
        if (p.touchCooldown > 0 || p.playLock > 0) return;
        const d = dist(p.pos, this.ball.pos);
        if (d < bestD) { bestD = d; this.looseClaimIdx = i; }
      });
    }
    this.players.forEach((p, i) => {
      const raw = inputs[i] ?? { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      const input = this.ceremony === 'walkback' ? this.walkHomeInput(p, i, raw) : this.attended(raw, p, i);
      // The leap is committed before the legs run, so the burst rides this tick
      if (ballLive && input.dive && p.id.role === 'GK') this.commitDive(p, i, input.dive);
      p.update(dt, input, this.events);
      if (p.lungeTimer <= 0) this.lungeRolled.delete(i);
      if (!ballLive) return;
      this.handleKick(p, input, dt, i);
      this.resolveLunge(p, i);
      this.handleDribble(p, input, i);
      this.collideBall(p, i);
    });
    if (ballLive) this.updateClamp(dt, inputs);
    this.resolveBodies();
    this.updateShield();

    // Nobody plays in the stands: bodies live on the pitch plus a whisker of
    // apron — except inside the goal mouth, where keepers chase balls in
    for (const p of this.players) {
      const inMouth = Math.abs(p.pos.y - PITCH.width / 2) < PITCH.goalWidth / 2 + 0.6;
      const xPad = inMouth ? PITCH.goalDepth : 0.4;
      p.pos.x = clamp(p.pos.x, -xPad, PITCH.length + xPad);
      p.pos.y = clamp(p.pos.y, -0.4, PITCH.width + 0.4);
    }

    if (ballLive) {
      this.ball.update(dt, this.surface, this.events);
      // Separate again after the ball has moved: every step ENDS with no body
      // overlapping the ball, so you can never run through it — and then prise
      // the shoulders back apart, because that keep-out push is the one thing
      // in the step that can bury one man in another after the solver has gone
      this.players.forEach((p, i) => this.collideBall(p, i));
      this.pryApart(false);
    } else {
      this.restartLock -= dt;
      if (this.holdLock && this.restartLock <= 0.05 && this.holdT < 10) {
        this.restartLock = 0.05; // the keeper is still picking his ball out
        this.holdT += dt;
      }
      if (this.restartLock <= 0) {
        this.holdLock = false;
        this.holdT = 0;
        this.holdingGk = -1;
      }
      this.ball.vel = vec();
      this.ball.savePrev();
    }
    // After the dead-ball beat has saved its frame, so the roll home renders
    if (this.ceremony === 'walkback') this.updateWalkback(dt);
    // The restart law holds until the ball is PLAYED, not just until the
    // beat ends — the taker owns his space for as long as he stands over it
    if (ballLive && this.restartExclusion > 0 && this.ball.speed() > 2) this.restartExclusion = 0;
    this.nudgeRestart(dt);
    if (this.restartExclusion > 0 && this.lastTouch) {
      for (const p of this.players) {
        if (p.id.team === this.lastTouch.team) continue;
        const away = sub(p.pos, this.ball.pos);
        const d = len(away);
        if (d < this.restartExclusion) {
          const out = d < 1e-6 ? vec(1, 0) : norm(away);
          const step = Math.min(12 * dt, this.restartExclusion - d);
          let nx = p.pos.x + out.x * step;
          let ny = p.pos.y + out.y * step;
          // The law never parks a body off the pitch or inside the goal
          // rigging: when the radial shove runs out of field, the body
          // SLIDES along the line around the ring instead of pinning
          if (nx < 0.4 || nx > PITCH.length - 0.4) {
            nx = clamp(nx, 0.4, PITCH.length - 0.4);
            ny += (ny >= this.ball.pos.y ? 1 : -1) * step;
          }
          if (ny < 0.4 || ny > PITCH.width - 0.4) {
            ny = clamp(ny, 0.4, PITCH.width - 0.4);
            nx += (nx >= this.ball.pos.x ? 1 : -1) * step;
          }
          p.pos.x = nx;
          p.pos.y = ny;
        }
      }
    }
    this.collideGoalFrames();
    this.settleFoul();   // the referee waits for the tick to finish moving
    this.checkOffside(); // the flag is raised BEFORE the net is credited
    this.handleGoalsAndBounds(dt);
  }

  // Human eyes: at a walk you watch the ball without turning your feet toward
  // it. Brains name their own attend point, so this only dresses seats — and
  // never while a kick is being aimed, where the body IS the sight.
  private attended(input: PlayerInput, p: PlayerBody, idx: number): PlayerInput {
    const dressed = this.pressing(input, p);
    if (!this.humanIdxs.has(idx) || dressed.attend || dressed.sprint || dressed.kickCharging) return dressed;
    if (dist(p.pos, this.ball.pos) > ATTEND_RANGE) return dressed;
    return { ...dressed, attend: this.ball.pos };
  }

  // Standing over a carrier's ball IS the clamp — nobody holds a button to do
  // what proximity already means. Everyone gets it, human and brain alike, so
  // pressing stays symmetric; the button is left with one honest job, the lunge.
  private pressing(input: PlayerInput, p: PlayerBody): PlayerInput {
    const latch = this.carrier;
    if (input.clamp || !latch || this.players[latch.idx].id.team === p.id.team) return input;
    if (dist(p.pos, this.ball.pos) > CLAMP.press) return input;
    return { ...input, clamp: true };
  }

  // A placed ball nobody has played yet — the clock owes these seconds back,
  // and the HUD has something honest to shout about
  get awaitingRestart(): boolean {
    return this.restartExclusion > 0;
  }

  // Somebody played it. Every strike, glove, shin and placement goes through
  // here so the ball's flight clock and its owner can never disagree.
  private touched(team: 0 | 1, idx: number) {
    this.lastTouch = idx >= 0 ? { team, idx } : null;
    this.ball.flight = 0;
  }

  // Nobody holds the game hostage. Past the referee's patience a dead ball is
  // squared off for its taker — the same "get on with it" a real official
  // produces, and the reason a kickoff handed to idle hands can never eat a half.
  private nudgeRestart(dt: number) {
    const taker = this.lastTouch;
    if (!taker || !this.awaitingRestart || this.restartLock > 0 || this.holdingGk >= 0 ||
        this.ceremony !== 'live' || this.ball.speed() > 1.5) {
      this.restartWait = 0; // a ball already moving is a game already going
      return;
    }
    this.restartWait += dt;
    if (this.restartWait < RESTART_PATIENCE) return;
    this.restartWait = 0;
    const from = this.ball.pos;
    const sign = this.attackSign(taker.team);
    let mate = -1;
    let best = Infinity;
    this.players.forEach((p, i) => {
      if (p.id.team !== taker.team || i === taker.idx || p.id.role === 'GK') return;
      const d = dist(p.pos, from);
      // square and short: the safe ball a taker plays when the referee looks over
      const cost = Math.abs(d - 11) - (p.pos.x - from.x) * sign * 0.35;
      if (cost < best) { best = cost; mate = i; }
    });
    const to = mate >= 0 ? this.players[mate].pos : vec(clamp(from.x + sign * 18, 4, PITCH.length - 4), from.y);
    const d = dist(from, to);
    const p = this.players[taker.idx];
    this.ball.vel = scale(d > 1e-4 ? norm(sub(to, from)) : vec(sign, 0), clamp(d * 1.4, 8, 22));
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.restartExclusion = 0;
    this.carrier = null;
    p.kickCooldown = 0.5;
    p.touchCooldown = 0.6;
    p.playLock = 0.3;
    this.latchOffside(taker.team, taker.idx);
    this.events.push({ kind: 'kick', x: from.x, y: from.y, power: 0.45, idx: taker.idx });
  }

  // Our keeper scoops up a ball played back into his hands: the game takes
  // the same breath as a catch, and he stands there picking his distribution.
  // No 'save' event — a backpass is housekeeping, not a stop.
  gkPickup(idx: number) {
    const p = this.players[idx];
    this.ball.pos = vec(p.pos.x + p.facing.x * 0.5, p.pos.y + p.facing.y * 0.5);
    this.ball.vel = vec();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.ball.savePrev();
    this.restartLock = 0.85;
    this.restartExclusion = 6.5;
    this.holdingGk = idx;
    this.touched(p.id.team, idx);
  }

  // Distribution from the keeper's hands: a THROW is flat and true, a PUNT is
  // a towering ball that lands somewhere in a scatter zone — his stats, his odds
  gkLaunch(idx: number, target: Vec2, kind: 'throw' | 'punt', scatter: number) {
    const p = this.players[idx];
    const ang = this.rng.next() * Math.PI * 2;
    const r = scatter * Math.pow(this.rng.next(), keeperCentering(p.stats.control));
    const land = vec(
      clamp(target.x + Math.cos(ang) * r, 1, PITCH.length - 1),
      clamp(target.y + Math.sin(ang) * r, 1, PITCH.width - 1),
    );
    const d = dist(this.ball.pos, land);
    const dir = d > 1e-4 ? norm(sub(land, this.ball.pos)) : vec(this.attackSign(p.id.team), 0);
    if (kind === 'throw') {
      this.ball.vel = scale(dir, clamp(9 + d * 0.42, 9, 24));
      this.ball.vz = 0.5;
    } else {
      const vz = 13.5; // a real punt HANGS — and can reach the far box
      const hang = (2 * vz) / GRAVITY;
      this.ball.vel = scale(dir, clamp((d / hang) * 1.04, 8, 75)); // 1.04 pays the air drag
      this.ball.vz = vz;
      this.ball.deadenOnLand = true; // it drops and sits, not skids into touch
    }
    this.ball.z = 1.1;
    this.ball.spin = 0;
    this.restartLock = 0;
    this.holdLock = false;
    this.holdT = 0;
    this.holdingGk = -1;
    this.restartExclusion = 0;
    p.kickCooldown = 0.5;
    p.touchCooldown = 0.6;
    this.touched(p.id.team, idx);
    this.latchOffside(p.id.team, idx); // hands play the game too — the flag watches them
    this.events.push({ kind: 'kick', x: this.ball.pos.x, y: this.ball.pos.y, power: kind === 'punt' ? 0.9 : 0.4, idx });
  }

  // The player currently in playing contact with the ball, if any
  possessor(): number | null {
    if (this.ball.z > 0.6) return null;
    let best: number | null = null;
    let bestD = 1.0;
    this.players.forEach((p, i) => {
      const d = dist(p.pos, this.ball.pos);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // A lunge in flight wins any ball it reaches — clean by design, no fouls.
  // The poke slips the ball SIDEWAYS past the carrier, never back into their
  // shins: a dispossession changes the play's direction, it doesn't ping-pong.
  private resolveLunge(p: PlayerBody, idx: number) {
    const gk = p.id.role === 'GK';
    const ceiling = gk ? (p.diveTimer > 0 && p.diveHeight === 1 ? 2.4 : 1.6) : 0.8;
    if (p.lungeTimer <= 0 || this.ball.z > ceiling) return;
    // Reach is the trade: agile hands for keepers, real DEFENDING for the rest.
    // A keeper standing on his feet covers his own body and nothing more — the
    // mouth of the goal is bought with the dive, and only with the dive.
    const reach = gk
      ? keeperStandingReach(p.stats.agility) + (p.diveTimer > 0 ? 0.75 + p.stats.dive * 0.75 : 0)
      : 0.8 + p.stats.defend * 0.45;
    const handsD = dist(p.pos, this.ball.pos);
    if (handsD > reach) {
      // Reaching the MAN but not his shielded ball IS the shoulder duel, and
      // the shield always swallows it — the ball is behind a body
      const latch = this.carrier;
      const shieldMan = latch && latch.idx !== idx && !gk ? this.players[latch.idx] : null;
      if (shieldMan && shieldMan.id.team !== p.id.team && dist(p.pos, shieldMan.pos) < SHOULDER_RANGE &&
          dist(this.ball.pos, shieldMan.pos) <= CLAMP.protect && this.shieldsBallFrom(shieldMan, p)) {
        this.maybeFoul(p, idx); // going through the man in the box still risks the spot
        this.bounceOffShield(p, shieldMan);
        return;
      }
      this.maybeFoul(p, idx); // flew past the ball — did he catch the man?
      return;
    }
    // A keeper's lunge is a CONTEST: hands versus pace. A slow ball at his
    // chest dies in the gloves; a rocket at full stretch gets fingertips at
    // best — and the worse he's beaten, the thinner the touch.
    if (gk) {
      const pace = Math.hypot(this.ball.speed(), this.ball.vz);
      const pCatch = saveChance(pace, clamp(handsD / reach, 0, 1), p.stats.agility, this.ball.flight);
      const roll = this.rng.next();
      const gathered = pace < 2.5 && handsD < reach * 0.7; // a ball dying at his chest is just picked up
      p.lungeTimer = 0;
      this.touched(p.id.team, idx);
      if (gathered || roll < pCatch) {
        this.ball.vel = vec();
        this.ball.z = 0;
        this.ball.vz = 0;
        this.ball.spin = 0;
        this.ball.savePrev();
        p.touchCooldown = 0.2;
        this.restartLock = 0.85;
        this.restartExclusion = 6.5;
        this.holdingGk = idx;
        this.carrier = null; // gloves end the war — nobody owns a held ball
        this.events.push({ kind: 'save', x: this.ball.pos.x, y: this.ball.pos.y });
      } else {
        const failFactor = (roll - pCatch) / Math.max(0.05, 1 - pCatch);
        const side = this.ball.pos.y >= PITCH.width / 2 ? 1 : -1;
        const turn = side * (0.55 + this.rng.next() * 0.4) * (1 - failFactor * 0.85);
        this.ball.vel = scale(rotate(norm(this.ball.vel), turn), this.ball.speed() * (0.42 + failFactor * 0.45));
        this.ball.vz = Math.max(this.ball.vz * 0.4, 1.8 * (1 - failFactor));
        this.ball.spin = 0;
        p.touchCooldown = 0.45;
        this.events.push({ kind: 'parry', x: this.ball.pos.x, y: this.ball.pos.y });
      }
      return;
    }
    // Against a LATCHED carrier the lunge is a shoulder duel, not a coin
    // pickup: physicality decides whether you strip it, poke it loose into a
    // scramble, or bounce clean off the shield and eat the recovery
    const latch = this.carrier;
    const heldBy = latch && latch.idx !== idx ? this.players[latch.idx] : null;
    const latched = !!heldBy && heldBy.id.team !== p.id.team &&
      dist(this.ball.pos, heldBy.pos) <= CLAMP.protect;
    if (latched) {
      const cb = heldBy!;
      // Arriving from behind the shield wins a shoulder, never the ball
      if (this.shieldsBallFrom(cb, p)) {
        this.bounceOffShield(p, cb);
        return;
      }
      const { atk, hold } = duelScores(p.stats, cb.stats);
      const margin = atk - hold + (this.rng.next() - 0.5) * 0.3;
      if (margin < -0.12) {
        // Bounced off — the Van Dijk moment. The ball stays glued to its owner.
        p.lungeTimer = 0;
        p.recoverTimer = 0.5;
        this.ball.vel = add(scale(cb.vel, 0.8), scale(norm(sub(this.ball.pos, p.pos)), 0.6));
        this.events.push({ kind: 'shrug', x: p.pos.x, y: p.pos.y });
        return;
      }
      if (margin < 0.1) {
        // Poked loose — nobody's prize, everybody's scramble
        const axis = norm(sub(cb.pos, p.pos));
        const toBall = sub(this.ball.pos, p.pos);
        const side = axis.x * toBall.y - axis.y * toBall.x >= 0 ? 1 : -1;
        this.ball.vel = add(scale(norm(add(scale(axis, 0.3), scale(perpRight(axis), side))), 5), scale(p.vel, 0.2));
        this.ball.spin = 0;
        p.lungeTimer = 0;
        p.touchCooldown = 0.3;
        cb.touchCooldown = Math.max(cb.touchCooldown, 0.3);
        this.carrier = null;
        this.touched(p.id.team, idx);
        return;
      }
    }
    let dir = p.speed() > 0.5 ? norm(p.vel) : p.facing;
    const carrierIdx = this.possessor();
    if (carrierIdx !== null && this.players[carrierIdx].id.team !== p.id.team) {
      const carrier = this.players[carrierIdx];
      const axis = norm(sub(carrier.pos, p.pos));
      const toBall = sub(this.ball.pos, p.pos);
      const side = axis.x * toBall.y - axis.y * toBall.x >= 0 ? 1 : -1;
      dir = norm(add(scale(axis, 0.55), scale(perpRight(axis), side * 0.85)));
    }
    this.ball.vel = add(scale(dir, 6.5), scale(p.vel, 0.2));
    this.ball.spin = 0;
    p.lungeTimer = 0;       // won it — no recovery penalty
    p.touchCooldown = 0.15; // and the ball is instantly yours to run onto
    this.carrier = null;    // stripped clean off the latch
    if (carrierIdx !== null && this.players[carrierIdx].id.team !== p.id.team) {
      // Beaten: the old carrier can't just re-tap it back — the win means something
      const carrier = this.players[carrierIdx];
      carrier.touchCooldown = Math.max(carrier.touchCooldown, 0.5);
      carrier.playLock = Math.max(carrier.playLock, 0.5);
    }
    this.touched(p.id.team, idx);
    this.events.push({ kind: 'steal', x: this.ball.pos.x, y: this.ball.pos.y });
  }

  // THE CLAMP: hold the tackle button near a latched carrier and chalk jaws
  // close around his ball — DEF+PHY squeezing against DRI+PHY+shielding. When
  // they meet, the take is clean; break the engagement and they fall open; a
  // skilled carrier FEINTS as they near closing and knocks them back. This is
  // defending as an intention: you are never stealing by accident.
  private updateClamp(dt: number, inputs: PlayerInput[]) {
    const latch = this.carrier;
    const cb = latch ? this.players[latch.idx] : null;
    const eligible = !!cb && dist(this.ball.pos, cb.pos) <= CLAMP.protect + 0.35 && this.ball.z <= 0.8;
    const engagedBy = (i: number) => {
      const p = this.players[i];
      return !!inputs[i]?.clamp && p.lungeTimer <= 0 && p.recoverTimer <= 0 &&
        dist(p.pos, this.ball.pos) <= CLAMP.engage + (this.clamp?.idx === i ? 0.4 : 0);
    };
    if (!this.clamp) {
      if (!eligible) return;
      let best = -1;
      let bestD = Infinity;
      this.players.forEach((p, i) => {
        if (p.id.team === cb!.id.team || !engagedBy(i)) return;
        const d = dist(p.pos, this.ball.pos);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0) return;
      this.clamp = { idx: best, close: 0, graceT: CLAMP.grace, feintRolled: false };
    }
    const cl = this.clamp;
    const def = this.players[cl.idx];
    const holding = eligible && def.id.team !== cb!.id.team && engagedBy(cl.idx);
    if (!holding) {
      cl.graceT -= dt;
      if (cl.graceT <= 0) {
        cl.close -= CLAMP.decay * dt;
        if (cl.close <= 0) this.clamp = null;
      }
      return;
    }
    cl.graceT = CLAMP.grace;
    cl.close += clampCloseRate(def.stats, cb!.stats, this.shieldsBallFrom(cb!, def)) * dt;
    if (cl.close >= CLAMP.feintAt && !cl.feintRolled && cb!.feintCooldown <= 0) {
      cl.feintRolled = true;
      if (this.rng.next() < cb!.stats.control * 0.78) {
        // The escape: a subtle cut AWAY from the jaws — momentum kept, ball along
        cl.close = 0.22;
        cb!.feintCooldown = 1.6;
        const lane = cb!.speed() > 0.6 ? norm(cb!.vel) : cb!.facing;
        const away = sub(cb!.pos, def.pos);
        let cut = perpRight(lane);
        if (cut.x * away.x + cut.y * away.y < 0) cut = scale(cut, -1);
        cb!.vel = add(cb!.vel, scale(cut, 3.4));
        // the ball RIDES the cut with him — an escape, never a giveaway
        this.ball.vel = add(scale(cb!.vel, 1.02), scale(cut, 0.8));
        this.events.push({ kind: 'feint', x: cb!.pos.x, y: cb!.pos.y, dx: cut.x, dy: cut.y });
      }
    }
    if (cl.close < CLAMP.feintReset) cl.feintRolled = false;
    if (cl.close >= 1) {
      // The jaws meet: a clean, earned take — the ball pops to the winner's feet
      const front = add(def.pos, scale(def.facing, 0.55));
      this.ball.pos = vec(front.x, front.y);
      this.ball.vel = scale(def.vel, 0.6);
      this.ball.z = 0;
      this.ball.vz = 0;
      this.ball.spin = 0;
      def.touchCooldown = 0.12;
      cb!.touchCooldown = Math.max(cb!.touchCooldown, 0.6);
      cb!.playLock = Math.max(cb!.playLock, 0.6);
      this.carrier = { idx: cl.idx, t: 0.8 };
      this.touched(def.id.team, cl.idx);
      this.events.push({ kind: 'steal', x: this.ball.pos.x, y: this.ball.pos.y });
      this.clamp = null;
    }
  }

  // The keeper commits: a burst along the side he chose, gloves live for the
  // whole flight, and a beat in the air where nothing can steer him. The dive
  // stat buys the reach; the catch is still the same old contest.
  private commitDive(p: PlayerBody, idx: number, dive: { dirY: -1 | 1; height: 0 | 1 }) {
    if (p.diveTimer > 0 || p.tackleCooldown > 0 || p.recoverTimer > 0) return;
    p.diveTimer = DIVE_TIME;
    p.diveHeight = dive.height;
    p.lungeTimer = DIVE_TIME; // the gloves are live for as long as he is in the air
    p.tackleCooldown = 1;
    p.vel = vec(p.vel.x * 0.35, dive.dirY * (8.2 + p.stats.dive * 4.4));
    this.events.push({ kind: 'gkDive', idx, dirY: dive.dirY, height: dive.height });
  }

  // The training ground's authority: cancel a pending goal ceremony so a
  // re-staged drill isn't teleported back to kickoff mid-lesson
  abortGoalReset() {
    this.clearCeremony();
  }

  // Every path that re-stages the game ends the ceremony where it stands
  private clearCeremony() {
    this.goalScored = false;
    this.goalResetT = 0;
    this.celebration = null;
    this.ceremony = 'live';
    this.walkT = 0;
    this.walkTaker = -1;
  }

  // Where the flag falls for this team's runs right now: the second-last
  // defender, never behind the halfway line. The chalk the renderer paints.
  offsideLineX(team: 0 | 1): number {
    const sign = this.attackSign(team);
    const axes = this.players
      .filter((p) => p.id.team !== team)
      .map((p) => (sign > 0 ? p.pos.x : PITCH.length - p.pos.x))
      .sort((a, b) => b - a);
    const line = Math.max(PITCH.length / 2, axes[1] ?? PITCH.length);
    return sign > 0 ? line : PITCH.length - line;
  }

  // The flag is latched at the KICK, never judged there: every attacker with
  // daylight beyond both the last line and the ball is marked, and only the
  // first touch of the flight decides whether the run was a goal or a lesson.
  // Throw-ins never latch; a keeper's hands do.
  private latchOffside(team: 0 | 1, kicker: number) {
    this.offsideLatch = null;
    if (this.throwInPending) {
      this.throwInPending = false;
      return;
    }
    if (!this.offsideEnabled || this.practice) return;
    const sign = this.attackSign(team);
    const axis = (x: number) => (sign > 0 ? x : PITCH.length - x);
    if (this.players.filter((p) => p.id.team !== team).length < 2) return;
    const line = axis(this.offsideLineX(team)) + OFFSIDE_GRACE;
    const ballLine = axis(this.ball.pos.x) + OFFSIDE_GRACE;
    const flagged: { idx: number; x: number; y: number }[] = [];
    this.players.forEach((p, i) => {
      if (p.id.team !== team || i === kicker || p.id.role === 'GK') return;
      const a = axis(p.pos.x);
      if (a > line && a > ballLine) flagged.push({ idx: i, x: p.pos.x, y: p.pos.y });
    });
    if (flagged.length) this.offsideLatch = { team, kicker, flagged };
  }

  // The whistle: this flight found the very man who was already beyond the
  // line. Anyone else touching it first — a teammate, a defender — waves it off.
  private checkOffside() {
    const latch = this.offsideLatch;
    if (!latch) return;
    const lt = this.lastTouch;
    if (!lt || lt.idx === latch.kicker) return; // still travelling
    const caught = lt.team === latch.team ? latch.flagged.find((f) => f.idx === lt.idx) : undefined;
    this.offsideLatch = null;
    if (!caught) return;
    const spot = vec(clamp(caught.x, 1, PITCH.length - 1), clamp(caught.y, 1, PITCH.width - 1));
    this.events.push({ kind: 'offside', x: spot.x, y: spot.y, idx: caught.idx });
    this.awardRestart(spot, latch.team === 0 ? 1 : 0, 'offside');
  }

  // Loose or heavy: true when nobody's latch protects the ball — the moment
  // an honest lunge or arrival is allowed to just take it
  ballExposed(): boolean {
    if (!this.carrier) return true;
    return dist(this.ball.pos, this.players[this.carrier.idx].pos) > CLAMP.protect;
  }

  // A lunge that misses the ball but arrives through the carrier is a foul.
  // Outside the box the referee waves play on — the arcade never stops
  // mid-pitch — and inside it the victim gets a free kick off the spot he was
  // felled on. No penalties. Keepers contest with hands and stay out of this.
  private maybeFoul(p: PlayerBody, idx: number, chance = 0.16) {
    if (!this.foulsEnabled || p.id.role === 'GK' || this.foulCooldown > 0) return;
    if (this.lungeRolled.has(idx)) return;
    const carrierIdx = this.possessor();
    if (carrierIdx === null) return;
    const carrier = this.players[carrierIdx];
    if (carrier.id.team === p.id.team || dist(p.pos, carrier.pos) > SHOULDER_RANGE) return;
    const defSign = this.attackSign(p.id.team);
    const boxDeep = defSign > 0 ? carrier.pos.x < 16.5 : carrier.pos.x > PITCH.length - 16.5;
    const inBox = boxDeep && Math.abs(carrier.pos.y - PITCH.width / 2) < 20.16;
    if (!inBox) return; // play on — no mid-pitch ceremony
    this.lungeRolled.add(idx);
    if (this.rng.next() > chance) return; // almost every late arrival gets away with it
    p.lungeTimer = 0;
    p.tackleCooldown = Math.max(p.tackleCooldown, 1.2);
    this.foulCooldown = 25; // the whistle is an event, not a rhythm
    // the victim goes DOWN — sprawled, shoved, and briefly out of the game.
    // Half theater, half truth: it sells the whistle and it's funny to watch.
    carrier.lungeTimer = Math.max(carrier.lungeTimer, 0.9);
    carrier.vel = add(carrier.vel, scale(norm(sub(carrier.pos, p.pos)), 3.6));
    carrier.touchCooldown = Math.max(carrier.touchCooldown, 0.8);
    this.events.push({ kind: 'tackle', x: carrier.pos.x, y: carrier.pos.y });
    this.foulPending = {
      spot: vec(clamp(carrier.pos.x, 1, PITCH.length - 1), clamp(carrier.pos.y, 1, PITCH.width - 1)),
      team: carrier.id.team,
    };
  }

  // The whistle lands at the END of the tick, once bodies and ball have had
  // their say — award it any earlier and the same tick's keep-out shove kicks
  // the placed ball straight back out of its own restart.
  private settleFoul() {
    const call = this.foulPending;
    if (!call) return;
    this.foulPending = null;
    this.awardRestart(call.spot, call.team, 'freekick');
    // the restart speaks first and the whistle last, so the banner keeps 'FOUL'
    this.events.push({ kind: 'foul', x: call.spot.x, y: call.spot.y });
  }

  // Bodies are BOUNDARIES: nobody runs through a defender. Whoever is DRIVING
  // into the contact is the one it stops — a braced shoulder barely gives, and
  // the heavier man gives less again — while the closing speed dies inside the
  // contact, so a collision lands like weight instead of pinging like a bumper.
  private resolveBodies() {
    this.pryApart(true);
  }

  // `contact` false is the relax pass: geometry only, for when something later
  // in the step (the ball keep-out) has shoved bodies back into each other.
  // The collision was already paid for; charging it twice would turn a jostle
  // into a handbrake.
  private pryApart(contact: boolean) {
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        const away = sub(b.pos, a.pos);
        const d = len(away);
        const overlap = BODY_R * 2 - d;
        if (overlap <= 0) continue;
        const n = d < 1e-6 ? vec(1, 0) : scale(away, 1 / d);
        const driveA = Math.max(0, a.vel.x * n.x + a.vel.y * n.y);
        const driveB = Math.max(0, -(b.vel.x * n.x + b.vel.y * n.y));
        const wA = (driveA + BODY_BRACE) / (0.6 + a.stats.phys);
        const wB = (driveB + BODY_BRACE) / (0.6 + b.stats.phys);
        const aShare = wA / (wA + wB);
        a.pos = sub(a.pos, scale(n, overlap * aShare));
        b.pos = add(b.pos, scale(n, overlap * (1 - aShare)));
        const closing = (b.vel.x - a.vel.x) * n.x + (b.vel.y - a.vel.y) * n.y;
        if (!contact || closing >= 0) continue;
        const kill = -closing * BODY_DAMP;
        a.vel = sub(a.vel, scale(n, kill * aShare));
        b.vel = add(b.vel, scale(n, kill * (1 - aShare)));
        this.rollShoulderFoul(a, i, b, j);
      }
    }
  }

  // Arriving at sprint pace into the back of a man shielding his ball is not
  // defending, it is a challenge — and inside the box the referee is watching
  private rollShoulderFoul(a: PlayerBody, ai: number, b: PlayerBody, bi: number) {
    const latch = this.carrier;
    if (!latch || (latch.idx !== ai && latch.idx !== bi)) return;
    const cb = latch.idx === ai ? a : b;
    const man = latch.idx === ai ? b : a;
    const idx = latch.idx === ai ? bi : ai;
    if (man.id.team === cb.id.team || man.bargeCooldown > 0) return;
    if (!man.isSprinting || man.speed() < cb.speed() + 1.5) return;
    if (!this.shieldsBallFrom(cb, man)) return;
    man.bargeCooldown = 1.2;
    this.maybeFoul(man, idx, 0.7);
  }

  // The turned back: the carrier's body sits between this man and the ball, so
  // there is a shoulder to go through before there is ever a ball to win
  private shieldsBallFrom(cb: PlayerBody, def: PlayerBody): boolean {
    return (this.ball.pos.x - cb.pos.x) * (cb.pos.x - def.pos.x) +
      (this.ball.pos.y - cb.pos.y) * (cb.pos.y - def.pos.y) > 0;
  }

  // The nearest opponent the latched carrier is currently screening off
  private updateShield() {
    this.shielding = null;
    const latch = this.carrier;
    if (!latch) return;
    const cb = this.players[latch.idx];
    if (dist(this.ball.pos, cb.pos) > CLAMP.protect || this.ball.z > 0.8) return;
    let bestD = SHIELD_WATCH;
    let from = -1;
    this.players.forEach((p, i) => {
      if (p.id.team === cb.id.team) return;
      const d = dist(p.pos, cb.pos);
      if (d < bestD && this.shieldsBallFrom(cb, p)) { bestD = d; from = i; }
    });
    if (from >= 0) this.shielding = { idx: latch.idx, from };
  }

  // A lunge that arrives on the wrong side of a shielding carrier buys a
  // shoulder and nothing else — the ball was never on offer
  private bounceOffShield(p: PlayerBody, cb: PlayerBody) {
    const back = dist(p.pos, cb.pos) < 1e-6 ? vec(1, 0) : norm(sub(p.pos, cb.pos));
    p.lungeTimer = 0;
    p.recoverTimer = 0.5;
    p.vel = add(scale(p.vel, 0.25), scale(back, 2.2));
    cb.vel = add(cb.vel, scale(back, -0.9)); // and the carrier feels it in his back
    this.events.push({ kind: 'shrug', x: p.pos.x, y: p.pos.y });
  }

  private handleKick(p: PlayerBody, input: PlayerInput, dt: number, idx: number) {
    if (input.kickReleased) {
      p.pendingKick = {
        power: input.kickReleased.power,
        bend: input.kickReleased.aimOffset ?? 0,
        aimAt: input.kickReleased.aimAt,
        ttl: KICK_BUFFER,
      };
    }
    if (!p.pendingKick) return;
    p.pendingKick.ttl -= dt;
    if (p.pendingKick.ttl <= 0) {
      p.pendingKick = null;
      return;
    }
    if (p.kickCooldown > 0) return;
    if (dist(p.pos, this.ball.pos) > KICK_RANGE || this.ball.z > 1.2) return;

    const inputPower = clamp(p.pendingKick.power, 0.1, 1);
    const power = inputPower * (0.75 + 0.25 * p.stats.power);
    const bend = clamp(p.pendingKick.bend, -AIM_BEND_MAX, AIM_BEND_MAX);
    const at = p.pendingKick.aimAt;
    p.pendingKick = null;
    // The stick IS the sight: hold any direction and the shot goes exactly
    // there. J/L bend the aim off that line — strike across the body without
    // breaking stride, and the cut across the ball CURLS its flight. A mouse
    // kick names a field POINT instead, and the ball leaves toward it.
    const toAt = at ? sub(at, this.ball.pos) : null;
    const aim = toAt && len(toAt) > 0.5
      ? norm(toAt)
      : rotate(len(input.move) > 0.25 ? norm(input.move) : p.facing, bend);
    // The cone made law: the ball samples inside the same wedge the sight
    // chalks — finishing governs balls driven at the mouth, passing governs
    // deliveries and decays toward the long-ball stat with intended distance,
    // and the pull blooms it all. Weak feet also misweight the pass.
    const shotness = goalness(this.ball.pos, aim, this.goalXOf(p.id.team), this.attackSign(p.id.team));
    const acc = kickAccuracy(p.stats, shotness, 8 + inputPower * 34);
    const theta = coneHalfAngle(acc, inputPower);
    // COMPLETELY random inside the wedge — any angle on the arc, equally
    // likely. No center bias: the cone you see is exactly the lottery you play.
    const dir = rotate(aim, (this.rng.next() * 2 - 1) * theta);

    // Driven, not ballooned: capped pace and a low arc that stays playable
    const speed = (10 + 14 * power) * (1 + this.rng.gauss() * 0.02 * (1 - acc));
    this.ball.deadenOnLand = false; // a fresh strike overrides any punt drop
    this.ball.vel = scale(dir, speed);
    this.ball.spin = bend * (0.5 + 0.5 * power) * 0.62;
    this.ball.vz = power > 0.4 ? (power - 0.4) * 7.5 : 0.4;
    this.ball.z = Math.max(this.ball.z, 0.01);
    p.kickCooldown = 0.4;
    // Short enough that a TAP-and-chase reconnects the moment you catch up —
    // the knock-past-and-go is a play, not a coin flip
    p.touchCooldown = 0.32;
    p.playLock = 0.45;
    this.carrier = null; // the ball is PLAYED — nobody owns a flying pass
    this.touched(p.id.team, idx);
    this.latchOffside(p.id.team, idx);
    this.events.push({ kind: 'kick', x: this.ball.pos.x, y: this.ball.pos.y, power, idx });
  }

  // Dribbling, built from nothing but real foot-to-ball contacts. Every touch
  // keeps a slice of the ball's momentum and adds push along the run, so
  // redirects ARC the way a ball comes off a boot — never snapping around a
  // pivot, never played from beyond a leg's reach. Between touches: free ball.
  private handleDribble(p: PlayerBody, input: PlayerInput, idx: number) {
    const justCut = p.justCut;
    p.justCut = false;
    if (this.ball.z > 0.6) return;
    const d = dist(p.pos, this.ball.pos);
    // The possession war's ground rules: a latched opponent's ball inside his
    // protect ring is NOT yours to osmose — win a clamp or a lunge. A heavy
    // touch is honest prey, and a loose ball belongs to whoever is truly first.
    const held = this.carrier ? this.players[this.carrier.idx] : null;
    if (held && this.carrier!.idx !== idx && held.id.team !== p.id.team &&
        dist(this.ball.pos, held.pos) <= CLAMP.protect) return;
    if (!held && this.looseClaimIdx !== null && this.looseClaimIdx !== idx) return;
    const touch = (cooldown: number, sprint = false) => {
      p.touchCooldown = cooldown;
      this.throwInPending = false; // the throw has been played; the flag watches all of it now
      this.ball.spin = 0; // any touch kills the curl
      this.touched(p.id.team, idx);
      this.carrier = { idx, t: 0.8 }; // a controlled touch is the latch
      this.events.push({ kind: 'touch', x: this.ball.pos.x, y: this.ball.pos.y, sprint });
    };

    // The chop: planting a hard cut with the ball at your feet knocks it
    // ACROSS the body onto the new running line — aimed at where you're going,
    // not just parallel to it, or you'd jog beside a ball you can't reach.
    // The plant foot strikes on its own timing, never blocked by the tap rhythm.
    if (justCut && d < CHOP_RANGE) {
      const ontoLane = norm(sub(add(p.pos, scale(p.cutDir, 1.6)), this.ball.pos));
      this.ball.vel = add(scale(this.ball.vel, MOMENTUM_KEPT), scale(ontoLane, p.speed() * 1.3 + 1.2));
      return touch(0.14);
    }

    // A fast body earns a longer engage window — at full tilt you cover the
    // ball's neighborhood in a couple of frames, and the boot must still get
    // there. Walking and sprinting collect with the SAME ease.
    const engage = CUSHION_RANGE + Math.max(0, p.speed() - 4) * 0.1 + (p.freshTouch > 0 ? 0.3 : 0);
    if (p.touchCooldown > 0 || d > engage) return;

    const rel = sub(this.ball.vel, p.vel);
    const toBall = sub(this.ball.pos, p.pos);
    const closing = d > 1e-6 ? -(rel.x * toBall.x + rel.y * toBall.y) / d : 0;
    const steer = len(input.move) > 0.3 ? norm(input.move) : p.speed() > 0.5 ? norm(p.vel) : p.facing;

    // A ball arriving with pace gets cushioned dead off the boot — dropped
    // into the stride you're STEERING, and released quickly so the very next
    // touch (a turn, a knock-on) comes without a dead beat. The trap is
    // FORGIVING: nearly all arriving pace dies, and the drop follows the
    // direction you're pressing — receive-and-turn is a play, not a coin flip.
    // Steering AGAINST your own stride (the 180 receive) also kills the drift
    // the ball would inherit from your body: it plants at the turn, with you.
    if (closing > 5) {
      // A ball from SOMEONE ELSE opens the fresh-touch beat: the next knocks
      // obey the stick almost completely, so receive-and-turn actually turns
      if (!this.lastTouch || this.lastTouch.idx !== idx) p.freshTouch = 0.28;
      const keep = 0.11 - 0.06 * p.stats.control;
      const pv = p.speed();
      const align = pv > 0.5 ? clamp((p.vel.x * steer.x + p.vel.y * steer.y) / pv, -1, 1) : 1;
      this.ball.vel = add(scale(p.vel, 0.62 + 0.38 * align), scale(rel, keep));
      this.ball.vel = add(this.ball.vel, scale(steer, pv > 0.8 ? 1.5 : 0.7));
      return touch(0.1);
    }

    // Turning with the ball: when it sits on the WRONG side of the new
    // direction, a straight knock would cannon it off your own shins and
    // ping-pong forever. Real feet DRAG it around: a stretched sole-roll along
    // the body ring toward the front of the run, then normal touches take over.
    // Only while genuinely steering — an idle body never stirs the ball.
    // The collect keeps up with the man: at a sprint the ball leaves the boot
    // faster, so the speed gate scales with the body or a full-tilt turn would
    // refuse the drag exactly when it's needed most
    const behind = d > 1e-6 && (toBall.x * steer.x + toBall.y * steer.y) / d < 0.1;
    if (behind && len(input.move) > 0.3 && d < COLLECT_RANGE && this.ball.speed() < Math.max(7.5, p.speed() * 1.25)) {
      // Aim the collect at a spot ahead-BESIDE the run, on the side the ball
      // already leans: its straight path skims the body ring, the roll-around
      // carries it to the front, and the pivot costs a beat of pace — you
      // turn around the ball, you don't outrun your own feet.
      const side = toBall.x * steer.y - toBall.y * steer.x >= 0 ? -1 : 1;
      const collectAt = add(add(p.pos, scale(steer, 0.9)), scale(perpRight(steer), side * 0.4));
      this.ball.vel = add(
        scale(this.ball.vel, 0.15),
        scale(norm(sub(collectAt, this.ball.pos)), Math.max(p.speed(), 3.4) * 0.95 + 1.6),
      );
      p.vel = scale(p.vel, 0.85);
      return touch(0.08);
    }

    const pSpeed = p.speed();
    if (pSpeed > 0.8) {
      // Soft taps at a jog keep it in stride; sprint knocks push it on ahead;
      // charging keeps it tucked under the plant foot for the strike.
      // Taps aim where you're STEERING, not where momentum drags you — press a
      // new direction mid-dribble and the next touch plays it that way, with a
      // stretched toe-poke reach while the ball is drifting off your new line.
      const veering = this.ball.speed() > 0.6 && angleBetween(this.ball.vel, steer) > 0.3;
      // A sprinting boot stretches for the ball — full pace never means losing
      // reach — and the fresh-touch beat stretches it further so the redirect
      // touch actually lands before the reception drifts away
      if (d > (veering ? STEER_RANGE : p.isSprinting ? SPRINT_REACH : CONTACT_RANGE) + (p.freshTouch > 0 ? 0.35 : 0)) return;
      const soft = p.isCharging || p.pendingKick;
      // Touches stay close: the ball works ahead of the boot, never away from it.
      // Sprint knocks ride barely past stride pace — glued, not booted ahead.
      // Sprint knocks sit barely past stride pace — the ball stays a boot-length
      // ahead, so full speed carries the same authority as a walk
      const target = pSpeed * (soft ? 0.95 : p.isSprinting ? 1.04 : 1.02) + (soft ? 0.2 : p.isSprinting ? 0.3 : 0.42);
      // Every touch CONVERGES on the dominant-foot lane — a point ahead-right
      // of the run — so a ball caught on the wrong foot or the edge of the
      // boot comes back across in a knock or two instead of bleeding away.
      // The cone cap keeps it a touch, not a tether: turn too hard, still lose it.
      const lane = add(add(p.pos, scale(steer, soft ? 0.8 : p.isSprinting ? 1.15 : 1.1)), scale(perpRight(steer), FOOT_LANE));
      const toLane = sub(lane, this.ball.pos);
      // Inside the fresh-touch beat the knock forgets the arrival: wider cone,
      // barely any inherited momentum — the ball goes where you're pressing
      const knockCone = p.freshTouch > 0 ? 1.35 : KNOCK_CONE;
      const kept = p.freshTouch > 0 ? 0.06 : MOMENTUM_KEPT;
      const knock = len(toLane) > 0.05
        ? rotate(steer, clamp(signedAngle(steer, toLane), -knockCone, knockCone))
        : steer;
      const wobble = this.rng.gauss() * (0.09 - 0.05 * p.stats.control);
      this.ball.vel = add(
        scale(this.ball.vel, kept),
        scale(rotate(knock, wobble), target * (1 - kept)),
      );
      touch(0.1, p.isSprinting);
    } else if (d < CONTACT_RANGE && this.ball.speed() > 1.0) {
      // Standing trap: kill most of the pace, let the rest roll off the boot
      this.ball.vel = add(scale(this.ball.vel, 0.25), scale(p.facing, 0.3));
      touch(0.28);
    }
  }

  // Bodies never pass through the ball: the keep-out ring sits just past the
  // ball's drawn edge, so what you see is what you collide with
  private collideBall(p: PlayerBody, idx: number) {
    const away = sub(this.ball.pos, p.pos);
    const d = len(away);
    if (d > BALL_KEEPOUT || this.ball.z > 1.5) return;
    // Brushing a latched opponent's ball claims nothing: no ownership flip,
    // no steering, no bulldozing it off his boot with your body ring. The
    // BALL owns its ground — the intruding BODY gives way instead.
    const held = this.carrier ? this.players[this.carrier.idx] : null;
    const protectedBall = !!held && this.carrier!.idx !== idx && held.id.team !== p.id.team &&
      dist(this.ball.pos, held.pos) <= CLAMP.protect;
    if (protectedBall) {
      const back = d < 1e-6 ? (p.speed() > 0.1 ? scale(norm(p.vel), -1) : vec(-1, 0)) : scale(norm(away), -1);
      p.pos = add(this.ball.pos, scale(back, BALL_KEEPOUT));
      return;
    }
    this.touched(p.id.team, idx);
    // Dead-centered overlap still resolves — shove it out along the run
    let push = d < 1e-6 ? (p.speed() > 0.1 ? norm(p.vel) : vec(1, 0)) : norm(away);
    // A moving body ROLLS the ball around toward the front of the run instead
    // of shoving it square off the boot — but only while this body may PLAY
    // the ball. Freshly dispossessed or mid-kick-recovery, separation is
    // purely radial: solid, never steering.
    const mayPlay = p.playLock <= 0;
    if (mayPlay && p.speed() > 0.5) push = norm(add(push, scale(norm(p.vel), 0.85)));
    this.ball.pos = add(p.pos, scale(push, BALL_KEEPOUT));
    const radialSpeed = this.ball.vel.x * push.x + this.ball.vel.y * push.y;
    if (radialSpeed < 0) {
      this.ball.vel = add(this.ball.vel, scale(push, -radialSpeed * 1.15));
    }
    // A body plowing into a slow ball knocks it along instead of ghosting it
    const approach = p.vel.x * push.x + p.vel.y * push.y;
    if (mayPlay && approach > 0 && radialSpeed < approach) {
      this.ball.vel = add(this.ball.vel, scale(push, (approach - Math.max(0, radialSpeed)) * 0.55));
    }
  }

  // The goal is FURNITURE: posts ping, side and back netting stop both bodies
  // and ball dead — nothing on the pitch walks or rolls through the rigging.
  // The mouth stays open, so shots score and keepers chase balls in.
  private collideGoalFrames() {
    for (const sgn of [-1, 1]) {
      const lineX = sgn < 0 ? 0 : PITCH.length;
      const backX = lineX + sgn * PITCH.goalDepth;
      const yFar = PITCH.width / 2 - PITCH.goalWidth / 2;
      const yNear = PITCH.width / 2 + PITCH.goalWidth / 2;
      const walls: [Vec2, Vec2][] = [
        [vec(backX, yFar), vec(backX, yNear)], // back net
        [vec(backX, yFar), vec(lineX, yFar)],  // far side net
        [vec(backX, yNear), vec(lineX, yNear)], // near side net
      ];

      for (const p of this.players) {
        for (const [a, b] of walls) this.pushOffWall(p.pos, p.vel, a, b, PLAYER_R, 0);
        for (const post of [vec(lineX, yFar), vec(lineX, yNear)]) {
          this.pushOffWall(p.pos, p.vel, post, post, PLAYER_R + 0.06, 0);
        }
      }
      if (this.ball.z < PITCH.goalHeight) {
        for (const [a, b] of walls) this.pushOffWall(this.ball.pos, this.ball.vel, a, b, BALL_R, 0.3);
        for (const post of [vec(lineX, yFar), vec(lineX, yNear)]) {
          // Off the woodwork! Posts ping instead of absorbing like net cord
          if (this.pushOffWall(this.ball.pos, this.ball.vel, post, post, BALL_R + 0.06, 0.72) && this.ball.speed() > 6) {
            this.events.push({ kind: 'post', x: this.ball.pos.x, y: this.ball.pos.y, impact: this.ball.speed() * 0.5 });
          }
        }
      }
    }
  }

  // Circle-vs-segment resolve: shove the body out and cancel (or reflect with
  // `rest`) the velocity component driving into the wall. Returns true on hit.
  private pushOffWall(pos: Vec2, vel: Vec2, a: Vec2, b: Vec2, radius: number, rest: number): boolean {
    const ab = sub(b, a);
    const abLen2 = ab.x * ab.x + ab.y * ab.y;
    const t = abLen2 < 1e-9 ? 0 : clamp(((pos.x - a.x) * ab.x + (pos.y - a.y) * ab.y) / abLen2, 0, 1);
    const closest = add(a, scale(ab, t));
    const away = sub(pos, closest);
    const d = len(away);
    if (d >= radius) return false;
    const n = d < 1e-6 ? vec(0, 1) : norm(away);
    pos.x = closest.x + n.x * radius;
    pos.y = closest.y + n.y * radius;
    const into = vel.x * n.x + vel.y * n.y;
    if (into < 0) {
      vel.x -= n.x * into * (1 + rest);
      vel.y -= n.y * into * (1 + rest);
    }
    return true;
  }

  private handleGoalsAndBounds(dt: number) {
    if (this.ceremony === 'walkback') return; // the ball is being walked home; nothing is in play
    const b = this.ball;
    const halfMouth = PITCH.goalWidth / 2;
    const inMouth = Math.abs(b.pos.y - PITCH.width / 2) < halfMouth && b.z < PITCH.goalHeight;

    if (!this.goalScored && inMouth && (b.pos.x < 0 || b.pos.x > PITCH.length)) {
      const side = b.pos.x < 0 ? 'left' : 'right';
      // whichever team ATTACKS the crossed line owns the goal — sides may swap
      const scoringTeam: 0 | 1 = (side === 'left') === (this.attackSign(0) < 0) ? 0 : 1;
      this.score[scoringTeam === 0 ? 'left' : 'right']++;
      this.goalScored = true;
      this.ceremony = 'celebrate';
      this.goalResetT = CEREMONY.celebrate; // the party owns this window before the walk
      const scorer = this.lastTouch?.idx ?? -1;
      this.celebration = { team: scoringTeam, scorer, t: this.goalResetT };
      this.kickoffTeam = scoringTeam === 0 ? 1 : 0; // the conceder restarts the game
      this.offsideLatch = null; // the flight ended in the net; no flag chases it
      this.events.push({ kind: 'goal', side, scorer });
      return;
    }

    if (this.goalScored) {
      // The net rigging catches it; the ball just dies in there while the
      // scorers wheel away — then everybody starts the walk home
      b.vel = scale(b.vel, 0.82);
      this.goalResetT -= dt;
      if (this.celebration) this.celebration.t = this.goalResetT;
      if (this.goalResetT <= 0 && b.speed() < 2) this.beginWalkback();
      return;
    }

    // Fast arcade restarts — the ball never bounces off invisible walls
    if (b.pos.y < -0.2) return this.awardRestart(vec(clamp(b.pos.x, 1, PITCH.length - 1), 0.3), this.throwInTeam(), 'throwin');
    if (b.pos.y > PITCH.width + 0.2) return this.awardRestart(vec(clamp(b.pos.x, 1, PITCH.length - 1), PITCH.width - 0.3), this.throwInTeam(), 'throwin');
    if (!inMouth && (b.pos.x < -0.25 || b.pos.x > PITCH.length + 0.25)) {
      const leftEnd = b.pos.x < 0;
      // the team DEFENDING the crossed end — honest across the halftime swap
      const defender: 0 | 1 = (this.attackSign(0) > 0) === leftEnd ? 0 : 1;
      // Training: your own end restarts from the keeper's hands, the far end
      // from the flag — goal kicks and corners both practicable, uncontested
      if (this.practice) {
        if (defender === 0) return this.awardRestart(vec(leftEnd ? 5.5 : PITCH.length - 5.5, PITCH.width / 2), 0, 'goalkick');
        const cx = leftEnd ? 0.4 : PITCH.length - 0.4;
        const cy = b.pos.y < PITCH.width / 2 ? 0.4 : PITCH.width - 0.4;
        return this.awardRestart(vec(cx, cy), 0, 'corner');
      }
      if (this.lastTouch && this.lastTouch.team === defender) {
        // Corner for the attackers, from the corner arc they earned
        const cx = leftEnd ? 0.4 : PITCH.length - 0.4;
        const cy = b.pos.y < PITCH.width / 2 ? 0.4 : PITCH.width - 0.4;
        return this.awardRestart(vec(cx, cy), defender === 0 ? 1 : 0, 'corner');
      }
      // Goal kick: the keeper plays out from the edge of the box
      return this.awardRestart(vec(leftEnd ? 5.5 : PITCH.length - 5.5, PITCH.width / 2), defender, 'goalkick');
    }
  }

  private throwInTeam(): 0 | 1 {
    if (this.practice) return 0; // the training ground has one set of hands
    return this.lastTouch ? (this.lastTouch.team === 0 ? 1 : 0) : 0;
  }

  // Place the ball dead, set the right taker walking onto it (the KEEPER for
  // goal kicks), and give the moment a broadcast beat before play resumes
  private awardRestart(spot: Vec2, team: 0 | 1, restart: 'throwin' | 'corner' | 'goalkick' | 'offside' | 'freekick') {
    this.offsideLatch = null;      // a dead ball ends every flight, flagged or not
    this.throwInPending = restart === 'throwin'; // nobody is ever offside from a throw
    let taker = -1;
    let bestD = Infinity;
    this.players.forEach((p, i) => {
      if (p.id.team !== team) return;
      const isGK = p.id.role === 'GK';
      if (restart === 'goalkick' ? !isGK : isGK) return;
      const d = dist(p.pos, spot);
      if (d < bestD) { bestD = d; taker = i; }
    });
    this.ball.pos = vec(spot.x, spot.y);
    this.ball.vel = vec();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.ball.savePrev();
    if (taker >= 0) {
      const p = this.players[taker];
      // BEHIND the ball, facing the field — his first step plays it inward,
      // never taps it back over the line he's restarting from. A free kick is
      // the exception: the man who was felled stands up looking at their goal.
      const inward = restart === 'freekick'
        ? vec(this.attackSign(team), 0)
        : norm(sub(vec(PITCH.length / 2, PITCH.width / 2), spot));
      p.pos = sub(vec(spot.x, spot.y), scale(inward, 1.0));
      p.vel = vec();
      p.facing = inward;
      p.savePrev();
      // A goal kick goes to the keeper's HANDS: he reads the field and
      // distributes like any collection — never a walked clearance
      if (restart === 'goalkick' && p.id.role === 'GK') this.holdingGk = taker;
    }
    this.restartLock = 1.25;
    this.restartExclusion = restart === 'goalkick' ? 11 : 6.5;
    this.touched(team, taker);
    this.events.push({ kind: 'restart', taker, team, restart });
  }

  // The party ends and the long walk begins: brains hush, the ball rolls back
  // to the circle, and all 22 take themselves to their kickoff marks on their
  // own legs. The taker walks to the SPOT, so the restart lands on nobody.
  private beginWalkback() {
    this.goalScored = false;
    this.celebration = null;
    this.ceremony = 'walkback';
    this.walkT = 0;
    if (this.practice) this.kickoffTeam = 0;
    this.walkTaker = this.kickoffTakerIdx();
  }

  // Where this body is walking: his kickoff mark, or the spot if he takes it
  private walkTargetOf(idx: number): Vec2 {
    const p = this.players[idx];
    return idx === this.walkTaker ? this.kickoffSpot() : vec(p.home.x, p.home.y);
  }

  // The world borrows the legs during the walk: brains are ignored, and a
  // human who isn't pressing anything drifts home with everyone else. Past the
  // cap the referee is waiting, so the stragglers hustle — and nobody, human
  // included, gets to hold the restart hostage.
  private walkHomeInput(p: PlayerBody, idx: number, raw: PlayerInput): PlayerInput {
    const late = this.walkT > CEREMONY.walk;
    if (!late && this.humanIdxs.has(idx) && len(raw.move) > 0.2) return raw;
    const to = sub(this.walkTargetOf(idx), p.pos);
    const d = len(to);
    // the last meters ease off, so nobody arrives by slamming into his mark
    return {
      move: d < 0.05 ? vec() : scale(to, Math.min(1, d / 1.4) / d),
      sprint: late,
      kickCharging: false,
      kickReleased: null,
    };
  }

  private updateWalkback(dt: number) {
    this.walkT += dt;
    const spot = vec(PITCH.length / 2, PITCH.width / 2);
    const ballD = dist(this.ball.pos, spot);
    this.ball.pos = moveToward(this.ball.pos, spot, clamp(ballD / 2, CEREMONY.ball[0], CEREMONY.ball[1]) * dt);
    this.ball.z = Math.max(0, this.ball.z - 3 * dt);
    let farthest = 0;
    this.players.forEach((p, i) => { farthest = Math.max(farthest, dist(p.pos, this.walkTargetOf(i))); });
    if ((farthest < 0.12 && ballD < 0.05) || this.walkT > CEREMONY.walk + CEREMONY.grace) this.kickoffReset();
  }

  // The most central forward of the kickoff team stands over the ball
  private kickoffTakerIdx(): number {
    let taker = -1;
    let bestC = Infinity;
    this.players.forEach((p, i) => {
      if (p.id.team !== this.kickoffTeam || p.id.role === 'GK') return;
      const c = Math.abs(p.home.y - PITCH.width / 2) - (p.id.role === 'FW' ? 100 : 0);
      if (c < bestC) { bestC = c; taker = i; }
    });
    return taker;
  }

  // His mark: a step behind the ball, on his own side of the halfway line
  private kickoffSpot(): Vec2 {
    return vec(PITCH.length / 2 - this.attackSign(this.kickoffTeam) * 1.5, PITCH.width / 2);
  }

  // Center spot, everyone home — and ONE player of the kickoff team stands
  // over the ball while the other side holds outside the circle. The game
  // starts when HE plays it, not with a scramble.
  kickoffReset() {
    if (this.practice) this.kickoffTeam = 0; // scored or conceded, you resume
    this.clearCeremony();
    this.offsideLatch = null;
    this.ball.pos = vec(PITCH.length / 2, PITCH.width / 2);
    this.ball.vel = vec();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.ball.savePrev();
    for (const p of this.players) {
      p.pos = vec(p.home.x, p.home.y);
      p.vel = vec();
      p.facing = vec(this.attackSign(p.id.team), 0);
      p.stamina = Math.max(p.stamina, 0.6);
      p.savePrev();
    }
    // The most central forward stands over the spot for his team — after a
    // walk back he is already standing there, so this only confirms the mark
    const taker = this.kickoffTakerIdx();
    if (taker >= 0) {
      const p = this.players[taker];
      p.pos = this.kickoffSpot();
      p.facing = vec(this.attackSign(this.kickoffTeam), 0);
      p.savePrev();
    }
    this.touched(this.kickoffTeam, taker);
    this.restartLock = 1.1;         // a kickoff beat before the next chapter
    this.restartExclusion = 9.15;   // the center circle belongs to the taker
    this.events.push({ kind: 'kickoff', team: this.kickoffTeam, taker });
  }
}
