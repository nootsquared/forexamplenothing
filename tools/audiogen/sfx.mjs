import {
  SR, secs, mtof, osc, noise, shape, ad, onePoleLP, onePoleHP, lowpass2, lowpass4, bandpass,
  bandLimited, polish, addInto, softClip, normalize, loopable, reverb, makeRng,
} from './lib.mjs';

// Every effect in the game, synthesized. The rule of the pile: soft, dense and
// clicky — low bodies that drop into a thump and a real strike of contact on
// top of them. Clicky is a TREBLE word: the thock of a keycap lives at 3-5kHz,
// so every one-shot leaves through `polish`, which keeps its air and scoops the
// one band the ear guards instead of bricking the whole top off.

const STADIUM = { wet: 0.2, decay: 0.74, size: 1.7, damp: 2400 };

// --------------------------------------------------------------- the whistle
// A referee's IMPRESSION, not his hardware. The real thing screams at 3.1kHz —
// dead centre of where the ear hurts — so this sits a fifth below it and gets
// its mellowness from SHAPE instead of a blanket: 22ms of attack, two tones
// beating at 26Hz for the pea, a chirp in, a sag out, and a breath of air over
// the top so it reads as a whistle across a pitch rather than a test tone.
function whistleBlast(dur, f0) {
  const rng = makeRng(101);
  const bend = (t) => (1 - 0.06 * Math.exp(-t / 0.03)) * (1 - 0.05 * Math.max(0, t - (dur - 0.06)) / 0.06);
  const voice = (f) => (t) => f * bend(t) * (1 + 0.004 * Math.sin(Math.PI * 2 * 5.5 * t));
  const env = (t) => Math.min(1, t / 0.022)
    * (0.72 + 0.28 * Math.exp(-t * 2.2))
    * (t > dur - 0.045 ? Math.max(0, (dur - t) / 0.045) : 1);
  const out = secs(dur + 0.12);
  addInto(out, shape(osc(dur, voice(f0), 'sine'), env), 0, 0.6);
  addInto(out, shape(osc(dur, voice(f0 + 26), 'sine'), env), 0, 0.33);
  addInto(out, shape(osc(dur, voice(f0 * 2), 'sine'), env), 0, 0.06); // identity only
  addInto(out, shape(bandpass(noise(dur, rng), 4200, 0.8), env), 0, 0.07);
  return lowpass2(out, 8000);
}

// notes: [dur, gap, freq] — the stadium answers every blast
function whistlePhrase(notes) {
  const total = notes.reduce((t, [dur, gap]) => t + dur + gap, 0) + 0.8;
  const out = secs(total);
  let at = 0;
  for (const [dur, gap, f0] of notes) {
    addInto(out, whistleBlast(dur, f0), at);
    at += dur + gap;
  }
  return normalize(polish(reverb(out, STADIUM), 8000, 5), 0.5);
}

// ------------------------------------------------------------------ the ball
// A kick is LEATHER, not a drum. Boot on ball IS the 1-4kHz band: the thock of
// the panel and the slap of contact carry the sound, and the 100Hz body is the
// weight underneath them, not the event itself. Balanced the other way round
// the game's most frequent sound vanishes on any laptop speaker — those cannot
// follow below ~300Hz. Power raises pitch, snap and saturation.
// The heartbeat, and it is a HEART: a chest thump you feel rather than hear.
// The old one was a ball kick pitched down by half, which meant the tensest
// minute of a match sounded like somebody booting the ball three times a
// second — and it stole the real kicks' voice off the debounce as it went.
function heartThump() {
  const rng = makeRng(77);
  const out = secs(0.3);
  const body = osc(0.26, (t) => 41 + (72 - 41) * Math.exp(-t / 0.045), 'sine');
  shape(body, ad(0.006, 0.19, 1.8)); // soft attack — a heart has no click in it
  const skin = shape(lowpass2(noise(0.07, rng), 240), ad(0.004, 0.055, 2.4));
  addInto(out, body, 0, 0.85);
  addInto(out, skin, 0, 0.22);
  return normalize(polish(softClip(out, 1.5), 900), 0.62);
}

function kickThump(power) {
  const rng = makeRng(7 + Math.round(power * 100));
  const out = secs(0.26);
  const f0 = 165 + power * 45;
  const body = osc(0.22, (t) => 95 + (f0 - 95) * Math.exp(-t / 0.035), 'sine');
  shape(body, ad(0.001, 0.1 + power * 0.05, 2));
  const sub = shape(osc(0.24, 52, 'sine'), ad(0.002, 0.14, 1.6));
  const thock = shape(bandpass(noise(0.1, rng), 900 + power * 520, 1), ad(0.001, 0.06, 2));
  const slap = shape(bandpass(noise(0.035, rng), 2900, 0.7), ad(0.0004, 0.022, 3));
  const leather = shape(lowpass2(noise(0.06, rng), 1500), ad(0.001, 0.05, 2));
  addInto(out, body, 0, 0.4);
  addInto(out, sub, 0, 0.1 + power * 0.08);
  addInto(out, thock, 0, 0.9 + power * 0.35);
  addInto(out, slap, 0, 0.6 + power * 0.3);
  addInto(out, leather, 0.002, 0.28);
  return normalize(polish(softClip(out, 1.8 + power * 0.6), 9500), 0.7 + power * 0.25);
}

// The ball meeting turf: the kick's shape, shorter and much less angry
function ballBounce() {
  const rng = makeRng(17);
  const out = secs(0.16);
  const body = osc(0.14, (t) => 110 + 110 * Math.exp(-t / 0.03), 'sine');
  shape(body, ad(0.001, 0.075, 2.5));
  const thock = shape(bandpass(noise(0.06, rng), 760, 1), ad(0.001, 0.04, 2.4));
  const tick = shape(bandpass(noise(0.02, rng), 2700, 1.2), ad(0.0003, 0.008, 4));
  const turf = shape(lowpass2(noise(0.06, rng), 900), ad(0.002, 0.045, 2));
  addInto(out, body, 0, 0.6);
  addInto(out, thock, 0, 0.34);
  addInto(out, tick, 0, 0.38);
  addInto(out, turf, 0, 0.12);
  return normalize(polish(softClip(out, 1.3), 7500), 0.7);
}

// The net takes a goal: a falling whoosh of air through rope + soft cord ticks
function netSwish() {
  const rng = makeRng(21);
  const dur = 0.55;
  const air = noise(dur, rng);
  onePoleLP(air, (t) => 4200 * Math.exp(-t * 4.5) + 320);
  onePoleHP(air, 220);
  shape(air, (t) => Math.min(1, t / 0.03) * Math.exp(-t * 5.2) * Math.max(0, 1 - t / dur));
  const out = secs(dur + 0.4);
  addInto(out, air, 0, 1);
  for (const [at, g] of [[0.05, 0.5], [0.13, 0.42], [0.22, 0.3], [0.34, 0.2]]) {
    const tick = shape(bandpass(noise(0.012, rng), 2300 + rng() * 900, 2), ad(0.0005, 0.01, 3));
    addInto(out, tick, at, g);
  }
  return normalize(polish(out, 5500, 3.5, 4), 0.7);
}

// The post says no — the game's most valuable non-goal. A DONK, not a ping:
// the bar's own note sagging 430→300Hz over two low inharmonic partials.
function postClank() {
  const rng = makeRng(31);
  const dur = 0.72;
  const out = secs(dur + 0.4);
  const barNote = osc(dur, (t) => 300 + 130 * Math.exp(-t / 0.06), 'tri');
  shape(barNote, ad(0.001, 0.5, 1.5));
  addInto(out, barNote, 0, 0.8);
  for (const [f, g, d] of [[227, 0.55, 0.62], [231, 0.4, 0.58], [683, 0.2, 0.3], [1490, 0.09, 0.16]]) {
    addInto(out, shape(osc(dur, f, 'sine'), ad(0.001, d, 2)), 0, g);
  }
  addInto(out, shape(bandpass(noise(0.02, rng), 3100, 1.1), ad(0.0004, 0.012, 3)), 0, 0.45);
  return normalize(polish(reverb(softClip(out, 1.3), { ...STADIUM, wet: 0.25, decay: 0.8 }), 8000), 0.82);
}

// Keeper gloves. The 4ms thud and the 12ms fabric swell are what read as
// CAUGHT instead of hit — sharpen either one and the ball bounces off him.
function gkCatch() {
  const rng = makeRng(41);
  const out = secs(0.24);
  const thud = osc(0.2, (t) => 85 + 35 * Math.exp(-t / 0.04), 'sine');
  shape(thud, ad(0.004, 0.075, 2));
  const glove = shape(bandpass(noise(0.05, rng), 1900, 0.7), ad(0.0008, 0.03, 3));
  const fabric = shape(lowpass2(noise(0.13, rng), 1100), ad(0.012, 0.1, 1.5));
  addInto(out, thud, 0, 0.5);
  addInto(out, glove, 0, 0.6);
  addInto(out, fabric, 0.004, 0.18);
  return normalize(polish(softClip(out, 1.2), 7000), 0.62);
}

// A slide through turf: swelling grass hiss with dirt crackle underneath
function tackleSlide() {
  const rng = makeRng(51);
  const dur = 0.42;
  const fade = (t) => (t > dur - 0.07 ? Math.max(0, (dur - t) / 0.07) : 1);
  const hiss = noise(dur, rng);
  onePoleLP(hiss, (t) => 3600 - t * 4200);
  shape(hiss, (t) => Math.min(1, t / 0.07) * Math.exp(-Math.max(0, t - 0.07) * 6.5) * fade(t));
  const crackle = secs(dur);
  for (let i = 0; i < crackle.length; i++) if (rng() < 0.004) crackle[i] = (rng() * 2 - 1) * 0.9;
  lowpass2(crackle, 1600);
  shape(crackle, (t) => Math.min(1, t / 0.05) * fade(t));
  const out = secs(dur + 0.1);
  addInto(out, hiss, 0, 0.9);
  addInto(out, crackle, 0, 0.55);
  return normalize(polish(out, 5000, 3.5, 4), 0.6);
}

// Boots on grass — three tiny scuffs the runtime rotates through
function stepGrass(seed) {
  const rng = makeRng(seed);
  const dur = 0.05;
  const out = noise(dur, rng);
  lowpass4(out, 1500 + rng() * 700);
  onePoleHP(out, 190);
  shape(out, ad(0.004, dur - 0.005, 1.8));
  return normalize(polish(out, 6000, 3.5, 4), 0.5);
}

// ----------------------------------------------------------------- the crowd
// The bed: band-limited noise wearing slow integer-cycle swells so the loop
// never betrays itself. Everything else layers on top of this wash.
function crowdBed() {
  const rng = makeRng(61);
  const dur = 9.5;
  const raw = noise(dur, rng);
  const low = onePoleLP(Float32Array.from(raw), 260);
  const mid = bandpass(Float32Array.from(raw), 500, 0.55);
  const air = bandpass(Float32Array.from(raw), 1900, 0.7);
  const bed = secs(dur);
  addInto(bed, low, 0, 0.58);
  addInto(bed, mid, 0, 0.62);
  addInto(bed, air, 0, 0.11);
  polish(bed, 4600, 3.5, 4);
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
// that rises and falls like a real hands-together moment. `tone` is the palm —
// low and cupped for a warm pat, brighter for a full house.
function applause(dur, peakDensity, seed, tone = 2400) {
  const rng = makeRng(seed);
  const out = secs(dur + 0.6);
  const density = (t) => peakDensity * Math.min(1, t / (dur * 0.25)) * Math.pow(Math.max(0, 1 - t / dur), 0.7);
  let t = 0.01;
  while (t < dur) {
    const d = Math.max(1, density(t));
    t += -Math.log(1 - rng()) / d;
    const clap = shape(bandpass(noise(0.008, rng), tone * (0.8 + rng() * 0.7), 1.8), ad(0.0005, 0.007, 3));
    addInto(out, clap, t, 0.25 + rng() * 0.55);
  }
  return polish(out, 6500, 5, 4);
}

// Fan whistles riding a big moment — kept under the roar, never over it
function fanWhistles(count, dur, seed) {
  const rng = makeRng(seed);
  const out = secs(dur);
  for (let i = 0; i < count; i++) {
    const base = 2050 + rng() * 420;
    const w = osc(0.4, (t) => base * (1 + 0.05 * Math.sin(t * 30)), 'sine');
    shape(w, ad(0.03, 0.35, 1.6));
    addInto(out, w, rng() * (dur - 0.5), 0.05 + rng() * 0.04);
  }
  return out;
}

// GOOOAL: the wash slams to full, hands and whistles pile in, then it breathes
// out. The single loudest thing in the game — everything else defers to it.
function crowdRoar() {
  const rng = makeRng(71);
  const dur = 3.6;
  const raw = noise(dur, rng);
  const mid = bandpass(Float32Array.from(raw), 620, 0.5);
  const air = bandpass(Float32Array.from(raw), 2500, 0.8);
  const roar = secs(dur + 1.2);
  addInto(roar, mid, 0, 1);
  addInto(roar, air, 0, 0.12);
  shape(roar, (t) => Math.min(1, t / 0.3) * (t > 1.6 ? Math.exp(-(t - 1.6) * 1.5) : 1));
  addInto(roar, applause(2.8, 55, 72, 2500), 0.5, 0.8);
  addInto(roar, fanWhistles(4, 3, 73), 0.15, 1);
  return normalize(polish(reverb(softClip(roar, 1.25), { ...STADIUM, wet: 0.3 }), 6000, 5, 4), 0.85);
}

// The near miss: a gasp that rises fast and sighs away — two formants crossfading
function crowdOoh() {
  const rng = makeRng(81);
  const dur = 1.5;
  const raw = noise(dur, rng);
  const f1 = bandpass(Float32Array.from(raw), 540, 1.4);
  const f2 = bandpass(Float32Array.from(raw), 330, 1.4);
  const voiced = secs(dur);
  for (let i = 0; i < 9; i++) addInto(voiced, osc(dur, 165 + rng() * 60, 'saw'), 0, 0.05);
  lowpass2(voiced, 480);
  const out = secs(dur + 0.5);
  const xf = (t) => Math.min(1, t / 0.35);
  for (let i = 0; i < f1.length; i++) {
    const t = i / SR;
    out[i] = f1[i] * (1 - xf(t)) * 0.9 + f2[i] * xf(t) * 0.9 + voiced[i] * 0.7;
  }
  shape(out, (t, d) => Math.min(1, t / 0.22) * Math.pow(Math.max(0, 1 - t / d), 1.5));
  return normalize(polish(reverb(out, { ...STADIUM, wet: 0.26 }), 4200), 0.6);
}

// A good save, a strong tackle: a short warm lift out of the bed
function crowdCheer() {
  const rng = makeRng(91);
  const dur = 1.8;
  const out = secs(dur + 0.6);
  addInto(out, bandpass(noise(dur, rng), 700, 0.6), 0, 0.8);
  shape(out, (t, d) => Math.min(1, t / 0.25) * (t > 0.8 ? Math.exp(-(t - 0.8) * 2.6) : 1) * Math.max(0, 1 - t / d));
  addInto(out, applause(1.4, 26, 92, 2200), 0.25, 0.7);
  return normalize(polish(reverb(out, { ...STADIUM, wet: 0.24 }), 6500, 5, 4), 0.55);
}

// The shot leaves the boot and the ground INHALES: a fast collective intake
// that then holds, so the bed can dip underneath it and the strike lands cold.
function crowdGasp() {
  const rng = makeRng(83);
  const dur = 1.5;
  const breath = bandpass(noise(dur, rng), 780, 1.1);
  const voiced = secs(dur);
  for (let i = 0; i < 9; i++) {
    const f = 190 + rng() * 70;
    addInto(voiced, osc(dur, (t) => f * (1 + 0.14 * Math.min(1, t / 0.3)), 'saw'), 0, 0.05);
  }
  lowpass2(voiced, 620);
  const out = secs(dur + 0.4);
  addInto(out, breath, 0, 0.75);
  addInto(out, voiced, 0, 0.8);
  shape(out, (t, d) => Math.min(1, t / 0.09) * Math.pow(Math.max(0, 1 - t / d), 2.2));
  return normalize(polish(reverb(out, { ...STADIUM, wet: 0.22 }), 4200), 0.5);
}

// Gave it away in front of your own house: a voiced AWWW sagging a whole tone
function crowdGroan() {
  const rng = makeRng(85);
  const dur = 1.7;
  const voiced = secs(dur);
  for (let i = 0; i < 11; i++) {
    const f = 138 + rng() * 46;
    addInto(voiced, osc(dur, (t) => f * (1 - 0.18 * Math.min(1, t / 1.2)), 'saw'), 0, 0.05);
  }
  lowpass2(voiced, 460);
  const out = secs(dur + 0.4);
  addInto(out, voiced, 0, 0.9);
  addInto(out, bandpass(noise(dur, rng), 430, 1.3), 0, 0.5);
  shape(out, (t, d) => Math.min(1, t / 0.18) * Math.pow(Math.max(0, 1 - t / d), 1.6));
  return normalize(polish(reverb(out, { ...STADIUM, wet: 0.22 }), 3600), 0.5);
}

// A pat on the back for a pass they liked — a whole section's cupped palms
// over a short murmur, gone in a second. Without the murmur it reads as four
// people clapping alone, which is worse than saying nothing.
function crowdPat() {
  const dur = 0.9;
  const out = secs(1.4);
  const murmur = bandpass(noise(dur, makeRng(77)), 620, 0.6);
  shape(murmur, (t, d) => Math.min(1, t / 0.08) * Math.max(0, 1 - t / d));
  addInto(out, murmur, 0, 0.55);
  addInto(out, applause(0.72, 110, 76, 1900), 0, 1);
  return normalize(polish(reverb(out, { ...STADIUM, wet: 0.2 }), 6500, 5, 4), 0.5);
}

// A terrace chant: hummed pulses on a fixed clock, alternating two notes. The
// grid starts a fifth of a beat in and every tail dies before the loop point,
// so the crossfade lands on silence — a live saw edge at the seam ticks.
function crowdChant(seed, period, count, root) {
  const rng = makeRng(seed);
  const buf = secs(period * count + 0.16);
  for (let i = 0; i < count; i++) {
    const hit = secs(period * 0.9);
    const len = hit.length / SR;
    const f = root * (i % 2 === 0 ? 1 : 1.125);
    for (let v = 0; v < 9; v++) addInto(hit, osc(len, f * (1 + (rng() - 0.5) * 0.02), 'saw'), 0, 0.05);
    lowpass2(hit, 520);
    addInto(hit, bandpass(noise(len, rng), 480, 1), 0, 0.25);
    shape(hit, ad(0.05, period * 0.45, 1.8));
    addInto(buf, hit, 0.2 + i * period, 0.9);
  }
  return normalize(polish(loopable(buf, 0.16), 3200), 0.42);
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
  return normalize(polish(reverb(out, { wet: 0.12, decay: 0.5, size: 0.8 }), 9000, 5), 0.4);
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
// The whole interface is one gesture wearing different clothes: a low sine
// that sags into a thump, the strike of contact over it, and a weight layer
// nobody consciously hears. Felt keycaps — and a keycap is only satisfying
// because of the 3-5kHz crack; take that away and you have a cardboard box.
function tapBody(f0, f1, tau, dur, decay, curve) {
  const b = osc(dur, (t) => f1 + (f0 - f1) * Math.exp(-t / tau), 'sine');
  return shape(b, ad(0.002, decay, curve));
}

// The strike: the part of a keypress the fingers actually feel
// A thock is a low fundamental AND a 400-700Hz wall resonance — the wall is
// what a laptop speaker can actually reproduce, and leaving it out is why a
// mix balanced in headphones inverts the moment anybody plays without them.
//
// Where the STRIKE of a key lives. Not 3-5kHz — that band is the ear canal's
// own resonance, the one the whole mix scoops out to stay polite, and anything
// parked in it gets removed twice. Down here the detail survives the tail chain
// AND a laptop speaker, which is the only place most players will ever hear it.
const TICK_HZ = 1950;

function tapTick(freq, q, decay, seed) {
  return shape(bandpass(noise(decay + 0.01, makeRng(seed)), freq, q), ad(0.0005, decay, 4));
}

function uiMove() {
  const out = secs(0.09);
  addInto(out, tapBody(190, 150, 0.025, 0.08, 0.055, 3), 0, 0.5);
  addInto(out, tapBody(660, 520, 0.03, 0.08, 0.055, 2.6), 0, 0.5); // the cap's own wall ringing
  addInto(out, tapTick(TICK_HZ, 1.2, 0.018, 301), 0, 0.75);
  addInto(out, shape(osc(0.07, 75, 'sine'), ad(0.001, 0.05, 3)), 0, 0.12);
  return normalize(polish(softClip(out, 1.4), 8000), 0.55);
}

function uiSelect() {
  const out = secs(0.2);
  addInto(out, tapBody(200, 170, 0.03, 0.09, 0.07, 3), 0, 0.5);
  addInto(out, tapBody(300, 255, 0.03, 0.13, 0.11, 2.5), 0.055, 0.42);
  addInto(out, tapBody(720, 560, 0.03, 0.09, 0.065, 2.4), 0, 0.48);
  addInto(out, tapTick(TICK_HZ * 1.15, 1.4, 0.016, 302), 0, 0.7);
  addInto(out, tapTick(TICK_HZ * 1.15, 1.4, 0.016, 303), 0.055, 0.7);
  addInto(out, shape(osc(0.1, 80, 'sine'), ad(0.001, 0.09, 3)), 0, 0.15);
  return normalize(polish(softClip(out, 1.5), 8500), 0.7);
}

function uiBack() {
  const out = secs(0.12);
  addInto(out, tapBody(175, 120, 0.04, 0.1, 0.085, 2.5), 0, 0.5);
  addInto(out, tapBody(560, 430, 0.035, 0.1, 0.075, 2.4), 0, 0.44);
  addInto(out, tapTick(TICK_HZ * 0.8, 1, 0.016, 304), 0, 0.6);
  return normalize(polish(softClip(out, 1.3), 6000), 0.5);
}

// The smallest voice in the game: sliders, tallies, typewriters
function uiTick() {
  const out = secs(0.032);
  addInto(out, shape(osc(0.026, 260, 'sine'), ad(0.001, 0.018, 4)), 0, 0.35);
  addInto(out, shape(osc(0.026, 780, 'sine'), ad(0.001, 0.016, 3)), 0, 0.4);
  addInto(out, tapTick(TICK_HZ * 1.35, 2, 0.01, 305), 0, 0.6);
  return normalize(polish(out, 9000), 0.32);
}

// No. A dead double-thud with the lid shut on it
function uiDenied() {
  const out = secs(0.24);
  addInto(out, tapBody(190, 112, 0.05, 0.14, 0.12, 2.2), 0, 0.44);
  addInto(out, tapBody(160, 96, 0.05, 0.14, 0.12, 2.2), 0.075, 0.38);
  addInto(out, tapBody(520, 380, 0.04, 0.12, 0.095, 2.2), 0, 0.6);
  addInto(out, tapBody(440, 330, 0.045, 0.13, 0.1, 2.2), 0.075, 0.5);
  addInto(out, tapTick(TICK_HZ * 0.7, 0.9, 0.022, 306), 0, 0.55);
  return normalize(polish(softClip(out, 1.4), 4200), 0.5);
}

// Money leaves the wallet: three felt taps climbing, one warm ring on top
function uiBuy() {
  const out = secs(0.5);
  [0, 0.06, 0.12].forEach((at, i) => {
    addInto(out, tapBody(210 + i * 70, 175 + i * 58, 0.03, 0.2, 0.16, 2.4), at, 0.45);
    addInto(out, tapTick(3200 + i * 600, 1.4, 0.008, 311 + i), at, 0.16);
  });
  addInto(out, shape(osc(0.3, 880, 'sine'), ad(0.004, 0.26, 2.4)), 0.12, 0.14);
  return normalize(polish(softClip(out, 1.5), 7500), 0.62);
}

function uiCard() {
  const rng = makeRng(131);
  const out = bandpass(noise(0.15, rng), 1250, 1);
  onePoleHP(out, 320);
  shape(out, (t, d) => Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.05) * 26) * Math.max(0, 1 - t / d));
  return normalize(polish(out, 5200, 3.5, 4), 0.45);
}

// A coin spun on a table: rings tightening as it settles, then the felt catch
function uiCoin() {
  const out = secs(1.1);
  let at = 0.02;
  let interval = 0.13;
  for (let i = 0; i < 7; i++) {
    const ring = osc(0.12, 980 * (1 + (i % 2) * 0.004), 'sine');
    shape(ring, ad(0.002, 0.1, 2.4));
    addInto(out, ring, at, 0.34 * (1 - at * 0.5));
    at += interval;
    interval *= 0.9;
  }
  addInto(out, tapBody(240, 130, 0.04, 0.2, 0.16, 2.2), at + 0.06, 0.7);
  addInto(out, tapTick(2900, 1.2, 0.01, 321), at + 0.06, 0.18);
  return normalize(polish(softClip(out, 1.3), 7500), 0.55);
}

function uiWheelTick() {
  const out = secs(0.05);
  addInto(out, tapBody(320, 230, 0.008, 0.042, 0.03, 4), 0, 0.5);
  addInto(out, tapTick(3800, 1.6, 0.006, 331), 0, 0.36);
  return normalize(polish(out, 8000), 0.42);
}

// The wheel lands on somebody good: four pure rings, each on its own thock
function uiWheelWin() {
  const out = secs(1.05);
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    addInto(out, shape(osc(0.4, f, 'sine'), ad(0.004, 0.36, 2.2)), i * 0.075, 0.34);
    addInto(out, tapBody(200 - i * 12, 150, 0.03, 0.2, 0.14, 2.6), i * 0.075, 0.22);
  });
  const glow = shape(bandpass(noise(0.55, makeRng(151)), 5200, 1.2), ad(0.03, 0.5, 2));
  addInto(out, glow, 0.15, 0.12);
  return normalize(polish(reverb(softClip(out, 1.4), { wet: 0.2, decay: 0.6, size: 1 }), 8500, 5, 4), 0.66);
}

// ---------------------------------------------------------------- fanfares
// Chord stabs on band-limited saws — arcade brass with the hash summed out
function stab(midis, dur, detune = 0.0015) {
  const out = secs(dur);
  for (const m of midis) {
    const f = mtof(m);
    addInto(out, bandLimited(dur, f * (1 + detune), 'saw'), 0, 0.16);
    addInto(out, bandLimited(dur, f * (1 - detune), 'saw'), 0, 0.16);
    addInto(out, bandLimited(dur, f, 'square', { duty: 0.3 }), 0, 0.1);
  }
  shape(out, (t, d) => Math.min(1, t / 0.012) * (t > d - 0.06 ? (d - t) / 0.06 : 1) * Math.pow(Math.max(0, 1 - t / (d * 1.4)), 0.4));
  return polish(out, 7000, 5);
}

function goalFanfare() {
  const out = secs(1.7);
  addInto(out, stab([57, 61, 64, 69], 0.2), 0, 1);       // A
  addInto(out, stab([57, 61, 64, 69], 0.18), 0.24, 0.9); // A again, urgent
  addInto(out, stab([62, 66, 69, 74], 0.55), 0.48, 1);   // lift to D
  const crash = shape(lowpass2(bandpass(noise(0.5, makeRng(161)), 3000, 1.4), 6500), ad(0.002, 0.45, 1.8));
  addInto(out, crash, 0, 0.4);
  return normalize(polish(reverb(softClip(out, 1.15), { wet: 0.2, decay: 0.65, size: 1.2 }), 7500, 5), 0.7);
}

function fulltimeFanfare() {
  const out = secs(2.6);
  addInto(out, stab([64, 68, 71], 0.24), 0, 0.85);    // E
  addInto(out, stab([62, 66, 69], 0.24), 0.28, 0.85); // D
  addInto(out, stab([57, 61, 64, 69], 1.1), 0.56, 1); // home to A, held
  const crash = shape(lowpass2(bandpass(noise(0.6, makeRng(171)), 3000, 1.4), 6500), ad(0.002, 0.55, 1.8));
  addInto(out, crash, 0.56, 0.36);
  return normalize(polish(reverb(softClip(out, 1.15), { wet: 0.24, decay: 0.7, size: 1.3 }), 7500, 5), 0.7);
}

// The other side of the same net. Same brass as the celebration, turned minor
// and stopped one chord short: it sags a whole tone and never walks home, so
// the ear knows the goal was not yours before the scoreboard says so.
function concededSting() {
  const out = secs(2.4);
  addInto(out, stab([57, 60, 64, 69], 0.26), 0, 0.62);   // A minor
  addInto(out, stab([55, 58, 62, 67], 1.0), 0.3, 0.7);   // sagging to G minor, held
  const sigh = osc(1.4, (t) => 132 - 34 * Math.min(1, t / 1.1), 'sine');
  shape(sigh, ad(0.05, 1.3, 1.4));
  addInto(out, sigh, 0.3, 0.3);
  return normalize(polish(reverb(softClip(out, 1.1), { wet: 0.28, decay: 0.72, size: 1.3 }), 6000, 5), 0.6);
}

// ------------------------------------------------------------------- export
// name → { render, loop, gain } — gain is the runtime's default mix level,
// balanced so nothing startles and the goal is the loudest thing in the game
export function bakeSfx(write) {
  const sounds = {
    'whistle-kickoff': { render: () => whistlePhrase([[0.3, 0.1, 1880], [0.44, 0, 2180]]), gain: 0.42 },
    'whistle-short': { render: () => whistlePhrase([[0.26, 0, 1990]]), gain: 0.4 },
    'whistle-half': { render: () => whistlePhrase([[0.5, 0, 1990]]), gain: 0.42 },
    'whistle-full': { render: () => whistlePhrase([[0.24, 0.11, 2180], [0.24, 0.11, 1990], [0.7, 0, 1760]]), gain: 0.44 },
    'kick-soft': { render: () => kickThump(0.2), gain: 0.22 },
    'kick-mid': { render: () => kickThump(0.6), gain: 0.25 },
    'kick-hard': { render: () => kickThump(1), gain: 0.27 },
    'ball-bounce': { render: ballBounce, gain: 0.24 },
    'net-swish': { render: netSwish, gain: 0.62 },
    'post-clank': { render: postClank, gain: 0.55 },
    'gk-catch': { render: gkCatch, gain: 0.5 },
    'tackle-slide': { render: tackleSlide, gain: 0.42 },
    'step-a': { render: () => stepGrass(201), gain: 0.16 },
    'step-b': { render: () => stepGrass(202), gain: 0.16 },
    'step-c': { render: () => stepGrass(203), gain: 0.16 },
    'crowd-bed': { render: crowdBed, loop: true, gain: 0.26 },
    'crowd-roar': { render: crowdRoar, gain: 0.9 },
    'crowd-ooh': { render: crowdOoh, gain: 0.5 },
    'crowd-cheer': { render: crowdCheer, gain: 0.5 },
    'crowd-gasp': { render: crowdGasp, gain: 0.45 },
    'crowd-heart': { render: heartThump, gain: 0.6 },
    'crowd-groan': { render: crowdGroan, gain: 0.5 },
    'crowd-pat': { render: crowdPat, gain: 0.5 },
    'crowd-chant-a': { render: () => crowdChant(95, 0.55, 8, 148), loop: true, gain: 0.2 },
    'crowd-chant-b': { render: () => crowdChant(96, 0.85, 6, 118), loop: true, gain: 0.2 },
    'bird-a': { render: () => bird(1, [[0, 0.07, 2820, 40], [0.12, 0.06, 3040, 46], [0.22, 0.09, 2660, 38]]), gain: 0.13 },
    'bird-b': { render: () => bird(2, [[0, 0.16, 2590, 22], [0.3, 0.12, 2790, 26]]), gain: 0.13 },
    'bird-c': { render: () => bird(3, [[0, 0.05, 3040, 52], [0.07, 0.05, 3180, 52], [0.14, 0.05, 2960, 52], [0.21, 0.05, 3100, 52]]), gain: 0.11 },
    'bird-d': { render: () => bird(4, [[0, 0.22, 2800, 14]]), gain: 0.13 },
    'wind': { render: windLoop, loop: true, gain: 0.12 },
    'ui-move': { render: uiMove, gain: 0.25 },
    'ui-select': { render: uiSelect, gain: 0.26 },
    'ui-back': { render: uiBack, gain: 0.28 },
    'ui-tick': { render: uiTick, gain: 0.34 },
    'ui-denied': { render: uiDenied, gain: 0.28 },
    'ui-buy': { render: uiBuy, gain: 0.3 },
    'ui-card': { render: uiCard, gain: 0.28 },
    'ui-coin': { render: uiCoin, gain: 0.34 },
    'ui-wheel-tick': { render: uiWheelTick, gain: 0.28 },
    'ui-wheel-win': { render: uiWheelWin, gain: 0.42 },
    'goal-fanfare': { render: goalFanfare, gain: 0.55 },
    'goal-conceded': { render: concededSting, gain: 0.44 },
    'fulltime-fanfare': { render: fulltimeFanfare, gain: 0.5 },
  };
  const entries = [];
  for (const [name, def] of Object.entries(sounds)) {
    const file = `${name}.wav`;
    write(file, def.render());
    entries.push({ name, file, loop: !!def.loop, gain: def.gain });
  }
  return entries;
}
