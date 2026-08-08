import { existsSync } from 'node:fs';
import {
  SR, readWav, upsample, normalize, onePoleHP, peakEq, softClip, polish,
  lowpass2, reverb, addInto, decimate,
} from './lib.mjs';
import { CALLS } from './lines.mjs';

// The stadium PA. A voice arrives here as a clean studio take and has to leave
// sounding like it came out of a horn bolted to a gantry eighty metres away —
// because a clean voice over a crowd reads as a podcast pasted onto a football
// match, and the whole point is that the ground is speaking, not a narrator.
//
// Everything below is one idea: throw away the parts of a human voice a horn
// could never carry. No chest, no air, no sibilance — just the honky middle
// that survives the trip, some grit off the driver, and the bowl answering.

const VOICE = new URL('voice/', import.meta.url).pathname;
const THIN = 4; // nothing survives above 3.2kHz, so ship at a quarter rate

const HORN_LOW = 430;   // below this a horn simply has no cone left — and it is where the crowd is loudest, so the voice is better off out of it
const HORN_HONK = 1750; // measured: the crowd's quietest decade. Owning it is why the PA cuts at a whisper instead of shouting
const HORN_ROOF = 3200; // the ear's sore spot starts here; the PA stops here

const SLAP = 0.115;     // the far stand answering, the length of the bowl
const HUSH = 0.0012;    // where a reverb tail stops being sound and starts being file size

// Cut the take where the tail dies, then ease the last 30ms out so the WAV
// boundary never clicks
function trimTail(buf) {
  let end = buf.length;
  while (end > 1 && Math.abs(buf[end - 1]) < HUSH) end--;
  const out = buf.slice(0, Math.min(buf.length, end + 256));
  const fade = Math.min(out.length, Math.round(0.03 * SR));
  for (let i = 0; i < fade; i++) out[out.length - fade + i] *= 1 - i / fade;
  return out;
}

function tannoy(file) {
  const take = readWav(file);
  const dry = normalize(upsample(take.samples, Math.round(SR / take.rate)), 0.7);

  // room for the bowl to answer after the last word
  const out = new Float32Array(dry.length + Math.round(1.4 * SR));
  addInto(out, dry, 0, 1);
  addInto(out, lowpass2(Float32Array.from(dry), 1400), SLAP, 0.17);

  onePoleHP(onePoleHP(out, HORN_LOW), HORN_LOW);
  peakEq(out, HORN_HONK, 7, 0.7); // wide enough to carry 1.2-2.6kHz, and it stops short of the sore band
  softClip(out, 1.55); // the driver working a little harder than it wants to
  // 4dB out of the sore spot, and two poles is a real wall here rather than
  // the usual four: the take arrives at 11kHz, so there is nothing above 5.5k
  // to catch — and a steeper slope would only eat the honk that does the work
  polish(out, HORN_ROOF, 4, 2);
  return trimTail(normalize(reverb(out, { wet: 0.26, decay: 0.7, size: 1.5, damp: 1800 }), 0.62));
}

// Measured, not guessed. In the 1-2kHz band the announcer lands level with the
// crowd bed and about 9dB under a goal roar — audible through everything,
// louder than nothing. He peaks at 0.31 where the roar peaks at 0.77, so he
// never touches the master ceiling. Ceremony drops a little because the ground
// is already quiet for a whistle, and the conceded call drops furthest: the
// man on the microphone does not want to be saying it.
const LEVEL = { conceded: 0.42, half: 0.46, full: 0.46, kickoff: 0.46 };
const LEVEL_DEFAULT = 0.5;

export function bakeAnnouncer(write) {
  const entries = [];
  for (const [call, texts] of Object.entries(CALLS)) {
    for (let i = 1; i <= texts.length; i++) {
      const src = `${VOICE}${call}-${i}.wav`;
      if (!existsSync(src)) continue; // no take on disk, no line — never a broken fetch
      const name = `vo-${call}-${i}`;
      const file = `${name}.wav`;
      write(file, decimate(tannoy(src), THIN), SR / THIN);
      entries.push({ name, file, loop: false, gain: LEVEL[call] ?? LEVEL_DEFAULT });
    }
  }
  if (!entries.length) console.warn('announcer: no takes in tools/audiogen/voice — run `node tools/audiogen/tts.mjs`');
  return entries;
}
