import { PlayerStats } from '../sim/player';
import { clamp } from '../core/math';
import { Role } from './formations';
import { POOL } from './pool';

// The World Cup class wearing the sim's stat model. Names are ASCII-only — the
// pixel font owns the typography. Numbers and nations ride onto the cards.

export interface StarPlayer {
  name: string;
  role: Role;
  ovr: number;
  price: number; // millions, from the OVR curve
  number: number; // his real shirt
  nation: string; // three letters of home
  stats: PlayerStats;
}

// The agreed curve: doubling every 6 OVR — superstars cost real budget
export function priceOf(ovr: number): number {
  return Math.round(0.9 * Math.pow(2, (ovr - 62) / 6) * 10) / 10;
}

// Card rarity straight off the rating — the border every collector reads first
export type Rarity = 'legend' | 'epic' | 'rare' | 'common';
export function rarityOf(ovr: number): Rarity {
  return ovr >= 88 ? 'legend' : ovr >= 82 ? 'epic' : ovr >= 76 ? 'rare' : 'common';
}

// Positional exclusivity, as arithmetic: each felt stat is base + gain·rating,
// and every off-role ceiling (base + gain + jitter) sits BELOW the opposing
// role's gray floor — a gold defender's finishing never reaches a gray
// striker's. Tiers ride the same rails without ever crossing them.
const ROLE_CURVES: Record<Role, Record<'shoot' | 'pass' | 'longBall' | 'defend' | 'phys', [number, number]>> = {
  FW: { shoot: [0.35, 0.62], pass: [0.22, 0.40], longBall: [0.25, 0.30], defend: [0.06, 0.10], phys: [0.20, 0.35] },
  MF: { shoot: [0.18, 0.35], pass: [0.40, 0.58], longBall: [0.45, 0.50], defend: [0.22, 0.33], phys: [0.25, 0.35] },
  DF: { shoot: [0.08, 0.12], pass: [0.30, 0.45], longBall: [0.10, 0.15], defend: [0.42, 0.56], phys: [0.40, 0.50] },
  GK: { shoot: [0.04, 0.04], pass: [0.10, 0.10], longBall: [0.04, 0.04], defend: [0.28, 0.30], phys: [0.30, 0.30] },
};

// Deterministic per-player grain (same on every machine — net-safe): even
// before the hand-authored roster pass, no two players are clones
const hash01 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
};
const jitter = (name: string, key: string) => (hash01(name + key) - 0.5) * 0.08;

// pace/agility/control/power in 0..1 + role + rating → the sim's full stat
// sheet. Legs run under the ball's pace on purpose (the PASS is the fast
// option) but the pace band is WIDE now — gold genuinely runs away from gray.
export function deriveStats(role: Role, ovr: number, pace: number, agility: number, control: number, power: number, name: string): PlayerStats {
  const n = clamp((ovr - 60) / 36, 0, 1);
  const curve = (key: keyof typeof ROLE_CURVES.FW, nudge = 0) => {
    const [base, gain] = ROLE_CURVES[role][key];
    return clamp(base + gain * n + nudge + jitter(name, key), 0.02, base + gain + 0.08);
  };
  const gk = role === 'GK';
  // Legs wear the shirt too: defenders visibly heavier while forwards keep
  // their authored ceilings — the role contrast reads at a glance on grass
  const paceEff = clamp(pace - (role === 'DF' ? 0.08 : role === 'MF' ? 0.03 : gk ? 0.1 : 0), 0.02, 1);
  return {
    topSpeed: 4.3 + paceEff * 1.5,
    sprintSpeed: 5.9 + paceEff * 2.3,
    accel: 8.4 + agility * 2.2,
    agility,
    control,
    power,
    shoot: curve('shoot', gk ? 0 : (power - 0.65) * 0.18),
    pass: curve('pass', gk ? 0 : (control - 0.65) * 0.15),
    longBall: curve('longBall'),
    defend: curve('defend'),
    phys: curve('phys'),
    reflex: gk ? clamp(0.30 + 0.62 * n + jitter(name, 'reflex'), 0.02, 0.99) : 0.1,
    dive: gk ? clamp(0.22 + 0.48 * n + agility * 0.22 + jitter(name, 'dive'), 0.02, 0.99) : 0.1,
    handling: gk ? clamp(0.26 + 0.50 * n + control * 0.18 + jitter(name, 'handling'), 0.02, 0.99) : 0.1,
  };
}

export const PLAYER_POOL: StarPlayer[] = POOL.map(([name, role, ovr, pace, agility, control, power, number, nation]) => ({
  name, role, ovr, number, nation,
  price: priceOf(ovr),
  stats: deriveStats(role, ovr, pace, agility, control, power, name),
}));

// The academy: an endless bench of 1M journeymen so a broke side still
// fields eleven — never good, never free
export function academyPlayer(role: Role, n: number): StarPlayer {
  return {
    name: `ACADEMY ${n}`,
    role,
    ovr: 62,
    price: priceOf(62),
    number: 0, // takes whatever shirt is left in the hamper
    nation: 'ACA',
    stats: deriveStats(role, 62, 0.42, 0.5, 0.45, 0.5, `ACADEMY ${n}`),
  };
}
