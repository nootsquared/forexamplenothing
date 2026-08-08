import { PlayerStats } from '../sim/player';
import { Role } from './formations';
import { StarPlayer } from './players';

// Quick match's eleven: nobody famous, nobody special. Every shirt carries the
// SAME sheet and wears the job it does, so the only thing on trial is the
// person holding the sticks. The class dial moves both benches, not one.

export type Quality = 0 | 1 | 2;
export const QUALITY_NAMES = ['SUNDAY LEAGUE', 'PRO', 'WORLD CLASS'];
const QUALITY_OVR = [66, 78, 90];

// One sheet for everyone on the grass: a defender shoots like a striker and a
// striker tackles like a defender, because a fair match has no specialists to
// hide behind. Keepers keep their hands — the one job nobody else can do.
function equalStats(q: Quality, keeper: boolean): PlayerStats {
  const t = q / 2;
  const mix = (lo: number, hi: number) => lo + (hi - lo) * t;
  return {
    topSpeed: mix(4.7, 5.6),
    sprintSpeed: mix(6.4, 7.6),
    accel: mix(8.6, 9.8),
    agility: mix(0.58, 0.86),
    control: mix(0.5, 0.86),
    power: mix(0.58, 0.86),
    shoot: mix(0.32, 0.6),
    pass: mix(0.4, 0.72),
    longBall: mix(0.34, 0.66),
    defend: mix(0.32, 0.6),
    phys: mix(0.38, 0.64),
    reflex: keeper ? mix(0.42, 0.86) : 0.1,
    dive: keeper ? mix(0.38, 0.82) : 0.1,
    handling: keeper ? mix(0.4, 0.84) : 0.1,
  };
}

// The job, spelled out — what the crowd would shout instead of a surname.
// Indexed by how many of that job take the field, so a back three reads
// RIGHT / CENTRE / LEFT and a back four splits the middle in two.
const ORDINALS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'];
const GENERIC: Record<Role, string> = { GK: 'KEEPER', DF: 'DEFENDER', MF: 'MIDFIELDER', FW: 'FORWARD' };
const JOB_NAMES: Record<Role, string[][]> = {
  GK: [[], ['KEEPER']],
  DF: [[], ['CENTRE BACK'], ['CENTRE BACK ONE', 'CENTRE BACK TWO'],
    ['RIGHT BACK', 'CENTRE BACK', 'LEFT BACK'],
    ['RIGHT BACK', 'CENTRE BACK ONE', 'CENTRE BACK TWO', 'LEFT BACK'],
    ['RIGHT BACK', 'CENTRE BACK ONE', 'CENTRE BACK TWO', 'CENTRE BACK THREE', 'LEFT BACK']],
  MF: [[], ['CENTRE MID'], ['CENTRE MID ONE', 'CENTRE MID TWO'],
    ['RIGHT WING', 'CENTRE MID', 'LEFT WING'],
    ['RIGHT WING', 'CENTRE MID ONE', 'CENTRE MID TWO', 'LEFT WING'],
    ['RIGHT WING', 'CENTRE MID ONE', 'CENTRE MID TWO', 'CENTRE MID THREE', 'LEFT WING']],
  FW: [[], ['STRIKER'], ['STRIKER ONE', 'STRIKER TWO'],
    ['RIGHT FORWARD', 'STRIKER', 'LEFT FORWARD'],
    ['RIGHT FORWARD', 'STRIKER ONE', 'STRIKER TWO', 'LEFT FORWARD']],
};
// Shirts the old way: one in goal, low numbers at the back, nine and ten up top
const SHIRTS: Record<Role, number[]> = { GK: [1], DF: [2, 5, 6, 3, 4], MF: [7, 8, 10, 11, 14], FW: [9, 17, 19] };

function jobNames(role: Role, count: number): string[] {
  const set = JOB_NAMES[role][count];
  if (set) return set;
  return Array.from({ length: count }, (_, i) => `${GENERIC[role]} ${ORDINALS[i] ?? i + 1}`);
}

// Both benches, dealt from nothing: same jobs, same shirts, same sheet — only
// the class each side was signed at can differ
export function quickSquads(quota: Record<Role, number>, quality: [Quality, Quality]): [StarPlayer[], StarPlayer[]] {
  const side = (q: Quality): StarPlayer[] => {
    const squad: StarPlayer[] = [];
    (['GK', 'DF', 'MF', 'FW'] as Role[]).forEach((role) => {
      const count = quota[role] ?? 0;
      jobNames(role, count).forEach((name, i) => {
        squad.push({
          name, role, ovr: QUALITY_OVR[q], price: 0,
          number: SHIRTS[role][i] ?? 20 + i,
          nation: 'T22',
          stats: equalStats(q, role === 'GK'),
        });
      });
    });
    return squad;
  };
  return [side(quality[0]), side(quality[1])];
}

// The class the setup screen last dialed. The attract match, the tutorial and
// the training ground field the same neutral eleven off it — one fair default
// nobody has to think about.
let table: [Quality, Quality] = [1, 1];
export function setQuickQuality(home: Quality, away: Quality) {
  table = [home, away];
}
export function quickQuality(): [Quality, Quality] {
  return table;
}
