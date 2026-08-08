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
  // the marquee men's own celebrations, one four-frame block each in this order
  celebSigStart: 39, celebSigLen: 4,
  celebSigs: ['siu', 'meditate', 'fold', 'wide', 'sky', 'sujood', 'samba'],
};

export const FRAME_W = 48; // wide enough for a full-stretch dive broadside
export const FRAME_H = 48;
export const BASELINE = 34; // world origin (the feet) inside the frame
export const DIRS = 16;     // full compass — heading angle picks the nearest row
export const FRAMES = ANIMS.celebSigStart + ANIMS.celebSigLen * ANIMS.celebSigs.length;

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
  if (frame < A.celebSigStart) {
    const i = frame - A.diveStart;
    return poseDive(i < A.diveSideStride ? -1 : 1, i % A.diveSideStride, kit);
  }
  const i = frame - A.celebSigStart;
  return SIGNATURES[A.celebSigs[Math.floor(i / A.celebSigLen)]](i % A.celebSigLen, kit);
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

// ---------------------------------------------------------------------------
// Signature celebrations. Silhouette is the ENTIRE job at thirty pixels tall
// and sixteen headings, so each of these was picked because the shape alone
// names the man — anything needing fingers, a face or a shirt over the head
// never made it in. Four frames each: two arriving, two breathing.
// ---------------------------------------------------------------------------

// SIU: a hop, a half-turn in the air, then absolute stillness — boots planted
// a metre apart, arms locked straight and held clear of the ribs. They hang
// DOWN and barely back: from this camera an arm swept behind rides up-screen
// and the whole man turns into an aeroplane.
function poseSiu(step, kit) {
  const s = [
    { bob: -0.24, lift: 0, feet: 0.1, knee: 0.5, arm: 0.4, spread: 0.18, lean: 0.15 },
    { bob: 0.02, lift: 0.36, feet: 0.14, knee: 0.62, arm: -0.55, spread: 0.3, lean: -0.05 },
    { bob: -0.08, lift: 0, feet: 0.52, knee: 0.08, arm: -0.15, spread: 0.46, lean: -0.13 },
    { bob: -0.04, lift: 0, feet: 0.49, knee: 0.06, arm: -0.12, spread: 0.43, lean: -0.1 },
  ][step];
  return assemble(kit, {
    bob: s.bob, lift: s.lift, lean: s.lean,
    hipL: 0.02, kneeL: s.knee, hipR: -0.02, kneeR: s.knee,
    splayL: -s.feet, splayR: s.feet,
    armL: s.arm, armR: s.arm, elbow: 0.02, armSpread: s.spread, armLen: 1.06,
  });
}

// MEDITATION: he sits down on the turf and switches off. Cross-legged, wrists
// on the knees, spine long — the only body in the game at half a man's height
function poseMeditate(step, kit) {
  const s = [
    { bob: -0.3, hip: 0.85, knee: 0.9, splay: 0.6, shin: -0.7, lean: 0.3, arm: 0.7, elbow: 0.6 },
    { bob: -0.62, hip: 1.1, knee: 1.3, splay: 1.05, shin: -1.2, lean: 0.12, arm: 0.58, elbow: 0.48 },
    { bob: -0.72, hip: 1.15, knee: 1.39, splay: 1.15, shin: -1.28, lean: 0.02, arm: 0.54, elbow: 0.45 },
    { bob: -0.69, hip: 1.15, knee: 1.39, splay: 1.15, shin: -1.28, lean: 0.05, arm: 0.56, elbow: 0.44 },
  ][step];
  return assemble(kit, {
    bob: s.bob, lean: s.lean,
    hipL: s.hip, kneeL: s.knee, splayL: -s.splay, shinL: -s.shin,
    hipR: s.hip, kneeR: s.knee, splayR: s.splay, shinR: s.shin,
    armL: s.arm, armR: s.arm, elbow: s.elbow, armSpread: 0.24, armLen: 1.1,
  });
}

// ARMS FOLDED: Mbappe's stillness, and Palmer's shiver. Upper arms hang, the
// elbows sit low and a little wide, and the forearms lie across the bottom of
// the ribs one over the other — a flat bar at mid-chest is the entire read
function poseFold(step, kit) {
  const s = [
    { arm: 0.6, bend: 1.2, spread: 0.3, fore: 0.5, lean: 0.06 },
    { arm: 0.36, bend: 2.1, spread: 0.52, fore: 1.2, lean: -0.02 },
    { arm: 0.306, bend: 2.434, spread: 0.63, fore: 1.437, lean: -0.06 },
    { arm: 0.316, bend: 2.41, spread: 0.61, fore: 1.42, lean: -0.04 },
  ][step];
  return assemble(kit, {
    bob: -0.02, lean: s.lean,
    hipL: 0.04, kneeL: 0.1, hipR: -0.04, kneeR: 0.1, splayL: -0.08, splayR: 0.08,
    armL: s.arm, armR: s.arm, elbow: s.bend, elbowL: s.bend - 0.12,
    armSpread: s.spread, foreSpread: s.fore, armLen: 1.18,
  });
}

// ARMS WIDE: Bellingham at the corner flag — a flat T thrown open to the
// stand, chest back, feet set. Reads from every heading because it is a cross
function poseWide(step, kit) {
  const s = [
    { arm: 0.5, spread: 0.5, lean: 0.08, bob: -0.1 },
    { arm: 0.05, spread: 1.15, lean: -0.1, bob: -0.05 },
    { arm: -0.14, spread: 1.42, lean: -0.18, bob: -0.02 },
    { arm: -0.1, spread: 1.38, lean: -0.15, bob: -0.04 },
  ][step];
  return assemble(kit, {
    bob: s.bob, lean: s.lean,
    hipL: 0.05, kneeL: 0.12, hipR: -0.05, kneeR: 0.12, splayL: -0.2, splayR: 0.2,
    armL: s.arm, armR: s.arm, elbow: 0.14, armSpread: s.spread, armLen: 1.15,
  });
}

// POINT TO THE SKY: Messi for his grandmother, Kaka for his god. Both arms
// straight up in a narrow V, heels together, head tipped back at the roof
function poseSky(step, kit) {
  const s = [
    { arm: 1.5, spread: 0.4, lean: 0.05, bob: -0.12 },
    { arm: 2.5, spread: -0.4, lean: -0.1, bob: -0.02 },
    { arm: Math.PI - 0.04, spread: -0.75, lean: -0.22, bob: 0.04 },
    { arm: Math.PI - 0.08, spread: -0.72, lean: -0.2, bob: 0.02 },
  ][step];
  return assemble(kit, {
    bob: s.bob, lean: s.lean,
    hipL: 0.03, kneeL: 0.06, hipR: -0.03, kneeR: 0.06, splayL: -0.02, splayR: 0.02,
    armL: s.arm, armR: s.arm, elbow: 0.03, armSpread: s.spread, armLen: 1.4,
  });
}

// SUJOOD: Salah's, and every man who goes to the turf with him. Knees down,
// shins flat behind, hips the highest point, forehead and both palms out on
// the grass. `fold` hinges the spine and `lean` curls the neck on top of it —
// without that curl the head hides inside its own chest from this camera
function poseSujood(step, kit) {
  const s = [
    { bob: -0.2, hip: 0.2, knee: 0.9, fold: -0.45, lean: 0.3, arm: 1.6, spread: -0.3 },
    { bob: -0.36, hip: 0.24, knee: 1.55, fold: -1.05, lean: 0.6, arm: 2.2, spread: -0.55 },
    { bob: -0.42, hip: 0.25, knee: 1.82, fold: -1.45, lean: 0.8, arm: 2.6, spread: -0.75 },
    { bob: -0.4, hip: 0.25, knee: 1.8, fold: -1.4, lean: 0.78, arm: 2.56, spread: -0.72 },
  ][step];
  // the palms go down WIDE, not together: from head-on this pose is a column
  // of foreshortened torso, and the flung-out arms are the only thing left
  return assemble(kit, {
    bob: s.bob, lean: s.lean, fold: s.fold,
    hipL: s.hip, kneeL: s.knee, splayL: -0.1,
    hipR: s.hip, kneeR: s.knee, splayR: 0.1,
    armL: s.arm, armR: s.arm, elbow: 0.02, armSpread: s.spread, armLen: 1.2,
  });
}

// THE DANCE: Vini's, and the whole samba line behind him. A real four-beat
// loop — knee up, down, other knee, down — with the shoulders turning under
// elbows carried high and wide. The only celebration here that keeps moving
function poseSamba(step, kit) {
  const s = [
    { up: 1, twist: 0.22, lean: 0.06, armHi: 0.05, armLo: 0.34 },
    { up: 0, twist: 0.04, lean: 0.12, armHi: 0.2, armLo: 0.2 },
    { up: -1, twist: -0.22, lean: 0.06, armHi: 0.34, armLo: 0.05 },
    { up: 0, twist: -0.04, lean: 0.12, armHi: 0.2, armLo: 0.2 },
  ][step];
  const lift = { hip: 0.95, knee: 1.55, splay: 0.3 };
  const plant = { hip: -0.12, knee: 0.34, splay: 0.12 };
  const R = s.up > 0 ? lift : plant;
  const L = s.up < 0 ? lift : plant;
  return assemble(kit, {
    bob: -0.1 - 0.05 * Math.abs(s.up), lean: s.lean, twist: s.twist,
    hipR: R.hip, kneeR: R.knee, splayR: R.splay,
    hipL: L.hip, kneeL: L.knee, splayL: -L.splay,
    armR: s.armHi, armL: s.armLo, elbow: 1.55, armSpread: 1.0, foreSpread: 1.0,
  });
}

const SIGNATURES = {
  siu: poseSiu, meditate: poseMeditate, fold: poseFold, wide: poseWide,
  sky: poseSky, sujood: poseSujood, samba: poseSamba,
};

// Joint angles → primitive list. hip/arm swing forward is +, knee flexion
// folds the shank back, splay/spread carry a limb sideways, lean tips the
// torso toward the run. `fold` then hinges everything above the waist for
// real (a shear cannot put a forehead on the turf), and twist/pitch/glide/lift
// move the WHOLE assembled body as one rigid thing — that is how a standing
// rig becomes a dive.
function assemble(kit, {
  bob, hipL, kneeL, hipR, kneeR, armL, armR, elbow, lean,
  splayL = 0, splayR = 0, shinL = splayL, shinR = splayR,
  elbowL = elbow, elbowR = elbow, armSpread = 0, foreSpread = armSpread,
  armLen = 1, armWide = 1, fold = 0,
  twist = 0, pitch = 0, yaw = 0, glide = 0, lift = 0,
}) {
  const P = [];
  const z0 = bob;

  for (const [side, hip, knee, splay, shin] of [[-1, hipL, kneeL, splayL, shinL], [1, hipR, kneeR, splayR, shinR]]) {
    const h = [side * RIG.hipX, 0, RIG.hipZ + z0];
    const kneeP = swingDown(h, hip, RIG.thigh, 0, splay);
    const ankle = swingDown(kneeP, hip - knee, RIG.shank, 0, shin);
    P.push(capsule(h, kneeP, RIG.thighR, kit.skin));            // thigh
    P.push(capsule(kneeP, ankle, RIG.legR, kit.socks));         // sock calf
    const toe = [ankle[0], ankle[1] + 0.13, ankle[2] - 0.02];
    P.push(capsule([ankle[0], ankle[1], ankle[2]], toe, 0.052, BOOT));
  }

  const leanY = (z) => lean * (z - RIG.shortsA); // pivot the upper body at the waist
  P.push(capsule([0, leanY(RIG.shortsA), RIG.shortsA + z0], [0, leanY(RIG.shortsB), RIG.shortsB + z0], RIG.shortsR, kit.shorts));

  const U = []; // everything above the belt, so `fold` can hinge it as one piece
  U.push(capsule([0, leanY(RIG.chestA), RIG.chestA + z0], [0, leanY(RIG.chestB), RIG.chestB + z0], RIG.chestR, kit.shirt));

  for (const [side, swing, bend] of [[-1, armL, elbowL], [1, armR, elbowR]]) {
    const sh = [side * RIG.shoulderX, leanY(RIG.shoulderZ), RIG.shoulderZ + z0];
    const el = swingDown(sh, swing, RIG.upperArm * armLen, side * 0.03, side * armSpread);
    const hand = swingDown(el, swing + bend, RIG.foreArm * armLen, side * 0.015, side * foreSpread);
    U.push(capsule(sh, el, RIG.armR * armWide, kit.shirt));   // sleeve
    U.push(capsule(el, hand, (RIG.armR - 0.006) * armWide, kit.skin));
  }

  const hy = leanY(RIG.headC);
  U.push(sphere([0, hy + 0.015, RIG.headC + z0], RIG.headR, kit.skin));
  U.push(sphere([0, hy - 0.055, RIG.headC + 0.045 + z0], RIG.hairR, kit.hair));
  // Eyes are real geometry: two dark caps on the face that appear, track and
  // vanish with the head like everything else — never painted on
  for (const side of [-1, 1]) {
    const dir = normDir([side * 0.4, 0.84, -0.22]);
    U.push(sphere([
      dir[0] * 0.155, hy + 0.015 + dir[1] * 0.155, RIG.headC + z0 + dir[2] * 0.155,
    ], 0.048, '#1f1713'));
  }
  // the spine hinges at the top of the shorts — negative folds him face-down
  P.push(...(fold ? U.map(mapPrim((p) => {
    const q = rotX([p[0], p[1] - leanY(RIG.shortsB), p[2] - RIG.shortsB - z0], fold);
    return [q[0], q[1] + leanY(RIG.shortsB), q[2] + RIG.shortsB + z0];
  })) : U));

  if (!twist && !pitch && !glide && !lift) return P;
  return P.map(mapPrim((p) => {
    const q = rotX(rotZ(p, twist), pitch);
    return rotZ([q[0], q[1] + glide, q[2] + lift], yaw);
  }));
}

// Lift a point-mover into a primitive-mover — spheres carry a center, capsules
// carry two ends, and neither cares which transform is riding them
const mapPrim = (move) => (p) =>
  p.kind === 's' ? { ...p, c: move(p.c) } : { ...p, a: move(p.a), b: move(p.b) };

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
