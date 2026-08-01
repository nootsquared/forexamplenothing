import { Application, TextureSource } from 'pixi.js';
import { GameLoop } from './core/loop';
import { vec, dist } from './core/math';
import { PlayerInput } from './sim/player';
import { createMatch, advanceMatch } from './match';
import { Keyboard } from './input/keyboard';
import { LocalControls } from './input/controls';
import { loadAssets } from './render/assets';
import { setProjection } from './render/projection';
import { Scene } from './render/scene';
import { MOODS } from './render/variants';

async function boot() {
  TextureSource.defaultOptions.scaleMode = 'nearest'; // crisp pixels everywhere

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#0a0e14',
    antialias: false,
    roundPixels: true,
    preserveDrawingBuffer: true, // reliable canvas capture (DevTools, user screenshots)
  });
  document.querySelector('#game')!.appendChild(app.canvas);

  const assets = await loadAssets();
  setProjection(assets.manifest.pxPerMeter, assets.manifest.iso);

  // Every body has a brain, always. The human hand simply overrides one of
  // them — release it and the brain resumes mid-stride, no lobotomy.
  const match = createMatch();
  const world = match.world;

  let controlledIdx = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'FW');
  let followPass = false; // after a human kick, control chases the receiving teammate
  // Nobody on the sticks? The brain takes the body back — no statues on the
  // pitch. The first real input reclaims it instantly.
  let humanIdle = Infinity;

  const kb = new Keyboard();
  const controls = new LocalControls();
  let input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };

  const nearestToBall = (team: 0 | 1, except: number) => {
    let best = -1;
    let bestD = Infinity;
    world.players.forEach((p, i) => {
      if (p.id.team !== team || i === except) return;
      const d = dist(p.pos, world.ball.pos);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  kb.onPress('KeyE', () => {
    const next = nearestToBall(0, controlledIdx);
    if (next >= 0) controlledIdx = next;
    followPass = false;
  });

  const loop = new GameLoop(
    1 / 60,
    (dt) => {
      input = controls.sample(dt, kb);
      const active = input.move.x !== 0 || input.move.y !== 0 ||
        input.sprint || input.kickCharging || !!input.kickReleased || !!input.tackle;
      humanIdle = active ? 0 : humanIdle + dt;
      advanceMatch(match, dt, humanIdle < 2.5 ? { [controlledIdx]: input } : {});

      for (const e of world.events) {
        if (e.kind === 'kick' && e.idx === controlledIdx) followPass = true;
        if (e.kind === 'restart' && e.team === 0 && e.taker >= 0) { controlledIdx = e.taker; followPass = false; }
      }
      // The pass finds your feet, control finds the receiver: hand over the
      // moment a teammate plays it (or is about to), drop it if stolen
      if (followPass) {
        const lt = world.lastTouch;
        if (lt && lt.team === 1) followPass = false;
        else if (lt && lt.team === 0 && lt.idx !== controlledIdx) {
          controlledIdx = lt.idx;
          followPass = false;
        } else {
          const receiver = nearestToBall(0, controlledIdx);
          if (receiver >= 0 && dist(world.players[receiver].pos, world.ball.pos) < 1.2) {
            controlledIdx = receiver;
            followPass = false;
          }
        }
      }
      scene.setControlled(controlledIdx);
      scene.handleEvents(world.events);
    },
    (alpha, renderDt) => scene.render(alpha, renderDt, { charge: controls.charge, offset: controls.aimOffset, move: input.move }),
  );

  const scene = new Scene(app, assets, world, loop);
  world.players.forEach((p) => scene.addPlayer(p.id.team === 0 ? 'home' : 'away'));
  scene.setControlled(controlledIdx);
  scene.setVariant(MOODS[0]);

  MOODS.forEach((mood, i) => kb.onPress(`Digit${i + 1}`, () => scene.setVariant(mood)));

  loop.start();

  if (import.meta.env.DEV) {
    (window as unknown as { __game: object }).__game = {
      world, scene, match,
      get hero() { return world.players[controlledIdx]; },
      get controlledIdx() { return controlledIdx; },
    };
  }
}

boot();
