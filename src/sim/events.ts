// Facts the renderer turns into juice; the sim never knows about pixels
export type SimEvent =
  | { kind: 'kick'; x: number; y: number; power: number; idx: number }
  | { kind: 'touch'; x: number; y: number; sprint: boolean }
  | { kind: 'cut'; x: number; y: number; dx: number; dy: number } // direction of the run being planted
  | { kind: 'bounce'; x: number; y: number; impact: number }
  | { kind: 'tackle'; x: number; y: number }
  | { kind: 'steal'; x: number; y: number } // a lunge that actually won the ball
  | { kind: 'save'; x: number; y: number }  // the keeper got something on it
  | { kind: 'restart'; taker: number; team: 0 | 1; restart: 'throwin' | 'corner' | 'goalkick' }
  | { kind: 'kickoff' }
  | { kind: 'goal'; side: 'left' | 'right' };
