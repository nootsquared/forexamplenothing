// Facts the renderer turns into juice; the sim never knows about pixels
export type SimEvent =
  | { kind: 'kick'; x: number; y: number; power: number; idx: number }
  | { kind: 'touch'; x: number; y: number; sprint: boolean }
  | { kind: 'cut'; x: number; y: number; dx: number; dy: number } // direction of the run being planted
  | { kind: 'bounce'; x: number; y: number; impact: number }
  | { kind: 'tackle'; x: number; y: number }
  | { kind: 'steal'; x: number; y: number } // a lunge that actually won the ball
  | { kind: 'restart'; taker: number; team: 0 | 1 } // throw-in / corner / goal kick awarded
  | { kind: 'goal'; side: 'left' | 'right' };
