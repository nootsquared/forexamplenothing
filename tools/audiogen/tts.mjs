import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { LINES } from './lines.mjs';

// The announcer's throat — run by hand (`node tools/audiogen/tts.mjs`), never
// by the bake. It speaks every line once into tools/audiogen/voice/*.wav and
// those takes are COMMITTED, because a 63MB neural voice and a Python venv are
// no business of `pnpm build`. The bake downstream only ever reads WAVs, so the
// game still builds on a machine that has never heard of Piper.
//
// Takes land as 11025Hz mono: the tannoy chain walls everything off above
// 3.2kHz anyway, so storing a fifth of a megabyte of headroom nobody hears
// would just be repo weight.

const HOME = `${homedir()}/.cache/total22-voice`;
const VOICE = 'en_GB-alan-medium'; // a dry, unhurried English baritone — a ground announcer, not a commentator
const OUT = new URL('voice/', import.meta.url).pathname;
const RAW_RATE = 11025;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...opts });
const has = (cmd) => { try { run('which', [cmd]); return true; } catch { return false; } };

// Piper ships as a Python wheel, so the first run builds itself a venv off to
// the side and pulls the voice down. Everything lives under ~/.cache — the
// repo never carries the model.
function provisionPiper() {
  const py = `${HOME}/venv/bin/python`;
  if (!existsSync(py)) {
    console.log('  provisioning piper (one time, ~100MB) …');
    mkdirSync(HOME, { recursive: true });
    run('python3', ['-m', 'venv', `${HOME}/venv`]);
    run(py, ['-m', 'pip', '-q', 'install', 'piper-tts']);
  }
  run(py, ['-c', 'import piper']);
  if (!existsSync(`${HOME}/voices/${VOICE}.onnx`)) {
    mkdirSync(`${HOME}/voices`, { recursive: true });
    run(py, ['-m', 'piper.download_voices', '--data-dir', `${HOME}/voices`, VOICE]);
  }
  return (text, wav) => run(py, [
    '-m', 'piper', '-m', `${HOME}/voices/${VOICE}.onnx`, '-f', wav,
    '--length-scale', '0.92',  // a shade quicker than conversational; a PA does not dawdle
    '--noise-w-scale', '0.85', // tighter phoneme widths — crisper consonants through a horn
    '--', text,
  ]);
}

// macOS has always had a synthesiser. It is stiffer than Piper, but under a
// bandpass and a stadium it is a perfectly respectable tannoy.
function provisionSay() {
  run('say', ['-v', 'Daniel', '-o', '/tmp/t22-say-probe.aiff', 'test']);
  return (text, wav) => {
    run('say', ['-v', 'Daniel', '-r', '186', '-o', '/tmp/t22-say.aiff', text]);
    run('ffmpeg', ['-y', '-v', 'error', '-i', '/tmp/t22-say.aiff', '-ar', '44100', '-ac', '1', wav]);
  };
}

// Speech that starts 80ms late plays 80ms late, and a call that lands after
// the roar has passed is worse than no call — so both ends get shaved.
const TRIM = 'silenceremove=start_periods=1:start_silence=0.01:start_threshold=-46dB:detection=peak,areverse,'
  + 'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-46dB:detection=peak,areverse';

if (!has('ffmpeg')) {
  console.error('tts: needs ffmpeg on PATH to trim and resample the takes.');
  process.exit(1);
}

let speak;
let route;
try {
  speak = provisionPiper();
  route = `piper ${VOICE}`;
} catch (err) {
  console.warn(`tts: piper unavailable (${String(err.message).split('\n')[0]}) — falling back to macOS say`);
  try {
    speak = provisionSay();
    route = 'macos say / Daniel';
  } catch {
    console.error('tts: no local voice on this machine. Lines left as they are on disk.');
    process.exit(1);
  }
}

mkdirSync(OUT, { recursive: true });
const t0 = performance.now();
for (const [name, text] of Object.entries(LINES)) {
  const tmp = `/tmp/t22-vo-${name}.wav`;
  speak(text, tmp);
  run('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-af', TRIM, '-ar', String(RAW_RATE), '-ac', '1', '-c:a', 'pcm_s16le', `${OUT}${name}.wav`]);
  rmSync(tmp, { force: true });
  process.stdout.write(`  ${name.padEnd(16)} "${text}"\n`);
}
console.log(`\n${Object.keys(LINES).length} takes via ${route} in ${((performance.now() - t0) / 1000).toFixed(1)}s → tools/audiogen/voice/`);
console.log('now run `pnpm gen:audio` to push them through the stadium PA.');
