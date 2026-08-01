import { PlayerStats } from '../sim/player';
import { Role } from './formations';

// The top 50: hand-rated attributes (0..1) that map onto the sim's stat
// model. Names are ASCII-only — the pixel font owns the typography.

export interface StarPlayer {
  name: string;
  role: Role;
  ovr: number;
  price: number; // millions, from the OVR curve
  stats: PlayerStats;
}

// The agreed curve: doubling every 6 OVR — superstars cost real budget
export function priceOf(ovr: number): number {
  return Math.round(0.9 * Math.pow(2, (ovr - 62) / 6) * 10) / 10;
}

// pace/agility/control/power in 0..1 → the sim's meters-and-seconds stats
function toStats(pace: number, agility: number, control: number, power: number): PlayerStats {
  return {
    topSpeed: 5.4 + pace * 1.3,
    sprintSpeed: 7.4 + pace * 1.9,
    accel: 9 + agility * 2.4,
    agility,
    control,
    power,
  };
}

const P = (name: string, role: Role, ovr: number, pace: number, agility: number, control: number, power: number): StarPlayer =>
  ({ name, role, ovr, price: priceOf(ovr), stats: toStats(pace, agility, control, power) });

export const TOP_50: StarPlayer[] = [
  // Forwards
  P('MBAPPE', 'FW', 94, 1.0, 0.92, 0.86, 0.88),
  P('HAALAND', 'FW', 93, 0.9, 0.72, 0.78, 1.0),
  P('VINICIUS', 'FW', 92, 0.96, 0.95, 0.88, 0.78),
  P('MESSI', 'FW', 92, 0.72, 1.0, 1.0, 0.82),
  P('SALAH', 'FW', 90, 0.88, 0.86, 0.86, 0.84),
  P('KANE', 'FW', 90, 0.62, 0.66, 0.88, 0.96),
  P('YAMAL', 'FW', 90, 0.86, 0.94, 0.92, 0.72),
  P('RONALDO', 'FW', 89, 0.78, 0.72, 0.82, 0.98),
  P('NEYMAR', 'FW', 88, 0.8, 0.94, 0.96, 0.74),
  P('LEWANDOWSKI', 'FW', 88, 0.64, 0.7, 0.86, 0.94),
  P('SON', 'FW', 87, 0.86, 0.8, 0.8, 0.86),
  P('SAKA', 'FW', 87, 0.84, 0.84, 0.84, 0.76),
  P('OSIMHEN', 'FW', 86, 0.92, 0.74, 0.72, 0.9),
  P('KVARA', 'FW', 86, 0.84, 0.9, 0.86, 0.74),
  P('LEAO', 'FW', 86, 0.92, 0.86, 0.8, 0.78),
  P('DEMBELE', 'FW', 85, 0.9, 0.9, 0.82, 0.7),
  P('GRIEZMANN', 'FW', 85, 0.7, 0.8, 0.88, 0.8),
  // Midfielders
  P('BELLINGHAM', 'MF', 92, 0.8, 0.82, 0.9, 0.86),
  P('DE BRUYNE', 'MF', 91, 0.68, 0.76, 0.96, 0.9),
  P('RODRI', 'MF', 90, 0.6, 0.68, 0.9, 0.82),
  P('WIRTZ', 'MF', 89, 0.78, 0.88, 0.92, 0.74),
  P('MUSIALA', 'MF', 89, 0.82, 0.94, 0.9, 0.68),
  P('ODEGAARD', 'MF', 88, 0.7, 0.82, 0.94, 0.74),
  P('PEDRI', 'MF', 87, 0.7, 0.86, 0.94, 0.64),
  P('VALVERDE', 'MF', 87, 0.84, 0.78, 0.84, 0.9),
  P('FODEN', 'MF', 87, 0.78, 0.88, 0.88, 0.74),
  P('BRUNO', 'MF', 86, 0.68, 0.74, 0.88, 0.84),
  P('RICE', 'MF', 86, 0.74, 0.7, 0.8, 0.8),
  P('MODRIC', 'MF', 85, 0.6, 0.84, 0.96, 0.72),
  P('CAMAVINGA', 'MF', 85, 0.8, 0.84, 0.82, 0.7),
  P('TCHOUAMENI', 'MF', 84, 0.72, 0.68, 0.78, 0.8),
  P('GAVI', 'MF', 84, 0.74, 0.86, 0.86, 0.62),
  // Defenders
  P('VAN DIJK', 'DF', 90, 0.72, 0.62, 0.72, 0.86),
  P('DIAS', 'DF', 89, 0.64, 0.64, 0.7, 0.78),
  P('SALIBA', 'DF', 88, 0.76, 0.68, 0.68, 0.76),
  P('HAKIMI', 'DF', 87, 0.94, 0.84, 0.78, 0.74),
  P('GVARDIOL', 'DF', 87, 0.78, 0.72, 0.74, 0.76),
  P('THEO', 'DF', 86, 0.92, 0.78, 0.74, 0.8),
  P('ARAUJO', 'DF', 86, 0.8, 0.7, 0.62, 0.8),
  P('RUDIGER', 'DF', 86, 0.78, 0.64, 0.62, 0.8),
  P('WALKER', 'DF', 85, 0.94, 0.74, 0.66, 0.72),
  P('DAVIES', 'DF', 85, 0.96, 0.82, 0.72, 0.68),
  P('STONES', 'DF', 84, 0.66, 0.68, 0.8, 0.68),
  P('KOUNDE', 'DF', 84, 0.8, 0.74, 0.7, 0.68),
  // Keepers
  P('COURTOIS', 'GK', 90, 0.5, 0.86, 0.6, 0.8),
  P('ALISSON', 'GK', 89, 0.54, 0.84, 0.66, 0.78),
  P('TER STEGEN', 'GK', 88, 0.48, 0.82, 0.7, 0.74),
  P('DONNARUMMA', 'GK', 88, 0.5, 0.84, 0.56, 0.82),
  P('EDERSON', 'GK', 87, 0.56, 0.78, 0.76, 0.86),
  P('MARTINEZ', 'GK', 86, 0.5, 0.8, 0.6, 0.76),
];

// The academy: an endless bench of 1M journeymen so a broke side still
// fields eleven — never good, never free
export function academyPlayer(role: Role, n: number): StarPlayer {
  return {
    name: `ACADEMY ${n}`,
    role,
    ovr: 62,
    price: priceOf(62),
    stats: toStats(0.42, 0.5, 0.45, 0.5),
  };
}
