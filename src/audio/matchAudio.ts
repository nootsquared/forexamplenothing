import { PITCH } from '../sim/constants';
import { Match } from '../match';
import { audio } from './engine';

// The match's sound director: turns sim events into thumps, whistles and
// crowd moods, keeps the stadium bed breathing with the state of play, and
// sprinkles birdsong into the quiet spells.

const panOf = (x: number) => ((x / PITCH.length) - 0.5) * 0.9;
const BIRDS = ['bird-a', 'bird-b', 'bird-c', 'bird-d'];
const STEPS = ['step-a', 'step-b', 'step-c'];

export class MatchAudio {
  private hype = 0;
  private intensity = 0.4;
  private buildupCooldown = 4;
  private birdTimer = 3;
  private stepClock = 0;
  private stepIdx = 0;
  private prevShots: [number, number] = [0, 0];
  private prevOnTarget: [number, number] = [0, 0];
  private mood = 'day';

  begin(moodId: string) {
    this.mood = moodId;
    this.hype = 0;
    audio.music(null, 0.5);
    audio.ambient('crowd-bed', true, 2);
    audio.ambient('wind', true, 3);
  }

  end() {
    audio.ambient('crowd-bed', false, 0.8);
    audio.ambient('wind', false, 0.8);
  }

  setMood(moodId: string) {
    this.mood = moodId;
  }

  // `events` defaults to the live sim's buffer; a net GUEST passes the batch
  // drained from snapshots instead — its own world never steps or clears
  tick(match: Match, heroIdx: number, dt: number, events = match.world.events) {
    const world = match.world;
    // at the break the half whistle speaks and the countdown owns the restart
    const atTheBreak = events.some((e) => e.kind === 'half');

    for (const e of events) {
      switch (e.kind) {
        case 'kick': {
          const name = e.power < 0.45 ? 'kick-soft' : e.power < 0.75 ? 'kick-mid' : 'kick-hard';
          audio.play(name, { vol: 0.7 + e.power * 0.3, pan: panOf(e.x), jitter: 0.05 });
          break;
        }
        case 'bounce':
          if (e.impact > 3.5) audio.play('ball-bounce', { vol: Math.min(1, e.impact / 12), pan: panOf(e.x), jitter: 0.07 });
          break;
        case 'post':
          audio.play('post-clank', { vol: Math.min(1, 0.5 + e.impact / 20), pan: panOf(e.x) });
          this.hype += 0.5;
          audio.play('crowd-ooh', { vol: 0.7, delay: 0.2 });
          break;
        case 'tackle':
          audio.play('tackle-slide', { pan: panOf(e.x), jitter: 0.06 });
          break;
        case 'steal':
          audio.play('tackle-slide', { vol: 0.8, pan: panOf(e.x), jitter: 0.06 });
          audio.play('crowd-cheer', { vol: 0.45, delay: 0.1 });
          this.hype += 0.25;
          break;
        case 'save':
          audio.play('gk-catch', { pan: panOf(e.x) });
          audio.play('crowd-cheer', { vol: 0.7, delay: 0.15 });
          this.hype += 0.5;
          break;
        case 'foul':
          audio.play('whistle-short');
          audio.play('crowd-ooh', { vol: 0.45, delay: 0.35 });
          break;
        case 'kickoff':
          if (!atTheBreak) audio.play('whistle-kickoff');
          break;
        case 'goal':
          audio.play('net-swish', { vol: 1, pan: panOf(world.ball.pos.x) });
          audio.play('crowd-roar', { delay: 0.12 });
          audio.play('goal-fanfare', { delay: 0.35 });
          this.hype = 2;
          break;
        case 'half':
          audio.play('whistle-half');
          break;
        case 'fulltime':
          audio.play('whistle-full');
          audio.play('fulltime-fanfare', { delay: 0.9 });
          audio.play('crowd-roar', { vol: 0.8, delay: 0.6 });
          break;
      }
    }

    // A shot that misses still moves the ground — the near-miss gasp
    for (const t of [0, 1] as const) {
      const shotNew = match.stats.shots[t] > this.prevShots[t];
      const onNew = match.stats.onTarget[t] > this.prevOnTarget[t];
      if (shotNew && !onNew) audio.play('crowd-ooh', { vol: 0.6, delay: 0.55 });
      if (shotNew) this.hype += 0.4;
      this.prevShots[t] = match.stats.shots[t];
      this.prevOnTarget[t] = match.stats.onTarget[t];
    }

    // The bed breathes: quiet in midfield, leaning forward in either box —
    // and when the ball LIVES deep, whole sections rise in waves
    this.hype = Math.max(0, this.hype - dt * 0.45);
    const axis = Math.abs(world.ball.pos.x - PITCH.length / 2) / (PITCH.length / 2);
    const target = Math.min(1.7, 0.5 + axis * 0.62 + this.hype * 0.55);
    this.intensity += (target - this.intensity) * Math.min(1, dt * 2.5);
    audio.ambientLevel('crowd-bed', this.intensity);
    this.buildupCooldown -= dt;
    const inFinalQuarter = axis > 0.5 && world.restartLock <= 0;
    if (inFinalQuarter && this.buildupCooldown <= 0) {
      this.buildupCooldown = 5 + Math.random() * 5;
      audio.play('crowd-cheer', { vol: 0.35 + axis * 0.3, jitter: 0.08 });
    }

    // Birdsong belongs to daylight and quiet spells
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 5 + Math.random() * 9;
      if (this.mood !== 'night' && this.intensity < 0.85) {
        audio.play(BIRDS[Math.floor(Math.random() * BIRDS.length)], { pan: Math.random() * 1.4 - 0.7, jitter: 0.12 });
      }
    }

    // The hero's boots: soft grass scuffs at running cadence
    const hero = world.players[heroIdx];
    if (hero && hero.speed() > 3.4) {
      this.stepClock -= dt;
      if (this.stepClock <= 0) {
        this.stepClock = 1 / Math.min(3.6, hero.speed() / 2);
        this.stepIdx = (this.stepIdx + 1) % STEPS.length;
        audio.play(STEPS[this.stepIdx], { vol: hero.isSprinting ? 1 : 0.7, pan: panOf(hero.pos.x), jitter: 0.15 });
      }
    } else {
      this.stepClock = 0;
    }
  }
}
