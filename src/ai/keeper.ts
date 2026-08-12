import { Vec2, add, clamp, dist, len, norm, scale, sub, vec } from '../core/math';
import { GRAVITY, PITCH } from '../sim/constants';
import { PlayerBody, PlayerInput } from '../sim/player';
import { DIVE_TIME, World, keeperStandingReach } from '../sim/world';
import { TeamBrain } from './blackboard';

// The keeper is his own animal — a state machine on his line, not a utility
// brain. He cuts the angle, pushes up when the game lives up the pitch, paces
// his six yards so he reads awake, PLANTS his feet the moment a man turns on
// him, and leaves the ground only for a ball he can genuinely reach. A ball
// across his face buys a re-set beat: switching the point is exactly how a
// keeper is beaten, and the tutorial teaches that lesson on purpose.
//
// He watches the play with his own eyes — no belief table out here, he is
// looking straight at it.

const SET_RANGE = 20;     // a man on the ball this close, facing the mouth, plants him
const RESET_BEAT = 0.45;  // seconds of finding his feet after a ball crosses the face
const DIVE_LOCK = 0.9;    // one shot buys one leap
// Nobody's nervous system is faster than this. An elite keeper shaves the top
// off it and no further, which is precisely why a striker's job is to get
// close: inside the reaction floor the leap starts after the ball has gone.
const REACT_FLOOR = 0.22;

interface ShotRead {
  t: number;      // seconds until it reaches the line
  crossY: number; // where it crosses the mouth
  crossZ: number; // and how high
}

export class KeeperMind {
  private reactT = 0;
  private resetT = 0;
  private diveLock = 0;
  private lastSide = 0;
  private pace: number;

  constructor(idx: number) {
    this.pace = idx * 1.37; // two keepers never shuffle on the same beat
  }

  // Everything his feet do in one tick — the brain hands him the body
  steer(world: World, me: PlayerBody, bb: TeamBrain, dt: number, input: PlayerInput) {
    const ball = world.ball.pos;
    const goal = bb.goalWeDefend();
    const goalDist = dist(ball, goal);
    const mid = PITCH.width / 2;
    this.pace += dt;
    this.resetT = Math.max(0, this.resetT - dt);
    this.diveLock = Math.max(0, this.diveLock - dt);
    input.attend = ball; // his eyes never leave it

    // The ball crossing his face costs him a beat: he has to find his feet
    // before he can push off them again
    const side = ball.y >= mid ? 1 : -1;
    if (this.lastSide !== 0 && side !== this.lastSide && goalDist < 26 && Math.abs(world.ball.vel.y) > 6) {
      this.resetT = RESET_BEAT;
    }
    this.lastSide = side;

    const shot = this.readShot(world, bb);
    if (shot) {
      this.reactT += dt;
      this.block(world, me, shot, input);
      return;
    }
    this.reactT = 0;

    // A slow ball dying near his goal is HIS — he comes and takes it. He picks
    // it UP; he never shepherds it, which is how keepers dribble balls over
    // their own line. And a BACKPASS is no less his ball: the old possession
    // gate here is exactly how a keeper stood scooting sideways while his own
    // team rolled one past him. Only a teammate actually dribbling it (latched)
    // is left alone.
    const mateLatched = world.carrier !== null &&
      world.players[world.carrier.idx].id.team === bb.team;
    if (goalDist < 11 && world.ball.speed() < 6.5 && world.ball.z < 1.6 && !mateLatched) {
      const theirs = world.carrier && world.players[world.carrier.idx].id.team !== bb.team;
      input.move = norm(sub(ball, me.pos));
      input.sprint = true;
      if (dist(me.pos, ball) < 1.35 && !theirs && me.tackleCooldown <= 0) input.tackle = true;
      return;
    }

    // A corner against him is not an angle to cut: he sets in the middle of
    // his mouth, a step off the line, and waits for the ball to come to him
    const corner = bb.corner;
    if (corner && corner.team !== bb.team && !corner.struck) {
      const set = vec(goal.x + (goal.x < PITCH.length / 2 ? 1.5 : -1.5), mid + (ball.y < mid ? -0.9 : 0.9));
      const step = sub(set, me.pos);
      if (len(step) > 0.5) input.move = scale(norm(step), 0.55);
      return;
    }

    // Angle first: stand on the ball-goal line, as far off it as the danger
    // allows. Far ball, high line — he sweeps behind his defenders instead of
    // watching the game from his six-yard box.
    const planted = this.threatened(world, bb) && this.resetT <= 0;
    const depth = goalDist < 14 ? 0.9 + goalDist * 0.09 : clamp(2.2 + (goalDist - 14) * 0.14, 2.2, 11);
    const line = norm(sub(ball, goal));
    const target = add(goal, scale(line, depth));
    // Idle is not frozen: with the game up the other end he works his line,
    // a slow shuffle across the mouth so he always reads alive
    if (!planted && goalDist > 26) {
      target.y += Math.sin(this.pace * 0.75) * 0.85;
      target.x += Math.cos(this.pace * 0.41) * 0.4;
    }
    const patrol = PITCH.goalWidth / 2 + 1.6; // he covers the near-post angle, never the corner flag
    target.y = clamp(target.y, mid - patrol, mid + patrol);
    target.x = clamp(target.x, 0.35, PITCH.length - 0.35);

    const to = sub(target, me.pos);
    const d = len(to);
    if (planted) {
      // Feet SET: he shuffles only when he is genuinely in the wrong place
      if (d > 1.1) input.move = scale(norm(to), 0.5);
      return;
    }
    if (d > 0.12) {
      input.move = scale(norm(to), clamp(d / 1.5, 0.3, 1));
      input.sprint = d > 4;
    }
  }

  // Attack the line of flight and pick the moment to leave the ground. Every
  // timing here is measured against the ball reaching HIM, not the goal line —
  // he stands meters off it, and a leap timed to the chalk lands far too late.
  private block(world: World, me: PlayerBody, shot: ShotRead, input: PlayerInput) {
    const b = world.ball;
    const dirHat = norm(b.vel);
    const rel = sub(me.pos, b.pos);
    const along = Math.max(0.5, rel.x * dirHat.x + rel.y * dirHat.y);
    const intercept: Vec2 = add(b.pos, scale(dirHat, along));
    input.move = norm(sub(intercept, me.pos));
    input.sprint = true;

    // Seconds until it is on him — never past the moment it reaches his line,
    // so a ball crawling almost parallel to the goal can't hand him a horizon
    // measured in minutes and freeze his hands waiting for it.
    const mine = clamp((me.pos.x - b.pos.x) / b.vel.x, 0, shot.t);
    const gap = b.pos.y + b.vel.y * mine - me.pos.y;
    const reach = 1.15 + me.stats.dive * 2.1 + mine * me.stats.topSpeed * 0.3;
    const onTarget = Math.abs(shot.crossY - PITCH.width / 2) < PITCH.goalWidth / 2 + 0.6;
    // Read it, then WAIT. A leap thrown the instant he recognises a shot lands
    // and dies before a thirty-yarder ever arrives. Anything his feet cannot
    // cover is worth leaving them for; anything they can, he simply stands up to.
    const standing = keeperStandingReach(me.stats.agility);
    const leaping = onTarget && Math.abs(gap) > standing * 0.7 && Math.abs(gap) < reach;
    if (leaping && this.diveLock <= 0 && this.resetT <= 0 && mine <= DIVE_TIME * 0.8 &&
        this.reactT >= REACT_FLOOR + (1 - me.stats.reflex) * 0.14) {
      input.dive = { dirY: gap >= 0 ? 1 : -1, height: shot.crossZ > 1.15 ? 1 : 0 };
      this.diveLock = DIVE_LOCK;
      return;
    }
    // Hands go out only for a ball already inside them. A speculative paw
    // spends the exact beat the leap needs — a keeper caught reaching at air
    // has thrown the save away before the ball ever arrived.
    if (!leaping && dist(me.pos, b.pos) < standing + b.speed() * 0.025 && me.tackleCooldown <= 0) {
      input.tackle = true;
    }
  }

  // Is that ball actually coming at my goal, and where will it cross my line?
  private readShot(world: World, bb: TeamBrain): ShotRead | null {
    const b = world.ball;
    const speed = b.speed();
    if (speed < 3.5) return null; // a ball rolling at goal is still a ball rolling at goal
    const goal = bb.goalWeDefend();
    const toGoal = sub(goal, b.pos);
    const range = len(toGoal);
    if (range > 24 || Math.abs(b.vel.x) < 1e-3) return null;
    if ((b.vel.x * toGoal.x + b.vel.y * toGoal.y) / (speed * (range + 1e-6)) < 0.55) return null;
    const t = (goal.x - b.pos.x) / b.vel.x;
    if (t <= 0 || t > 2) return null;
    return {
      t,
      crossY: b.pos.y + b.vel.y * t,
      crossZ: Math.max(0, b.z + b.vz * t - 0.5 * GRAVITY * t * t),
    };
  }

  // A man on the ball inside twenty meters, turned toward the mouth
  private threatened(world: World, bb: TeamBrain): boolean {
    const i = world.possessor();
    if (i === null) return false;
    const p = world.players[i];
    if (p.id.team === bb.team) return false;
    const goal = bb.goalWeDefend();
    if (dist(p.pos, goal) > SET_RANGE) return false;
    const to = norm(sub(goal, p.pos));
    return p.facing.x * to.x + p.facing.y * to.y > 0.3;
  }
}
