# Total22 — The Overhaul (two phases)

Execution spec for the next session. Written 2026-08-12 after four rounds of live couch playtesting.
Everything here is a **decision already made with the user** — do not re-litigate, do not re-brainstorm.
Read the repo `CLAUDE.md` first for architecture and commands. Work happens on branch
`controller-local-multiplayer-fix`. Never push, never open a PR; commit locally per milestone
**only after the user's explicit yes**.

## Ground rules (hard-won — violating these burned entire sessions)

1. **Feel first.** This user judges every change by what their hands do and eyes see in the first
   minute of play. Sim-layer changes with stable aggregate stats read as "nothing changed."
   Every milestone must alter the moment-to-moment experience.
2. **Verify the served port from Vite's own output.** Other checkouts squat 5173/5174; last time the
   user playtested a stale build for hours because the agent said 5173 while the server sat on 5175.
3. **No text/banners mid-screen during play.** The user removed them once already ("get rid of the
   fucking things in the middle of the screen"). Communicate on the turf (chalk) or not at all.
4. **No mouse in play.** Kicking and switching are keyboard/pad only. Clicks remain only for
   dead-ball sights (keeper throw, corner ring).
5. **Skill = decisions and timing, never input combos or memorization.** One button = one move.
6. **AI/human symmetry is sacred.** AI acts only through `PlayerInput` (see `src/ai/brain.ts` header).
   Every new verb you give humans, brains must be able to use, and vice versa.
7. `pnpm test` green at every milestone. `pnpm build` clean. The measurement harness
   `tests/diag.test.ts` is skipped by default — unskip locally to compare before/after when touching
   gameplay balance, re-skip before finishing.
8. Proposal style when talking to the user: tiny numbered problem/fix chunks, no walls of text.
   Playtest checkpoints should ask 2–3 specific verdict questions, not "how does it feel?"

## Current state (already in the tree from the last session — do not redo, do not regress)

- **Kick = face + charge + release.** Space (kb) / A (pad) charges ~0.85s from nothing to full;
  release fires; holding pinned past ~0.35s **fizzles** (fires nothing). `src/input/controls.ts`.
  The user's verdict: "a lot harder, a lot more interactive" — this is the keeper.
- Charge sight = the sling chalk (dot-arrow grows with charge, faint wedge, arrowhead), drawn via
  `scene.setKickDrags` from `main.ts` tickMatch. No sprite mini-arrow, no head charge bar (AI wind-up
  tell stays). Aim **glides** toward key direction at 6 rad/s (`AIM_SWEEP`) — never 8-way snap.
- Mouse kick + click-to-switch removed. Keyboard: Space kick, K defend (hold=clamp/tap=lunge),
  Shift sprint, E switch, V lens, J/L bend. Pad: A kick, B defend, X switch, Y auto-switch,
  RT sprint (LT alias), bumpers deliberately empty. Controls card updated (`ui/controlsPanel.ts`).
- Camera lens density on `FollowCamera.density`, V cycles BROADCAST/CLOSE/INTENSE, **default CLOSE**.
- Sprint-with-ball tax (~85–89%, control-scaled) in `player.ts` (`carrying` flag set by world).
- Keeper claims backpasses (possession-phase gate removed in `ai/keeper.ts`).
- AI layer has through balls (turn-tax interception model in `ai/intercept.ts`, imagined-run pass in
  `brain.ts`), BREAK/SCRAMBLE/HUNT drama state on the blackboard, linebreak weave. Cursor: calm
  jaws-handoff (close>0.3 + 2s cooldown), switch inheritance (`assist` in `PlayerInput`, blend in
  `match.ts`), opportunity election (tackle windows, real flight pricing).
- The stance/wall/quality-clamp defense experiments were **rewound by user order**. Defense today =
  baseline chase + hold-K clamp bar + tap-K lunge diamond. Phase 1 below replaces it properly.

---

# PHASE 1 — The Duel: skill moves, controller v2, clamp removal, camera

Build in the milestone order given; each milestone is independently playable and committable.

## 1.1 Controller v2 + keyboard equivalents

**Pad (user's ergonomics, final):**

| Input | Verb |
|---|---|
| Left stick | Move |
| **RT (analog)** | Kick: **trigger depth = power**, release fires. Pinning it deep past the grace = fizzle. |
| **LT** | Sprint (moves off RT; bumpers stay **empty** — user: "hand sits wrong on them") |
| **A** | Switch man |
| **B / X / Y** | The skill kit, context-swapped by possession (see 1.3) |
| Y-auto-switch toggle | Move to **dpad-up** (Y is now a move). Celebrate: during goal ceremony any face button celebrates (no moves exist mid-ceremony). |
| Right stick | Flick pass stays for now (re-evaluate with user after 1.3 ships) |
| Start / Select / dpad | Pause / controls card / menus — unchanged |

**Keyboard equivalents (user explicitly required easy, planned-out keys):**

| Input | Verb |
|---|---|
| WASD | Move |
| Shift | Sprint |
| **Space** | Kick — hold to charge, release to fire, overcook fizzles (keyboard can't do trigger depth; hold-time stays) |
| **E** | Switch man |
| **J / K / L** | The skill kit (maps 1:1 to B/X/Y), context-swapped. Three fingers resting on the row — no reaching. |
| U / O | Bend (J/L's old job relocates; with aim-glide, bend is a purist tool now) |
| V | Lens · T auto-switch · 1/2/3 pitch mood · C controls card · Esc pause |

Update `ui/controlsPanel.ts`, pad hints, `SECOND_HANDS`/`SECOND_JOIN` in `input/seats.ts`
(second keyboard seat needs its own three move keys — right-hand cluster, e.g. `;`/`,`/`.`),
and sweep `ui/tutorial.ts` for stale control text. RT-as-kick needs analog trigger value plumbed
through `input/gamepad.ts` (`PadState` gains kick depth 0–1; `held()` boolean is not enough).

## 1.2 The clamp dies (user has ordered this three times — final)

- Remove the jaws mechanic from open play entirely: `updateClamp`, auto-press `pressing()`,
  the chalk jaws render in `scene.ts`, the cursor's jaws-handoff. Possession changes ONLY via
  events: a tackle landed, a barge won, a pass cut, a heavy touch claimed. "You get the ball
  or you don't."
- The carrier feint-escape tied to clamp closure dies with it (the feint returns as an attack
  skill move in 1.3).
- Tests: `tests/possession.test.ts` clamp suite and parts of `rules.test.ts` (shield crawl) assert
  the old mechanic — rewrite them to pin the new contract, don't delete coverage.
- Keep: the lunge (tap), shield/shoulder physics, `tackleWindow` diamond, loose-ball claim rules.

## 1.3 The skill-move system (the heart of Phase 1)

**Success model (decided):** moves ALWAYS fire instantly — no timing bars, no RNG pass/fail.
The ball is displaced deterministically ("the ball is moved; the player runs and goes to get it").
Whether it *beats* the defender emerges from geometry + the opponent's state. **Stats scale the
move's quality** (speed, reach, tightness, recovery) plus continuous low-stat scatter (like the kick
cone — never a coin flip). This is how players FEEL different: you watch a gold winger's rainbow
land on his laces and a centre-back's sail long, every single use.

**The kit (fixed loadout v1; per-player customization is Phase-1-later):**

| Button (pad / kb) | Defending | Attacking |
|---|---|---|
| B / K | **Standing tackle** — the current lunge, quick, modest risk | **Feint** — body sways one way (stick names it), burst opposite; defenders bite on what they can read |
| X / J | **Slide tackle** — committed slide *faster than sprint* along the stick; any ball touched is won and the dribbler goes down; **from behind = foul + free kick** (extend the existing lateLunge/foul machinery with a behind-arc check); miss = grass for ~1s | **Croqueta** — fast lateral ball-shift through the reach gap; control stat = shift speed/tightness |
| Y / L | **Shoulder barge** — shoulder-to-shoulder shove, phys-stat contest; the answer to shielders (`bargeCooldown` field already exists unused) | **Rainbow** — ball flipped over the defender (ball z physics already exists), run around; agility/control scale arc quality; longest cooldown, biggest payoff |

- Per-move cooldowns so it's a decision, not spam. Short global move lockout after a failed one.
- `PlayerInput` gains `skill?: { kind: SkillKind; dir: Vec2 }`. Brains get the same verbs:
  AI defenders slide when geometry says slide; AI wingers rainbow humans at parties. The take-on
  size-up tell in `brain.ts` (sizeT/driveT) becomes the moment AI *chooses* its attack move.
- Animations v1 without new art: the lunge sheet IS a slide tackle (`anims.lunge`), feint sells via
  cut/shuffle frames + ball motion, rainbow needs no body frames (the ball's flight is the show),
  barge via the shrug/recover frames. Bespoke frames = a texgen round in Phase 2+.
- FX: reuse dust/hitstop/trails on move commits; won slides get the crunch treatment.
- Defending against moves is positioning + patience + picking the tackle moment: with the clamp
  gone, containment (body between man and goal) plus the three defensive moves IS defending.

## 1.4 Camera: vision as a resource (decided design)

1. **Couch leash floor:** the tight lens is a ceiling, never a promise — extend the hero leash so
   EVERY human-worn body (`world.humanIdxs`) stays in frame; the lens breathes out only as far as
   the most spread human. Nobody at the party plays blind.
2. **Winding up is looking up:** while a kick charges, ease the zoom out a touch (head up over the
   ball). Tap passes stay tight; the 40-yard diagonal costs a visible, tackle-able beat. Marries the
   fizzle to vision.
3. **Facing forward shows forward:** bias frame center a few meters toward the controlled player's
   facing — head-up posture literally buys sight.
4. Add one density notch between CLOSE (1.16) and INTENSE (1.34) to the V cycle (~1.24) as the
   passing-nerf candidate; the user picks with their thumbs. Default stays CLOSE until they vote.

## 1.5 Phase 1 verification

- Suite green; rewrite outdated control/possession tests to pin new contracts (precedent: the
  Space-kick tests in `tests/controls.test.ts`).
- Unskip `tests/diag.test.ts` once after 1.3: confirm turnover mix still has deliberate-defense
  share ≥ ~25% (steals now = tackles/slides/barges) and no offside/foul explosion. Re-skip.
- Playtest checkpoint questions for the user: (1) does a slide tackle landing feel like YOUR play?
  (2) does eating a rainbow at the party make people scream? (3) RT-depth kick vs Space — same skill?

---

# PHASE 2 — Hyper-premium: sound, lighting, depth, net

Only start after Phase 1 is approved in play. Each item independently shippable, in this order.

## 2.1 Sound (first — highest premium-per-effort, zero sim risk)

**Root cause, verified:** every sound including the crowd is *synthesized* in `tools/audiogen/`
(the crowd is literally shaped noise — hence "sounds like washing"). Fix = real licensed recordings
fed through the existing bake pipeline.

- **Ingest:** add `tools/audiogen/samples/` + a license manifest (file → source URL, license,
  author). Only game-legal licenses: CC0 / royalty-free-no-attribution preferred. Sources:
  - Sonniss GDC bundles (tens of thousands of pro effects, royalty-free, no attribution)
  - Kenney.nl CC0 packs (impacts, UI)
  - Pixabay sound effects (no-attribution license; has soccer + football-crowd recordings)
  - freesound.org filtered to CC0 only (check each file's license)
  - itch.io CC0 collections; indiesfx S024C sports pack (crowds, applause, whistles)
  - AVOID: BBC archive (research-only license), Zapsplat free tier (attribution + account terms — read before shipping)
- **The "matte" chain (the ChatGPT-trailer quality the user wants is processing, not sourcing):**
  one shared mastering pass in the bake for EVERY sample — low-pass ~2–3kHz shelf, pitch down
  2–4 semitones where weighty, soften the first ~5ms transient, gentle saturation, tight short
  room reverb, uniform loudness. One chain = one cohesive, non-fatiguing palette.
- **Slate:** grass footsteps by pace, every touch/trap/knock graded by ball speed, kicks graded by
  power, the slide (grass-tear + body thud), net swish, post ping (event exists), ball whistle on
  driven balls, keeper gloves.
- **The crowd becomes an instrument:** recorded murmur bed + swell layers + chant stingers + goal
  roar, driven by existing blackboard drama state (`breakT`, `huntT`, shots, goals) through
  `audio/matchAudio.ts`. The announcer already carves crowd frequency space (`audiogen/announcer.mjs`
  comments) — keep that contract. Delete the synthesized crowd once the recorded one lands.

## 2.2 Lighting: bake the ray tracing offline, keep runtime consistent

The premium look in THIS engine comes from the offline raytracer that already renders the sprites
from real 3D rigs — extend it, don't bolt a runtime ray tracer onto Pixi.

- **Texgen time-of-day worlds:** DAY / SUNSET / NIGHT variants — field albedo, sprite lighting, and
  TRUE long shadows rendered by the raytracer. One `sunAngle`/`timeOfDay` constant published through
  the manifest (same pattern as the iso squash — sim/render/texgen must agree). Random per match;
  integrate with the existing variants/moods system (`render/variants.ts`, keys 1/2/3).
- **Normal-map bake:** same rigs, one more offline pass → sprite + pitch normal maps.
- **Runtime light layer (Pixi v8 custom shaders are first-class):** normal-mapped ground/sprite
  shading, floodlight pools that shade bodies moving through them, dynamic player shadows that
  stretch/rotate by sun angle. References to READ first (both target older Pixi — budget a port):
  pixijs-userland/lights (deferred shading, v7), dobrado76/pixi-lights-and-shadows (2.5D casting),
  TarVK/pixi-shadows. Perf budget: 60fps with 22 bodies + ~19k grass blades on couch hardware —
  profile before/after, keep the light pass optional (a quality toggle).
- **Night:** floodlight towers baked as real 3D-rendered objects with real shadows (never flat
  cutouts), additive cones, glow pools, multi-directional faint ball/player shadows near the spot.
- Sim/render separation stays absolute: none of this touches `src/sim`.

## 2.3 Depth: the world around the pitch

Stands, owner's box, tunnel, ad boards as parallax-offset billboard layers baked with real
perspective at the 52° camera (the user's "Doom-style" instinct — billboarded surroundings, not a
new field projection). Subtle parallax against the pitch as the camera pans kills the flat-card
feeling. The pitch keeps its projection (the sim depends on it) and gains mow-stripe sheen +
normal-mapped light from 2.2.

## 2.4 The net is strings

Verlet cloth (small grid per goal), rendered as a Pixi mesh, impulses from the ball's actual
velocity on goal events; light ambient sway at night. Ripples on a screamer, shivers on a trickler.
A few dozen points — trivial cost, most-watched object in the game at its most-watched moment.

---

## Backlog acknowledged but NOT in these phases (do not silently start them)

Defense "round two" beyond the skill kit · crowd *visuals* v2 · substitutes + turn-based mode
(user said "remind me later") · lock mode (each human locked to one player) · aftertouch curl ·
Siege/Story drama systems (box runs, score/clock urgency) · loadout customization in draft ·
extra-time toggle · pause-nav bug (needs runtime trace).
