import { mkdirSync, writeFileSync } from 'node:fs';
import { SR, writeWav } from './lib.mjs';
import { bakeSfx } from './sfx.mjs';
import { bakeMusic } from './music.mjs';

// Bakes the game's whole voice — SFX, ambience, music — into public/assets/audio
// plus a manifest of loop flags and default mix gains the runtime trusts.

const OUT = new URL('../../public/assets/audio/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const t0 = performance.now();
const stats = [];
const write = (file, data) => {
  const chs = Array.isArray(data) ? data : [data];
  writeWav(OUT + file, chs);
  const n = chs[0].length;
  let peak = 0, sum = 0;
  for (const ch of chs) for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(ch[i])); sum += ch[i] * ch[i]; }
  stats.push({ file, secs: (n / SR).toFixed(2), peak: peak.toFixed(2), rms: Math.sqrt(sum / (n * chs.length)).toFixed(3) });
};

const entries = [...bakeSfx(write), ...bakeMusic(write)];
writeFileSync(`${OUT}audio-manifest.json`, JSON.stringify({ sounds: entries }, null, 2));

console.table(stats);
console.log(`audio baked in ${(performance.now() - t0).toFixed(0)}ms → public/assets/audio/ (${entries.length} sounds)`);
