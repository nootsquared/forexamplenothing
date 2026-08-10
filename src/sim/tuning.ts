import { clamp, Vec2 } from '../core/math';
import { PITCH } from './constants';
import { PlayerStats } from './player';

// One knob over every stat→feel curve. Shipped HOT on purpose: tiers should
// read leagues apart first and get trimmed from there — turning this down
// softens the whole game at once instead of twelve separate retunes.
export const INTENSITY = 1;

// The aim cone: tap-tight for everyone, blooming with the pull — and HOW FAST
// it blooms is the player. The ball lands UNIFORMLY inside it.
export const CONE = { min: 0.021, span: 0.5, gamma: 1.8 };

// Even the softest human touch is a real ball: every human kick — the charged
// boot, the mouse sling, the stick flick — rides the upper half of the range.
export const HUMAN_KICK_FLOOR = 0.45;
// The kick as the HAND feels it: 0 is the gentlest human ball, 1 is the stick
// buried to the pin. The sight colours off this, not off raw power, so the
// arrow spends its life in the middle of the range instead of pinned hot.
export const pullOf = (power: number) => clamp((power - HUMAN_KICK_FLOOR) / (1 - HUMAN_KICK_FLOOR), 0, 1);

export function coneHalfAngle(acc: number, inputPower: number): number {
  const p = clamp((inputPower - 0.1) / 0.9, 0, 1);
  return CONE.min + CONE.span * INTENSITY * Math.pow(1 - clamp(acc, 0.02, 0.99), 1.15) * Math.pow(p, CONE.gamma);
}

// How much of a SHOT this kick is: 1 aimed square at the mouth in range,
// easing to 0 as the line drifts wide or the range stretches. SMOOTH on
// purpose — the arc must never snap size while an aim sweeps past the goal.
export function goalness(ballPos: Vec2, aimDir: Vec2, goalX: number, sign: 1 | -1): number {
  const fwd = aimDir.x * sign;
  if (fwd <= 0.05) return 0;
  const distX = Math.abs(goalX - ballPos.x);
  if (distX > 42) return 0;
  const yAtLine = ballPos.y + (aimDir.y / Math.max(0.2, Math.abs(aimDir.x))) * distX;
  const off = Math.abs(yAtLine - PITCH.width / 2) - PITCH.goalWidth / 2;
  const aimK = clamp(1 - off / 8, 0, 1);
  const distK = clamp((42 - distX) / 6, 0, 1);
  const fwdK = clamp((fwd - 0.05) / 0.2, 0, 1);
  return aimK * distK * fwdK;
}

// Which accuracy governs a kick: passing that decays toward the LONG-BALL
// stat with intended distance, blended toward FINISHING by how squarely the
// mouth is the target — one continuous number, no cliffs
export function kickAccuracy(stats: PlayerStats, shotness: number, intendDist: number): number {
  const longness = clamp((intendDist - 14) / 26, 0, 1);
  const t = longness * longness * (3 - 2 * longness);
  const passAcc = stats.pass * (1 - t) + Math.min(stats.pass, stats.longBall) * t;
  return passAcc + (stats.shoot - passAcc) * clamp(shotness, 0, 1);
}

// Everything the sight needs to chalk an honest wedge for one armed kick
export function kickSight(stats: PlayerStats, ballPos: Vec2, aimDir: Vec2, inputPower: number, goalX: number, sign: 1 | -1) {
  const shotness = goalness(ballPos, aimDir, goalX, sign);
  const acc = kickAccuracy(stats, shotness, 8 + inputPower * 34);
  return { theta: coneHalfAngle(acc, inputPower), acc, shotness };
}

// The keeper's hands are the ACCURATE option — a throw is near-laser, a punt
// drops close. The sight that chalks the zone and the sim that rolls the ball
// read the SAME two numbers here: a keeper launched over the wire must scatter
// exactly like the cone his captain was shown.
export function keeperScatter(kind: 'throw' | 'punt', d: number, control: number): number {
  return kind === 'throw'
    ? (0.15 + d * 0.012) * (1.2 - control * 0.55)
    : (0.7 + d * 0.028) * (1.3 - control * 0.55);
}

// How hard those misses hug the target — higher is tighter
export function keeperCentering(control: number): number {
  return 0.5 + 0.6 * control;
}

// The clamp: hold-to-take. Chalk jaws close around a latched carrier's ball;
// when they meet, the take is clean. Stealing is a DUEL now, never osmosis.
export const CLAMP = {
  engage: 2.6,     // how close the squeezing defender must stay to the ball
  press: 1.9,      // ...and how close he must be for the jaws to close on their
                   // own. Tighter than engage on purpose: brushing past a man
                   // is not pressing him, or every loose 7v7 seizes up
  pressMan: 1.8,   // being next to the MAN arms them too — his touch running
                   // ahead of him is not an excuse to stop pressing him
  carry: 2.0,      // how far his ball may run and still be his to squeeze. A
                   // sprint knocks it past the protect ring every touch; the
                   // jaws holding only inside that ring is why they kept quitting

  protect: 1.1,    // the carrier's controlled bubble — beyond it the ball is honest prey
  decay: 1.5,      // jaws fall open per second once the engagement breaks
  grace: 0.35,     // beat of forgiveness before a broken engagement decays
  feintAt: 0.65,   // closure that forces the carrier's escape roll
  feintReset: 0.5, // dropping back under here re-arms the roll
};

// A back turned into the challenge is worth more than any stat: the jaws
// crawl, and a lunge from that side never finds the ball at all.
export const SHIELD_CLAMP = 0.45;

// Ground the committed burst covers before the boot ever arrives
// The burst a lunge carries. Widened from 1.25: the window it paints was so
// tight the red diamond flickered past unseen, and a signal nobody catches is
// a mechanic nobody has. This is ONE number on purpose — the diamond, the
// boot's reach and the referee's late-arrival ruler all move together, so a
// window you can finally see is a challenge that can actually land.
const LUNGE_TRAVEL = 1.9;

// How far a lunging boot reaches — the only ruler a challenge is measured with
export function lungeReach(defend: number): number {
  return 0.8 + defend * 0.45;
}

// ...and how far the burst carries it: the window the red diamond paints, and
// the same number the referee judges a late arrival against
export function lungeWindowReach(defend: number): number {
  return lungeReach(defend) + LUNGE_TRAVEL;
}

// How fast the jaws close: the defender's trade against the carrier's hold.
// A striker's clamp barely moves; gold DF on a gray carrier snaps shut in ~1s.
export function clampCloseRate(defender: PlayerStats, carrier: PlayerStats, shielded: boolean): number {
  const squeeze = 0.22 + defender.defend * 1.35 * INTENSITY;
  const resist = 0.55 + carrier.control * 0.55 + carrier.phys * 0.5;
  return (squeeze / resist) * (shielded ? SHIELD_CLAMP : 1);
}

// The shoulder duel a lunge buys against a latched carrier's OPEN side:
// attack beats hold and the poke is clean; near-even pokes it loose; lose big
// and you bounce off. The shielded side is not a duel — it is a wall.
export function duelScores(defender: PlayerStats, carrier: PlayerStats) {
  return {
    atk: defender.defend * 0.5 + defender.phys * 0.3,
    hold: carrier.control * 0.35 + carrier.phys * 0.45,
  };
}
