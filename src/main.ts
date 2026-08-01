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
import { OnlineScreen } from './ui/online';
import { NetSession, NetStartConfig } from './net/net';
import { Party, packInput, unpackInput } from './net/party';
import { takeSnap, SnapPlayer } from './net/snapshot';
import { loadNationSheets } from './render/assets';
import { SimEvent } from './sim/events';

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
  let throwAim: { taker: number } | null = null; // your throw-in, aimed like a keeper's throw
  // ---- the online party ----
  let net: NetSession | null = null;
  let party: Party | null = null;                    // host-side authority
  let netRole: 'host' | 'guest' | null = null;
  let snapPlayer: SnapPlayer | null = null;          // guest-side truth
  const seatCursors = new Map<number, { cursor: TeamCursor; team: 0 | 1 }>();
  let netTick = 0;
  let pendingNetEvents: SimEvent[] = [];
  let guestSwitch = false;                           // E queued for the next packet
  let guestSeatNames: Record<number, string> = {};
  let lastStartConfig: NetStartConfig | null = null; // late joiners get the stage too
  let myName = localStorage.getItem('golazo-name') ?? '';
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
  const onlineScreen = new OnlineScreen(assets);
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
    if (screenName === 'draft') audio.music('music-draft');
    else audio.music(null); // menus play the stadium, not a tune — user's call
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
  menu.onOnline = () => { onlineScreen.begin(myName ? 'gate' : 'name', myName); show(onlineScreen); };

  // ---- the party line ----------------------------------------------------
  function leaveOnline() {
    net?.close();
    net = null;
    party = null;
    netRole = null;
    snapPlayer = null;
    seatCursors.clear();
    guestSeatNames = {};
    lastStartConfig = null;
    if (screenName === 'match') return toMenu();
    menu.openPage('root');
    show(menu);
  }

  onlineScreen.onNamed = (name) => {
    myName = name;
    localStorage.setItem('golazo-name', name);
    onlineScreen.begin('gate', name);
  };
  onlineScreen.onHost = () => {
    net = new NetSession();
    net.onMessage = (m) => {
      if (m.t === 'hosted' && net) {
        netRole = 'host';
        if (import.meta.env.DEV) (window as unknown as { __room?: string }).__room = net.code;
        party = new Party(net, myName || 'HOST', assets.manifest.nations.map((n) => n.id));
        party.attach();
        party.onChange = () => { if (activeScreen === onlineScreen && party) onlineScreen.setLobby(party.snap(), 0, true); };
        // whoever walks in mid-match gets the stage and spectates
        party.onSeatJoined = (seat) => {
          if (screenName === 'match' && lastStartConfig) net?.to(seat, { t: 'start', config: lastStartConfig });
        };
        onlineScreen.setLobby(party.snap(), 0, true);
      }
    };
    net.onClosed = () => { if (netRole === 'host') leaveOnline(); };
    net.host();
  };
  onlineScreen.onJoin = (code) => {
    net = new NetSession();
    netRole = 'guest';
    net.onMessage = (m) => {
      if (m.t === 'no-room') { onlineScreen.begin('code', myName); return; }
      if (m.t === 'room-closed') return leaveOnline();
      if (m.t === 'lobby' && net) { if (screenName === 'menu') onlineScreen.setLobby(m.state, net.seat, false); return; }
      if (m.t === 'start') { void guestStartMatch(m.config); return; }
      if (m.t === 'snap') { snapPlayer?.push(m.snap); return; }
      if (m.t === 'end') return; // the room closes right behind it
    };
    net.onClosed = () => { if (netRole === 'guest') leaveOnline(); };
    net.join(code, myName || 'PLAYER');
  };
  onlineScreen.onClaim = (team) => { if (netRole === 'host') party?.claim(0, team); else net?.send({ t: 'claim', team }); };
  onlineScreen.onNation = (dir) => { if (netRole === 'host') party?.cycleNation(0, dir); else net?.send({ t: 'nation', dir }); };
  onlineScreen.onRename = (name) => { if (netRole === 'host') party?.renameTeam(0, name); else net?.send({ t: 'teamname', name }); };
  onlineScreen.onReady = () => {
    if (netRole !== 'guest' || !net) return;
    const me = onlineScreen.lobby?.seats.find((s) => s.seat === net!.seat);
    net.send({ t: 'ready', ready: !me?.ready });
  };
  onlineScreen.onStart = () => hostStartOnline();
  onlineScreen.onLeave = () => leaveOnline();
  // typed characters flow into name/code/team-name fields
  window.addEventListener('keydown', (e) => {
    if (activeScreen === onlineScreen && onlineScreen.textKey(e)) e.preventDefault();
  });
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
    if (netRole) {
      // leaving a match ends the party: rooms die with their host
      net?.close();
      net = null;
      party = null;
      netRole = null;
      snapPlayer = null;
      seatCursors.clear();
      guestSeatNames = {};
    }
    ensureAttract();
    menu.openPage('root'); // a finished match walks in through the front door
    show(menu);
    routeMusic();
  }

  // ---- match lifecycle ---------------------------------------------------
  const ballIsMine = () => {
    if (!match || !cursor) return false;
    if (netRole === 'guest') {
      // a guest's world never thinks — proximity to the snapped ball decides
      const myIdx = snapPlayer?.latest?.cursors[net?.seat ?? -1] ?? -1;
      return myIdx >= 0 && dist(match.world.players[myIdx].pos, match.world.ball.pos) < 3.5;
    }
    const poss = match.teamBrains[0].possessorIdx;
    if (poss !== null && match.world.players[poss].id.team !== 0) return false;
    return dist(match.world.players[cursor.idx].pos, match.world.ball.pos) < 3.5;
  };

  // The host presses START: his claimed side becomes SIM TEAM 0 (every local
  // aid — keeper sight, penalty bins, drag pass — keeps working unchanged),
  // nations dress the teams, seated friends become cursors, and the whole
  // stage description ships to every guest.
  function hostStartOnline() {
    if (!party || !net || !party.allReady()) return;
    const lob = party.snap();
    const hostTeam = party.seats.get(0)?.team ?? 0;
    const flip = hostTeam === 1;
    const simTeamOf = (t: 0 | 1): 0 | 1 => (flip ? ((1 - t) as 0 | 1) : t);
    const nations = assets.manifest.nations;
    const n0 = nations.find((n) => n.id === lob.nations[flip ? 1 : 0]) ?? nations[0];
    const n1 = nations.find((n) => n.id === lob.nations[flip ? 0 : 1]) ?? nations[1];
    // two shirts from the same paint pot: the second team changes into away
    const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const [r0, g0, b0] = rgb(n0.color);
    const [r1, g1, b1] = rgb(n1.color);
    const clash = Math.hypot(r0 - r1, g0 - g1, b0 - b1) < 95;
    const kitKey = (file: string) => file.replace('players-', '').replace('.png', '');
    const kits: [string, string] = [kitKey(n0.sheets.h), kitKey(clash ? n1.sheets.a : n1.sheets.h)];
    const shapes = formationsOfSize(11);
    const homeShape = shapes[Math.min(1, shapes.length - 1)];
    const awayShape = shapes[0];
    const [homeStars, awayStars] = quickSplit(11);
    const homeSquad = toSquad(homeStars, FORMATIONS[homeShape]);
    const awaySquad = toSquad(awayStars, FORMATIONS[awayShape]);
    const toss: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    const seatTeams: Record<number, 0 | 1> = {};
    const seatNames: Record<number, string> = {};
    for (const s of party.seats.values()) {
      if (s.team !== null) seatTeams[s.seat] = simTeamOf(s.team);
      seatNames[s.seat] = s.name;
    }
    const config: NetStartConfig = {
      halfLength: 120,
      homeShape, awayShape, homeSquad, awaySquad, kits,
      nations: [n0.id, n1.id],
      teamNames: [lob.teamNames[flip ? 1 : 0] || n0.name, lob.teamNames[flip ? 0 : 1] || n1.name],
      seatTeams, seatNames,
      kickoffFirst: toss,
    };
    void (async () => {
      await loadNationSheets(assets, [n0.sheets.h, n0.sheets.a, n1.sheets.h, n1.sheets.a]);
      party!.phase = 'match';
      lastStartConfig = config;
      party!.broadcast({ t: 'start', config });
      startMatch(homeSquad, homeShape, awaySquad, awayShape, { kits, halfLength: config.halfLength, kickoffFirst: toss });
      seatCursors.clear();
      netTick = 0;
      pendingNetEvents = [];
      for (const s of party!.seats.values()) {
        if (s.seat === 0 || s.team === null || !match) continue;
        const st = simTeamOf(s.team);
        const c = new TeamCursor(st, match.world);
        c.isCaptain = party!.captainOf(s.team) === s.seat;
        seatCursors.set(s.seat, { cursor: c, team: st });
      }
      wireSeatClaims();
      // penalties for a side with no LOCAL human take themselves
      const auto = new Set<0 | 1>([1]);
      if (party!.seats.get(0)?.team === null) auto.add(0);
      if (match) match.autoPenaltyTeams = auto;
    })();
  }

  // No two hands on one body, ever — every cursor refuses the others' bodies
  function wireSeatClaims() {
    if (!cursor) return;
    const all: { cursor: TeamCursor }[] = [{ cursor }, ...seatCursors.values()];
    for (const a of all) {
      a.cursor.claimed = (idx) => all.some((b) => b !== a && b.cursor.idx === idx);
    }
  }

  // A guest builds the same stage from the host's description and simply
  // WATCHES it through his own camera — inputs go up, snapshots come down
  async function guestStartMatch(config: NetStartConfig) {
    killAttract();
    scene?.destroy();
    await loadNationSheets(assets, config.kits.map((k) => `players-${k}.png`));
    match = createMatch({
      homeSquad: config.homeSquad, homeShape: config.homeShape,
      awaySquad: config.awaySquad, awayShape: config.awayShape,
      halfLength: config.halfLength, kickoffFirst: config.kickoffFirst,
    });
    scene = new Scene(app, assets, match.world, loop);
    if (import.meta.env.DEV) {
      (window as unknown as { __match?: Match; __net?: object }).__match = match;
      (window as unknown as { __net?: object }).__net = { get myIdx() { return snapPlayer?.latest?.cursors[net?.seat ?? -1] ?? -1; } };
    }
    match.world.players.forEach((p, i) => scene!.addPlayer(p.id.team === 0 ? config.kits[0] : config.kits[1], match!.names[i], p.id.number));
    scene.setVariant(MOODS[menu.moodIdx]);
    scene.toast(`${config.teamNames[0]} V ${config.teamNames[1]}`);
    snapPlayer = new SnapPlayer();
    guestSeatNames = config.seatNames;
    controls = new LocalControls();
    cursor = new TeamCursor(config.seatTeams[net?.seat ?? -1] ?? 0, match.world);
    gkIdx = -1;
    keeperAiming = false;
    penAim = null;
    throwAim = null;
    humanIdle = 0;
    halfCountdown = 0;
    fulltimeDelay = 0;
    passHints = [];
    app.stage.addChild(uiRoot);
    screenName = 'match';
    paused = false;
    show(null);
    matchAudio.begin(MOODS[menu.moodIdx].id);
  }

  // One guest render-tick: send my hands, glide to the freshest truth
  function tickMatchGuest(dt: number) {
    if (!match || !scene || !net || !snapPlayer) return;
    const myIdx = snapPlayer.latest?.cursors[net.seat] ?? -1;
    const facing = myIdx >= 0 ? match.world.players[myIdx].facing : vec(1, 0);
    input = controls.sample(dt, kb, facing);
    if (mouseKick) {
      input.kickReleased = { power: mouseKick.power, aimOffset: 0, aimAt: mouseKick.aimAt };
      mouseKick = null;
    }
    net.send({ t: 'input', input: packInput(input, guestSwitch) });
    guestSwitch = false;
    snapPlayer.apply(match.world, dt);
    const evs = snapPlayer.drainEvents();
    if (evs.length) scene.handleEvents(evs);
    const snap = snapPlayer.latest;
    if (snap) {
      if (myIdx >= 0) scene.setControlled(myIdx);
      const tags: Record<number, string> = {};
      for (const [seatStr, idx] of Object.entries(snap.cursors)) {
        const seat = Number(seatStr);
        if (seat === net.seat || myIdx < 0) continue;
        if (match.world.players[idx]?.id.team === match.world.players[myIdx]?.id.team) {
          tags[idx] = guestSeatNames[seat] ?? `P${seat}`;
        }
      }
      scene.setSeatTags(tags);
      scene.setClock(`${snap.half === 1 ? '1ST' : '2ND'} ${fmtClock(snap.clock)}`);
    }
    // the sling arrow rides the same code the host uses
    if (drag.active && !ballIsMine()) drag.active = false;
    if (drag.active) {
      const pull = resolveDrag();
      scene.setKickDrag(pull && myIdx >= 0 ? { from: match.world.players[myIdx].pos, dir: pull.dir, power: pull.power } : null);
    } else scene.setKickDrag(null);
    matchAudio.tick(match, Math.max(0, myIdx), dt);
    mouse.clicked = false;
  }

  function startMatch(
    homeSquad: SquadPlayer[], homeShape: string, awaySquad: SquadPlayer[], awayShape: string,
    opts?: { kits?: [string, string]; halfLength?: number; kickoffFirst?: 0 | 1 },
  ) {
    killAttract();
    scene?.destroy();
    const toss: 0 | 1 = opts?.kickoffFirst ?? (Math.random() < 0.5 ? 0 : 1);
    match = createMatch({
      homeSquad, homeShape, awaySquad, awayShape,
      halfLength: opts?.halfLength ?? setup.halfLength, kickoffFirst: toss,
      awayProfile: AI_PROFILES[setup.difficulty],
    });
    scene = new Scene(app, assets, match.world, loop);
    if (import.meta.env.DEV) (window as unknown as { __match?: Match }).__match = match; // dev console handle
    const kits = opts?.kits ?? ['home', 'away'];
    match.world.players.forEach((p, i) => scene!.addPlayer(p.id.team === 0 ? kits[0] : kits[1], match!.names[i], p.id.number));
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
    throwAim = null;
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
    if (activeScreen === onlineScreen) return leaveOnline(); // walk out of the party
    if (screenName === 'match' && netRole === 'guest') return leaveOnline(); // a guest can always leave
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
  kb.onPress('KeyE', () => {
    if (screenName !== 'match' || paused) return;
    if (netRole === 'guest') { guestSwitch = true; return; } // rides the next packet
    cursor?.manualSwitch();
  });
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
    // a taker mid-throw stands at the line; the mouse owns the delivery
    if (throwAim) overrides[throwAim.taker] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
    // online: every seated friend drives his own body through his own cursor
    if (netRole === 'host' && party) {
      for (const [seat, sc] of seatCursors) {
        const s = party.seats.get(seat);
        if (!s) { seatCursors.delete(seat); continue; }
        if (s.switchPressed) { sc.cursor.manualSwitch(); s.switchPressed = false; }
        overrides[sc.cursor.idx] = s.lastInput
          ? unpackInput(s.lastInput)
          : { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
        if (s.lastInput && s.lastInput.kp > 0) s.lastInput = { ...s.lastInput, kp: 0 }; // a release fires once
      }
    }
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

    // online: friends' cursors follow the same football rules, then the
    // whole truth ships out ~30 times a second
    if (netRole === 'host' && party) {
      for (const sc of seatCursors.values()) sc.cursor.update(world, match.teamBrains[sc.team], dt);
      pendingNetEvents.push(...world.events);
      netTick++;
      if (netTick % 2 === 0) {
        const cursors: Record<number, number> = { 0: cursor.idx };
        for (const [seat, sc] of seatCursors) cursors[seat] = sc.cursor.idx;
        party.broadcast({ t: 'snap', snap: takeSnap(match, netTick, cursors, pendingNetEvents) });
        pendingNetEvents = [];
      }
      const tags: Record<number, string> = {};
      for (const [seat, sc] of seatCursors) {
        if (sc.team === 0) tags[sc.cursor.idx] = party.seats.get(seat)?.name ?? '';
      }
      scene.setSeatTags(tags);
    }

    // A ball your own team plays back to the keeper is HIS — always. The
    // moment it arrives in his reach he takes it into his hands and the
    // distribution sight opens. Recycling through the goalie is a real tool.
    gkHoldCooldown = Math.max(0, gkHoldCooldown - dt);
    const ourBoxDeep = world.attackSign(0) > 0 ? world.ball.pos.x < 18 : world.ball.pos.x > 96;
    if (!keeperAiming && gkHoldCooldown <= 0 && world.restartLock <= 0 && gkIdx >= 0 &&
        world.lastTouch?.team === 0 && world.ball.z < 1.2 && world.ball.speed() < 9 &&
        dist(world.players[gkIdx].pos, world.ball.pos) < 1.6 &&
        ourBoxDeep && Math.abs(world.ball.pos.y - 37) < 21.5) {
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
      if (e.kind === 'restart' && e.team === 0 && e.taker >= 0 && e.restart !== 'goalkick') {
        cursor.assign(e.taker);
        // your throw-in opens the throw sight — pick the man, not the walk
        if (e.restart === 'throwin' && humanIdle < 2.5) throwAim = { taker: e.taker };
      }
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
        launchKeeper(vec(clamp(gk.pos.x + world.attackSign(0) * 38, 8, 97), world.ball.pos.y < 34 ? 22 : 46), 'punt', 5);
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
    // The throw-in sight: the keeper's throw ring, worn by the taker at the
    // line. Click a spot inside it and the ball is slung there — control
    // follows the throw to whoever it was for.
    if (throwAim) {
      const taker = world.players[throwAim.taker];
      const gone = (world.restartLock <= 0 && world.ball.speed() > 2) ||
        world.lastTouch?.team !== 0 || world.lastTouch.idx !== throwAim.taker;
      if (gone) {
        throwAim = null;
        if (!keeperAiming) scene.setKeeperAim(null);
      } else {
        const throwR = 14 + 10 * taker.stats.power;
        const origin = world.ball.pos;
        if (humanIdle >= 6) {
          // walked away: sling it safe to the nearest shirt
          let best: Vec2 = vec(origin.x, origin.y < 37 ? origin.y + 10 : origin.y - 10);
          let bestD = Infinity;
          world.players.forEach((p, i) => {
            if (p.id.team !== 0 || i === throwAim!.taker) return;
            const d = dist(origin, p.pos);
            if (d < throwR && d < bestD) { bestD = d; best = vec(p.pos.x, p.pos.y); }
          });
          world.gkLaunch(throwAim.taker, best, 'throw', 2);
          throwAim = null;
          if (!keeperAiming) scene.setKeeperAim(null);
        } else {
          const m = scene.screenToWorld(mouse.x, mouse.y);
          const toM = vec(m.x - origin.x, m.y - origin.y);
          const dRaw = Math.hypot(toM.x, toM.y);
          const d = Math.min(dRaw, throwR);
          const target = dRaw > 1e-4
            ? vec(origin.x + (toM.x / dRaw) * d, origin.y + (toM.y / dRaw) * d)
            : vec(origin.x + world.attackSign(0) * 6, origin.y);
          const scatter = (0.8 + d * 0.05) * (1.35 - taker.stats.control * 0.7);
          const pCenter = Math.pow(0.5, 1 / (0.5 + 0.6 * taker.stats.control));
          scene.setKeeperAim({ gk: origin, target, throwR, puntR: throwR, scatter, kind: 'throw', pCenter });
          if (mouse.clicked) {
            world.gkLaunch(throwAim.taker, target, 'throw', scatter);
            let best = -1;
            let bestD = Infinity;
            world.players.forEach((p, i) => {
              if (p.id.team !== 0 || i === throwAim!.taker) return;
              const dd = dist(p.pos, target);
              if (dd < bestD) { bestD = dd; best = i; }
            });
            if (best >= 0) cursor.assign(best);
            throwAim = null;
            scene.setKeeperAim(null);
          }
        }
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
      }
    }
  }

  const loop = new GameLoop(
    1 / 60,
    (dt) => {
      if (screenName === 'match' && match && !paused) {
        if (netRole === 'guest') tickMatchGuest(dt);
        else if (!match.finished || fulltimeDelay > 0) tickMatch(dt);
      }
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
