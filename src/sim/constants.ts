export const PITCH = {
  length: 105,
  width: 68,
  goalWidth: 9.8,  // arcade-wide: a keeper GUARDS it, he doesn't blanket it
  goalHeight: 2.7,
  goalDepth: 2.2,
  apron: 6,
};

export const GRAVITY = 21; // slightly heavier than earth — snappy arcade bounces

export interface Surface {
  id: string;
  rollFriction: number; // constant decel while rolling, m/s²
  dragK: number;        // speed-proportional decel, 1/s
  bounce: number;       // vertical restitution
}

// Pitch modifiers (ice rink, blacktop…) plug in here later
export const SURFACES: Record<string, Surface> = {
  grass: { id: 'grass', rollFriction: 2.4, dragK: 0.35, bounce: 0.58 },
};
