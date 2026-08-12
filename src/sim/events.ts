// Facts the renderer turns into juice; the sim never knows about pixels
export type SimEvent =
  | { kind: 'kick'; x: number; y: number; power: number; idx: number }
  | { kind: 'touch'; x: number; y: number; sprint: boolean }
  | { kind: 'cut'; x: number; y: number; dx: number; dy: number } // direction of the run being planted
  | { kind: 'bounce'; x: number; y: number; impact: number }
  | { kind: 'post'; x: number; y: number; impact: number } // off the woodwork!
  | { kind: 'tackle'; x: number; y: number }
  | { kind: 'steal'; x: number; y: number } // a lunge or a slide actually won the ball
  | { kind: 'feint'; x: number; y: number; dx: number; dy: number } // the sway sold, the burst gone the other way
  // A kit move committed (croqueta / rainbow / barge — feint and slide speak
  // through their own events above); dx/dy is the move's line
  | { kind: 'skillmove'; move: 'croqueta' | 'rainbow' | 'barge'; idx: number; x: number; y: number; dx: number; dy: number }
  | { kind: 'shrug'; x: number; y: number } // a lunge bounced off the shield — physicality said no
  | { kind: 'save'; x: number; y: number }  // the keeper killed it in his gloves
  | { kind: 'parry'; x: number; y: number } // strong hands turned it away, ball live
  | { kind: 'restart'; taker: number; team: 0 | 1; restart: 'throwin' | 'corner' | 'goalkick' | 'offside' | 'freekick' }
  | { kind: 'offside'; x: number; y: number; idx: number } // the flag: caught beyond the line at the kick
  | { kind: 'gkDive'; idx: number; dirY: -1 | 1; height: 0 | 1 } // the keeper leaves his feet
  // the whistle: a late lunge caught the man, and the free kick is already
  // staged. `by` is the body that went in — a foul always has a name on it.
  | { kind: 'foul'; x: number; y: number; by: number }
  | { kind: 'kickoff'; team: 0 | 1; taker: number } // whose ball starts the play
  | { kind: 'goal'; side: 'left' | 'right'; scorer: number } // last touch owns it
  | { kind: 'half' }      // pushed by the match clock at the break
  | { kind: 'fulltime' }; // and at the whistle
