import { makeCanvas } from './lib.mjs';
import { renderScene, rotScene, rotX, rotZ, sphere, capsule } from './iso3d.mjs';

// Where every animation lives in the strip. The renderer reads this straight
// off the manifest, so adding a cycle is a pose function plus a row here.
export const ANIMS = {
  idleStart: 0, idleLen: 2,
  runStart: 2, runLen: 8,
  kickStart: 10, kickLen: 3,
  lunge: 13, recover: 14,
  // sideways travel: three phases, the -x block first then the +x block
  shuffleStart: 15, shuffleLen: 3, shuffleSideStride: 3,
  celebStart: 21, celebLen: 6,
  // the keeper's leap: six stages per side, same -x-then-+x blocking
  diveStart: 27, diveSideStride: 6,
  diveStage: { launch: 0, low: 1, high: 2, catch: 3, parry: 4, land: 5 },
};

export const FRAME_W = 48; // wide enough for a full-stretch dive broadside
export const FRAME_H = 48;
export const BASELINE = 34; // world origin (the feet) inside the frame
export const DIRS = 16;     // full compass — heading angle picks the nearest row
export const FRAMES = ANIMS.diveStart + ANIMS.diveSideStride * 2;

const S = 16; // bake px per meter, matches the pitch
const BOOT = '#211d1c';

// The player is a small, skinny 3D body — a real rig of capsules posed per
// frame, spun to 16 headings and raytraced. 22 of these share a pitch, so the
// silhouette stays light: narrow shoulders, thin limbs, a readable head.
const RIG = {
  hipZ: 0.94, hipX: 0.085,
  thigh: 0.44, shank: 0.42, legR: 0.058, thighR: 0.066,
  chestA: 1.02, chestB: 1.42, chestR: 0.15,
  shortsA: 0.84, shortsB: 1.03, shortsR: 0.16,
  shoulderX: 0.165, shoulderZ: 1.38, upperArm: 0.28, foreArm: 0.26, armR: 0.05,
  headC: 1.59, headR: 0.158, hairR: 0.162,
};

// One sheet per kit: 16 direction rows × FRAMES frame columns
export function generatePlayerSheet(kit) {
  const { canvas, ctx } = makeCanvas(FRAME_W * FRAMES, FRAME_H * DIRS);
  for (let d = 0; d < DIRS; d++) {
    const heading = (d * Math.PI * 2) / DIRS; // atan2 angle: 0 = east, +y = south
    for (let f = 0; f < FRAMES; f++) {
      const prims = rotScene(buildPose(f, kit), heading - Math.PI / 2);
      const grid = renderScene(prims, { w: FRAME_W, h: FRAME_H, S, originX: FRAME_W / 2, baselineY: BASELINE });
      grid.autoOutline('#151226');
      grid.blitTo(ctx, f * FRAME_W, d * FRAME_H);
    }
  }
  return canvas;
}

// Canonical rig faces +y (south). Poses only bend joints; rotScene aims it.
function buildPose(frame, kit) {
  const A = ANIMS;
  if (frame < A.runStart) return poseIdle(frame, kit);
  if (frame < A.kickStart) return poseRun((frame - A.runStart) / A.runLen, kit);
  if (frame < A.lunge) return poseKick(frame - A.kickStart, kit);
  if (frame === A.lunge) return poseLunge(kit);
  if (frame === A.recover) return poseRecover(kit);
  if (frame < A.celebStart) {
    const i = frame - A.shuffleStart;
    return poseShuffle(i < A.shuffleSideStride ? -1 : 1, i % A.shuffleLen, kit);
  }
  if (frame < A.diveStart) return poseCelebrate((frame - A.celebStart) / A.celebLen, kit);
  const i = frame - A.diveStart;
  return poseDive(i < A.diveSideStride ? -1 : 1, i % A.diveSideStride, kit);
}

function poseIdle(f, kit) {
  const sway = f === 0 ? 0 : 0.05;
  return assemble(kit, {
    bob: f === 0 ? 0 : -0.012,
    hipL: -0.06 + sway, kneeL: 0.1, hipR: 0.06 - sway, kneeR: 0.1,
    armL: 0.12, armR: -0.12, elbow: 0.25,
    lean: 0.02,
  });
}

// Exaggerated arcade gait: deep opposite leg/arm swings, knees folding on the
// swing-through, a double-frequency bob that pounds the turf
function poseRun(phase, kit) {
  const t = phase * Math.PI * 2;
  const swing = Math.sin(t);
  return assemble(kit, {
    bob: -0.035 * (0.5 + 0.5 * Math.sin(t * 2 + Math.PI / 2)),
    hipR: 0.6 * swing, kneeR: 0.25 + 0.85 * Math.max(0, Math.cos(t)),
    hipL: -0.6 * swing, kneeL: 0.25 + 0.85 * Math.max(0, -Math.cos(t)),
    armR: -0.75 * swing, armL: 0.75 * swing, elbow: 0.7,
    lean: 0.1,
  });
}

// The kick is a full-body move: coil back, whip the leg long through the ball,
// then ride the follow-through tall — three strong silhouettes
function poseKick(step, kit) {
  const poses = [
    { hipR: -1.05, kneeR: 1.35, hipL: -0.1, kneeL: 0.35, armR: 0.7, armL: -0.6, elbow: 0.5, lean: 0.12, bob: -0.02 },
    { hipR: 1.2, kneeR: 0.12, hipL: -0.18, kneeL: 0.3, armR: -0.8, armL: 0.75, elbow: 0.4, lean: -0.1, bob: -0.01 },
    { hipR: 1.45, kneeR: 0.4, hipL: -0.12, kneeL: 0.25, armR: -0.5, armL: 0.5, elbow: 0.45, lean: -0.16, bob: 0 },
  ];
  return assemble(kit, poses[step]);
}

// The full-stretch lunge: one leg thrown long and low toward the ball, body
// pitched hard over it, arms flung wide — the outfielder's slide tackle,
// aimed by heading like everything else
function poseLunge(kit) {
  return assemble(kit, {
    bob: -0.26,
    hipR: 1.2, kneeR: 0.18, hipL: -1.15, kneeL: 0.3,
    armR: -1.5, armL: 1.5, elbow: 0.15,
    lean: 0.5,
  });
}

// Picking yourself up after committing: a low gathered crouch
function poseRecover(kit) {
  return assemble(kit, {
    bob: -0.2,
    hipR: 0.55, kneeR: 1.25, hipL: -0.5, kneeL: 1.2,
    armR: 0.35, armL: -0.35, elbow: 0.6,
    lean: 0.22,
  });
}

// Travelling sideways with your eyes still on the play. Knees NEVER straighten
// — a bent stance is the whole read at this size — and the feet trade a wide
// stance for a gathered one while the shoulders stay square. `side` is which
// way he is going in rig space (+1 = toward +x).
function poseShuffle(side, phase, kit) {
  // lead foot reaches out, trail foot gathers under him, then drives again
  const steps = [
    { lead: [0.48, 0.28], trail: [-0.14, 0.55], bob: -0.19 },
    { lead: [0.3, 0.6], trail: [0.16, 0.92], bob: -0.13 },
    { lead: [0.5, 0.25], trail: [0.02, 0.5], bob: -0.2 },
  ][phase];
  const lead = side > 0 ? 'R' : 'L';
  const trail = side > 0 ? 'L' : 'R';
  return assemble(kit, {
    bob: steps.bob,
    [`splay${lead}`]: side * steps.lead[0], [`knee${lead}`]: steps.lead[1], [`hip${lead}`]: 0.1,
    [`splay${trail}`]: side * steps.trail[0], [`knee${trail}`]: steps.trail[1], [`hip${trail}`]: -0.1,
    armL: 0.1, armR: 0.1, elbow: 0.35, armSpread: 0.38,
    lean: 0.06,
  });
}

// He has scored and he is GONE: arms wheeling overhead, chest thrown back,
// the run cycle's legs at full stride and a bob that leaves the ground
function poseCelebrate(phase, kit) {
  const t = phase * Math.PI * 2;
  const swing = Math.sin(t);
  return assemble(kit, {
    bob: -0.05 * (0.5 + 0.5 * Math.sin(t * 2 + Math.PI / 2)),
    hipR: 0.72 * swing, kneeR: 0.3 + 0.95 * Math.max(0, Math.cos(t)),
    hipL: -0.72 * swing, kneeL: 0.3 + 0.95 * Math.max(0, -Math.cos(t)),
    // Both arms live above the head, thrown WIDE — dead straight up they
    // vanish behind his own skull — and they wheel forward/back out of phase.
    // They stay balanced around vertical on purpose: an arm that leans back
    // rides UP-screen going away and DOWN-screen coming at you, and a
    // celebration that flattens out at half the compass is no celebration.
    armR: Math.PI + 0.42 * swing, armL: Math.PI - 0.42 * swing,
    elbow: 0.12, armSpread: -0.4, armLen: 1.4,
    lean: -0.13,
  });
}

// The money shot. The keeper flies ALONG his heading — the sim aims his eyes
// down the leap — so the rig is laid flat onto +y and rolled about its own
// long axis until the chest turns toward the shooter. Arms lead, legs trail,
// and the whole body clears the turf. `side` is which way the strike came
// from in rig space (-1 = the ball is off his +x shoulder).
function poseDive(side, stage, kit) {
  const twist = side * 1.32; // chest toward the ball, back to the net
  // and the body angles into the shot rather than flying dead straight — a
  // line down the screen's own axis reads as a man standing on his head
  const yaw = side * 0.42;
  const shape = [
    // launch: still driving off the plant foot, body only starting to fall
    { pitch: -0.95, lift: 0.06, glide: -0.45, reach: -0.5, elbow: 0.5,
      hipLead: 0.55, kneeLead: 1.0, hipTrail: -0.42, kneeTrail: 0.2, lean: 0.16 },
    // low stretch: flat out along the deck, fingertips at boot height
    { pitch: -1.45, lift: 0.28, glide: -0.95, reach: -0.14, elbow: 0.04,
      hipLead: -0.12, kneeLead: 0.48, hipTrail: -0.3, kneeTrail: 0.14, lean: 0.02 },
    // high stretch: the same body angled up, everything strained toward a
    // ball that is going over him
    { pitch: -1.22, lift: 0.56, glide: -0.8, reach: 0.3, elbow: 0.02,
      hipLead: -0.5, kneeLead: 0.8, hipTrail: -0.22, kneeTrail: 0.25, lean: -0.06 },
    // catch: it dies in the gloves — elbows fold, knees come up around it
    { pitch: -1.34, lift: 0.5, glide: -0.8, reach: 0.06, elbow: 0.82,
      hipLead: -0.55, kneeLead: 1.05, hipTrail: -0.45, kneeTrail: 0.9, lean: 0.1 },
    // parry: the top hand punches through flat, the buried arm stays tucked
    { pitch: -1.3, lift: 0.58, glide: -0.85, reach: 0.2, elbow: 0.02,
      hipLead: -0.45, kneeLead: 0.62, hipTrail: -0.24, kneeTrail: 0.22, lean: 0 },
    // land: he is down, gathered, arms in — the beat that sells the flight
    { pitch: -1.52, lift: 0.14, glide: -1.05, reach: -1.0, elbow: 1.4,
      hipLead: -0.5, kneeLead: 1.15, hipTrail: -0.35, kneeTrail: 0.95, lean: 0.14 },
  ][stage];
  // the roll leaves one half of him uppermost: that shoulder is the free hand
  // the parry punches with, and that hip is the leg that scissors behind
  const lead = side > 0 ? 'R' : 'L';
  const trail = side > 0 ? 'L' : 'R';
  const arms = stage === ANIMS.diveStage.parry
    ? { [`arm${trail}`]: Math.PI + shape.reach, [`elbow${trail}`]: 0.02,
        [`arm${lead}`]: 2.25, [`elbow${lead}`]: 1.0 }
    : { armL: Math.PI + shape.reach, armR: Math.PI + shape.reach };
  return assemble(kit, {
    bob: 0, lean: shape.lean,
    [`hip${lead}`]: shape.hipLead, [`knee${lead}`]: shape.kneeLead,
    [`hip${trail}`]: shape.hipTrail, [`knee${trail}`]: shape.kneeTrail,
    [`splay${lead}`]: side * 0.16, [`splay${trail}`]: side * -0.1,
    elbow: shape.elbow, armSpread: 0.26, ...arms,
    // straining arms: this rig's stock reach barely clears its own head, and a
    // dive is nothing without one. Thicker too, or the subray rule eats a
    // horizontal limb alive.
    armLen: 1.5, armWide: 1.3,
    twist, yaw, pitch: shape.pitch, glide: shape.glide, lift: shape.lift,
  });
}

// Joint angles → primitive list. hip/arm swing forward is +, knee flexion
// folds the shank back, splay/spread carry a limb sideways, lean tips the
// torso toward the run. twist/pitch/glide/lift then move the WHOLE assembled
// body as one rigid thing — that is how a standing rig becomes a dive.
function assemble(kit, {
  bob, hipL, kneeL, hipR, kneeR, armL, armR, elbow, lean,
  splayL = 0, splayR = 0, elbowL = elbow, elbowR = elbow, armSpread = 0,
  armLen = 1, armWide = 1, twist = 0, pitch = 0, yaw = 0, glide = 0, lift = 0,
}) {
  const P = [];
  const z0 = bob;

  for (const [side, hip, knee, splay] of [[-1, hipL, kneeL, splayL], [1, hipR, kneeR, splayR]]) {
    const h = [side * RIG.hipX, 0, RIG.hipZ + z0];
    const kneeP = swingDown(h, hip, RIG.thigh, 0, splay);
    const ankle = swingDown(kneeP, hip - knee, RIG.shank, 0, splay);
    P.push(capsule(h, kneeP, RIG.thighR, kit.skin));            // thigh
    P.push(capsule(kneeP, ankle, RIG.legR, kit.socks));         // sock calf
    const toe = [ankle[0], ankle[1] + 0.13, ankle[2] - 0.02];
    P.push(capsule([ankle[0], ankle[1], ankle[2]], toe, 0.052, BOOT));
  }

  const leanY = (z) => lean * (z - RIG.shortsA); // pivot the upper body at the waist
  P.push(capsule([0, leanY(RIG.shortsA), RIG.shortsA + z0], [0, leanY(RIG.shortsB), RIG.shortsB + z0], RIG.shortsR, kit.shorts));
  P.push(capsule([0, leanY(RIG.chestA), RIG.chestA + z0], [0, leanY(RIG.chestB), RIG.chestB + z0], RIG.chestR, kit.shirt));

  for (const [side, swing, bend] of [[-1, armL, elbowL], [1, armR, elbowR]]) {
    const sh = [side * RIG.shoulderX, leanY(RIG.shoulderZ), RIG.shoulderZ + z0];
    const el = swingDown(sh, swing, RIG.upperArm * armLen, side * 0.03, side * armSpread);
    const hand = swingDown(el, swing + bend, RIG.foreArm * armLen, side * 0.015, side * armSpread);
    P.push(capsule(sh, el, RIG.armR * armWide, kit.shirt));   // sleeve
    P.push(capsule(el, hand, (RIG.armR - 0.006) * armWide, kit.skin));
  }

  const hy = leanY(RIG.headC);
  P.push(sphere([0, hy + 0.015, RIG.headC + z0], RIG.headR, kit.skin));
  P.push(sphere([0, hy - 0.055, RIG.headC + 0.045 + z0], RIG.hairR, kit.hair));
  // Eyes are real geometry: two dark caps on the face that appear, track and
  // vanish with the head like everything else — never painted on
  for (const side of [-1, 1]) {
    const dir = normDir([side * 0.4, 0.84, -0.22]);
    P.push(sphere([
      dir[0] * 0.155, hy + 0.015 + dir[1] * 0.155, RIG.headC + z0 + dir[2] * 0.155,
    ], 0.048, '#1f1713'));
  }
  if (!twist && !pitch && !glide && !lift) return P;
  const fly = (p) => {
    const q = rotX(rotZ(p, twist), pitch);
    return rotZ([q[0], q[1] + glide, q[2] + lift], yaw);
  };
  return P.map((p) => (p.kind === 's' ? { ...p, c: fly(p.c) } : { ...p, a: fly(p.a), b: fly(p.b) }));
}

function normDir(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Limb segment hanging from `from`, swung `ang` radians toward +y (forward)
// then rolled `abduct` radians about the +y axis. A limb hanging DOWN carries
// toward +x on a positive roll; one raised overhead swings the other way.
function swingDown(from, ang, length, drift = 0, abduct = 0) {
  const dy = Math.sin(ang) * length;
  const dz = -Math.cos(ang) * length;
  return [from[0] + drift - dz * Math.sin(abduct), from[1] + dy, from[2] + dz * Math.cos(abduct)];
}
