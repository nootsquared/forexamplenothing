import { Application, TextureSource } from 'pixi.js';
import { GameLoop } from './core/loop';
import { vec } from './core/math';
import { World } from './sim/world';
import { PlayerBody, PlayerInput } from './sim/player';
import { PITCH } from './sim/constants';
import { Keyboard } from './input/keyboard';
import { LocalControls } from './input/controls';
import { loadAssets } from './render/assets';
import { setProjection } from './render/projection';
import { Scene } from './render/scene';
import { MOODS } from './render/variants';

const HERO_STATS = {
  topSpeed: 6.4,
  sprintSpeed: 8.8,
  accel: 10,
  agility: 0.85,
  control: 0.8,
  power: 0.75,
};

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
  setProjection(assets.manifest.pxPerMeter, assets.manifest.persp);

  const world = new World();
  const hero = new PlayerBody(vec(PITCH.length / 2 - 8, PITCH.width / 2), HERO_STATS);
  world.players.push(hero);

  const kb = new Keyboard();
  const controls = new LocalControls();
  let input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };

  const loop = new GameLoop(
    1 / 60,
    (dt) => {
      input = controls.sample(dt, kb);
      world.step(dt, [input]);
      scene.handleEvents(world.events);
    },
    (alpha, renderDt) => scene.render(alpha, renderDt, controls.charge),
  );

  const scene = new Scene(app, assets, world, loop);
  const playerView = scene.addPlayer('home');
  scene.setVariant(MOODS[0]);

  MOODS.forEach((mood, i) => kb.onPress(`Digit${i + 1}`, () => scene.setVariant(mood)));
  kb.onPress('KeyR', () => {
    world.ball.pos = vec(hero.pos.x + 2, hero.pos.y);
    world.ball.vel = vec();
    world.ball.z = 0;
    world.ball.vz = 0;
  });

  loop.start();

  if (import.meta.env.DEV) {
    (window as unknown as { __game: object }).__game = { world, hero, scene, playerView };
  }
}

boot();
