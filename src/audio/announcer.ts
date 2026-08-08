import { audio } from './engine';

// THE MAN ON THE MICROPHONE. His whole job is knowing when NOT to speak — a
// voice that comments on everything is a robot reading a log, and it turns a
// stadium into a tutorial. So he holds one line at a time, never talks over
// himself, gives way to anything bigger than what he was about to say, and
// goes quiet for a minute at a stretch while ordinary football happens.
//
// Nothing here is deterministic and nothing here may be — the sim never sees
// this file. It is theatre, and theatre is allowed to roll dice.

export type Call =
  | 'goal' | 'conceded' | 'full'   // the moments nothing outranks
  | 'half' | 'post' | 'save'       // worth interrupting for
  | 'late' | 'kickoff'
  | 'miss' | 'colour';             // and the small talk, first to be dropped

// who wins the microphone when two moments land together
const RANK: Record<Call, number> = {
  goal: 5, conceded: 5, full: 5, half: 4, post: 3, save: 3, late: 2, kickoff: 2, miss: 1, colour: 0,
};

// how long before this call may be made again. A save every twenty seconds
// stops being a save; the woodwork is rare enough to look after itself.
const COOLDOWN: Record<Call, number> = {
  goal: 0, conceded: 0, full: 0, half: 0, kickoff: 0,
  post: 9, save: 14, late: 90, miss: 26, colour: 75,
};

const GAP = 0.5;     // a breath after every line, so two calls never touch
const IDLE_GAP = 8;  // small talk waits this long after the PA last said anything
const STALE = 1.6;   // a call the ground has already moved past is not worth making
const DUCK = 0.72;   // the crowd pulled back a couple of dB behind the voice
const LEAN_IN = 0.35; // the mixer's hand moving BEFORE the mic opens

class Announcer {
  private t = 0;
  private busyUntil = -1;
  private busyRank = 0;
  private pending: { call: Call; name: string; at: number } | null = null;
  private said = new Map<Call, number>();
  private bags = new Map<Call, string[]>();
  private lastLine = new Map<Call, string>();

  reset() {
    this.t = 0;
    this.busyUntil = -1;
    this.busyRank = 0;
    this.pending = null;
    this.said.clear();
    this.bags.clear();
    this.lastLine.clear();
  }

  // What the crowd bed should be multiplied by right now — 1 unless there is
  // a voice in the air, which is the difference between a broadcast and a man
  // shouting from the terrace
  get duck() {
    const soon = this.pending && this.pending.at - this.t < LEAN_IN;
    return this.busyUntil > this.t || soon ? DUCK : 1;
  }

  // Offer a moment to the announcer. He may well decline, and declining is the
  // feature. `delay` is the beat he waits so the net, the roar and the brass
  // all get there first.
  say(call: Call, delay = 0) {
    const rank = RANK[call];
    const last = this.said.get(call);
    if (last !== undefined && this.t - last < COOLDOWN[call]) return;
    if (rank === 0 && this.t < this.busyUntil + IDLE_GAP) return; // small talk needs a real lull
    if (this.busyUntil > this.t && rank < this.busyRank) return;  // never over the top of a bigger moment
    if (this.pending && RANK[this.pending.call] > rank) return;   // and never two deep
    const name = this.draw(call);
    if (name) this.pending = { call, name, at: this.t + delay };
  }

  // Lines are held here rather than handed to the mixer early, so leaving a
  // match cannot leave a goal call hanging in the air over the menu
  update(dt: number) {
    this.t += dt;
    const p = this.pending;
    if (!p || this.t < p.at) return;
    // waiting for the microphone does not age a line; waiting for the world to
    // care does
    if (this.t > Math.max(p.at, this.busyUntil) + STALE) { this.pending = null; return; }
    if (this.t < this.busyUntil) return;
    this.pending = null;
    audio.play(p.name);
    this.said.set(p.call, this.t);
    this.busyUntil = this.t + audio.duration(p.name) + GAP;
    this.busyRank = RANK[p.call];
  }

  // A bag that empties before it refills: every variant is heard once before
  // any of them comes round again. Five goal calls picked at random still
  // stutter; five picked from a bag never do.
  private draw(call: Call) {
    let bag = this.bags.get(call);
    if (!bag?.length) {
      bag = audio.variants(`vo-${call}-`);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      // and the seam a plain shuffle leaves: a new bag must never open on the
      // line the old one closed with, or five variants still stutter
      const top = bag.length - 1;
      if (top > 0 && bag[top] === this.lastLine.get(call)) [bag[0], bag[top]] = [bag[top], bag[0]];
      this.bags.set(call, bag);
    }
    const name = bag.pop();
    if (name) this.lastLine.set(call, name);
    return name;
  }
}

export const announcer = new Announcer();
