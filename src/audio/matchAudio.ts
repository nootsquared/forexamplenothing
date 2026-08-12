import { clamp } from '../core/math';
import { Match } from '../match';
import { director, tackleWindow } from '../director';
import { audio } from './engine';
import { announcer, Call } from './announcer';
import { BIRDS } from './ambience';

// The match's sound director: turns sim events into thumps, whistles and crowd
// moods, and rides the tension director's number so the ground breathes with
// the game — murmur in midfield, chants in the final third, a held breath the
// instant a shot leaves a boot, then the roar or the groan.

// The PA is off: a synthesised announcer sounds like a toy, and a toy voice
// over a real moment cheapens it. Everything behind it is intact and waiting.
const PA_VOICE = false;

// The ears sit where the LENS does, and the lens is glued to the ball — so a
// pan is measured from the ball, not from the halfway line. Panning in pitch
// coordinates puts a boot at the near post hard left while it fills the screen.
const HALF_VIEW = 22; // metres from the centre of frame to its edge, near enough
const STEPS = ['step-a', 'step-b', 'step-c'];

export class MatchAudio {
  private bed = 0.5;
  private buildupCooldown = 4;
  private birdTimer = 3;
  private stepClock = 0;
  private stepIdx = 0;
  private prevShots: [number, number] = [0, 0];
  private prevOnTarget: [number, number] = [0, 0];
  private mood = 'day';
  private chant: string | null = null;
  private chantQuietT = 0;
  private heartDub = 0;   // the second half of a beat, one breath behind the first
  private windowTick = 0; // the whisper that says a tackle would land right now
  private musicOn = true;
  private musicQuietT = 0;
  private musicHold = 0;  // seconds the ambient cue must stay out of the way
  private listenerX = 0;  // where the frame is looking, smoothed like the lens
  private lateCalled = false; // the run-in warning belongs to one half, once
  private kickoffCall = false; // the greeting waits for the first tick to know where it is
  private quiet = true;   // no clock, no PA: drills and the attract game hear nothing

  // Everything the announcer is offered comes through here, because a ground
  // announcer at a training session is a joke, and the coach's tutorial has a
  // voice of its own that nothing may talk over.
  // SHELVED: the synthesised voice reads as a novelty, not a broadcast. The
  // lines, the bake and the priority rules all stay — flip this back on when
  // there is a voice worth listening to.
  private pa(call: Call, delay = 0) {
    if (PA_VOICE && !this.quiet) announcer.say(call, delay);
  }

  // A stand is thousands of people and it never makes the same noise twice.
  // Every crowd one-shot goes through here, so the pitch and level spread that
  // stops a two-second cheer reading as a tape loop is ONE rule — not fourteen
  // call sites that each have to remember it.
  private crowd(name: string, vol: number, delay = 0, pan = 0) {
    audio.play(name, { vol: vol * (0.85 + Math.random() * 0.3), delay, pan, jitter: 0.075 });
  }

  begin(moodId: string) {
    this.mood = moodId;
    director.reset();
    this.musicOn = true;
    this.musicHold = 0;
    this.listenerX = 0;
    this.lateCalled = false;
    this.kickoffCall = true;
    this.quiet = true;
    announcer.reset();
    // the ambient bed arrives over five seconds and sits UNDER the crowd —
    // play should never be silent, and it should never sound accompanied
    audio.music('music-calm', 5, 0.35);
    audio.ambient('crowd-bed', true, 2);
    // no wind under a full stadium: two rushing beds stacked was the "grass or
    // wind or something" the ear kept hearing instead of people. It belongs to
    // the quiet places — the menu keeps it.
    // The sim queues its opening kickoff before the first tick and clears the
    // buffer on that tick, so the one whistle every player expects to hear
    // never reached the ear. It is spoken here instead; the engine's debounce
    // swallows the event's copy if the buffer ever does survive.
    audio.play('whistle-kickoff');
  }

  end() {
    announcer.reset();
    audio.music(null, 2);
    audio.ambient('crowd-bed', false, 0.8);
    audio.ambient('wind', false, 0.8);
    if (this.chant) audio.ambient(this.chant, false, 1.2);
    this.chant = null;
    director.reset();
  }

  setMood(moodId: string) {
    this.mood = moodId;
  }

  // `events` defaults to the live sim's buffer; a net GUEST passes the batch
  // drained from snapshots instead — its own world never steps or clears
  tick(match: Match, heroIdx: number, dt: number, events = match.world.events) {
    const world = match.world;
    // a clock is what makes it a match; drills and the attract game have none
    this.quiet = match.halfLength <= 0;
    if (this.kickoffCall) {
      this.kickoffCall = false;
      this.pa('kickoff', 1.2);
    }
    director.update(match, heroIdx, events, dt);
    // at the break the half whistle speaks and the countdown owns the restart
    const atTheBreak = events.some((e) => e.kind === 'half');
    // the lens chases the ball; the ears follow it a beat behind so a bouncing
    // ball does not slide the whole stadium left and right
    this.listenerX += (world.ball.pos.x - this.listenerX) * Math.min(1, dt * 4);
    const panOf = (x: number) => clamp((x - this.listenerX) / HALF_VIEW, -1, 1) * 0.8;
    const heroTeam = world.players[heroIdx]?.id.team;

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
          this.crowd('crowd-ooh', 0.85, 0.18);
          this.pa('post', 0.62);
          break;
        case 'tackle':
          audio.play('tackle-slide', { pan: panOf(e.x), jitter: 0.06 });
          break;
        case 'steal':
          audio.play('tackle-slide', { vol: 0.7, rate: 1.14, pan: panOf(e.x), jitter: 0.06 });
          break;
        case 'skillmove':
          // the barge lands as a body thud; the footwork moves stay under the
          // crowd until the real recordings arrive
          if (e.move === 'barge') audio.play('tackle-slide', { vol: 0.5, rate: 0.8, pan: panOf(e.x), jitter: 0.08 });
          break;
        case 'save':
          audio.play('gk-catch', { pan: panOf(e.x) });
          this.crowd('crowd-cheer', 0.75, 0.15);
          this.pa('save', 0.55);
          break;
        case 'foul':
          audio.play('whistle-short');
          this.crowd('crowd-ooh', 0.45, 0.35);
          break;
        // the flag: same short blast as any referee call, and a crowd that
        // has just watched a good move struck off
        case 'offside':
          audio.play('whistle-short', { vol: 0.9 });
          this.crowd('crowd-groan', 0.5, 0.3);
          break;
        case 'kickoff':
          if (!atTheBreak) audio.play('whistle-kickoff');
          break;
        // The two goals sound NOTHING alike. Yours: the net, the roar, the
        // brass. Theirs: the same net, a roar that arrives late and distant
        // from the away end, your own stand groaning over it, and a sting that
        // sags instead of lifting. Rewarding a concession is the one mistake
        // a football game cannot make.
        case 'goal': {
          const scoringTeam: 0 | 1 = (e.side === 'left') === (world.attackSign(0) < 0) ? 0 : 1;
          audio.play('net-swish', { vol: 1, pan: panOf(world.ball.pos.x) });
          // the PA waits for the roar to come off its plateau and the brass to
          // finish — measured, not felt: the roar holds full for 1.75s
          if (heroTeam === undefined || scoringTeam === heroTeam) {
            this.crowd('crowd-roar', 1, 0.12);
            audio.play('goal-fanfare', { delay: 0.35 });
            this.pa('goal', 2.2);
          } else {
            this.crowd('crowd-roar', 0.5, 0.5, 0.55);
            this.crowd('crowd-groan', 0.85, 0.16);
            audio.play('goal-conceded', { delay: 0.5 });
            this.pa('conceded', 1.9);
          }
          this.musicHold = 14; // the stadium owns the next quarter-minute
          break;
        }
        case 'half':
          audio.play('whistle-half');
          this.pa('half', 1.1);
          this.lateCalled = false; // the second half gets its own run-in
          break;
        case 'fulltime':
          audio.play('whistle-full');
          audio.play('fulltime-fanfare', { delay: 0.9 });
          this.crowd('crowd-roar', 0.8, 0.6);
          this.pa('full', 2.4);
          break;
      }
    }

    this.answerCues();
    // A shot that misses still moves the ground — a groan when it was yours,
    // the sound of a held breath let go when it was theirs
    for (const t of [0, 1] as const) {
      const shotNew = match.stats.shots[t] > this.prevShots[t];
      const onNew = match.stats.onTarget[t] > this.prevOnTarget[t];
      if (shotNew && !onNew) {
        if (heroTeam === undefined || t === heroTeam) {
          this.crowd('crowd-groan', 0.55, 0.5);
          this.pa('miss', 0.8);
        } else this.crowd('crowd-cheer', 0.4, 0.45);
      }
      this.prevShots[t] = match.stats.shots[t];
      this.prevOnTarget[t] = match.stats.onTarget[t];
    }

    // The run-in: once, in the half that decides it, and only while the ball
    // is live — nobody announces the closing minute over a goal kick. The
    // clock on screen is real seconds and a half is two minutes, so the last
    // minute is capped at a share of the half rather than a flat number,
    // or a short half would hear it moments after the restart.
    const runIn = Math.min(55, match.halfLength * 0.45);
    if (!this.lateCalled && match.halfLength > 0 && match.half === 2 && match.halfLive
      && match.halfLength - match.clock < runIn) {
      this.lateCalled = true;
      this.pa('late');
    }

    announcer.update(dt);
    this.rideCrowd(dt);
    this.rideMusic(dt);

    // The whisper that a lunge would land RIGHT NOW — the ear learns the
    // rhythm long before the eye trusts the diamond
    this.windowTick = Math.max(0, this.windowTick - dt);
    if (this.windowTick <= 0 && tackleWindow(world, heroIdx) > 0.5) {
      this.windowTick = 1.6;
      audio.play('ui-tick', { vol: 0.3, rate: 1.4, pan: panOf(world.ball.pos.x) });
    }

    // Birdsong belongs to daylight and quiet spells
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 5 + Math.random() * 9;
      if (this.mood !== 'night' && director.level < 0.45) {
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

  // The stadium answering what YOU just did: a pat for a pass through the
  // lines, a groan for the ball you gave away, a real cheer when you win it
  private answerCues() {
    const pulseVol = 0.9 + director.level * 0.5;
    for (const cue of director.cues) {
      switch (cue) {
        case 'shot':
          this.crowd('crowd-gasp', 0.45 + director.level * 0.35);
          break;
        case 'heart':
          audio.play('crowd-heart', { vol: pulseVol });
          this.heartDub = 0.17;
          break;
        // small talk hangs off a pass worth admiring rather than a timer, so
        // the one time a minute he says something it is about football you
        // just played. His own cooldown makes it rare; the lull test keeps him
        // out of the moments the crowd should own alone.
        case 'through':
          this.crowd('crowd-pat', 0.62, 0.06);
          if (director.level < 0.66) this.pa('colour', 0.5);
          break;
        case 'clean':
          this.crowd('crowd-pat', 0.34, 0.05);
          break;
        case 'won':
          this.crowd('crowd-cheer', 0.55, 0.08);
          break;
        case 'beatman':
          this.crowd('crowd-ooh', 0.45, 0.05);
          break;
        case 'giveaway':
          this.crowd('crowd-groan', 0.4, 0.12);
          break;
        // the tally trick: every extra pass in the run rides a step higher
        case 'chain':
          audio.play('ui-tick', { vol: 0.28, rate: 1 + Math.min(0.55, (director.chain - 3) * 0.07) });
          break;
      }
    }
  }

  // The bed, the chants and the held breath — one arc, all from one number
  private rideCrowd(dt: number) {
    // silence is the loudest tool there is — and the ground steps back a
    // couple of dB behind the microphone, the way a mixer rides a PA feed
    const breath = (1 - 0.72 * director.hush) * announcer.duck;
    const target = (0.45 + director.level * 1.2) * breath;
    this.bed += (target - this.bed) * Math.min(1, dt * (target < this.bed ? 9 : 2.5));
    audio.ambientLevel('crowd-bed', this.bed, director.hush > 0.02 ? 0.08 : 0.45);

    // Chants belong to the end being attacked, and they hold that end until
    // the pressure genuinely dies — nothing thrashes when play swings
    if (!this.chant && director.level > 0.62) {
      this.chant = director.end > 0 ? 'crowd-chant-a' : 'crowd-chant-b';
      audio.ambient(this.chant, true, 3.5);
      this.chantQuietT = 0;
    } else if (this.chant) {
      this.chantQuietT = director.level < 0.5 ? this.chantQuietT + dt : 0;
      if (this.chantQuietT > 2.5) {
        audio.ambient(this.chant, false, 3);
        this.chant = null;
      } else {
        audio.ambientLevel(this.chant, clamp((director.level - 0.5) / 0.45, 0, 1) * 0.95 * breath, 0.7);
      }
    }

    if (this.heartDub > 0) {
      this.heartDub -= dt;
      if (this.heartDub <= 0) audio.play('crowd-heart', { vol: (0.9 + director.level * 0.5) * 0.6, rate: 0.9 });
    }

    // Whole sections rising in waves while the ground is up on its feet
    this.buildupCooldown -= dt;
    if (director.level > 0.55 && this.buildupCooldown <= 0) {
      this.buildupCooldown = 5 + Math.random() * 5;
      this.crowd('crowd-cheer', 0.3 + director.level * 0.3);
    }
  }

  // Minecraft's cadence, not a soundtrack: the calm loop plays through the
  // quiet spells and LEAVES when the ground finds its voice — coming back is
  // what makes it feel like a gift
  private rideMusic(dt: number) {
    this.musicHold = Math.max(0, this.musicHold - dt);
    if (this.musicOn && (director.level > 0.6 || this.musicHold > 0)) {
      audio.music(null, 2.5);
      this.musicOn = false;
      this.musicQuietT = 0;
      return;
    }
    if (this.musicOn) return;
    this.musicQuietT = director.level < 0.45 && this.musicHold <= 0 ? this.musicQuietT + dt : 0;
    if (this.musicQuietT > 6) {
      audio.music('music-calm', 6, 0.35);
      this.musicOn = true;
    }
  }
}
