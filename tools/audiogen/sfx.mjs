import {
  SR, secs, osc, noise, shape, ad, onePoleLP, onePoleHP, bandpass,
  addInto, gain, softClip, normalize, loopable, reverb, makeRng, writeWav,
} from './lib.mjs';

// Every effect in the game, synthesized. The rule of the pile: sounds land
// like real play — thumps, air, leather, crowds — never arcade bloops.

const STADIUM = { wet: 0.22, decay: 0.74, size: 1.7, damp: 3200 };

// --------------------------------------------------------------- the whistle
// A pea whistle: a thin square carrier trilled hard at ~35Hz (the pea), a
// breath of noise, and the stadium answering back.
function peep(dur, base = 2150) {
  const rng = makeRng(101);
  const trill = (t) => 34 + 3 * Math.sin(t * 5.1);
  let trillPh = 0;
  const carrier = osc(dur, (t) => {
    trillPh += trill(t) / SR;
    return base * (1 + 0.014 * Math.sin(trillPh * Math.PI * 2)) * (t > dur - 0.07 ? 0.985 : 1);
  }, 'square', { duty: 0.42 });
  // the pea chokes the airflow — deep AM at the trill rate
  let amPh = 0;
  for (let i = 0; i < carrier.length; i++) {
    amPh += trill(i / SR) / SR;
    carrier[i] *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(amPh * Math.PI * 2 + 1));
  }
  shape(carrier, (t) => Math.min(1, t / 0.012) * (t > dur - 0.06 ? (dur - t) / 0.06 : 1));
  const breath = bandpass(noise(dur, rng), base, 3);
  shape(breath, (t) => Math.min(1, t / 0.02) * (t > dur - 0.05 ? (dur - t) / 0.05 : 1));
  const out = secs(dur + 0.9);
  addInto(out, carrier, 0, 0.62);
  addInto(out, breath, 0, 0.2);
  return out;
}

function whistlePhrase(peeps) {
  const total = peeps.reduce((t, [dur, gap]) => t + dur + gap, 0) + 1.0;
  const out = secs(total);
  let at = 0;
  for (const [dur, gap] of peeps) {
    addInto(out, peep(dur), at);
    at += dur + gap;
  }
  return normalize(reverb(out, STADIUM), 0.72);
}

// ------------------------------------------------------------------ the ball
// A kick is LEATHER, not a drum: a fast low punch that dies quickly, a bright
// strike click, and a mid 'thwack' band that carries the contact. Power
// raises pitch, snap and bite together — never a hollow boom.
function kickThump(power) {
  const dur = 0.1 + power * 0.05;
  const out = secs(dur + 0.2);
  const f0 = 150 + power * 90;
  const body = osc(dur, (t) => 58 + (f0 - 58) * Math.exp(-t * 42), 'sine');
  shape(body, ad(0.0015, dur * 0.6, 2.8));
  const rng = makeRng(7 + Math.round(power * 100));
  const click = onePoleHP(noise(0.014, rng), 2100);
  shape(click, ad(0.0004, 0.012, 2));
  const thwack = bandpass(noise(0.045, rng), 620 + power * 520, 1.6);
  shape(thwack, ad(0.0008, 0.038, 2.2));
  const thock = bandpass(noise(0.05, rng), 300 + power * 220, 1.2);
  shape(thock, ad(0.001, 0.04, 2));
  addInto(out, body, 0, 0.68);
  addInto(out, click, 0, 0.32 + power * 0.34);
  addInto(out, thwack, 0, 0.6 + power * 0.35);
  addInto(out, thock, 0, 0.44 + power * 0.24);
  return normalize(softClip(out, 1.6), 0.82);
}

function ballBounce() {
  const out = kickThump(0.15);
  return gain(out, 0.7);
}

// The net takes a goal: a falling whoosh of air through rope + tiny cord ticks
function netSwish() {
  const rng = makeRng(21);
  const dur = 0.55;
  const air = noise(dur, rng);
  onePoleLP(air, (t) => 2100 * Math.exp(-t * 4.5) + 320);
  onePoleHP(air, 260);
  shape(air, (t) => Math.min(1, t / 0.03) * Math.exp(-t * 5.2));
  const out = secs(dur + 0.4);
  addInto(out, air, 0, 1);
  for (const [at, g] of [[0.05, 0.5], [0.13, 0.42], [0.22, 0.3], [0.34, 0.2]]) {
    const tick = bandpass(noise(0.012, rng), 1700 + rng() * 600, 2);
    shape(tick, ad(0.0005, 0.01, 2));
    addInto(out, tick, at, g);
  }
  return normalize(out, 0.7);
}

// The post says no: detuned metal partials ringing off a hard attack
function postClank() {
  const dur = 0.7;
  const out = secs(dur + 0.5);
  const partials = [[227, 1], [229.4, 0.7], [431, 0.62], [683, 0.42], [1187, 0.28], [1830, 0.16]];
  for (const [f, g] of partials) {
    const p = osc(dur, f, 'sine');
    shape(p, ad(0.001, 0.6 / Math.sqrt(f / 227), 2));
    addInto(out, p, 0, g * 0.5);
  }
  const rng = makeRng(31);
  const strike = onePoleHP(noise(0.008, rng), 900);
  shape(strike, ad(0.0004, 0.007, 2));
  addInto(out, strike, 0, 0.5);
  return normalize(reverb(softClip(out, 1.2), { ...STADIUM, wet: 0.16 }), 0.8);
}

// Keeper gloves: a leather slap over a low chest thud
function gkCatch() {
  const rng = makeRng(41);
  const out = secs(0.3);
  const slap = bandpass(noise(0.035, rng), 680, 0.9);
  shape(slap, ad(0.001, 0.03, 2));
  const thud = osc(0.14, (t) => 95 * Math.exp(-t * 9) + 45, 'sine');
  shape(thud, ad(0.002, 0.12, 2.2));
  addInto(out, slap, 0, 0.75);
  addInto(out, thud, 0.004, 0.8);
  return normalize(out, 0.72);
}

// A slide through turf: swelling grass hiss with dirt crackle underneath
function tackleSlide() {
  const rng = makeRng(51);
  const dur = 0.42;
  const hiss = noise(dur, rng);
  onePoleLP(hiss, (t) => 1300 - t * 1800 + 350);
  shape(hiss, (t) => Math.min(1, t / 0.07) * Math.exp(-Math.max(0, t - 0.07) * 6));
  const crackle = secs(dur);
  for (let i = 0; i < crackle.length; i++) if (rng() < 0.004) crackle[i] = (rng() * 2 - 1) * 0.9;
  onePoleLP(crackle, 900);
  const out = secs(dur + 0.1);
  addInto(out, hiss, 0, 0.9);
  addInto(out, crackle, 0, 0.6);
  return normalize(out, 0.6);
}

// Boots on grass — three tiny scuffs the runtime rotates through
function stepGrass(seed) {
  const rng = makeRng(seed);
  const dur = 0.05;
  const out = noise(dur, rng);
  onePoleLP(out, 650 + rng() * 380);
  onePoleHP(out, 140);
  shape(out, ad(0.003, dur - 0.004, 1.8));
  return normalize(out, 0.5);
}

// ----------------------------------------------------------------- the crowd
// The bed: band-limited noise wearing slow integer-cycle swells so the loop
// never betrays itself. Everything else layers on top of this wash.
function crowdBed() {
  const rng = makeRng(61);
  const dur = 9.5;
  const raw = noise(dur, rng);
  const low = onePoleLP(Float32Array.from(raw), 260);
  const mid = bandpass(Float32Array.from(raw), 520, 0.55);
  const high = bandpass(Float32Array.from(raw), 1150, 0.7);
  const bed = secs(dur);
  addInto(bed, low, 0, 0.58);
  addInto(bed, mid, 0, 0.62);
  addInto(bed, high, 0, 0.14);
  const looped = loopable(bed, 0.5); // exactly 9.0s now
  const L = looped.length / SR;
  for (let i = 0; i < looped.length; i++) {
    const t = i / SR;
    looped[i] *= 0.78
      + 0.12 * Math.sin((Math.PI * 2 * 3 * t) / L)
      + 0.08 * Math.sin((Math.PI * 2 * 7 * t) / L + 1.4)
      + 0.05 * Math.sin((Math.PI * 2 * 13 * t) / L + 4.2);
  }
  return normalize(looped, 0.5);
}

// Applause is honest synthesis: hundreds of tiny filtered slaps at a density
// that rises and falls like a real hands-together moment
function applause(dur, peakDensity, seed) {
  const rng = makeRng(seed);
  const out = secs(dur + 0.6);
  const density = (t) => peakDensity * Math.min(1, t / (dur * 0.25)) * Math.pow(Math.max(0, 1 - t / dur), 0.7);
  let t = 0.01;
  while (t < dur) {
    const d = Math.max(1, density(t));
    t += -Math.log(1 - rng()) / d;
    const clap = bandpass(noise(0.008, rng), 2100 + rng() * 1500, 2.2);
    shape(clap, ad(0.0005, 0.007, 2));
    addInto(out, clap, t, 0.25 + rng() * 0.55);
  }
  return out;
}

// Crowd whistles — a couple of piercing fan whistles riding a big moment
function fanWhistles(count, dur, seed) {
  const rng = makeRng(seed);
  const out = secs(dur);
  for (let i = 0; i < count; i++) {
    const at = rng() * (dur - 0.5);
    const base = 2300 + rng() * 700;
    const w = osc(0.4, (t) => base * (1 + 0.05 * Math.sin(t * 30)), 'sine');
    shape(w, ad(0.03, 0.35, 1.6));
    addInto(out, w, at, 0.05 + rng() * 0.05);
  }
  return out;
}

// GOOOAL: the wash slams to full, hands and whistles pile in, then it breathes out
function crowdRoar() {
  const rng = makeRng(71);
  const dur = 3.6;
  const raw = noise(dur, rng);
  const mid = bandpass(Float32Array.from(raw), 620, 0.5);
  const air = onePoleHP(Float32Array.from(raw), 2400);
  const roar = secs(dur + 1.2);
  addInto(roar, mid, 0, 1);
  addInto(roar, air, 0, 0.22);
  shape(roar, (t) => {
    const rise = Math.min(1, t / 0.3);
    const fall = t > 1.6 ? Math.exp(-(t - 1.6) * 1.5) : 1;
    return rise * fall;
  });
  addInto(roar, applause(2.8, 55, 72), 0.5, 0.8);
  addInto(roar, fanWhistles(4, 3, 73), 0.15, 1);
  return normalize(reverb(softClip(roar, 1.25), { ...STADIUM, wet: 0.3 }), 0.85);
}

// The near miss: a gasp that rises fast and sighs away — two formants crossfading
function crowdOoh() {
  const rng = makeRng(81);
  const dur = 1.5;
  const raw = noise(dur, rng);
  const f1 = bandpass(Float32Array.from(raw), 540, 1.4);
  const f2 = bandpass(Float32Array.from(raw), 330, 1.4);
  const voiced = secs(dur);
  for (let i = 0; i < 9; i++) {
    const hum = osc(dur, 165 + rng() * 60, 'saw');
    addInto(voiced, hum, 0, 0.05);
  }
  onePoleLP(voiced, 480);
  const out = secs(dur + 0.5);
  const xf = (t) => Math.min(1, t / 0.35);
  for (let i = 0; i < f1.length; i++) {
    const t = i / SR;
    out[i] = f1[i] * (1 - xf(t)) * 0.9 + f2[i] * xf(t) * 0.9 + voiced[i] * 0.7;
  }
  shape(out, (t) => Math.min(1, t / 0.22) * (t > 0.5 ? Math.exp(-(t - 0.5) * 3.2) : 1));
  return normalize(reverb(out, { ...STADIUM, wet: 0.26 }), 0.6);
}

// A good save, a strong tackle: a short warm lift out of the bed
function crowdCheer() {
  const rng = makeRng(91);
  const dur = 1.8;
  const raw = noise(dur, rng);
  const mid = bandpass(Float32Array.from(raw), 700, 0.6);
  const out = secs(dur + 0.6);
  addInto(out, mid, 0, 0.8);
  shape(out, (t) => Math.min(1, t / 0.25) * (t > 0.8 ? Math.exp(-(t - 0.8) * 2.6) : 1));
  addInto(out, applause(1.4, 26, 92), 0.25, 0.7);
  return normalize(reverb(out, { ...STADIUM, wet: 0.24 }), 0.55);
}

// ------------------------------------------------------------------- nature
// Birdsong: chirplets with fast pitch warbles, four phrasings to rotate
function bird(seed, pattern) {
  const rng = makeRng(seed);
  const total = pattern.reduce((t, [at, d]) => Math.max(t, at + d), 0) + 0.3;
  const out = secs(total);
  for (const [at, d, f0, warb] of pattern) {
    const c = osc(d, (t) => f0 * (1 + 0.12 * Math.sin(t * Math.PI * 2 * warb) + 0.1 * (t / d)), 'sine');
    shape(c, ad(0.006, d - 0.005, 1.6));
    addInto(out, c, at, 0.5 + rng() * 0.2);
  }
  return normalize(reverb(out, { wet: 0.12, decay: 0.5, size: 0.8 }), 0.4);
}

// Wind: brown noise breathing on slow integer-cycle gusts — barely there
function windLoop() {
  const rng = makeRng(111);
  const dur = 10.5;
  const raw = noise(dur, rng);
  let acc = 0;
  for (let i = 0; i < raw.length; i++) { acc = acc * 0.985 + raw[i] * 0.015; raw[i] = acc * 18; }
  onePoleLP(raw, 240);
  onePoleHP(raw, 45);
  const looped = loopable(raw, 0.5);
  const L = looped.length / SR;
  for (let i = 0; i < looped.length; i++) {
    const t = i / SR;
    looped[i] *= 0.6 + 0.28 * Math.sin((Math.PI * 2 * 2 * t) / L) + 0.12 * Math.sin((Math.PI * 2 * 5 * t) / L + 2);
  }
  return normalize(looped, 0.45);
}

// ---------------------------------------------------------------------- UI
// The interface speaks softly: wood ticks and warm plucks, never sirens
function pluck(freq, dur, wave = 'tri') {
  const p = osc(dur, freq, wave);
  shape(p, ad(0.002, dur - 0.002, 2));
  return p;
}

function uiMove() {
  const out = secs(0.09);
  addInto(out, pluck(880, 0.045), 0, 0.5);
  const thud = osc(0.03, 190, 'sine');
  shape(thud, ad(0.001, 0.028, 2));
  addInto(out, thud, 0, 0.5);
  return normalize(onePoleLP(out, 3800), 0.42);
}

function uiSelect() {
  const out = secs(0.3);
  addInto(out, pluck(659, 0.12), 0, 0.6);
  addInto(out, pluck(880, 0.18), 0.055, 0.6);
  return normalize(onePoleLP(out, 5200), 0.5);
}

function uiBack() {
  const out = secs(0.3);
  addInto(out, pluck(784, 0.1), 0, 0.55);
  addInto(out, pluck(587, 0.16), 0.055, 0.55);
  return normalize(onePoleLP(out, 4800), 0.45);
}

function uiDenied() {
  const out = secs(0.22);
  const low = osc(0.16, (t) => 150 - t * 90, 'square', { duty: 0.5 });
  shape(low, ad(0.002, 0.15, 1.6));
  addInto(out, onePoleLP(low, 500), 0, 0.7);
  return normalize(out, 0.4);
}

// Money leaves the wallet: a warm coin arp with a sparkle on top
function uiBuy() {
  const out = secs(0.55);
  [880, 1174.7, 1568].forEach((f, i) => addInto(out, pluck(f, 0.16), i * 0.05, 0.5));
  const ting = osc(0.3, 2093, 'sine');
  shape(ting, ad(0.001, 0.28, 2));
  addInto(out, ting, 0.16, 0.3);
  const rng = makeRng(121);
  const sparkle = onePoleHP(noise(0.12, rng), 5500);
  shape(sparkle, ad(0.004, 0.11, 2));
  addInto(out, sparkle, 0.05, 0.2);
  return normalize(out, 0.55);
}

function uiCard() {
  const rng = makeRng(131);
  const out = bandpass(noise(0.15, rng), 950, 1.1);
  onePoleHP(out, 420);
  shape(out, (t) => Math.min(1, t / 0.045) * Math.exp(-Math.max(0, t - 0.045) * 26));
  return normalize(out, 0.42);
}

// A coin spun on a table: tings tightening as it settles, then the catch
function uiCoin() {
  const out = secs(1.15);
  let at = 0;
  let interval = 0.1;
  let i = 0;
  while (at < 0.8) {
    const ting = osc(0.09, 1959.9 * (1 + (i % 2) * 0.004), 'sine');
    shape(ting, ad(0.0008, 0.085, 2));
    addInto(out, ting, at, 0.4 * (1 - at * 0.5));
    at += interval;
    interval *= 0.93;
    i++;
  }
  const settle = osc(0.12, (t) => 240 - t * 400, 'sine');
  shape(settle, ad(0.002, 0.11, 2));
  addInto(out, settle, 0.85, 0.6);
  return normalize(out, 0.5);
}

function uiWheelTick() {
  const rng = makeRng(141);
  const out = secs(0.05);
  const click = onePoleHP(noise(0.006, rng), 2000);
  shape(click, ad(0.0004, 0.005, 2));
  addInto(out, click, 0, 0.8);
  addInto(out, pluck(1245, 0.03, 'sine'), 0.001, 0.5);
  return normalize(out, 0.4);
}

function uiWheelWin() {
  const out = secs(1.1);
  [1046.5, 1318.5, 1568, 2093].forEach((f, i) => addInto(out, pluck(f, 0.22, 'square'), i * 0.07, 0.28));
  const rng = makeRng(151);
  const shimmer = onePoleHP(noise(0.5, rng), 6000);
  shape(shimmer, ad(0.02, 0.45, 2));
  addInto(out, shimmer, 0.2, 0.16);
  return normalize(reverb(out, { wet: 0.2, decay: 0.6, size: 1 }), 0.55);
}

// ---------------------------------------------------------------- fanfares
// Chord stabs with a saw-square blend — arcade brass for the big moments
function stab(midis, dur, detune = 0.0015) {
  const out = secs(dur);
  for (const m of midis) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    addInto(out, osc(dur, f * (1 + detune), 'saw'), 0, 0.16);
    addInto(out, osc(dur, f * (1 - detune), 'saw'), 0, 0.16);
    addInto(out, osc(dur, f, 'square', { duty: 0.3 }), 0, 0.12);
  }
  shape(out, (t, d) => Math.min(1, t / 0.01) * (t > d - 0.05 ? (d - t) / 0.05 : 1) * Math.pow(1 - t / (d * 1.4), 0.4));
  return onePoleLP(out, 5200);
}

function goalFanfare() {
  const out = secs(1.7);
  addInto(out, stab([57, 61, 64, 69], 0.2), 0, 1);      // A
  addInto(out, stab([57, 61, 64, 69], 0.18), 0.24, 0.9); // A again, urgent
  addInto(out, stab([62, 66, 69, 74], 0.55), 0.48, 1);   // lift to D
  const rng = makeRng(161);
  const crash = onePoleHP(noise(0.5, rng), 4200);
  shape(crash, ad(0.002, 0.45, 1.8));
  addInto(out, crash, 0, 0.3);
  return normalize(reverb(softClip(out, 1.15), { wet: 0.2, decay: 0.65, size: 1.2 }), 0.7);
}

function fulltimeFanfare() {
  const out = secs(2.6);
  addInto(out, stab([64, 68, 71], 0.24), 0, 0.85);        // E
  addInto(out, stab([62, 66, 69], 0.24), 0.28, 0.85);     // D
  addInto(out, stab([57, 61, 64, 69], 1.1), 0.56, 1);     // home to A, held
  const rng = makeRng(171);
  const crash = onePoleHP(noise(0.6, rng), 4200);
  shape(crash, ad(0.002, 0.55, 1.8));
  addInto(out, crash, 0.56, 0.26);
  return normalize(reverb(softClip(out, 1.15), { wet: 0.24, decay: 0.7, size: 1.3 }), 0.7);
}

// ------------------------------------------------------------------- export
// name → { render, loop, gain } — gain is the runtime's default mix level
export function bakeSfx(write) {
  const sounds = {
    'whistle-kickoff': { render: () => whistlePhrase([[0.8, 0]]), gain: 0.5 },
    'whistle-short': { render: () => whistlePhrase([[0.42, 0]]), gain: 0.5 },
    'whistle-half': { render: () => whistlePhrase([[0.3, 0.16], [0.55, 0]]), gain: 0.5 },
    'whistle-full': { render: () => whistlePhrase([[0.28, 0.13], [0.28, 0.13], [0.95, 0]]), gain: 0.5 },
    'kick-soft': { render: () => kickThump(0.2), gain: 0.55 },
    'kick-mid': { render: () => kickThump(0.6), gain: 0.62 },
    'kick-hard': { render: () => kickThump(1), gain: 0.7 },
    'ball-bounce': { render: ballBounce, gain: 0.32 },
    'net-swish': { render: netSwish, gain: 0.65 },
    'post-clank': { render: postClank, gain: 0.6 },
    'gk-catch': { render: gkCatch, gain: 0.6 },
    'tackle-slide': { render: tackleSlide, gain: 0.5 },
    'step-a': { render: () => stepGrass(201), gain: 0.16 },
    'step-b': { render: () => stepGrass(202), gain: 0.16 },
    'step-c': { render: () => stepGrass(203), gain: 0.16 },
    'crowd-bed': { render: crowdBed, loop: true, gain: 0.24 },
    'crowd-roar': { render: crowdRoar, gain: 0.85 },
    'crowd-ooh': { render: crowdOoh, gain: 0.5 },
    'crowd-cheer': { render: crowdCheer, gain: 0.45 },
    'bird-a': { render: () => bird(1, [[0, 0.07, 3400, 40], [0.12, 0.06, 3700, 46], [0.22, 0.09, 3200, 38]]), gain: 0.2 },
    'bird-b': { render: () => bird(2, [[0, 0.16, 2700, 22], [0.3, 0.12, 2900, 26]]), gain: 0.2 },
    'bird-c': { render: () => bird(3, [[0, 0.05, 4100, 52], [0.07, 0.05, 4300, 52], [0.14, 0.05, 4000, 52], [0.21, 0.05, 4200, 52]]), gain: 0.18 },
    'bird-d': { render: () => bird(4, [[0, 0.22, 3000, 14]]), gain: 0.2 },
    'wind': { render: windLoop, loop: true, gain: 0.13 },
    'ui-move': { render: uiMove, gain: 0.5 },
    'ui-select': { render: uiSelect, gain: 0.55 },
    'ui-back': { render: uiBack, gain: 0.5 },
    'ui-denied': { render: uiDenied, gain: 0.5 },
    'ui-buy': { render: uiBuy, gain: 0.6 },
    'ui-card': { render: uiCard, gain: 0.5 },
    'ui-coin': { render: uiCoin, gain: 0.55 },
    'ui-wheel-tick': { render: uiWheelTick, gain: 0.45 },
    'ui-wheel-win': { render: uiWheelWin, gain: 0.6 },
    'goal-fanfare': { render: goalFanfare, gain: 0.55 },
    'fulltime-fanfare': { render: fulltimeFanfare, gain: 0.55 },
  };
  const entries = [];
  for (const [name, def] of Object.entries(sounds)) {
    const file = `${name}.wav`;
    write(file, def.render());
    entries.push({ name, file, loop: !!def.loop, gain: def.gain });
  }
  return entries;
}
