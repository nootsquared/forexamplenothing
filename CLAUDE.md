# Golazo Arcade — project facts

Arcade 11v11 couch-multiplayer soccer game. Premium pixel art, angled broadcast
camera (never flat top-down). Per-player AI is the flagship system.

## Commands

- `pnpm dev` — dev server (Vite, http://localhost:5173)
- `pnpm gen:assets` — regenerate all baked textures/sprites into `public/assets/`
  (run after touching anything in `tools/texgen/`)
- `pnpm test` — vitest (headless sim tests)
- `pnpm build` — typecheck + production build

## Architecture

- `tools/texgen/` — offline asset generator (plain .mjs + @napi-rs/canvas).
  All textures are baked PNGs; nothing is drawn procedurally at runtime.
- `src/core/` — fixed 60Hz timestep loop, math, seeded RNG.
- `src/sim/` — pure deterministic simulation (meters, top-down coords, ball has
  height z). No rendering imports, runs headless.
- `src/ai/` — team blackboard + per-player brains (from M2).
- `src/input/` — keyboard + Gamepad API, device→player mapping.
- `src/render/` — PixiJS 8: broadcast oblique projection (y-squash + z lift),
  ball-follow camera, depth-sorted sprites, arcade FX (dust, hitstop, trails).
- `src/ui/` — HUD, menus.
- `src/data/` — players/formations/pitch surfaces.

## Conventions

- Simulation units are meters/seconds; pixels exist only in `render/`.
- Visual variants (palette/lighting) live in texgen palettes + `render/variants.ts`;
  switch in-game with keys 1/2/3.
