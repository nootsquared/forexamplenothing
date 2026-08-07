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

export function coneHalfAngle(acc: number, inputPower: number): number {
  const p = clamp((inputPower - 0.1) / 0.9, 0, 1);
  return CONE.min + CONE.span * INTENSITY * Math.pow(1 - clamp(acc, 0.02, 0.99), 1.15) * Math.pow(p, CONE.gamma);
}

// A ball driven at the mouth within shooting range is a SHOT — judged on the
// INTENDED line, before the cone rolls, so the wedge can tell you beforehand
export function aimsAtGoal(ballPos: Vec2, aimDir: Vec2, goalX: number, sign: 1 | -1): boolean {
  if (aimDir.x * sign < 0.25) return false;
  const distX = Math.abs(goalX - ballPos.x);
  if (distX > 40) return false;
  const yAtLine = ballPos.y + (aimDir.y / Math.abs(aimDir.x)) * distX;
  return Math.abs(yAtLine - PITCH.width / 2) < PITCH.goalWidth / 2 + 3;
}

// Which accuracy governs a kick: finishing at the mouth, short-passing close,
// and decaying toward the LONG-BALL stat as the intended delivery stretches —
// a defender's ten-meter ball is crisp while his fifty-meter rake is a prayer
export function kickAccuracy(stats: PlayerStats, isShot: boolean, intendDist: number): number {
  if (isShot) return stats.shoot;
  const longness = clamp((intendDist - 14) / 26, 0, 1);
  const t = longness * longness * (3 - 2 * longness);
  return stats.pass * (1 - t) + Math.min(stats.pass, stats.longBall) * t;
}

// Everything the sight needs to chalk an honest wedge for one armed kick
export function kickSight(stats: PlayerStats, ballPos: Vec2, aimDir: Vec2, inputPower: number, goalX: number, sign: 1 | -1) {
  const isShot = aimsAtGoal(ballPos, aimDir, goalX, sign);
  const acc = kickAccuracy(stats, isShot, 8 + inputPower * 34);
  return { theta: coneHalfAngle(acc, inputPower), acc, isShot };
}

// The clamp: hold-to-take. Chalk jaws close around a latched carrier's ball;
// when they meet, the take is clean. Stealing is a DUEL now, never osmosis.
export const CLAMP = {
  engage: 2.6,     // how close the squeezing defender must stay to the ball
  protect: 1.1,    // the carrier's controlled bubble — beyond it the ball is honest prey
  decay: 1.5,      // jaws fall open per second once the engagement breaks
  grace: 0.35,     // beat of forgiveness before a broken engagement decays
  feintAt: 0.65,   // closure that forces the carrier's escape roll
  feintReset: 0.5, // dropping back under here re-arms the roll
};

// How fast the jaws close: the defender's trade against the carrier's hold.
// A striker's clamp barely moves; gold DF on a gray carrier snaps shut in ~1s.
export function clampCloseRate(defender: PlayerStats, carrier: PlayerStats, shielded: boolean): number {
  const squeeze = 0.22 + defender.defend * 1.35 * INTENSITY;
  const resist = 0.55 + carrier.control * 0.55 + carrier.phys * 0.5 + (shielded ? 0.5 : 0);
  return squeeze / resist;
}

// The shoulder duel a lunge buys against a latched carrier: attack beats hold
// and the poke is clean; near-even pokes it loose; lose big and you bounce off
export function duelScores(defender: PlayerStats, carrier: PlayerStats, shielded: boolean) {
  return {
    atk: defender.defend * 0.5 + defender.phys * 0.3,
    hold: carrier.control * 0.35 + carrier.phys * 0.45 + (shielded ? 0.2 : 0),
  };
}
