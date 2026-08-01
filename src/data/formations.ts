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
  slots: FormationSlot[]; // always 11, GK first
}

const slot = (role: Role, x: number, y: number): FormationSlot => ({ role, x, y });

export const FORMATIONS: Record<string, Formation> = {
  '4-4-2': {
    id: '4-4-2',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.46, 0.14), slot('MF', 0.44, 0.4), slot('MF', 0.44, 0.6), slot('MF', 0.46, 0.86),
      slot('FW', 0.72, 0.42), slot('FW', 0.72, 0.58),
    ],
  },
  '4-3-3': {
    id: '4-3-3',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.2, 0.15), slot('DF', 0.18, 0.38), slot('DF', 0.18, 0.62), slot('DF', 0.2, 0.85),
      slot('MF', 0.44, 0.3), slot('MF', 0.42, 0.5), slot('MF', 0.44, 0.7),
      slot('FW', 0.72, 0.14), slot('FW', 0.75, 0.5), slot('FW', 0.72, 0.86),
    ],
  },
  '4-2-3-1': {
    id: '4-2-3-1',
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
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.18, 0.28), slot('DF', 0.16, 0.5), slot('DF', 0.18, 0.72),
      slot('MF', 0.42, 0.08), slot('MF', 0.44, 0.32), slot('MF', 0.4, 0.5), slot('MF', 0.44, 0.68), slot('MF', 0.42, 0.92),
      slot('FW', 0.72, 0.4), slot('FW', 0.72, 0.6),
    ],
  },
  '5-3-2': {
    id: '5-3-2',
    slots: [
      slot('GK', 0.04, 0.5),
      slot('DF', 0.22, 0.08), slot('DF', 0.17, 0.3), slot('DF', 0.15, 0.5), slot('DF', 0.17, 0.7), slot('DF', 0.22, 0.92),
      slot('MF', 0.46, 0.28), slot('MF', 0.44, 0.5), slot('MF', 0.46, 0.72),
      slot('FW', 0.72, 0.4), slot('FW', 0.72, 0.6),
    ],
  },
};
