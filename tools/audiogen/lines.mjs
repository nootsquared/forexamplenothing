// What the ground announcer is allowed to say. Kept deliberately small: a
// short set heard often beats a long one heard once, and the only real enemy
// is repetition — so the calls that fire every match carry the most variants
// and the ceremonial ones carry a single take.
//
// Two rules govern every line. It must be TRUE whoever is playing (no team
// names, no scoreline, no player), and it must land inside about a second,
// because it is speaking over a crowd that is already making its own noise.

export const CALLS = {
  goal: [
    'Goal!',
    'What a finish!',
    'That is buried!',
    "Oh, he's smashed it in!",
    'Get in there!',
  ],
  // the other net. Flat, faintly sick — never a celebration
  conceded: [
    "Oh, that's gone in.",
    "They've found the net.",
  ],
  save: [
    'What a save!',
    'The keeper says no!',
    'Brilliant hands!',
  ],
  // the woodwork is the most valuable thing in the game that is not a goal
  post: [
    'Off the woodwork!',
    'Off the post!',
    'Oh, so close!',
  ],
  miss: [
    'Just wide!',
    'Inches away!',
  ],
  late: [
    'Not long left!',
    'Into the final minute!',
  ],
  half: ["That's half time."],
  full: [
    "That's full time!",
    "It's all over!",
  ],
  // the neutral ones: colour for a lull, so the box is not a goal machine
  colour: [
    'Lovely football.',
    "The pressure's building.",
    'End to end, this.',
  ],
  kickoff: ['And we are under way!'],
};

// flat name → text, the form both the synthesiser and the bake want
export const LINES = Object.fromEntries(
  Object.entries(CALLS).flatMap(([call, texts]) => texts.map((text, i) => [`${call}-${i + 1}`, text])),
);
