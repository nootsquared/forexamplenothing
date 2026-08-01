import { Application, Container, TextureSource } from 'pixi.js';
import { GameLoop } from './core/loop';
import { Vec2, vec, dist, clamp } from './core/math';
import { PlayerInput } from './sim/player';
import { World } from './sim/world';
import { Match, createMatch, advanceMatch } from './match';
import { leadTarget, passMargin } from './ai/brain';
import { AI_PROFILES } from './ai/blackboard';
import { FORMATIONS, formationsOfSize } from './data/formations';
import { quickSplit, toSquad } from './data/draft';
import { SquadPlayer } from './data/roster';
import { Keyboard } from './input/keyboard';
import { LocalControls } from './input/controls';
import { TeamCursor } from './input/cursor';
import { audio } from './audio/engine';
import { MatchAudio } from './audio/matchAudio';
import { loadAssets } from './render/assets';
import { setProjection } from './render/projection';
import { Scene } from './render/scene';
import { MOODS } from './render/variants';
import { Screen, MenuScreen, SetupScreen, PauseScreen, StatsScreen, MatchSetup, fmtClock } from './ui/screens';
import { SquadBuilderScreen } from './ui/draft';

// The shell: menu → (draft → shape) → match → full time → menu. One Pixi
// app, one loop; a match owns the pitch while it lives, screens own the top.

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

  const [assets] = await Promise.all([loadAssets(), audio.load()]);
  setProjection(assets.manifest.pxPerMeter, assets.manifest.iso);

  const kb = new Keyboard();
  let controls = new LocalControls();

  // ---- shell state -------------------------------------------------------
  type ScreenName = 'menu' | 'draft' | 'match' | 'fulltime';
  let screenName: ScreenName = 'menu';
  let paused = false;
  let fulltimeDelay = 0; // a beat for the FULL TIME banner before the sheet
  let setup: MatchSetup = { mode: 'quick', size: 11, halfLength: 120, difficulty: 1 };

  // ---- match-scoped state (rebuilt every kickoff) ------------------------
  let match: Match | null = null;
  let scene: Scene | null = null;
  const matchAudio = new MatchAudio();
  // The menu's living backdrop: an endless AI-vs-AI kickabout
  let attract: { match: Match; scene: Scene } | null = null;
  let cursor: TeamCursor | null = null;
  let gkIdx = -1;
  let gkHoldCooldown = 0; // a fresh launch can't be instantly re-scooped
  let halfCountdown = 0; // the 3-2-1 before the second half kicks off
  let humanIdle = Infinity;
  let passHints: number[] = [];
  let hintClock = 0;
  let keeperAiming = false;
  let penAim: { col: number; row: number } | null = null; // the shooter's chosen bin
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, clicked: false, moved: false };
  const drag = { active: false, anchorX: 0, anchorY: 0 };
  const DRAG_FULL_PX = 260;
  let mouseKick: { power: number; aimAt: Vec2 } | null = null;
  let input: PlayerInput = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };

  // ---- screens -----------------------------------------------------------
  const uiRoot = new Container();
  const menu = new MenuScreen(assets);
  const setupScreen = new SetupScreen(assets);
  const draftScreen = new SquadBuilderScreen(assets);
  const pauseScreen = new PauseScreen(assets);
  const statsScreen = new StatsScreen(assets);
  let activeScreen: Screen | null = null;

  const show = (s: Screen | null) => {
    uiRoot.removeChildren();
    activeScreen = s;
    if (s) {
      s.layout(app.renderer.width, app.renderer.height);
      uiRoot.addChild(s.root);
      s.enter?.(); // entrances land on freshly laid-out rests
    }
  };
  window.addEventListener('resize', () => activeScreen?.layout(app.renderer.width, app.renderer.height));

  // The CPU wears the difficulty mostly in its BRAIN (AI_PROFILES); the legs
  // shift only slightly so nobody ever looks drunk
  const DIFF_SCALE = [0.92, 1, 1.06];
  const scaleSquad = (squad: SquadPlayer[], f: number): SquadPlayer[] =>
    f === 1 ? squad : squad.map((p) => ({
      ...p,
      stats: {
        topSpeed: p.stats.topSpeed * f,
        sprintSpeed: p.stats.sprintSpeed * f,
        accel: p.stats.accel * f,
        agility: Math.min(1, p.stats.agility * f),
        control: Math.min(1, p.stats.control * f),
        power: Math.min(1, p.stats.power * f),
      },
    }));

  // The soundtrack follows the room: anthem over the menus, the war-room
  // groove over squad building, and only the stadium during play
  const routeMusic = () => {
    if (screenName === 'match') audio.music(null);
    else if (screenName === 'draft') audio.music('music-draft');
    else audio.music('music-menu');
  };
  audio.setVolumes(menu.musicVol, menu.sfxVol);
  menu.onAudio = (m, s) => audio.setVolumes(m, s);
  const unlock = () => {
    audio.unlock();
    routeMusic();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  menu.onQuick = () => { setupScreen.begin('quick'); show(setupScreen); };
  menu.onDraft = () => { setupScreen.begin('draft'); show(setupScreen); };
  menu.onGamble = () => { setupScreen.begin('gamble'); show(setupScreen); };
  setupScreen.onBack = () => { menu.openPage('play'); show(menu); }; // back means BACK, not the front door
  setupScreen.onStart = (s) => {
    setup = s;
    if (s.mode === 'quick') {
      const shapes = formationsOfSize(s.size);
      const homeShape = shapes[Math.min(1, shapes.length - 1)];
      const awayShape = shapes[0];
      const [homeStars, awayStars] = quickSplit(s.size);
      startMatch(
        toSquad(homeStars, FORMATIONS[homeShape]), homeShape,
        scaleSquad(toSquad(awayStars, FORMATIONS[awayShape]), DIFF_SCALE[s.difficulty]), awayShape,
      );
    } else {
      draftScreen.begin(s.size, s.mode);
      screenName = 'draft';
      show(draftScreen);
      routeMusic();
    }
  };
  draftScreen.onDone = (home, homeShape, away, awayShape) => {
    startMatch(home, homeShape, scaleSquad(away, DIFF_SCALE[setup.difficulty]), awayShape);
  };
  pauseScreen.onResume = () => pauseScreen.close(); // slide out, then release
  pauseScreen.onClosed = () => { paused = false; scene?.setHudVisible(true); show(null); };
  pauseScreen.onQuit = () => toMenu();
  statsScreen.onDone = () => toMenu();
  menu.onMood = (i) => attract?.scene.setVariant(MOODS[i]);
  menu.onFps = (cap) => { loop.fpsCap = cap; };

  function ensureAttract() {
    if (attract) return;
    const [a, b] = quickSplit();
    const m = createMatch({
      homeSquad: toSquad(a, FORMATIONS['4-3-3']), homeShape: '4-3-3',
      awaySquad: toSquad(b, FORMATIONS['4-4-2']), awayShape: '4-4-2',
    });
    const s = new Scene(app, assets, m.world, loop);
    m.world.players.forEach((p, i) => s.addPlayer(p.id.team === 0 ? 'home' : 'away', m.names[i], p.id.number));
    s.setVariant(MOODS[menu.moodIdx]);
    s.setHudVisible(false);
    attract = { match: m, scene: s };
    app.stage.addChild(uiRoot); // menu rides above its own backdrop
  }

  function killAttract() {
    attract?.scene.destroy();
    attract = null;
  }

  function toMenu() {
    scene?.destroy();
    scene = null;
    match = null;
    matchAudio.end();
    screenName = 'menu';
    paused = false;
    ensureAttract();
    menu.openPage('root'); // a finished match walks in through the front door
    show(menu);
    routeMusic();
  }

  // ---- match lifecycle ---------------------------------------------------
  const ballIsMine = () => {
    if (!match || !cursor) return false;
    const poss = match.teamBrains[0].possessorIdx;
    if (poss !== null && match.world.players[poss].id.team !== 0) return false;
    return dist(match.world.players[cursor.idx].pos, match.world.ball.pos) < 3.5;
  };

  function startMatch(homeSquad: SquadPlayer[], homeShape: string, awaySquad: SquadPlayer[], awayShape: string) {
    killAttract();
    scene?.destroy();
    const toss: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    match = createMatch({
      homeSquad, homeShape, awaySquad, awayShape,
      halfLength: setup.halfLength, kickoffFirst: toss,
      awayProfile: AI_PROFILES[setup.difficulty],
    });
    scene = new Scene(app, assets, match.world, loop);
    if (import.meta.env.DEV) (window as unknown as { __match?: Match }).__match = match; // dev console handle
    match.world.players.forEach((p, i) => scene!.addPlayer(p.id.team === 0 ? 'home' : 'away', match!.names[i], p.id.number));
    scene.setVariant(MOODS[menu.moodIdx]);
    scene.toast(toss === 0 ? 'RED WINS THE TOSS' : 'BLUE WINS THE TOSS');
    cursor = new TeamCursor(0, match.world);
    cursor.autoMode = menu.autoSwitch;
    // the opening kickoff event fires before the first frame — hand the taker over now
    if (toss === 0 && match.world.lastTouch) cursor.assign(match.world.lastTouch.idx);
    gkIdx = match.world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'GK');
    scene.setControlled(cursor.idx);
    controls = new LocalControls();
    humanIdle = Infinity;
    keeperAiming = false;
    penAim = null;
    halfCountdown = 0;
    drag.active = false;
    mouseKick = null;
    passHints = [];
    fulltimeDelay = 0;
    app.stage.addChild(uiRoot); // UI rides above the fresh pitch
    screenName = 'match';
    paused = false;
    show(null);
    matchAudio.begin(MOODS[menu.moodIdx].id);
  }

  // ---- input plumbing ----------------------------------------------------
  // The penalty sight eats UI keys first: WASD/arrows walk the bin, Enter
  // pulls the trigger. Any key it doesn't claim falls through to the screens.
  const penaltyKey = (code: string): boolean => {
    if (screenName !== 'match' || paused || !penAim || !match || !scene) return false;
    const pen = match.world.penalty;
    if (pen?.phase !== 'aiming' || pen.team !== 0) return false;
    const move: Record<string, [number, number]> = {
      KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
      KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
    };
    if (move[code]) {
      penAim.col = clamp(penAim.col + move[code][0], 0, 2);
      penAim.row = clamp(penAim.row + move[code][1], 0, 1);
      audio.ui('move');
      return true;
    }
    if (code === 'Enter') {
      match.world.takePenalty((penAim.col - 1) as -1 | 0 | 1, penAim.row === 0);
      penAim = null;
      scene.setPenaltyAim(null);
      return true;
    }
    return false;
  };
  const uiKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyF', 'KeyX'];
  for (const code of uiKeys) kb.onPress(code, () => { if (!penaltyKey(code)) activeScreen?.key(code); });
  kb.onPress('Space', () => activeScreen?.key('Space'));
  kb.onPress('Escape', () => {
    if (screenName === 'menu') return activeScreen?.key('Escape'); // menu pages or match setup
    if (screenName === 'draft') { audio.ui('back'); return toMenu(); } // walk out of the war room
    if (screenName !== 'match' || !match || match.finished) return;
    if (paused) {
      pauseScreen.close(); // slide out; onClosed releases the match
    } else {
      paused = true;
      pauseScreen.begin(match);
      pauseScreen.open();
      scene?.setHudVisible(false); // the pause board carries the numbers itself
      show(pauseScreen);
    }
    audio.ui('card');
  });
  kb.onPress('KeyE', () => { if (screenName === 'match' && !paused) cursor?.manualSwitch(); });
  kb.onPress('KeyT', () => {
    if (screenName !== 'match' || paused || !cursor || !scene) return;
    cursor.autoMode = !cursor.autoMode;
    scene.toast(cursor.autoMode ? 'AUTO SWITCH ON' : 'AUTO SWITCH OFF');
  });
  MOODS.forEach((mood, i) => kb.onPress(`Digit${i + 1}`, () => {
    if (screenName !== 'match') return;
    scene?.setVariant(mood);
    matchAudio.setMood(mood.id);
  }));

  // The pull, resolved on the FIELD: direction is anchor-minus-mouse in world
  // space (so the iso squash never skews your aim), power is hand travel
  const resolveDrag = () => {
    if (!scene) return null;
    const a = scene.screenToWorld(drag.anchorX, drag.anchorY);
    const m = scene.screenToWorld(mouse.x, mouse.y);
    const pull = vec(a.x - m.x, a.y - m.y);
    const px = Math.hypot(mouse.x - drag.anchorX, mouse.y - drag.anchorY);
    if (px < 14 || (Math.abs(pull.x) < 1e-4 && Math.abs(pull.y) < 1e-4)) return null;
    const len = Math.hypot(pull.x, pull.y);
    return {
      dir: vec(pull.x / len, pull.y / len),
      // shifted range: the shortest pull is what MEDIUM used to be
      power: 0.45 + clamp(px / DRAG_FULL_PX, 0, 1) * 0.55,
    };
  };

  app.canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true; });
  app.canvas.addEventListener('mousedown', (e) => {
    mouse.clicked = true;
    if (screenName !== 'match' || paused) return;
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
    if (!pull || !match || !cursor) return; // a stray click is not a kick
    const hero = match.world.players[cursor.idx];
    mouseKick = { power: pull.power, aimAt: vec(hero.pos.x + pull.dir.x * 30, hero.pos.y + pull.dir.y * 30) };
  });

  // The keeper launches, and control moves to the man his ball was for
  const launchKeeper = (target: Vec2, kind: 'throw' | 'punt', scatter: number) => {
    if (!match || !cursor || !scene) return;
    match.world.gkLaunch(gkIdx, target, kind, scatter);
    let best = -1;
    let bestD = Infinity;
    match.world.players.forEach((p, i) => {
      if (p.id.team !== 0 || p.id.role === 'GK') return;
      const d = dist(p.pos, target);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) cursor.assign(best);
    keeperAiming = false;
    gkHoldCooldown = 2;
    scene.setKeeperAim(null);
  };

  // ---- the match tick (unchanged control feel, now clock-aware) ----------
  function tickMatch(dt: number) {
    if (!match || !scene || !cursor) return;
    const world = match.world;

    input = controls.sample(dt, kb, world.players[cursor.idx].facing);
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

    // YOUR body is always yours — an empty input means he holds, not plays on.
    // While you aim a penalty the body waits on the spot; the keys own the sight.
    const penMine = world.penalty?.phase === 'aiming' && world.penalty.team === 0;
    const overrides: Record<number, PlayerInput> = {
      [cursor.idx]: penMine ? { move: vec(), sprint: false, kickCharging: false, kickReleased: null } : input,
    };
    if (keeperAiming) overrides[gkIdx] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
    // A team-0 ball rolling AT your keeper is a backpass in flight: he stands
    // ready for his hands — his brain may not panic-boot it while it arrives
    if (!keeperAiming && gkIdx >= 0 && cursor.idx !== gkIdx && world.restartLock <= 0 &&
        world.lastTouch?.team === 0 && world.ball.speed() > 1.5) {
      const gk = world.players[gkIdx];
      const toGk = vec(gk.pos.x - world.ball.pos.x, gk.pos.y - world.ball.pos.y);
      const dGk = Math.hypot(toGk.x, toGk.y);
      const sp = world.ball.speed();
      const closing = dGk > 1e-4 ? (world.ball.vel.x * toGk.x + world.ball.vel.y * toGk.y) / dGk : 0;
      const missBy = dGk > 1e-4 ? Math.abs(world.ball.vel.x * toGk.y - world.ball.vel.y * toGk.x) / sp : 99;
      if (dGk < 15 && closing > 1.5 && missBy < 2.4) {
        overrides[gkIdx] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      }
    }
    advanceMatch(match, dt, overrides);
    cursor.update(world, match.teamBrains[0], dt);
    matchAudio.tick(match, cursor.idx, dt);

    // A ball your own team plays back to the keeper is HIS — always. The
    // moment it arrives in his reach he takes it into his hands and the
    // distribution sight opens. Recycling through the goalie is a real tool.
    gkHoldCooldown = Math.max(0, gkHoldCooldown - dt);
    if (!keeperAiming && gkHoldCooldown <= 0 && world.restartLock <= 0 && gkIdx >= 0 &&
        world.lastTouch?.team === 0 && world.ball.z < 1.2 && world.ball.speed() < 9 &&
        dist(world.players[gkIdx].pos, world.ball.pos) < 1.6 &&
        world.ball.pos.x < 18 && Math.abs(world.ball.pos.y - 37) < 21.5) {
      world.gkPickup(gkIdx);
      keeperAiming = true;
      world.holdLock = true;
      audio.play('gk-catch', { vol: 0.7 });
    }

    // A catch or goal kick for OUR keeper opens the distribution sight —
    // if someone's actually playing
    for (const e of world.events) {
      const caught = e.kind === 'save' && world.lastTouch?.team === 0 && world.lastTouch.idx === gkIdx;
      const goalKick = e.kind === 'restart' && e.team === 0 && e.taker === gkIdx;
      if ((caught || goalKick) && humanIdle < 2.5) {
        keeperAiming = true;
        world.holdLock = true;
      }
      // YOUR restarts belong to YOU: throw-ins, corners and free kicks hand
      // you the taker and the game waits for your delivery — no gray body
      // ever plays your dead ball for you
      if (e.kind === 'restart' && e.team === 0 && e.taker >= 0 && e.restart !== 'goalkick') cursor.assign(e.taker);
      if (e.kind === 'kickoff' && e.team === 0 && e.taker >= 0) cursor.assign(e.taker);
      // A penalty for US: you become the shooter and the sight opens
      if (e.kind === 'foul' && e.penalty && world.penalty?.team === 0) {
        cursor.assign(world.penalty.shooterIdx);
      }
      if (e.kind === 'fulltime') fulltimeDelay = 1.5;
      if (e.kind === 'half') halfCountdown = 4.3; // HALF TIME banner first, then 3-2-1
      if (e.kind === 'goal' && e.scorer >= 0) scene.toast(`${match.names[e.scorer]}!`);
    }

    // The second half arrives on a count, not a drop: 3… 2… 1… PLAY!
    if (halfCountdown > 0) {
      const before = halfCountdown;
      halfCountdown -= dt;
      for (const mark of [3, 2, 1]) {
        if (before > mark && halfCountdown <= mark) {
          scene.announce(String(mark));
          audio.ui('move');
        }
      }
      if (before > 0 && halfCountdown <= 0) {
        scene.announce('PLAY!');
        audio.play('whistle-kickoff');
      }
    }
    // The penalty sight rides the world's state — it opens for your spot
    // kicks and folds away the instant the ball is struck or the play dies
    if (penMine || (world.penalty?.phase === 'aiming' && world.penalty.team === 0)) {
      if (!penAim) penAim = { col: 2, row: 1 };
      scene.setPenaltyAim(penAim);
    } else if (penAim) {
      penAim = null;
      scene.setPenaltyAim(null);
    }

    if (keeperAiming) {
      const gk = world.players[gkIdx];
      if (humanIdle >= 6 || world.restartLock <= 0) {
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
    // stoppage time wears a plus — the referee is letting the move breathe
    const et = match.halfLength > 0 && match.clock > match.halfLength ? '+' : '';
    scene.setClock(match.halfLength > 0 ? `${match.half === 1 ? '1ST' : '2ND'} ${fmtClock(match.clock)}${et}` : '');
    scene.handleEvents(world.events);

    if (fulltimeDelay > 0 && match.finished) {
      fulltimeDelay -= dt;
      if (fulltimeDelay <= 0) {
        screenName = 'fulltime';
        scene.setHudVisible(false); // the sheet carries every number now
        statsScreen.begin(match);
        show(statsScreen);
        matchAudio.end();
        audio.music('music-menu', 2, 0.65); // the anthem hums under the sheet
      }
    }
  }

  const loop = new GameLoop(
    1 / 60,
    (dt) => {
      if (screenName === 'match' && match && !paused && (!match.finished || fulltimeDelay > 0)) tickMatch(dt);
      if (screenName === 'menu' && attract) advanceMatch(attract.match, dt); // the backdrop plays on
      activeScreen?.update?.(dt);
    },
    (alpha, renderDt) => {
      if (scene) scene.render(alpha, renderDt, { charge: controls.charge, move: input.move, dir: controls.aimDir });
      else if (screenName === 'menu') attract?.scene.render(alpha, renderDt, { charge: 0, move: vec(), dir: null });
    },
  );

  app.stage.addChild(uiRoot);
  toMenu();
  loop.start();

  if (import.meta.env.DEV) {
    (window as unknown as { __game: object }).__game = {
      get match() { return match; },
      get world() { return match?.world; },
      get scene() { return scene; },
      get screen() { return screenName; },
      get hero() { return match && cursor ? match.world.players[cursor.idx] : null; },
      get controlledIdx() { return cursor?.idx ?? -1; },
      get suggested() { return cursor?.suggested ?? -1; },
      get passHints() { return passHints; },
      get keeperAiming() { return keeperAiming; },
      get cursor() { return cursor; },
      menu, draftScreen,
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
