import { Role } from './formations';
import { StarPlayer } from './players';

// The five numbers a manager actually argues about, read straight off a squad
// as it stands right now — a half-built board rates what it has, and an empty
// line rates zero (the compare card draws that as a dash, never a nought).

export interface SquadRating {
  att: number;
  mid: number;
  def: number;
  gk: number;
  pace: number;
}

export const RATING_ROWS: (keyof SquadRating)[] = ['att', 'mid', 'def', 'gk', 'pace'];
export const RATING_LABELS: Record<keyof SquadRating, string> = {
  att: 'ATTACK', mid: 'MIDFIELD', def: 'DEFENCE', gk: 'KEEPER', pace: 'PACE',
};
// ...and the three-letter version, for a strip that has to fit under a board
export const RATING_SHORT: Record<keyof SquadRating, string> = {
  att: 'ATT', mid: 'MID', def: 'DEF', gk: 'GK', pace: 'PAC',
};

// The card's PAC scale, same mapping the player cards print
const pace99 = (p: StarPlayer) => Math.round(((p.stats.sprintSpeed - 5.9) / 2.3) * 99);

export function rateSquad(picks: StarPlayer[]): SquadRating {
  const line = (roles: Role[], value: (p: StarPlayer) => number) => {
    const grp = picks.filter((p) => roles.includes(p.role));
    return grp.length ? Math.round(grp.reduce((s, p) => s + value(p), 0) / grp.length) : 0;
  };
  const ovr = (p: StarPlayer) => p.ovr;
  return {
    att: line(['FW'], ovr),
    mid: line(['MF'], ovr),
    def: line(['DF'], ovr),
    gk: line(['GK'], ovr),
    pace: Math.max(0, Math.min(99, line(['DF', 'MF', 'FW'], pace99))),
  };
}
