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

// Legs sit ~15% under the ball's pace — passing is the fast option. The felt
// stats carry the positional exclusivity in miniature: mid-tier at their own
// trade, poor at everyone else's.
const ARCHETYPES: Record<Role, PlayerStats> = {
  GK: { topSpeed: 4.4, sprintSpeed: 6.0, accel: 8.4, agility: 0.75, control: 0.5, power: 0.65,
        shoot: 0.05, pass: 0.15, longBall: 0.05, defend: 0.42, phys: 0.45, reflex: 0.58, dive: 0.52, handling: 0.5 },
  DF: { topSpeed: 5.0, sprintSpeed: 6.9, accel: 8.8, agility: 0.6, control: 0.55, power: 0.7,
        shoot: 0.13, pass: 0.5, longBall: 0.17, defend: 0.66, phys: 0.62, reflex: 0.1, dive: 0.1, handling: 0.1 },
  MF: { topSpeed: 5.2, sprintSpeed: 7.1, accel: 9.3, agility: 0.75, control: 0.75, power: 0.7,
        shoot: 0.33, pass: 0.66, longBall: 0.67, defend: 0.36, phys: 0.4, reflex: 0.1, dive: 0.1, handling: 0.1 },
  FW: { topSpeed: 5.4, sprintSpeed: 7.5, accel: 9.8, agility: 0.8, control: 0.7, power: 0.8,
        shoot: 0.62, pass: 0.4, longBall: 0.38, defend: 0.1, phys: 0.35, reflex: 0.1, dive: 0.1, handling: 0.1 },
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
        ...base,
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
