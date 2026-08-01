import { SR, secs, osc, noise, shape, ad, onePoleLP, onePoleHP, bandpass, softClip, normalize, makeRng } from './lib.mjs';

// A four-voice chip tracker and the two songs the game owns: a bright bouncing
// menu anthem and a cooler, coiled draft-room groove. Loops are sample-exact —
// every echo and release tail wraps around into the top of the form.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// note: [bar, beat, midi, lenBeats, vel?]
function renderSong(song) {
  const spb = 60 / song.bpm;
  const loopLen = Math.round(song.bars * 4 * spb * SR);
  const L = new Float32Array(loopLen);
  const R = new Float32Array(loopLen);

  const addWrapped = (buf, at, gainL, gainR) => {
    const o = Math.round(at * SR);
    for (let i = 0; i < buf.length; i++) {
      const j = (o + i) % loopLen;
      L[j] += buf[i] * gainL;
      R[j] += buf[i] * gainR;
    }
  };
  const panGains = (g, p) => [g * Math.min(1, 1 - p), g * Math.min(1, 1 + p)];

  for (const ch of song.channels) {
    const [gl, gr] = panGains(ch.gain, ch.pan ?? 0);
    for (const [bar, beat, midi, len, vel = 1] of ch.notes) {
      const at = (bar * 4 + beat) * spb;
      const dur = Math.max(0.05, len * spb * 0.92);
      const f0 = mtof(midi + (ch.transpose ?? 0));
      const vib = ch.vib;
      const freq = vib
        ? (t) => f0 * (1 + vib.depth * Math.sin(Math.PI * 2 * vib.rate * t) * Math.min(1, Math.max(0, t - vib.after) / 0.14))
        : f0;
      const n = osc(dur + 0.08, freq, ch.wave, { duty: ch.duty ?? 0.5 });
      shape(n, (t) => {
        const a = Math.min(1, t / 0.005);
        const rel = t > dur ? Math.max(0, 1 - (t - dur) / 0.08) : 1;
        const sus = t < 0.05 ? 1 : 0.78 + 0.22 * Math.exp(-(t - 0.05) * 3);
        return a * rel * sus;
      });
      addWrapped(n, at, gl * vel, gr * vel);
      if (ch.echo) {
        for (let e = 1; e <= 2; e++) {
          addWrapped(n, at + ch.echo.time * spb * e, gl * vel * Math.pow(ch.echo.gain, e), gr * vel * Math.pow(ch.echo.gain, e));
        }
      }
    }
  }

  const rng = makeRng(999);
  const drumKit = {
    kick: () => {
      const b = osc(0.09, (t) => 42 + 90 * Math.exp(-t * 55), 'sine');
      shape(b, ad(0.001, 0.085, 2));
      const c = onePoleHP(noise(0.006, rng), 2000);
      shape(c, ad(0.0004, 0.005, 2));
      for (let i = 0; i < c.length; i++) b[i] += c[i] * 0.25;
      return b;
    },
    snare: () => {
      const n = bandpass(noise(0.13, rng), 1900, 0.8);
      shape(n, ad(0.001, 0.12, 2.2));
      const body = osc(0.06, 195, 'sine');
      shape(body, ad(0.001, 0.055, 2));
      for (let i = 0; i < body.length; i++) n[i] += body[i] * 0.5;
      return n;
    },
    hat: () => {
      const n = onePoleHP(noise(0.03, rng), 6800);
      shape(n, ad(0.0005, 0.028, 2));
      return n;
    },
    ohat: () => {
      const n = onePoleHP(noise(0.09, rng), 6200);
      shape(n, ad(0.0005, 0.085, 1.6));
      return n;
    },
    rim: () => {
      const n = bandpass(noise(0.02, rng), 3100, 2);
      shape(n, ad(0.0004, 0.018, 2));
      const p = osc(0.015, 820, 'sine');
      shape(p, ad(0.0005, 0.013, 2));
      for (let i = 0; i < p.length; i++) n[i] += p[i] * 0.6;
      return n;
    },
  };
  const drumGain = { kick: 0.5, snare: 0.3, hat: 0.1, ohat: 0.11, rim: 0.2 };
  const drumPan = { kick: 0, snare: 0.05, hat: 0.22, ohat: 0.22, rim: -0.12 };
  for (const [bar, beat, kind, vel = 1] of song.drums) {
    const [gl, gr] = panGains(drumGain[kind] * vel, drumPan[kind]);
    addWrapped(drumKit[kind](), (bar * 4 + beat) * spb, gl, gr);
  }

  onePoleLP(L, 11500);
  onePoleLP(R, 11500);
  softClip(L, 1.12);
  softClip(R, 1.12);
  const peak = Math.max(...[L, R].map((b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9)));
  for (let i = 0; i < loopLen; i++) { L[i] *= 0.85 / peak; R[i] *= 0.85 / peak; }
  return [L, R];
}

// Expand a chord chart into a driving root-and-fifth bass with a chromatic
// walk into each new bar — the engine room of both songs
function pumpBass(roots) {
  const notes = [];
  roots.forEach((r, bar) => {
    const next = roots[(bar + 1) % roots.length];
    const steps = [[0, r], [0.5, r], [1, r + 7], [1.5, r], [2, r + 12], [2.5, r], [3, r + 7]];
    for (const [b, m] of steps) notes.push([bar, b, m, 0.5, b === 0 ? 1 : 0.82]);
    notes.push([bar, 3.5, next === r ? r : next - Math.sign(next - r), 0.5, 0.9]);
  });
  return notes;
}

// Chord tones rippling in 16ths across two octaves
function arpeggio(roots, quality, bars, gainVelocity = 1) {
  const notes = [];
  for (const bar of bars) {
    const r = roots[bar % roots.length];
    const tones = [0, quality[bar % quality.length], 7, 12];
    for (let s = 0; s < 16; s++) {
      const tone = tones[s % 4] + (s % 8 >= 4 ? 12 : 0);
      notes.push([bar, s * 0.25, r + 24 + tone, 0.25, gainVelocity * (s % 4 === 0 ? 1 : 0.75)]);
    }
  }
  return notes;
}

// ------------------------------------------------------------ GOLAZO THEME
// The menu anthem: A major, 118 on the clock, a hook that kicks the door in,
// a lifted middle eight, and a walk-up turnaround that lands on its own head.
function golazoTheme() {
  const A = 45, D = 50, E = 52, Fs = 54;
  const roots = [A, A, D, E, A, A, D, E, Fs, D, A, E, D, E, A, A];
  const lead = [
    // the hook
    [0, 0, 76, 0.5], [0, 0.5, 73, 0.5], [0, 1, 69, 1], [0, 2.5, 69, 0.5], [0, 3, 71, 0.5], [0, 3.5, 73, 0.5],
    [1, 0, 76, 0.75], [1, 1, 78, 0.5], [1, 1.5, 76, 0.5], [1, 2, 73, 1.5],
    [2, 0, 78, 0.5], [2, 0.5, 81, 0.5], [2, 1, 78, 0.5], [2, 1.5, 74, 0.5], [2, 2, 76, 1], [2, 3, 74, 0.5], [2, 3.5, 73, 0.5],
    [3, 0, 71, 1], [3, 1.5, 73, 0.5], [3, 2, 71, 0.5], [3, 2.5, 68, 0.5], [3, 3, 64, 1],
    // the hook again, answered upward
    [4, 0, 76, 0.5], [4, 0.5, 73, 0.5], [4, 1, 69, 1], [4, 2.5, 69, 0.5], [4, 3, 71, 0.5], [4, 3.5, 73, 0.5],
    [5, 0, 76, 0.75], [5, 1, 78, 0.5], [5, 1.5, 76, 0.5], [5, 2, 73, 1.5],
    [6, 0, 78, 0.5], [6, 0.5, 81, 0.5], [6, 1, 83, 0.75], [6, 2, 81, 0.5], [6, 2.5, 80, 0.5], [6, 3, 78, 0.5], [6, 3.5, 76, 0.5],
    [7, 0, 78, 0.5], [7, 0.5, 80, 0.5], [7, 1, 81, 2],
    // the lift
    [8, 0, 81, 1.5], [8, 2, 78, 1], [8, 3, 76, 0.5], [8, 3.5, 78, 0.5],
    [9, 0, 78, 1.5], [9, 2, 74, 1], [9, 3, 76, 0.5], [9, 3.5, 78, 0.5],
    [10, 0, 76, 1.5], [10, 2, 73, 1], [10, 3, 71, 0.5], [10, 3.5, 73, 0.5],
    [11, 0, 71, 2], [11, 2, 76, 0.5], [11, 2.5, 78, 0.5], [11, 3, 80, 1],
    // drive it home
    [12, 0, 81, 0.5], [12, 0.5, 81, 0.5], [12, 1, 78, 1], [12, 2, 81, 0.5], [12, 2.5, 81, 0.5], [12, 3, 78, 1],
    [13, 0, 80, 0.5], [13, 0.5, 80, 0.5], [13, 1, 76, 1], [13, 2, 83, 1], [13, 3, 81, 0.5], [13, 3.5, 80, 0.5],
    [14, 0, 81, 2.5], [14, 3, 76, 0.5], [14, 3.5, 73, 0.5],
    // walk-up turnaround: lands on the hook's opening E
    [15, 1, 64, 0.5], [15, 1.5, 66, 0.5], [15, 2, 68, 0.5], [15, 2.5, 71, 0.5], [15, 3, 73, 0.5], [15, 3.5, 74, 0.5],
  ];
  const pad = [8, 9, 10, 11, 14].flatMap((bar) => {
    const r = roots[bar];
    const third = bar === 8 ? 3 : 4; // F#m keeps its minor color
    return [[bar, 0, r + 24, 4, 1], [bar, 0, r + 24 + third, 4, 0.8]];
  });
  const drums = [];
  for (let bar = 0; bar < 16; bar++) {
    drums.push([bar, 0, 'kick'], [bar, 2, 'kick'], [bar, 1, 'snare'], [bar, 3, 'snare']);
    if (bar % 2 === 1) drums.push([bar, 3.75, 'kick', 0.7]);
    for (let e = 0; e < 8; e++) drums.push([bar, e * 0.5, 'hat', e % 2 === 0 ? 1 : 0.55]);
    if (bar % 4 === 3) drums.push([bar, 1.5, 'ohat', 0.9]);
    if (bar === 7 || bar === 15) {
      drums.push([bar, 3, 'snare', 0.5], [bar, 3.25, 'snare', 0.65], [bar, 3.5, 'snare', 0.8], [bar, 3.75, 'snare', 1]);
    }
  }
  return renderSong({
    bpm: 118,
    bars: 16,
    channels: [
      { wave: 'square', duty: 0.25, gain: 0.26, pan: 0.1, vib: { rate: 5.3, depth: 0.008, after: 0.1 }, echo: { time: 0.75, gain: 0.26 }, notes: lead },
      { wave: 'tri', gain: 0.34, pan: 0, notes: pumpBass(roots) },
      { wave: 'square', duty: 0.25, gain: 0.085, pan: -0.25, notes: arpeggio(roots, [4, 4, 4, 4, 4, 4, 4, 4, 3, 4, 4, 4, 4, 4, 4, 4], [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 0.9) },
      { wave: 'square', duty: 0.5, gain: 0.07, pan: -0.35, notes: pad },
      { wave: 'square', duty: 0.5, gain: 0.07, pan: 0.35, transpose: 0.06, notes: pad },
    ],
    drums,
  });
}

// ---------------------------------------------------------------- WAR ROOM
// The draft's groove: F# minor at 102, a coiled bass pulse, rim clicks and a
// motif that surfaces every four bars — cool heads, big money on the table.
function warRoom() {
  const Fs = 42, D = 38, A = 45, E = 40;
  const roots = [Fs, Fs, D, E, Fs, D, E, E];
  const lead = [
    [1, 0, 85, 0.75], [1, 1, 83, 0.5], [1, 2, 81, 1.5],
    [2, 2, 78, 0.5], [2, 2.5, 81, 0.5], [2, 3, 83, 1],
    [3, 0, 81, 2],
    [5, 0, 81, 0.5], [5, 0.5, 83, 0.5], [5, 1, 85, 1.5], [5, 3, 83, 0.5], [5, 3.5, 81, 0.5],
    [6, 0, 80, 1.5], [6, 2, 76, 1],
    [7, 0, 78, 2.5],
  ];
  const bass = [];
  roots.forEach((r, bar) => {
    const steps = [[0, r, 1], [0.5, r, 0.7], [1, r, 0.85], [1.5, r + 12, 0.7], [2, r, 1], [2.5, r, 0.7], [3, r + 7, 0.85], [3.5, r + 10, 0.75]];
    for (const [b, m, v] of steps) bass.push([bar, b, m, 0.5, v]);
  });
  const drums = [];
  for (let bar = 0; bar < 8; bar++) {
    drums.push([bar, 0, 'kick'], [bar, 2.5, 'kick', 0.85], [bar, 3, 'kick', 0.6]);
    drums.push([bar, 1, 'rim'], [bar, 3, 'rim']);
    for (let e = 0; e < 8; e++) drums.push([bar, e * 0.5, 'hat', e % 2 === 0 ? 0.8 : 0.45]);
    if (bar === 3 || bar === 7) drums.push([bar, 3.5, 'ohat', 0.8]);
  }
  return renderSong({
    bpm: 102,
    bars: 8,
    channels: [
      { wave: 'square', duty: 0.3, gain: 0.2, pan: 0.12, vib: { rate: 5, depth: 0.007, after: 0.12 }, echo: { time: 0.75, gain: 0.3 }, notes: lead },
      { wave: 'tri', gain: 0.36, pan: 0, notes: bass },
      { wave: 'square', duty: 0.25, gain: 0.075, pan: -0.28, notes: arpeggio(roots, [3, 3, 4, 4, 3, 4, 4, 4], [0, 1, 2, 3, 4, 5, 6, 7], 0.8) },
    ],
    drums,
  });
}

export function bakeMusic(write) {
  const entries = [];
  const songs = {
    'music-menu': { render: golazoTheme, gain: 0.5 },
    'music-draft': { render: warRoom, gain: 0.45 },
  };
  for (const [name, def] of Object.entries(songs)) {
    const file = `${name}.wav`;
    write(file, def.render());
    entries.push({ name, file, loop: true, gain: def.gain, music: true });
  }
  return entries;
}
