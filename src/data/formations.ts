// Formation shapes in normalized pitch space: x 0 = own goal line, 1 = the
// goal we attack; y 0 = far touchline, 1 = near. The same shape serves both
// teams — the sim mirrors it for whoever attacks left.

export type Role = 'GK' | 'DF' | 'MF' | 'FW';

export interface FormationSlot {
  role: Role;
  x: number;
  y: number;
}

export interface Formation {
  id: string;
  size: number;           // players per side — 5, 7 or the full 11
  slots: FormationSlot[]; // GK first
}

const slot = (role: Role, x: number, y: number): FormationSlot => ({ role, x, y });

// Shapes of a given side size — the setup screen filters by this
export function formationsOfSize(size: number): string[] {
  return Object.keys(FORMATIONS).filter((k) => FORMATIONS[k].size === size);
}

export const FORMATIONS: Record<string, Formation> = {
  '2-1-1': {
    id: '2-1-1',
    size: 5,
    slots: [
      slot('GK', 0.06, 0.5),
      slot('DF', 0.24, 0.3), slot('DF', 0.24, 0.7),
      slot('MF', 0.48, 0.5),
      slot('FW', 0.74, 0.5),
    ],
  },
  '3-2-1': {
    id: '3-2-1',
    size: 7,
    slots: [
      slot('GK', 0.05, 0.5),
      slot('DF', 0.22, 0.22), slot('DF', 0.2, 0.5), slot('DF', 0.22, 0.78),
      slot('MF', 0.47, 0.35), slot('MF', 0.47, 0.65),
      slot('FW', 0.74, 0.5),
    ],
  },
  '2-3-1': {
    id: '2-3-1',
    size: 7,
    slots: [
      slot('GK', 0.05, 0.5),
      slot('DF', 0.21, 0.35), slot('DF', 0.21, 0.65),
      slot('MF', 0.46, 0.18), slot('MF', 0.44, 0.5), slot('MF', 0.46, 0.82),
      slot('FW', 0.74, 0.5),
    ],
  },
  '4-4-2': {
    id: '4-4-2',
    size: 11,
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.46, 0.14), slot('MF', 0.44, 0.4), slot('MF', 0.44, 0.6), slot('MF', 0.46, 0.86),
      slot('FW', 0.72, 0.42), slot('FW', 0.72, 0.58),
    ],
  },
  '4-3-3': {
    id: '4-3-3',
    size: 11,
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.44, 0.3), slot('MF', 0.42, 0.5), slot('MF', 0.44, 0.7),
      slot('FW', 0.72, 0.14), slot('FW', 0.75, 0.5), slot('FW', 0.72, 0.86),
    ],
  },
  '4-2-3-1': {
    id: '4-2-3-1',
    size: 11,
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.38, 0.36), slot('MF', 0.38, 0.64),
      slot('MF', 0.55, 0.18), slot('MF', 0.56, 0.5), slot('MF', 0.55, 0.82),
      slot('FW', 0.75, 0.5),
    ],
  },
  '3-5-2': {
    id: '3-5-2',
    size: 11,
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.18, 0.28), slot('DF', 0.16, 0.5), slot('DF', 0.18, 0.72),
      slot('MF', 0.42, 0.08), slot('MF', 0.44, 0.32), slot('MF', 0.4, 0.5), slot('MF', 0.44, 0.68), slot('MF', 0.42, 0.92),
      slot('FW', 0.72, 0.4), slot('FW', 0.72, 0.6),
    ],
  },
  '5-3-2': {
    id: '5-3-2',
    size: 11,
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.22, 0.08), slot('DF', 0.17, 0.3), slot('DF', 0.15, 0.5), slot('DF', 0.17, 0.7), slot('DF', 0.22, 0.92),
      slot('MF', 0.46, 0.28), slot('MF', 0.44, 0.5), slot('MF', 0.46, 0.72),
      slot('FW', 0.72, 0.4), slot('FW', 0.72, 0.6),
    ],
  },
};
