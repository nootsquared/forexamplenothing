import { Vec2, add, clamp, dist, len, scale, sub } from '../core/math';

// The one mental model every brain shares: can that ball beat that man to
// that patch of grass. Passing, run scoring, cover positions and the cursor's
// interception election all ask these two questions and nothing else.

const OPP_EST_SPEED = 7.1; // how fast everyone assumes an opponent can run — mean of the widened pace band
const OPP_REACTION = 0.25; // seconds before that opponent gets moving

// Where do the ball and a moving receiver actually MEET? Solves the classic
// intercept: receiver keeps running his line, the ball leaves now at
// ballSpeed — aim at the meeting point, not at where he's standing.
export function leadTarget(from: Vec2, receiverPos: Vec2, receiverVel: Vec2, ballSpeed: number): Vec2 {
  const R = sub(receiverPos, from);
  const a = receiverVel.x * receiverVel.x + receiverVel.y * receiverVel.y - ballSpeed * ballSpeed;
  const b = 2 * (R.x * receiverVel.x + R.y * receiverVel.y);
  const c = R.x * R.x + R.y * R.y;
  let t: number | null = null;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r1 = (-b - Math.sqrt(disc)) / (2 * a);
      const r2 = (-b + Math.sqrt(disc)) / (2 * a);
      t = r1 > 0.05 ? r1 : r2 > 0.05 ? r2 : null;
    }
  }
  const tt = clamp(t ?? len(R) / ballSpeed, 0.05, 1.6);
  return add(receiverPos, scale(receiverVel, tt));
}

// Seconds of margin the fastest known defender leaves on a pass along
// from→to at ballSpeed: positive = it arrives first, negative = cut out.
// This is every player's mental model of "can THAT guy get there before my
// ball does" — pure, shared, and testable.
export function passMargin(from: Vec2, to: Vec2, ballSpeed: number, opponents: Vec2[]): number {
  const ab = sub(to, from);
  const L = len(ab);
  if (L < 1e-4) return 9;
  const dir = scale(ab, 1 / L);
  let worst = 9;
  for (const opp of opponents) {
    const along = clamp((opp.x - from.x) * dir.x + (opp.y - from.y) * dir.y, 1, L - 0.4);
    const point = add(from, scale(dir, along));
    const ballT = along / ballSpeed;
    const oppT = dist(opp, point) / OPP_EST_SPEED + OPP_REACTION;
    worst = Math.min(worst, oppT - ballT);
  }
  return worst;
}
