// The game's ears-side: loads the baked WAV library, owns the music/sfx/ambient
// buses, and stays politely silent until the browser lets sound through.

interface SoundMeta {
  name: string;
  file: string;
  loop: boolean;
  gain: number;
  music?: boolean;
}

interface PlayOpts {
  vol?: number;
  pan?: number;   // -1 left … 1 right
  rate?: number;
  jitter?: number; // random playbackRate spread — repeated sounds never machine-gun
  delay?: number;
}

const volCurve = (v: number) => Math.pow(Math.max(0, Math.min(10, v)) / 10, 1.6);

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private ambientBus!: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private meta = new Map<string, SoundMeta>();
  private musicNow: { name: string; src: AudioBufferSourceNode; g: GainNode } | null = null;
  private loops = new Map<string, { src: AudioBufferSourceNode; g: GainNode; level: number }>();
  private lastAt = new Map<string, number>();
  private ready = false;

  async load() {
    if (typeof AudioContext === 'undefined') return; // headless: the game plays mute
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.ambientBus = this.ctx.createGain();
    for (const bus of [this.musicBus, this.sfxBus, this.ambientBus]) bus.connect(this.master);
    try {
      const manifest = await (await fetch('/assets/audio/audio-manifest.json')).json();
      await Promise.all(manifest.sounds.map(async (s: SoundMeta) => {
        const data = await (await fetch(`/assets/audio/${s.file}`)).arrayBuffer();
        this.buffers.set(s.name, await this.ctx!.decodeAudioData(data));
        this.meta.set(s.name, s);
      }));
      this.ready = true;
    } catch {
      this.ctx = null; // a missing bake never breaks the game — it just goes quiet
    }
  }

  // Browsers gate audio behind a gesture; the shell calls this on the first one
  unlock() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(music: number, sfx: number) {
    if (!this.ctx) return;
    this.musicBus.gain.value = volCurve(music);
    this.sfxBus.gain.value = volCurve(sfx);
    this.ambientBus.gain.value = volCurve(sfx) * 0.9; // the stadium lives on the SFX dial
  }

  play(name: string, { vol = 1, pan = 0, rate = 1, jitter = 0, delay = 0 }: PlayOpts = {}) {
    if (!this.ready || !this.ctx) return;
    const buf = this.buffers.get(name);
    const m = this.meta.get(name);
    if (!buf || !m) return;
    const now = this.ctx.currentTime;
    if ((this.lastAt.get(name) ?? -1) > now - 0.045) return; // same-frame pile-ups collapse
    this.lastAt.set(name, now + delay);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = this.ctx.createGain();
    g.gain.value = m.gain * vol;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(this.sfxBus);
    src.start(now + delay);
  }

  ui(name: 'move' | 'select' | 'back' | 'denied' | 'buy' | 'card' | 'coin' | 'wheel-tick' | 'wheel-win', vol = 1) {
    this.play(`ui-${name}`, { vol });
  }

  // Crossfade to a looping track — or to silence with music(null)
  music(name: string | null, fade = 0.8, vol = 1) {
    if (!this.ready || !this.ctx) return;
    if (this.musicNow?.name === name) return;
    const now = this.ctx.currentTime;
    if (this.musicNow) {
      const old = this.musicNow;
      old.g.gain.setValueAtTime(old.g.gain.value, now);
      old.g.gain.linearRampToValueAtTime(0, now + fade);
      old.src.stop(now + fade + 0.05);
      this.musicNow = null;
    }
    if (!name) return;
    const buf = this.buffers.get(name);
    const m = this.meta.get(name);
    if (!buf || !m) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(m.gain * vol, now + fade);
    src.connect(g).connect(this.musicBus);
    src.start(now);
    this.musicNow = { name, src, g };
  }

  // Ambient beds fade in and hold until told otherwise
  ambient(name: string, on: boolean, fade = 1.2) {
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    const running = this.loops.get(name);
    if (on && !running) {
      const buf = this.buffers.get(name);
      const m = this.meta.get(name);
      if (!buf || !m) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(m.gain, now + fade);
      src.connect(g).connect(this.ambientBus);
      src.start(now);
      this.loops.set(name, { src, g, level: 1 });
    } else if (!on && running) {
      running.g.gain.setValueAtTime(running.g.gain.value, now);
      running.g.gain.linearRampToValueAtTime(0, now + fade);
      running.src.stop(now + fade + 0.05);
      this.loops.delete(name);
    }
  }

  // Live level for a running bed — the crowd swells with the match
  ambientLevel(name: string, level: number, ramp = 0.5) {
    if (!this.ctx) return;
    const running = this.loops.get(name);
    const m = this.meta.get(name);
    if (!running || !m || Math.abs(running.level - level) < 0.02) return;
    running.level = level;
    const now = this.ctx.currentTime;
    running.g.gain.setValueAtTime(running.g.gain.value, now);
    running.g.gain.linearRampToValueAtTime(m.gain * level, now + ramp);
  }
}

export const audio = new AudioEngine();
