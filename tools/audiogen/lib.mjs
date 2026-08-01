import { writeFileSync } from 'node:fs';

// The bake's little DSP kit: deterministic synthesis primitives that turn
// plain math into WAV files. Everything the game hears is built from these.

export const SR = 44100;

export const secs = (n) => new Float32Array(Math.ceil(n * SR));
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Phase-accumulated oscillator; freq may be a constant or fn(t) — chirps and
// slides come free. Naive waves on purpose: the edge IS the chiptune flavor.
export function osc(seconds, freq, wave = 'sine', { duty = 0.5, phase = 0 } = {}) {
  const out = secs(seconds);
  const f = typeof freq === 'function' ? freq : () => freq;
  let ph = phase;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += f(t) / SR;
    const p = ph - Math.floor(ph);
    out[i] =
      wave === 'sine' ? Math.sin(p * Math.PI * 2) :
      wave === 'tri' ? 1 - 4 * Math.abs(p - 0.5) :
      wave === 'saw' ? 2 * p - 1 :
      p < duty ? 1 : -1; // square with duty
  }
  return out;
}

export function noise(seconds, rng) {
  const out = secs(seconds);
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return out;
}

// Shape a buffer in place with env(t 0..dur) and return it
export function shape(buf, env) {
  const dur = buf.length / SR;
  for (let i = 0; i < buf.length; i++) buf[i] *= env(i / SR, dur);
  return buf;
}

// Classic percussive attack-decay envelope
export const ad = (attack, decay, curve = 2) => (t) =>
  t < attack ? t / Math.max(attack, 1e-5) : Math.pow(Math.max(0, 1 - (t - attack) / decay), curve);

export function onePoleLP(buf, cutoff) {
  const f = typeof cutoff === 'function' ? cutoff : () => cutoff;
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.min(0.99, (Math.PI * 2 * f(i / SR)) / SR);
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

export function onePoleHP(buf, cutoff) {
  const f = typeof cutoff === 'function' ? cutoff : () => cutoff;
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.min(0.99, (Math.PI * 2 * f(i / SR)) / SR);
    y += a * (buf[i] - y);
    buf[i] = buf[i] - y;
  }
  return buf;
}

// RBJ bandpass, output re-normalized so Q never changes loudness
export function bandpass(buf, freq, q = 1) {
  const w0 = (Math.PI * 2 * freq) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let peak = 1e-9;
  const src = Float32Array.from(buf);
  for (let i = 0; i < buf.length; i++) {
    const x = src[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
    const a = Math.abs(y);
    if (a > peak) peak = a;
  }
  const srcPeak = src.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  const g = srcPeak / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

export function addInto(dst, src, at = 0, gain = 1) {
  const o = Math.round(at * SR);
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i] * gain;
  return dst;
}

export function gain(buf, g) {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

export function softClip(buf, drive = 1) {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive);
  return buf;
}

export function normalize(buf, peakTarget = 0.9) {
  let peak = 1e-9;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  return gain(buf, peakTarget / peak);
}

// Crossfade the tail into the head so a bed loops without a seam, then trim
export function loopable(buf, fade = 0.5) {
  const n = Math.round(fade * SR);
  const len = buf.length - n;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = buf[i];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = out[i] * t + buf[len + i] * (1 - t);
  }
  return out;
}

// Schroeder reverb — four combs and two allpasses is all a stadium needs
export function reverb(buf, { wet = 0.3, decay = 0.75, size = 1, damp = 3500 } = {}) {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({
    buf: new Float32Array(Math.round(d * size)), i: 0, lp: 0,
  }));
  const alls = [225, 556].map((d) => ({ buf: new Float32Array(d), i: 0 }));
  const dampA = Math.min(0.99, (Math.PI * 2 * damp) / SR);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp += dampA * (y - c.lp);
      c.buf[c.i] = x + c.lp * decay;
      c.i = (c.i + 1) % c.buf.length;
      acc += y;
    }
    acc /= combs.length;
    for (const a of alls) {
      const y = a.buf[a.i];
      a.buf[a.i] = acc + y * 0.5;
      acc = y - acc * 0.5;
      a.i = (a.i + 1) % a.buf.length;
    }
    out[i] = x * (1 - wet) + acc * wet;
  }
  return out;
}

// 16-bit PCM WAV, mono or stereo
export function writeWav(path, channels) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const n = chs[0].length;
  const nCh = chs.length;
  const dataLen = n * nCh * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(nCh, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * nCh * 2, 28); b.writeUInt16LE(nCh * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, chs[c][i]));
      b.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  writeFileSync(path, b);
}
