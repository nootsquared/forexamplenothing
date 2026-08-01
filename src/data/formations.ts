// Formation shapes in normalized pitch space: x 0 = own goal line, 1 = the
// goal we attack; y 0 = far touchline, 1 = near. The same shape serves both
// teams — the sim mirrors it for whoever attacks left.

export type Role = 'GK' | 'DF' | 'MF' | 'FW';
export type PlayStyle = 'attacking' | 'balanced' | 'defensive';
export const STYLES: PlayStyle[] = ['attacking', 'balanced', 'defensive'];

export interface FormationSlot {
  role: Role;
  x: number;
  y: number;
}

export interface Formation {
  id: string;
  size: number;           // players per side — 5, 7 or the full 11
  style: PlayStyle;       // the face it shows: front-foot, even, or a wall
  slots: FormationSlot[]; // GK first
}

const slot = (role: Role, x: number, y: number): FormationSlot => ({ role, x, y });

// Shapes of a given side size — the pickers filter by this
export function formationsOfSize(size: number): string[] {
  return Object.keys(FORMATIONS).filter((k) => FORMATIONS[k].size === size);
}
export function formationsOf(size: number, style: PlayStyle): string[] {
  return formationsOfSize(size).filter((k) => FORMATIONS[k].style === style);
}

export const FORMATIONS: Record<string, Formation> = {
  // ------------------------------------------------------------ five a side
  '2-1-1': {
    id: '2-1-1',
    size: 5,
    style: 'balanced',
    slots: [
      slot('GK', 0.06, 0.5),
      slot('DF', 0.24, 0.3), slot('DF', 0.24, 0.7),
      slot('MF', 0.48, 0.5),
      slot('FW', 0.74, 0.5),
    ],
  },
  '1-2-1': {
    id: '1-2-1',
    size: 5,
    style: 'attacking',
    slots: [
      slot('GK', 0.06, 0.5),
      slot('DF', 0.22, 0.5),
      slot('MF', 0.48, 0.28), slot('MF', 0.48, 0.72),
      slot('FW', 0.76, 0.5),
    ],
  },
  '2-2': {
    id: '2-2',
    size: 5,
    style: 'defensive',
    slots: [
      slot('GK', 0.06, 0.5),
      slot('DF', 0.22, 0.32), slot('DF', 0.22, 0.68),
      slot('MF', 0.52, 0.35), slot('MF', 0.52, 0.65),
    ],
  },
  // ----------------------------------------------------------- seven a side
  '3-2-1': {
    id: '3-2-1',
    size: 7,
    style: 'defensive',
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
    style: 'balanced',
    slots: [
      slot('GK', 0.05, 0.5),
      slot('DF', 0.21, 0.35), slot('DF', 0.21, 0.65),
      slot('MF', 0.46, 0.18), slot('MF', 0.44, 0.5), slot('MF', 0.46, 0.82),
      slot('FW', 0.74, 0.5),
    ],
  },
  '2-2-2': {
    id: '2-2-2',
    size: 7,
    style: 'attacking',
    slots: [
      slot('GK', 0.05, 0.5),
      slot('DF', 0.2, 0.35), slot('DF', 0.2, 0.65),
      slot('MF', 0.45, 0.25), slot('MF', 0.45, 0.75),
      slot('FW', 0.72, 0.38), slot('FW', 0.72, 0.62),
    ],
  },
  // ------------------------------------------------------------- the elevens
  '4-3-3': {
    id: '4-3-3',
    size: 11,
    style: 'attacking',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.44, 0.3), slot('MF', 0.42, 0.5), slot('MF', 0.44, 0.7),
      slot('FW', 0.72, 0.14), slot('FW', 0.75, 0.5), slot('FW', 0.72, 0.86),
    ],
  },
  '3-4-3': {
    id: '3-4-3',
    size: 11,
    style: 'attacking',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.18, 0.28), slot('DF', 0.16, 0.5), slot('DF', 0.18, 0.72),
      slot('MF', 0.44, 0.1), slot('MF', 0.42, 0.38), slot('MF', 0.42, 0.62), slot('MF', 0.44, 0.9),
      slot('FW', 0.7, 0.2), slot('FW', 0.74, 0.5), slot('FW', 0.7, 0.8),
    ],
  },
  '4-1-2-1-2': {
    id: '4-1-2-1-2',
    size: 11,
    style: 'attacking',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.34, 0.5),
      slot('MF', 0.48, 0.28), slot('MF', 0.48, 0.72),
      slot('MF', 0.6, 0.5),
      slot('FW', 0.74, 0.4), slot('FW', 0.74, 0.6),
    ],
  },
  '4-4-2': {
    id: '4-4-2',
    size: 11,
    style: 'balanced',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.46, 0.14), slot('MF', 0.44, 0.4), slot('MF', 0.44, 0.6), slot('MF', 0.46, 0.86),
      slot('FW', 0.72, 0.42), slot('FW', 0.72, 0.58),
    ],
  },
  '4-2-3-1': {
    id: '4-2-3-1',
    size: 11,
    style: 'balanced',
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
    style: 'balanced',
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
    style: 'defensive',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.22, 0.08), slot('DF', 0.17, 0.3), slot('DF', 0.15, 0.5), slot('DF', 0.17, 0.7), slot('DF', 0.22, 0.92),
      slot('MF', 0.46, 0.28), slot('MF', 0.44, 0.5), slot('MF', 0.46, 0.72),
      slot('FW', 0.72, 0.4), slot('FW', 0.72, 0.6),
    ],
  },
  '4-5-1': {
    id: '4-5-1',
    size: 11,
    style: 'defensive',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.4, 0.1), slot('MF', 0.42, 0.3), slot('MF', 0.38, 0.5), slot('MF', 0.42, 0.7), slot('MF', 0.4, 0.9),
      slot('FW', 0.72, 0.5),
    ],
  },
  '5-4-1': {
    id: '5-4-1',
    size: 11,
    style: 'defensive',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.22, 0.08), slot('DF', 0.17, 0.3), slot('DF', 0.15, 0.5), slot('DF', 0.17, 0.7), slot('DF', 0.22, 0.92),
      slot('MF', 0.44, 0.16), slot('MF', 0.42, 0.4), slot('MF', 0.42, 0.6), slot('MF', 0.44, 0.84),
      slot('FW', 0.7, 0.5),
    ],
  },
};
