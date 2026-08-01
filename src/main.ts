import { Application, TextureSource } from 'pixi.js';
import { GameLoop } from './core/loop';
import { Vec2, vec, dist, clamp } from './core/math';
import { PlayerInput } from './sim/player';
import { World } from './sim/world';
import { createMatch, advanceMatch } from './match';
import { leadTarget, passMargin } from './ai/brain';
import { Keyboard } from './input/keyboard';
import { LocalControls } from './input/controls';
import { TeamCursor } from './input/cursor';
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

  // The seat: your body is YOURS, always — no input means he stands with the
  // ball, because this team does not play itself. The cursor follows
  // possession (a pass, a pickup, an interception is instantly you); off the
  // ball E takes the previewed man, or T turns on auto-switch.
  const cursor = new TeamCursor(0, world);
  const gkIdx = world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'GK');
  let humanIdle = Infinity; // only the keeper failsafe cares — an absent human shouldn't stall a dead ball
  let passHints: number[] = [];
  let hintClock = 0;
  let keeperAiming = false;
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, clicked: false, moved: false };
  // Slingshot passing: press, DRAG BACK to charge — the arrow points the shot
  // the other way and thickens with power — release to let it fly
  const drag = { active: false, anchorX: 0, anchorY: 0 };
  const DRAG_FULL_PX = 260; // hand travel for a full-power strike
  let mouseKick: { power: number; aimAt: Vec2 } | null = null;

  // The pull, resolved on the FIELD: direction is anchor-minus-mouse in world
  // space (so the iso squash never skews your aim), power is hand travel
  const resolveDrag = () => {
    const a = scene.screenToWorld(drag.anchorX, drag.anchorY);
    const m = scene.screenToWorld(mouse.x, mouse.y);
    const pull = vec(a.x - m.x, a.y - m.y);
    const px = Math.hypot(mouse.x - drag.anchorX, mouse.y - drag.anchorY);
    if (px < 14 || (Math.abs(pull.x) < 1e-4 && Math.abs(pull.y) < 1e-4)) return null;
    const len = Math.hypot(pull.x, pull.y);
    return {
      dir: vec(pull.x / len, pull.y / len),
      power: clamp(px / DRAG_FULL_PX, 0.14, 1),
    };
  };

  const kb = new Keyboard();
  const controls = new LocalControls();
  let input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };

  kb.onPress('KeyE', () => cursor.manualSwitch());
  kb.onPress('KeyT', () => {
    cursor.autoMode = !cursor.autoMode;
    scene.toast(cursor.autoMode ? 'AUTO SWITCH ON' : 'AUTO SWITCH OFF');
  });
  app.canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true; });
  // The ball counts as YOURS while it's in playing reach and not theirs —
  // dribble touches pop it a stride ahead, and that must not drop the sling
  const ballIsMine = () => {
    const poss = match.teamBrains[0].possessorIdx;
    if (poss !== null && world.players[poss].id.team !== 0) return false;
    return dist(world.players[cursor.idx].pos, world.ball.pos) < 3.5;
  };

  app.canvas.addEventListener('mousedown', (e) => {
    mouse.clicked = true;
    // The sling only arms with the ball at YOUR feet — no phantom arrows
    if (!keeperAiming && ballIsMine()) {
      drag.active = true;
      drag.anchorX = e.clientX;
      drag.anchorY = e.clientY;
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drag.active) return;
    drag.active = false;
    const pull = resolveDrag();
    if (!pull) return; // a stray click is not a kick
    const hero = world.players[cursor.idx];
    mouseKick = { power: pull.power, aimAt: vec(hero.pos.x + pull.dir.x * 30, hero.pos.y + pull.dir.y * 30) };
  });

  // The keeper launches, and control moves to the man his ball was for
  const launchKeeper = (target: Vec2, kind: 'throw' | 'punt', scatter: number) => {
    world.gkLaunch(gkIdx, target, kind, scatter);
    let best = -1;
    let bestD = Infinity;
    world.players.forEach((p, i) => {
      if (p.id.team !== 0 || p.id.role === 'GK') return;
      const d = dist(p.pos, target);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) cursor.assign(best);
    keeperAiming = false;
    scene.setKeeperAim(null);
  };

  const loop = new GameLoop(
    1 / 60,
    (dt) => {
      input = controls.sample(dt, kb, world.players[cursor.idx].facing);
      // A released mouse drag IS a kick — both hands work the same body
      if (mouseKick) {
        input.kickReleased = { power: mouseKick.power, aimOffset: 0, aimAt: mouseKick.aimAt };
        mouseKick = null;
      }
      const active = input.move.x !== 0 || input.move.y !== 0 ||
        input.sprint || input.kickCharging || !!input.kickReleased || !!input.tackle || mouse.moved;
      mouse.moved = false;
      humanIdle = active ? 0 : humanIdle + dt;

      // Auto-tackle: with hands on and THEIR carrier's ball in winning range,
      // the lunge throws itself — you defend by arriving, not by hotkey
      const poss = match.teamBrains[0].possessorIdx;
      if (humanIdle < 2.5 && poss !== null && world.players[poss].id.team === 1 &&
          world.players[cursor.idx].tackleCooldown <= 0 &&
          dist(world.players[cursor.idx].pos, world.ball.pos) < 1.3) {
        input.tackle = true;
      }

      // YOUR body is always yours — an empty input means he holds, not plays on
      const overrides: Record<number, PlayerInput> = { [cursor.idx]: input };
      if (keeperAiming) overrides[gkIdx] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      advanceMatch(match, dt, overrides);
      cursor.update(world, match.teamBrains[0], dt);

      // A catch or goal kick for OUR keeper opens the distribution sight —
      // if someone's actually playing
      for (const e of world.events) {
        const caught = e.kind === 'save' && world.lastTouch?.team === 0 && world.lastTouch.idx === gkIdx;
        const goalKick = e.kind === 'restart' && e.team === 0 && e.taker === gkIdx;
        if ((caught || goalKick) && humanIdle < 2.5) {
          keeperAiming = true;
          world.holdLock = true;
        }
      }
      if (keeperAiming) {
        const gk = world.players[gkIdx];
        if (humanIdle >= 6 || world.restartLock <= 0) {
          // Stalled out or walked away: he hoofs it upfield himself
          launchKeeper(vec(clamp(gk.pos.x + 38, 8, 97), world.ball.pos.y < 34 ? 22 : 46), 'punt', 5);
        } else {
          const throwR = 24 + 14 * gk.stats.power;
          const puntR = clamp(60 + 34 * gk.stats.power, 60, 88);
          const m = scene.screenToWorld(mouse.x, mouse.y);
          const toM = vec(m.x - gk.pos.x, m.y - gk.pos.y);
          const dRaw = Math.hypot(toM.x, toM.y);
          const d = Math.min(dRaw, puntR);
          const target = dRaw > 1e-4
            ? vec(gk.pos.x + (toM.x / dRaw) * d, gk.pos.y + (toM.y / dRaw) * d)
            : vec(gk.pos.x + 10, gk.pos.y);
          const kind: 'throw' | 'punt' = d <= throwR ? 'throw' : 'punt';
          const scatter = kind === 'throw'
            ? (0.8 + d * 0.045) * (1.35 - gk.stats.control * 0.7)
            : (2.2 + d * 0.075) * (1.45 - gk.stats.control * 0.7);
          const pCenter = Math.pow(0.5, 1 / (0.5 + 0.6 * gk.stats.control));
          scene.setKeeperAim({ gk: gk.pos, target, throwR, puntR, scatter, kind, pCenter });
          if (mouse.clicked) launchKeeper(target, kind, scatter);
        }
      }
      mouse.clicked = false;

      // While you wind up a kick, the open men light up — the same
      // interception model the brains trust, working for your eyes
      hintClock += dt;
      if (input.kickCharging && match.teamBrains[0].possessorIdx === cursor.idx) {
        if (hintClock > 0.1) {
          hintClock = 0;
          passHints = openTeammates(world, cursor.idx);
        }
      } else passHints = [];
      scene.setPassHints(passHints);

      // The drag sight: an arrow off your boot, growing longer and thicker
      // as you pull back — the meter IS the arrow. Lose the ball, lose the sling.
      if (drag.active && !ballIsMine()) drag.active = false;
      if (drag.active) {
        const pull = resolveDrag();
        scene.setKickDrag(pull ? { from: world.players[cursor.idx].pos, dir: pull.dir, power: pull.power } : null);
      } else {
        scene.setKickDrag(null);
      }

      scene.setControlled(cursor.idx);
      scene.setSwitchTarget(cursor.suggested);
      scene.setBallGlow(ballIsMine());
      scene.handleEvents(world.events);
    },
    (alpha, renderDt) => scene.render(alpha, renderDt, { charge: controls.charge, move: input.move, dir: controls.aimDir }),
  );

  const scene = new Scene(app, assets, world, loop);
  world.players.forEach((p) => scene.addPlayer(p.id.team === 0 ? 'home' : 'away'));
  scene.setControlled(cursor.idx);
  scene.setVariant(MOODS[0]);

  MOODS.forEach((mood, i) => kb.onPress(`Digit${i + 1}`, () => scene.setVariant(mood)));

  loop.start();

  if (import.meta.env.DEV) {
    (window as unknown as { __game: object }).__game = {
      world, scene, match,
      get hero() { return world.players[cursor.idx]; },
      get controlledIdx() { return cursor.idx; },
      get suggested() { return cursor.suggested; },
      get passHints() { return passHints; },
      get keeperAiming() { return keeperAiming; },
      cursor,
    };
  }
}

// The couch aid: which teammates can this pass actually REACH? True positions,
// the brains' own interception math — a sight for the eyes, not a cheat sheet.
function openTeammates(world: World, meIdx: number): number[] {
  const me = world.players[meIdx];
  const opps = world.players.filter((p) => p.id.team !== me.id.team).map((p) => p.pos);
  const open: { i: number; margin: number }[] = [];
  world.players.forEach((p, i) => {
    if (i === meIdx || p.id.team !== me.id.team || p.id.role === 'GK') return;
    const d = dist(me.pos, p.pos);
    if (d < 4 || d > 40) return;
    const speed = clamp(10 + d * 0.5, 11, 23);
    const margin = passMargin(me.pos, leadTarget(me.pos, p.pos, p.vel, speed), speed, opps);
    if (margin > 0.3) open.push({ i, margin });
  });
  return open.sort((a, b) => b.margin - a.margin).slice(0, 3).map((o) => o.i);
}

boot();
