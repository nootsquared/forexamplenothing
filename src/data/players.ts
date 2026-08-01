import { PlayerStats } from '../sim/player';
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

// pace/agility/control/power in 0..1 → the sim's meters-and-seconds stats.
// Legs run ~15% under the ball's pace on purpose: the PASS is the fast option,
// and slower play buys everyone time to think between moves.
function toStats(pace: number, agility: number, control: number, power: number): PlayerStats {
  return {
    topSpeed: 4.6 + pace * 1.1,
    sprintSpeed: 6.3 + pace * 1.6,
    accel: 8.4 + agility * 2.2,
    agility,
    control,
    power,
  };
}

export const PLAYER_POOL: StarPlayer[] = POOL.map(([name, role, ovr, pace, agility, control, power, number, nation]) => ({
  name, role, ovr, number, nation,
  price: priceOf(ovr),
  stats: toStats(pace, agility, control, power),
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
    stats: toStats(0.42, 0.5, 0.45, 0.5),
  };
}
