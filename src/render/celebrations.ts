// Who does what when he scores. Names are the roster's exact spelling
// (src/data/pool.ts) — anybody not on this list keeps the generic wheel-away,
// which is still most of a matchday. Poses are baked in tools/texgen and
// picked out of the sheet by id; only the seven that survive a thirty-pixel
// silhouette at sixteen headings made it this far.
export interface Celebration {
  id: string;       // the pose block in manifest.player.anims.celebSigs
  label: string;    // what the goal card calls it
  loopFrom: number; // the frame it settles back to once he has arrived
  loopFps: number;  // a held pose breathes; a dance keeps time
}

const ROLL: (Celebration & { players: string[] })[] = [
  { id: 'siu', label: 'SIU', loopFrom: 2, loopFps: 2.5, players: ['RONALDO'] },
  { id: 'meditate', label: 'MEDITATION', loopFrom: 2, loopFps: 1.6, players: ['HAALAND'] },
  { id: 'fold', label: 'ARMS CROSSED', loopFrom: 2, loopFps: 2.2, players: ['MBAPPE', 'PALMER'] },
  { id: 'wide', label: 'ARMS WIDE', loopFrom: 2, loopFps: 2.2, players: ['BELLINGHAM', 'ZLATAN', 'KANE'] },
  { id: 'sky', label: 'TO THE SKY', loopFrom: 2, loopFps: 2, players: ['MESSI', 'KAKA', 'DROGBA'] },
  {
    id: 'sujood', label: 'SUJOOD', loopFrom: 2, loopFps: 1.4,
    players: ['SALAH', 'MANE', 'MAHREZ', 'HAKIMI', 'MARMOUSH', 'EN NESYRI', 'BRAHIM', 'ZIYECH', 'BOUNOU', 'MENDY', 'KOULIBALY'],
  },
  {
    id: 'samba', label: 'THE DANCE', loopFrom: 0, loopFps: 8,
    players: ['VINICIUS', 'NEYMAR', 'RONALDINHO', 'YAMAL', 'RAPHINHA', 'RODRYGO', 'MARCELO', 'ESTEVAO', 'ENDRICK', 'MARTINELLI', 'ANTONY', 'CUNHA'],
  },
];

const BY_NAME = new Map<string, Celebration>(
  ROLL.flatMap(({ players, ...cel }) => players.map((name) => [name, cel] as const)),
);

// His own, or nothing — the caller falls back to the generic arms-up cycle
export function celebrationFor(name: string): Celebration | null {
  return BY_NAME.get(name) ?? null;
}
