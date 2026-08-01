import { Rng } from '../core/rng';
import { PlayerStats } from '../sim/player';
import { Formation } from './formations';
import { Role } from './formations';

// M2 squads: archetype stats varied per role, seeded so both teams are fair
// and every rebuild fields the same players. The real top-100 roster with
// prices replaces this in draft mode (M4).

export interface SquadPlayer {
  number: number;
  name: string;
  role: Role;
  stats: PlayerStats;
}

// Legs sit ~15% under the ball's pace — passing is the fast option
const ARCHETYPES: Record<Role, PlayerStats> = {
  GK: { topSpeed: 4.4, sprintSpeed: 6.0, accel: 8.4, agility: 0.75, control: 0.5, power: 0.65 },
  DF: { topSpeed: 5.0, sprintSpeed: 6.9, accel: 8.8, agility: 0.6, control: 0.55, power: 0.7 },
  MF: { topSpeed: 5.2, sprintSpeed: 7.1, accel: 9.3, agility: 0.75, control: 0.75, power: 0.7 },
  FW: { topSpeed: 5.4, sprintSpeed: 7.5, accel: 9.8, agility: 0.8, control: 0.7, power: 0.8 },
};

export function buildSquad(formation: Formation, seed: number): SquadPlayer[] {
  const rng = new Rng(seed);
  return formation.slots.map((slot, i) => {
    const base = ARCHETYPES[slot.role];
    const vary = (v: number, spread: number) => v * (1 + (rng.next() - 0.5) * spread);
    return {
      number: i + 1,
      name: `NO ${i + 1}`,
      role: slot.role,
      stats: {
        topSpeed: vary(base.topSpeed, 0.08),
        sprintSpeed: vary(base.sprintSpeed, 0.08),
        accel: vary(base.accel, 0.1),
        agility: Math.min(1, vary(base.agility, 0.15)),
        control: Math.min(1, vary(base.control, 0.15)),
        power: Math.min(1, vary(base.power, 0.12)),
      },
    };
  });
}
