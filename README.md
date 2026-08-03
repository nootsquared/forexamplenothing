<h1 align="center">Golazo Arcade</h1>

<p align="center">Arcade eleven a side football, played in a browser tab.</p>

## Play it

**[golazo-arcade.prmaringantiofficial.workers.dev](https://golazo-arcade.prmaringantiofficial.workers.dev/)**

Nothing to install, no account, no download. Open the link and press Enter.

## What it is

A full eleven a side match on one screen. You hold one player at a time and the other twenty one think for themselves. Each of them runs its own brain off what it can actually see rather than off the ball's true position, so defenders get sold by a shoulder drop and strikers pull runs nobody asked for.

There is one kick button and it does everything. Hold it and the power builds, but even a tap leaves your boot as a real ball. While you hold it the aim sweeps, and that same sweep is what bends the flight. The aim locks onto a spot on the grass instead of onto your body, so it stays where you put it while you keep running.

Fouls and penalties get whistled. Offside does not. Throw ins, corners and goal kicks all come back the way they should, and the keeper picks where to throw or punt it.

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move | WASD or arrows | Left stick |
| Sprint | Shift | RB or RT |
| Kick | Hold Space, release | Hold A, release |
| Bend the ball | J and L while holding | Right stick while holding A |
| Quick pass | | Flick the right stick and let go |
| Tackle | K | B |
| Switch player | E | LB or X |
| Toggle auto switch | T | Y |
| Pause | Esc | Start |
| Change the pitch look | 1, 2, 3 | |

You can sling the ball with the mouse too. Drag back from your player and release, the way you would pull a catapult, and the length of the drag is the power. The keeper works the same way, click where you want the ball and he throws it short or punts it long depending on how far out you pick.

Menus take W and S to move and Enter to choose. Penalties take the arrows to pick a corner and Enter to hit it.

## Modes

| Mode | What happens |
| --- | --- |
| Quick Match | Two star squads, straight to kickoff |
| Draft Mode | A coin flip, then snake picks from a shared pool on a budget. Spend it all and you are taking academy kids |
| Gamble Mode | The same squad builder with no budget. Every slot is a slot machine spin and you take whoever the needle lands on |
| Training Ground | Your eleven on an open pitch with no opponent and no clock. Nobody hunts the ball but you, a called pass is always met, and standing still lets the whole field think with you |

Before kickoff you set the sides to five, seven or eleven a side, the half length anywhere from one to five minutes, and the difficulty to easy, medium or hard.

## Playing with other people

One person per screen. Everyone else opens the same link on their own device and joins with a four letter room code.

Host a party and you get the code. Up to eleven humans a side and twenty two on the pitch, with every seat you leave empty played by the AI. Whoever claims a side first wears the armband, which means they pick the nation, name the team, run that side's draft board and take the set pieces.

The host's tab runs the match and the server only carries messages, so a room holds no state and it closes when the host walks away.

## Running it locally

```sh
pnpm install
pnpm dev
```

That serves the game on http://localhost:5173 with the room relay attached, so online play already works across your network without deploying anything.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 5173 |
| `pnpm test` | Headless simulation and protocol tests |
| `pnpm build` | Typecheck and production build |
| `pnpm gen:assets` | Rebake every texture and sound |
| `pnpm cf:deploy` | Build and ship to Cloudflare |

## How it is put together

The simulation is pure and deterministic, runs at a fixed sixty ticks a second in meters, and carries no rendering code, so the whole match runs headless in tests. The AI sits on top of it as a team blackboard plus one utility brain per player, and those brains emit exactly the same input a human does. Rendering is PixiJS through a high angle projection, over turf made of roughly nineteen thousand grass blades that bend under a sprint and spring back behind it. Every texture and sound is baked ahead of time by the generators in `tools/`, so nothing is drawn or synthesised at runtime.
