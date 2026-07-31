import { makeCanvas } from './lib.mjs';
import { renderScene, rotScene, sphere, capsule } from './iso3d.mjs';

export const FRAME_W = 30;
export const FRAME_H = 28;
export const BASELINE = 24; // world origin (the feet) inside the frame
export const DIRS = 16;     // full compass — heading angle picks the nearest row
export const FRAMES = 13;   // 0-1 idle, 2-9 run, 10-12 kick (windup/strike/follow)

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

// One sheet per kit: 16 direction rows × 13 frame columns
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
  if (frame < 2) return poseIdle(frame, kit);
  if (frame < 10) return poseRun((frame - 2) / 8, kit);
  return poseKick(frame - 10, kit);
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

// Joint angles → primitive list. hip/arm swing forward is +, knee flexion
// folds the shank back, lean tips the torso toward the run.
function assemble(kit, { bob, hipL, kneeL, hipR, kneeR, armL, armR, elbow, lean }) {
  const P = [];
  const z0 = bob;

  for (const [side, hip, knee] of [[-1, hipL, kneeL], [1, hipR, kneeR]]) {
    const h = [side * RIG.hipX, 0, RIG.hipZ + z0];
    const kneeP = swingDown(h, hip, RIG.thigh);
    const ankle = swingDown(kneeP, hip - knee, RIG.shank);
    P.push(capsule(h, kneeP, RIG.thighR, kit.skin));            // thigh
    P.push(capsule(kneeP, ankle, RIG.legR, kit.socks));         // sock calf
    const toe = [ankle[0], ankle[1] + 0.13, Math.max(0.035, ankle[2] - 0.02)];
    P.push(capsule([ankle[0], ankle[1], Math.max(0.045, ankle[2])], toe, 0.052, BOOT));
  }

  const leanY = (z) => lean * (z - RIG.shortsA); // pivot the upper body at the waist
  P.push(capsule([0, leanY(RIG.shortsA), RIG.shortsA + z0], [0, leanY(RIG.shortsB), RIG.shortsB + z0], RIG.shortsR, kit.shorts));
  P.push(capsule([0, leanY(RIG.chestA), RIG.chestA + z0], [0, leanY(RIG.chestB), RIG.chestB + z0], RIG.chestR, kit.shirt));

  for (const [side, swing] of [[-1, armL], [1, armR]]) {
    const sh = [side * RIG.shoulderX, leanY(RIG.shoulderZ), RIG.shoulderZ + z0];
    const el = swingDown(sh, swing, RIG.upperArm, side * 0.03);
    const hand = swingDown(el, swing + elbow, RIG.foreArm, side * 0.015);
    P.push(capsule(sh, el, RIG.armR, kit.shirt));   // sleeve
    P.push(capsule(el, hand, RIG.armR - 0.006, kit.skin));
  }

  const hy = leanY(RIG.headC);
  P.push(sphere([0, hy + 0.015, RIG.headC + z0], RIG.headR, kit.skin));
  P.push(sphere([0, hy - 0.055, RIG.headC + 0.045 + z0], RIG.hairR, kit.hair));
  return P;
}

// Limb segment hanging from `from`, swung `ang` radians toward +y (forward)
function swingDown(from, ang, length, drift = 0) {
  return [from[0] + drift, from[1] + Math.sin(ang) * length, from[2] - Math.cos(ang) * length];
}
