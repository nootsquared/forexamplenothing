# Golazo Arcade

Arcade 11v11 pixel soccer. Couch multiplayer, per-player AI brains, online
rooms with four-letter codes.

## Run it

```sh
pnpm install
pnpm dev          # http://localhost:5173 — the relay rides the dev server
pnpm test         # headless sim + protocol tests
```

Online play on a LAN: the host runs `pnpm dev`, friends open
`http://<host-ip>:5173/`, everyone meets at the room code.

## Going global (Cloudflare)

The whole game — static files and the `/mp` room relay — ships as one
Cloudflare Worker with a Durable Object per room (`server/worker.mjs`,
`wrangler.jsonc`). The free plan covers it.

One-time setup:

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. `pnpm exec wrangler login` — opens the browser, click Allow.

Deploy (first time and every update):

```sh
pnpm cf:deploy
```

Wrangler prints the public URL, e.g. `https://golazo-arcade.<you>.workers.dev`.
Send that link to anyone on the planet: one of you hosts, the other joins with
the room code. The host's browser tab runs the match; the Durable Object only
relays, so it holds no game state and rooms die with their host.

`pnpm cf:dev` runs the same Worker locally on :8788; point the protocol tests
at it with `RELAY_WS=ws://127.0.0.1:8788 pnpm test`.

Non-interactive deploys (CI): set `CLOUDFLARE_API_TOKEN` (dash → My Profile →
API Tokens → "Edit Cloudflare Workers" template) instead of `wrangler login`.
