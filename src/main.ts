import { Application, Container, Graphics, TextureSource } from 'pixi.js';
import { GameLoop } from './core/loop';
import { Vec2, vec, dist, clamp, norm, scale, expDecayVec } from './core/math';
import { PlayerInput } from './sim/player';
import { World } from './sim/world';
import { Match, createMatch, advanceMatch, pickDistribution } from './match';
import { leadTarget, passMargin } from './ai/brain';
import { AI_PROFILES } from './ai/blackboard';
import { FORMATIONS, formationsOfSize } from './data/formations';
import { quickSplit, toSquad } from './data/draft';
import { SquadPlayer } from './data/roster';
import { Keyboard } from './input/keyboard';
import { LocalControls } from './input/controls';
import { pads } from './input/gamepad';
import { TeamCursor } from './input/cursor';
import { audio } from './audio/engine';
import { MatchAudio } from './audio/matchAudio';
import { loadAssets } from './render/assets';
import { setProjection, squash } from './render/projection';
import { Scene } from './render/scene';
import { PixelText } from './render/pixelText';
import { MOODS } from './render/variants';
import { Screen, MenuScreen, SetupScreen, PauseScreen, StatsScreen, MatchSetup, fmtClock } from './ui/screens';
import { SquadBuilderScreen } from './ui/draft';
import { OnlineScreen } from './ui/online';
import { NetSession, NetStartConfig, DraftCtl } from './net/net';
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
  let controls = new LocalControls(squash());

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
  let trainT = 0;   // the coach's next line, fused
  let trainIdx = 0;
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
  let guestEchoIdx = -1;   // the body E takes on MY screen NOW — truth confirms in a snap
  let guestEchoT = 0;
  let guestFace = vec();   // my last steered facing, held briefly past release
  let guestFaceT = 0;
  let guestEndT = 0;                                 // full-time beat before the lobby
  let guestStaleT = 0;                               // cadence for the waiting-for-host toast
  let guestSeatNames: Record<number, string> = {};
  let lastStartConfig: NetStartConfig | null = null; // late joiners get the stage too
  // A holding keeper on a guest captain's team: HIS seat aims the distribution
  let remoteGk: { seat: number; gkIdx: number; t: number } | null = null;
  // ...and his validated call, waiting for the next tick to launch in-sim
  let pendingGkLaunch: { gkIdx: number; seat: number; target: Vec2; kind: 'throw' | 'punt'; scatter: number } | null = null;
  let guestGkIdx = -1;      // my team's keeper, as a guest tab knows him
  let guestGkSentT = 0;     // sight down while my distribution call rides the wire
  let guestLead = vec();    // my body's local head start — input answered this frame
  let guestLeadIdx = -1;
  let guestKickEchoT = 0;   // my kick already sounded locally — mute its snap echo
  // The spot kick fires INSIDE the tick so its events reach every listener
  let penaltyShot: { side: -1 | 0 | 1; high: boolean } | null = null;
  let myName = ''; // asked fresh every time — his call, no stored defaults
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, clicked: false, moved: false };
  const drag = { active: false, anchorX: 0, anchorY: 0 };
  const DRAG_FULL_PX = 260;
  // The coach's lines, keyboard and pad wordings — rotated slowly on the
  // training ground so a new player learns the sticks without reading a menu
  const TRAINING_TIPS: [string, string][] = [
    ['WASD RUNS - SHIFT SPRINTS', 'LEFT STICK RUNS - RT SPRINTS'],
    ['DRAG BACK OFF YOUR MAN, RELEASE TO PASS', 'FLICK THE RIGHT STICK TO SLING A PASS'],
    ['HOLD SPACE TO CHARGE, LET GO TO SHOOT', 'HOLD A TO CHARGE, LET GO TO SHOOT'],
    ['E TAKES THE MAN UNDER THE CHEVRON', 'LB TAKES THE MAN UNDER THE CHEVRON'],
    ['T HANDS YOU THE HUNTER - AUTO SWITCH', 'Y HANDS YOU THE HUNTER - AUTO SWITCH'],
    ['PASS TO YOUR KEEPER - HIS HANDS OPEN THE SIGHT', 'PASS TO YOUR KEEPER - HIS HANDS OPEN THE SIGHT'],
    ['KICK IT OUT ANYWHERE - EVERY RESTART IS YOURS', 'KICK IT OUT ANYWHERE - EVERY RESTART IS YOURS'],
    ['STAND STILL - THE WHOLE FIELD WAITS WITH YOU', 'STAND STILL - THE WHOLE FIELD WAITS WITH YOU'],
  ];
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

  // The shell's one warning toast, riding above every screen: the double-press
  // guard that keeps a pause-reflex ESC from throwing anyone out of a party
  const leaveHint = new Container();
  let leaveArm = 0; // seconds left on an armed online exit
  const shellHint = (text: string | null) => {
    leaveHint.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!text) return;
    const t = new PixelText(assets, 2, 0xffd95e);
    t.text = text;
    const w = app.renderer.width;
    const y = app.renderer.height - 118;
    const bh = assets.manifest.font.cellH * 2 + 20;
    const plate = new Graphics();
    plate.rect(w / 2 - t.textWidth / 2 - 14, y, t.textWidth + 28, bh).fill({ color: 0x0d1119, alpha: 0.92 });
    plate.rect(w / 2 - t.textWidth / 2 - 14, y, t.textWidth + 28, 2).fill({ color: 0xffd95e, alpha: 0.55 });
    leaveHint.addChild(plate);
    t.centerAt(w / 2, y + 10);
    leaveHint.addChild(t);
  };

  const show = (s: Screen | null) => {
    uiRoot.removeChildren();
    activeScreen = s;
    if (s) {
      s.layout(app.renderer.width, app.renderer.height);
      uiRoot.addChild(s.root);
      s.enter?.(); // entrances land on freshly laid-out rests
    }
    uiRoot.addChild(leaveHint); // always the top card
  };
  // the RENDERER's resize, not the window's — the window event fires before
  // Pixi has taken the new size, and a screen laid out on stale dims paints
  // its backdrop for a canvas that no longer exists
  app.renderer.on('resize', () => activeScreen?.layout(app.renderer.width, app.renderer.height));

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
  menu.onTraining = () => startTraining();
  menu.onOnline = () => { onlineScreen.begin('name', ''); show(onlineScreen); };

  // The training ground: your full XI on an open field, nobody pressing.
  // Teammates still make real runs, every restart is yours, the clock never
  // runs — the place a new player learns the sticks without losing for it.
  function startTraining() {
    const [stars] = quickSplit(11);
    startMatch(toSquad(stars, FORMATIONS['4-3-3']), '4-3-3', [], '4-4-2',
      { halfLength: 0, kickoffFirst: 0, practice: true });
  }

  // ---- the party line ----------------------------------------------------
  function leaveOnline() {
    leaveArm = 0;
    shellHint(null);
    net?.close();
    net = null;
    party = null;
    netRole = null;
    snapPlayer = null;
    seatCursors.clear();
    guestSeatNames = {};
    lastStartConfig = null;
    guestEndT = 0;
    if (screenName === 'match') return toMenu();
    menu.openPage('root');
    show(menu);
  }

  // A connect that dies before a seat is dealt (busy room, dead server) hands
  // back the gate — never a freeze on CONNECTING, never a silent menu-dump
  function backToGate() {
    net?.close();
    net = null;
    netRole = null;
    audio.ui('denied');
    onlineScreen.begin('gate', myName);
  }

  onlineScreen.onNamed = (name) => {
    myName = name;
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
        // guest captains play the war room through the host's referee desk
        party.onGuestDraft = (seat, action) => {
          if (screenName === 'draft') draftScreen.remoteIntent(seat, action);
        };
        party.onSeatLeft = (seat) => {
          if (screenName === 'draft') draftScreen.seatLeft(seat);
        };
        // A guest captain clicked his keeper's sight: validate that the call
        // is his to make, rebuild throw-or-punt from the KEEPER's own stats
        // (the wire names only a field point), and launch inside the sim
        party.onGuestGk = (seat, x, y) => {
          if (!match || screenName !== 'match' || !remoteGk || remoteGk.seat !== seat) return;
          const world = match.world;
          const gkIdx2 = remoteGk.gkIdx;
          if (world.holdingGk !== gkIdx2) return;
          const gk = world.players[gkIdx2];
          const throwR = 24 + 14 * gk.stats.power;
          const puntR = clamp(60 + 34 * gk.stats.power, 60, 88);
          const toT = vec(clamp(x, 1, 104) - gk.pos.x, clamp(y, 1, 73) - gk.pos.y);
          const dRaw = Math.hypot(toT.x, toT.y);
          const d = Math.min(Math.max(dRaw, 4), puntR);
          const dir = dRaw > 1e-4 ? vec(toT.x / dRaw, toT.y / dRaw) : vec(world.attackSign(gk.id.team), 0);
          const target = vec(gk.pos.x + dir.x * d, gk.pos.y + dir.y * d);
          const kind: 'throw' | 'punt' = d <= throwR ? 'throw' : 'punt';
          const scatter = kind === 'throw'
            ? (0.8 + d * 0.045) * (1.35 - gk.stats.control * 0.7)
            : (2.2 + d * 0.075) * (1.45 - gk.stats.control * 0.7);
          remoteGk = null;
          pendingGkLaunch = { gkIdx: gkIdx2, seat, target, kind, scatter };
        };
        onlineScreen.setLobby(party.snap(), 0, true);
      }
    };
    net.onClosed = () => {
      if (netRole === 'host') leaveOnline();
      else if (net) backToGate(); // closed before 'hosted' ever landed
    };
    net.host();
  };
  onlineScreen.onJoin = (code) => {
    net = new NetSession();
    netRole = 'guest';
    net.onMessage = (m) => {
      if (m.t === 'no-room') {
        // a typo'd code stays a typo, not an ejection — quietly drop the dead
        // socket and hand the code pad back
        if (net) { net.onClosed = () => {}; net.close(); }
        net = null;
        netRole = null;
        onlineScreen.begin('code', myName);
        return;
      }
      if (m.t === 'room-closed') return leaveOnline();
      // the lobby snap is ALWAYS kept fresh — a full-time return must never
      // render a stale phase (the "captains are building" ghost)
      if (m.t === 'lobby' && net) { onlineScreen.setLobby(m.state, net.seat, false); return; }
      if (m.t === 'start') { void guestStartMatch(m.config); return; }
      if (m.t === 'draft') {
        // the war room, mirrored: captains act through intents, everyone
        // else watches the same boards fill in real time
        const op = m.op;
        if (op.k === 'begin' && net) {
          draftScreen.beginMirror(op, net.seat, (action) => net?.send({ t: 'draft', action }));
          screenName = 'draft';
          show(draftScreen);
          routeMusic();
        } else if (op.k === 'abort') {
          if (screenName === 'draft') {
            audio.ui('back');
            screenName = 'menu';
            show(onlineScreen);
            routeMusic();
          }
        } else if (screenName === 'draft') {
          draftScreen.applyRemoteOp(op);
        }
        return;
      }
      if (m.t === 'snap') { snapPlayer?.push(m.snap); return; }
      // full time: let the banner land before walking back to the lobby
      if (m.t === 'end') { if (screenName === 'match') guestEndT = 2.6; return; }
    };
    net.onClosed = () => {
      if (netRole !== 'guest' || !net) return;
      if (net.seat < 0) backToGate(); // never seated — the join itself died
      else leaveOnline();
    };
    net.join(code, myName || 'PLAYER');
  };
  onlineScreen.onClaim = (team) => { if (netRole === 'host') party?.claim(0, team); else net?.send({ t: 'claim', team }); };
  onlineScreen.onNation = (dir) => { if (netRole === 'host') party?.cycleNation(0, dir); else net?.send({ t: 'nation', dir }); };
  onlineScreen.onRename = (name) => { if (netRole === 'host') party?.renameTeam(0, name); else net?.send({ t: 'teamname', name }); };
  onlineScreen.onReady = () => {
    if (netRole === 'host' && party) {
      const me = party.seats.get(0);
      if (me) party.setReady(0, !me.ready);
      return;
    }
    if (!net) return;
    const me = onlineScreen.lobby?.seats.find((s) => s.seat === net!.seat);
    net.send({ t: 'ready', ready: !me?.ready });
  };
  onlineScreen.onStart = () => hostStartOnline();
  onlineScreen.onLeave = () => leaveOnline();
  onlineScreen.onMode = () => {
    if (!party) return;
    party.mode = party.mode === 'quick' ? 'draft' : party.mode === 'draft' ? 'gamble' : 'quick';
    party.publish();
  };
  onlineScreen.onHalf = () => {
    if (!party) return;
    const choices = [60, 120, 180, 300];
    party.half = choices[(choices.indexOf(party.half) + 1) % choices.length];
    party.publish();
  };

  // Full time online: the ROOM lives on — everyone returns to the lobby for
  // the rematch instead of the party dying with the whistle
  function backToLobby() {
    leaveArm = 0; // an exit armed in the match must not fire in the lobby
    shellHint(null);
    scene?.destroy();
    scene = null;
    match = null;
    matchAudio.end();
    snapPlayer = netRole === 'guest' ? new SnapPlayer() : null;
    seatCursors.clear();
    lastStartConfig = null;
    guestEndT = 0;
    remoteGk = null;
    pendingGkLaunch = null;
    screenName = 'menu';
    paused = false;
    ensureAttract();
    if (netRole === 'host' && party) {
      party.phase = 'teams';
      for (const seat of party.seats.values()) seat.ready = false;
      onlineScreen.setLobby(party.snap(), 0, true);
      party.publish();
    }
    show(onlineScreen);
    routeMusic();
  }
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
    if (netRole === 'host' && pendingDress) {
      const dress = pendingDress;
      pendingDress = null;
      launchOnline(dress, home, homeShape, away, awayShape);
      return;
    }
    startMatch(home, homeShape, scaleSquad(away, DIFF_SCALE[setup.difficulty]), awayShape);
  };
  // Walking out of the war room: offline goes home; an online host folds the
  // draft and brings the whole party back to the lobby — the room lives on
  draftScreen.onBack = () => {
    audio.ui('back');
    if (netRole === 'host' && party) {
      draftScreen.abortOnline();
      pendingDress = null;
      party.phase = 'teams';
      for (const seat of party.seats.values()) seat.ready = false;
      screenName = 'menu';
      onlineScreen.setLobby(party.snap(), 0, true);
      party.publish();
      show(onlineScreen);
      routeMusic();
      return;
    }
    toMenu();
  };
  pauseScreen.onResume = () => pauseScreen.close(); // slide out, then release
  pauseScreen.onClosed = () => { paused = false; scene?.setHudVisible(true); show(null); };
  pauseScreen.onQuit = () => toMenu();
  statsScreen.onDone = () => { if (netRole === 'host') backToLobby(); else toMenu(); };
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
  // The body that is MINE on this tab right now: the host's word — or, for
  // the beat after E, the echoed switch target the wire hasn't confirmed yet
  const guestMyIdx = () => {
    const truth = snapPlayer?.latest?.cursors[net?.seat ?? -1] ?? -1;
    return guestEchoT > 0 && guestEchoIdx >= 0 ? guestEchoIdx : truth;
  };
  const ballIsMine = () => {
    if (!match || !cursor) return false;
    if (netRole === 'guest') {
      // a guest's world never thinks — proximity to the snapped ball decides,
      // with slack for the interpolation buffer's lag
      const myIdx = guestMyIdx();
      return myIdx >= 0 && dist(match.world.players[myIdx].pos, match.world.ball.pos) < 5;
    }
    const poss = match.teamBrains[0].possessorIdx;
    if (poss !== null && match.world.players[poss].id.team !== 0) return false;
    return dist(match.world.players[cursor.idx].pos, match.world.ball.pos) < 3.5;
  };

  // The stick's sling and the mouse's sling land in the same place: a
  // field-point kick released this frame, aimed FROM THE BALL. Any release
  // also kicks the pad's motors, scaled to the ball it just hit.
  const applyFlick = (into: PlayerInput, world: World) => {
    const flick = controls.takeFlick();
    if (flick && !into.kickReleased) {
      into.kickReleased = {
        power: flick.power,
        aimOffset: 0,
        aimAt: vec(world.ball.pos.x + flick.dir.x * 30, world.ball.pos.y + flick.dir.y * 30),
      };
    }
    if (into.kickReleased) pads.rumble(0.2 + into.kickReleased.power * 0.45, 90);
  };

  // The host presses START: his claimed side becomes SIM TEAM 0 (every local
  // aid — keeper sight, penalty bins, drag pass — keeps working unchanged),
  // nations dress the teams, seated friends become cursors, and the whole
  // stage description ships to every guest.
  // The wardrobe and seating a match needs, from the party as it stands.
  // The host's claimed side becomes SIM TEAM 0 so every local aid (keeper
  // sight, penalty bins, drag pass) keeps working unchanged.
  interface OnlineDress {
    kits: [string, string];
    nations: [string, string];
    teamNames: [string, string];
    seatTeams: Record<number, 0 | 1>;
    seatNames: Record<number, string>;
    halfLength: number;
  }
  let pendingDress: OnlineDress | null = null; // set while captains draft

  function buildOnlineDress(): OnlineDress | null {
    if (!party) return null;
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
    const seatTeams: Record<number, 0 | 1> = {};
    const seatNames: Record<number, string> = {};
    for (const st of party.seats.values()) {
      if (st.team !== null) seatTeams[st.seat] = simTeamOf(st.team);
      seatNames[st.seat] = st.name;
    }
    return {
      kits: [kitKey(n0.sheets.h), kitKey(clash ? n1.sheets.a : n1.sheets.h)],
      nations: [n0.id, n1.id],
      teamNames: [lob.teamNames[flip ? 1 : 0] || n0.name, lob.teamNames[flip ? 0 : 1] || n1.name],
      seatTeams, seatNames,
      halfLength: party.half,
    };
  }

  // Ship the stage to every guest and raise the curtain locally
  function launchOnline(dress: OnlineDress, homeSquad: SquadPlayer[], homeShape: string, awaySquad: SquadPlayer[], awayShape: string) {
    if (!party || !net) return;
    const toss: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    const config: NetStartConfig = {
      halfLength: dress.halfLength,
      homeShape, awayShape, homeSquad, awaySquad,
      kits: dress.kits, nations: dress.nations, teamNames: dress.teamNames,
      seatTeams: dress.seatTeams, seatNames: dress.seatNames,
      kickoffFirst: toss,
    };
    void (async () => {
      const nations = assets.manifest.nations;
      const files = dress.nations.flatMap((id) => {
        const n = nations.find((x) => x.id === id);
        return n ? [n.sheets.h, n.sheets.a] : [];
      });
      await loadNationSheets(assets, files);
      party!.phase = 'match';
      party!.publish(); // every guest's lobby snap now says 'match', not 'draft'
      lastStartConfig = config;
      party!.broadcast({ t: 'start', config });
      startMatch(homeSquad, homeShape, awaySquad, awayShape, { kits: dress.kits, halfLength: dress.halfLength, kickoffFirst: toss });
      // set pieces belong to the true captain — the host included
      const hostTeam = party!.seats.get(0)?.team;
      if (cursor && hostTeam !== null && hostTeam !== undefined) {
        cursor.isCaptain = party!.captainOf(hostTeam) === 0;
      }
      seatCursors.clear();
      netTick = 0;
      pendingNetEvents = [];
      for (const st of party!.seats.values()) {
        if (st.seat === 0 || st.team === null || !match) continue;
        const simT = dress.seatTeams[st.seat];
        if (simT === undefined) continue;
        const c = new TeamCursor(simT, match.world);
        c.isCaptain = party!.captainOf(st.team) === st.seat;
        seatCursors.set(st.seat, { cursor: c, team: simT });
      }
      wireSeatClaims();
      // penalties for a side with no LOCAL human take themselves
      const auto = new Set<0 | 1>([1]);
      if (party!.seats.get(0)?.team === null) auto.add(0);
      if (match) match.autoPenaltyTeams = auto;
    })();
  }

  function hostStartOnline() {
    if (!party || !net || !party.allReady()) return;
    const dress = buildOnlineDress();
    if (!dress) return;
    if (party.mode === 'quick') {
      const shapes = formationsOfSize(11);
      const homeShape = shapes[Math.min(1, shapes.length - 1)];
      const awayShape = shapes[0];
      const [homeStars, awayStars] = quickSplit(11);
      launchOnline(dress, toSquad(homeStars, FORMATIONS[homeShape]), homeShape, toSquad(awayStars, FORMATIONS[awayShape]), awayShape);
      return;
    }
    // draft and gamble: the whole room walks into the war room. Each side is
    // run by its CAPTAIN — the first person who claimed that shirt, host or
    // guest alike — and only a shirt nobody claimed goes to the CPU.
    pendingDress = dress;
    const flip = party.seats.get(0)?.team === 1;
    const ctl = ([0, 1] as const).map((side) => {
      const partyTeam = (flip ? 1 - side : side) as 0 | 1;
      const cap = party!.captainOf(partyTeam);
      return cap === 0 ? { kind: 'local' as const }
        : cap > 0 ? { kind: 'remote' as const, seat: cap }
        : { kind: 'cpu' as const };
    }) as [DraftCtl, DraftCtl];
    const capNames = ctl.map((c) =>
      c.kind === 'local' ? (myName || 'HOST').toUpperCase()
      : c.kind === 'remote' ? (party!.seats.get(c.seat)?.name ?? 'CAPTAIN').toUpperCase()
      : 'CPU') as [string, string];
    party.phase = 'draft';
    party.publish();
    draftScreen.beginOnlineHost({
      mode: party.mode as 'draft' | 'gamble',
      first: Math.random() < 0.5 ? 0 : 1,
      ctl,
      teamNames: dress.teamNames,
      capNames,
      seatSides: dress.seatTeams,
      sendOp: (op) => party?.broadcast({ t: 'draft', op }),
    });
    screenName = 'draft';
    show(draftScreen);
    routeMusic();
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
    match.world.events.length = 0; // a guest's world never steps — nothing may linger
    scene = new Scene(app, assets, match.world, loop);
    if (import.meta.env.DEV) {
      (window as unknown as { __match?: Match; __net?: object }).__match = match;
      (window as unknown as { __net?: object }).__net = {
        get myIdx() { return snapPlayer?.latest?.cursors[net?.seat ?? -1] ?? -1; },
        get suggest() { return snapPlayer?.latest?.suggest?.[net?.seat ?? -1] ?? -1; },
        get rtt() { return net?.rtt ?? 0; },
        get gkAim() { return snapPlayer?.latest?.gkAim ?? -1; },
        get seat() { return net?.seat ?? -1; },
        get lag() { return snapPlayer?.lagTicks ?? 0; },
        get echo() { return guestEchoT > 0 ? guestEchoIdx : -1; },
      };
    }
    match.world.players.forEach((p, i) => scene!.addPlayer(p.id.team === 0 ? config.kits[0] : config.kits[1], match!.names[i], p.id.number));
    scene.setVariant(MOODS[menu.moodIdx]);
    scene.setPadHints(pads.connected);
    scene.toast(`${config.teamNames[0]} V ${config.teamNames[1]}`);
    snapPlayer = new SnapPlayer();
    guestSeatNames = config.seatNames;
    guestEndT = 0;
    controls = new LocalControls(squash());
    const myTeam = config.seatTeams[net?.seat ?? -1] ?? 0;
    cursor = new TeamCursor(myTeam, match.world);
    guestGkIdx = match.world.players.findIndex((p) => p.id.team === myTeam && p.id.role === 'GK');
    guestGkSentT = 0;
    guestLead = vec();
    guestLeadIdx = -1;
    guestEchoIdx = -1;
    guestEchoT = 0;
    guestFaceT = 0;
    guestKickEchoT = 0;
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
    if (guestEndT > 0) {
      guestEndT -= dt;
      if (guestEndT <= 0) return backToLobby();
    }
    // the switch echo dies the moment truth confirms it (or the window lapses)
    if (guestEchoT > 0) {
      guestEchoT -= dt;
      const truthIdx = snapPlayer.latest?.cursors[net.seat] ?? -1;
      if (truthIdx === guestEchoIdx || guestEchoT <= 0) { guestEchoT = 0; guestEchoIdx = -1; }
    }
    const myIdx = guestMyIdx();
    const facing = myIdx >= 0 ? match.world.players[myIdx].facing : vec(1, 0);
    input = controls.sample(dt, kb, facing);
    if (mouseKick) {
      input.kickReleased = { power: mouseKick.power, aimOffset: 0, aimAt: mouseKick.aimAt };
      mouseKick = null;
    }
    applyFlick(input, match.world);
    // Your boot SOUNDS the moment you let go — the strike itself still rides
    // the wire, but the thump answers your hands, not the round trip
    guestKickEchoT = Math.max(0, guestKickEchoT - dt);
    if (input.kickReleased && ballIsMine()) {
      const p = input.kickReleased.power;
      audio.play(p < 0.45 ? 'kick-soft' : p < 0.75 ? 'kick-mid' : 'kick-hard', { vol: 0.7 + p * 0.3, jitter: 0.05 });
      guestKickEchoT = 0.7;
    }
    // A choking wire gets FRESH state, not a queue: plain movement packets
    // drop when the socket is backed up — a kick or a switch always ships
    const packet = packInput(input, guestSwitch);
    if (net.backlog < 3_000 || packet.kp > 0 || packet.sw) {
      net.send({ t: 'input', input: packet });
      guestSwitch = false;
    }
    snapPlayer.apply(match.world, dt);
    // My body answers my stick THIS FRAME: a bounded lead in the pressed
    // direction, sized by the wire's round trip, melted back onto the truth
    // when I ease off. The ball and everyone else stay the host's word.
    if (myIdx !== guestLeadIdx) { guestLead = vec(); guestLeadIdx = myIdx; }
    if (myIdx >= 0) {
      const me = match.world.players[myIdx];
      const moveLen = Math.hypot(input.move.x, input.move.y);
      // on the ball the lead eases only a little — dribbling is exactly where
      // hands must feel answered, and the host's touch corrects any overlap
      const nearBall = dist(me.pos, match.world.ball.pos) < 2.4;
      const leadT = clamp(((net.rtt || 90) / 1000) * 0.85 + 0.04, 0.07, 0.24) * (nearBall ? 0.6 : 1);
      const spd = input.sprint && me.stamina > 0.05 ? me.stats.sprintSpeed : me.stats.topSpeed;
      const want = moveLen > 0.2 && match.world.restartLock <= 0 && me.lungeTimer <= 0
        ? scale(norm(input.move), spd * Math.min(1, moveLen) * leadT)
        : vec();
      guestLead = expDecayVec(guestLead, want, 16, dt);
      me.pos.x += guestLead.x;
      me.pos.y += guestLead.y;
      // the turn is instant on my own screen — and HELD briefly past release,
      // so the host's delayed facing never flicks the sprite back around
      if (moveLen > 0.2) { guestFace = norm(input.move); guestFaceT = 0.18; }
      if (guestFaceT > 0) { guestFaceT -= dt; me.facing = guestFace; }
    }
    const evs = snapPlayer.drainEvents();
    if (evs.length) scene.handleEvents(evs);
    for (const e of evs) if (e.kind === 'goal') pads.rumble(1, 350);
    // a silent host tab reads as a broken game — say what's actually wrong
    guestStaleT -= dt;
    if (snapPlayer.lastAt > 0 && performance.now() - snapPlayer.lastAt > 2500 && guestStaleT <= 0) {
      scene.toast('WAITING FOR HOST...');
      guestStaleT = 4;
    }
    // my own kick already thumped locally — its snapshot echo stays visual
    const audioEvs = guestKickEchoT > 0 ? evs.filter((e) => !(e.kind === 'kick' && e.idx === myIdx)) : evs;
    matchAudio.tick(match, Math.max(0, myIdx), dt, audioEvs);
    const snap = snapPlayer.latest;
    if (snap) {
      if (myIdx >= 0) scene.setControlled(myIdx);
      scene.setSwitchTarget(snap.suggest?.[net.seat] ?? -1);
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
    scene.setPing(net.rtt > 0 ? net.rtt : null);
    // MY goal kick, MY catch: the same distribution sight the host enjoys,
    // driven from this tab — the host says whose sight is open (snap.gkAim),
    // this tab aims it, and a click sends the field point up the wire
    guestGkSentT = Math.max(0, guestGkSentT - dt);
    if (snap && snap.gkAim === net.seat && guestGkIdx >= 0 && guestGkSentT <= 0) {
      const gk = match.world.players[guestGkIdx];
      const sight = readKeeperSight(gk.pos, gk.stats);
      scene.setKeeperAim(sight);
      if (mouse.clicked) {
        net.send({ t: 'gk', x: sight.target.x, y: sight.target.y });
        scene.setKeeperAim(null);
        guestGkSentT = 1; // sight stays down while the wire answers
      }
    } else {
      scene.setKeeperAim(null);
    }
    // the sling arrow rides the same code the host uses
    if (drag.active && !ballIsMine()) drag.active = false;
    if (drag.active) {
      const pull = resolveDrag();
      scene.setKickDrag(pull && myIdx >= 0 ? { from: match.world.players[myIdx].pos, dir: pull.dir, power: pull.power } : null);
    } else if (controls.flickAim && myIdx >= 0 && ballIsMine()) {
      scene.setKickDrag({ from: match.world.players[myIdx].pos, dir: controls.flickAim.dir, power: controls.flickAim.power });
    } else scene.setKickDrag(null);
    mouse.clicked = false;
  }

  function startMatch(
    homeSquad: SquadPlayer[], homeShape: string, awaySquad: SquadPlayer[], awayShape: string,
    opts?: { kits?: [string, string]; halfLength?: number; kickoffFirst?: 0 | 1; practice?: boolean },
  ) {
    killAttract();
    scene?.destroy();
    const toss: 0 | 1 = opts?.kickoffFirst ?? (Math.random() < 0.5 ? 0 : 1);
    match = createMatch({
      homeSquad, homeShape, awaySquad, awayShape,
      halfLength: opts?.halfLength ?? setup.halfLength, kickoffFirst: toss,
      awayProfile: AI_PROFILES[setup.difficulty],
      practice: opts?.practice,
    });
    scene = new Scene(app, assets, match.world, loop);
    if (import.meta.env.DEV) (window as unknown as { __match?: Match }).__match = match; // dev console handle
    const kits = opts?.kits ?? ['home', 'away'];
    match.world.players.forEach((p, i) => scene!.addPlayer(p.id.team === 0 ? kits[0] : kits[1], match!.names[i], p.id.number));
    scene.setVariant(MOODS[menu.moodIdx]);
    scene.setPadHints(pads.connected);
    scene.toast(opts?.practice ? 'TRAINING GROUND' : toss === 0 ? 'RED WINS THE TOSS' : 'BLUE WINS THE TOSS');
    trainT = 4;
    trainIdx = 0;
    cursor = new TeamCursor(0, match.world);
    cursor.autoMode = menu.autoSwitch;
    // the opening kickoff event fires before the first frame — hand the taker over now
    if (toss === 0 && match.world.lastTouch) cursor.assign(match.world.lastTouch.idx);
    gkIdx = match.world.players.findIndex((p) => p.id.team === 0 && p.id.role === 'GK');
    scene.setControlled(cursor.idx);
    controls = new LocalControls(squash());
    humanIdle = Infinity;
    keeperAiming = false;
    penAim = null;
    penaltyShot = null;
    throwAim = null;
    remoteGk = null;
    pendingGkLaunch = null;
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
      // queued for the next tick — a between-frames strike would push its
      // events into a buffer the sim wipes before anyone hears them
      penaltyShot = { side: (penAim.col - 1) as -1 | 0 | 1, high: penAim.row === 0 };
      penAim = null;
      scene.setPenaltyAim(null);
      return true;
    }
    return false;
  };
  const routeKey = (code: string) => { if (!penaltyKey(code)) activeScreen?.key(code); };
  const uiKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyF', 'KeyX'];
  for (const code of uiKeys) kb.onPress(code, () => routeKey(code));
  kb.onPress('Space', () => activeScreen?.key('Space'));
  // Online exits must be MEANT. ESC, START and B all land here, and every one
  // of them is also a pause or cancel reflex — so the first press only ARMS
  // the door, and a second inside the window actually walks through it.
  const wantLeave = (): boolean => {
    if (leaveArm > 0) { leaveArm = 0; shellHint(null); return true; }
    leaveArm = 2.5;
    shellHint(netRole === 'host' ? 'PRESS AGAIN TO CLOSE THE PARTY FOR EVERYONE' : 'PRESS AGAIN TO LEAVE THE PARTY');
    audio.ui('card');
    return false;
  };
  const pressEscape = () => {
    if (activeScreen === onlineScreen) {
      // pre-party pages back out freely; a LIVE party only opens the door twice
      const partyLive = onlineScreen.stage === 'party' && netRole !== null &&
        (netRole === 'guest' || (party?.seats.size ?? 1) > 1);
      if (partyLive && !wantLeave()) return;
      return leaveOnline();
    }
    if (screenName === 'match' && netRole === 'guest') { // a guest can always leave — knowingly
      if (wantLeave()) leaveOnline();
      return;
    }
    if (screenName === 'menu') return activeScreen?.key('Escape'); // menu pages or match setup
    if (screenName === 'draft') {
      if (netRole === 'guest') { // a guest walks out of the party — knowingly
        if (wantLeave()) leaveOnline();
        return;
      }
      return draftScreen.onBack(); // host folds to the lobby; offline goes home
    }
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
  };
  kb.onPress('Escape', pressEscape);
  const pressSwitch = () => {
    if (screenName !== 'match' || paused) return;
    if (netRole === 'guest') {
      guestSwitch = true; // rides the next packet up to the host...
      const sug = snapPlayer?.latest?.suggest?.[net?.seat ?? -1] ?? -1;
      if (sug >= 0) { guestEchoIdx = sug; guestEchoT = 0.6; } // ...the ring moves NOW
      return;
    }
    cursor?.manualSwitch();
  };
  kb.onPress('KeyE', pressSwitch);
  const toggleAutoSwitch = () => {
    if (screenName !== 'match' || paused || !cursor || !scene) return;
    cursor.autoMode = !cursor.autoMode;
    scene.toast(cursor.autoMode ? 'AUTO SWITCH ON' : 'AUTO SWITCH OFF');
  };
  kb.onPress('KeyT', toggleAutoSwitch);

  // ---- the pad speaks every language: sticks in play, dpad in menus ------
  pads.onConnect = () => {
    audio.ui('move');
    scene?.toast('PAD ON - RIGHT STICK SLINGS THE PASS');
    scene?.setPadHints(true);
  };
  pads.onDisconnect = () => scene?.setPadHints(false);
  const tickPad = (dt: number) => {
    pads.poll(dt);
    if (!pads.connected) return;
    if (activeScreen || penAim) for (const code of pads.navCodes()) routeKey(code);
    if (pads.pressed('a')) routeKey('Enter');
    if (pads.pressed('start')) pressEscape();
    if (pads.pressed('b') && activeScreen) pressEscape(); // B backs out of menus; in play it tackles
    if (pads.pressed('lb') || pads.pressed('x')) pressSwitch();
    if (pads.pressed('y')) {
      toggleAutoSwitch();                  // in play: hand-me-the-hunter mode
      if (activeScreen) routeKey('KeyF');  // in the lobby: READY UP
    }
  };
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
    if (!pull || !match) return; // a stray click is not a kick
    // aim FROM THE BALL — the kick leaves the ball, and on a guest tab the
    // local cursor is a bystander (his true body lives in the snapshots)
    const origin = match.world.ball.pos;
    mouseKick = { power: pull.power, aimAt: vec(origin.x + pull.dir.x * 30, origin.y + pull.dir.y * 30) };
  });

  // The distribution sight's numbers — one math for the host's keeper, a
  // guest captain's keeper, and the referee desk validating a wire call
  const readKeeperSight = (origin: Vec2, stats: { power: number; control: number }) => {
    const throwR = 24 + 14 * stats.power;
    const puntR = clamp(60 + 34 * stats.power, 60, 88);
    const m = scene!.screenToWorld(mouse.x, mouse.y);
    const toM = vec(m.x - origin.x, m.y - origin.y);
    const dRaw = Math.hypot(toM.x, toM.y);
    const d = Math.min(dRaw, puntR);
    const target = dRaw > 1e-4
      ? vec(origin.x + (toM.x / dRaw) * d, origin.y + (toM.y / dRaw) * d)
      : vec(origin.x + 10, origin.y);
    const kind: 'throw' | 'punt' = d <= throwR ? 'throw' : 'punt';
    const scatter = kind === 'throw'
      ? (0.8 + d * 0.045) * (1.35 - stats.control * 0.7)
      : (2.2 + d * 0.075) * (1.45 - stats.control * 0.7);
    const pCenter = Math.pow(0.5, 1 / (0.5 + 0.6 * stats.control));
    return { gk: origin, target, throwR, puntR, scatter, kind, pCenter };
  };

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
    applyFlick(input, world);
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
        // a line gone quiet means HOLD, not "keep running the old way" — stale
        // packets steering a body is the ghost movement guests can't explain
        const fresh = performance.now() - s.heardAt < 250;
        const seatIn = fresh && s.lastInput
          ? unpackInput(s.lastInput)
          : { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
        // the latched release fires exactly once, whatever the packet timing
        if (s.pendingKick) {
          seatIn.kickReleased = {
            power: s.pendingKick.power,
            aimOffset: 0,
            aimAt: s.pendingKick.x || s.pendingKick.y ? vec(s.pendingKick.x, s.pendingKick.y) : undefined,
          };
          s.pendingKick = null;
        } else if (seatIn.kickReleased) {
          seatIn.kickReleased = null; // stale kp in a repeated packet never double-fires
        }
        // the same auto-tackle the host enjoys: a hands-on guest near an
        // opponent's carried ball lunges without the button
        const seatBody = world.players[sc.cursor.idx];
        const seatPoss = match.teamBrains[sc.team].possessorIdx;
        if (!seatIn.tackle && seatPoss !== null && world.players[seatPoss].id.team !== sc.team &&
            performance.now() - s.activeAt < 2500 && seatBody.tackleCooldown <= 0 &&
            dist(seatBody.pos, world.ball.pos) < 1.3) {
          seatIn.tackle = true;
        }
        overrides[sc.cursor.idx] = seatIn;
      }
    }
    // Online: a holding keeper whose team's CAPTAIN sits on another tab waits
    // for THAT captain's distribution call — his sight opens over there
    // (snap.gkAim), the beat pins here, and a sleeping captain gets the
    // CPU's distribution after a grace
    if (netRole === 'host' && party && world.holdingGk >= 0 && !(keeperAiming && world.holdingGk === gkIdx)) {
      const holdingIdx = world.holdingGk;
      const gkTeam = world.players[holdingIdx].id.team;
      let heldSeat = -1;
      if (!(gkTeam === 0 && cursor.isCaptain)) {
        for (const [seat, sc] of seatCursors) {
          if (sc.team === gkTeam && sc.cursor.isCaptain) { heldSeat = seat; break; }
        }
      }
      if (heldSeat >= 0) {
        if (!remoteGk || remoteGk.seat !== heldSeat || remoteGk.gkIdx !== holdingIdx) {
          remoteGk = { seat: heldSeat, gkIdx: holdingIdx, t: 0 };
        }
        remoteGk.t += dt;
        world.holdLock = true;
        overrides[holdingIdx] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
        if (remoteGk.t > 7) { // the captain slept on it — the keeper plays it himself
          const { target, kind, scatter } = pickDistribution(world, holdingIdx);
          pendingGkLaunch = { gkIdx: holdingIdx, seat: heldSeat, target, kind, scatter };
          remoteGk = null;
        }
      } else remoteGk = null;
    } else if (netRole === 'host') remoteGk = null;
    if (keeperAiming) overrides[gkIdx] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
    // Training: stand still ~3 seconds and the field thinks WITH you — every
    // shirt holds his spot (a called pass still gets met) until you move again
    if (match.practice && humanIdle >= 3) {
      const receiver = match.teamBrains[0].calledReceiver;
      world.players.forEach((_, i) => {
        if (i === receiver || i in overrides) return;
        overrides[i] = { move: vec(), sprint: false, kickCharging: false, kickReleased: null };
      });
    }
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
    // Deferred actions fire INSIDE the tick, so their events survive to
    // every end-of-tick listener: a wire keeper launch, the host's spot kick
    if (pendingGkLaunch) {
      const g = pendingGkLaunch;
      pendingGkLaunch = null;
      if (world.holdingGk === g.gkIdx) {
        world.gkLaunch(g.gkIdx, g.target, g.kind, g.scatter);
        const sc = seatCursors.get(g.seat);
        if (sc) {
          let best = -1;
          let bestD = Infinity;
          world.players.forEach((p, i) => {
            if (p.id.team !== sc.team || i === g.gkIdx || p.id.role === 'GK') return;
            const d = dist(p.pos, g.target);
            if (d < bestD) { bestD = d; best = i; }
          });
          if (best >= 0) sc.cursor.assign(best);
        }
      }
    }
    if (penaltyShot) {
      world.takePenalty(penaltyShot.side, penaltyShot.high);
      penaltyShot = null;
    }
    cursor.update(world, match.teamBrains[0], dt);

    // online: friends' cursors follow the same football rules (the truth
    // itself ships at the END of the tick, launches included)
    if (netRole === 'host' && party) {
      for (const sc of seatCursors.values()) sc.cursor.update(world, match.teamBrains[sc.team], dt);
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
      // the sight is the CAPTAIN's — a non-captain host leaves it to the
      // captain's tab (the remote-aim flow hands it over)
      if (cursor.isCaptain) {
        keeperAiming = true;
        world.holdLock = true;
      }
      audio.play('gk-catch', { vol: 0.7 });
    }

    // A catch or goal kick for OUR keeper opens the distribution sight —
    // if someone's actually playing
    for (const e of world.events) {
      const caught = e.kind === 'save' && world.lastTouch?.team === 0 && world.lastTouch.idx === gkIdx;
      const goalKick = e.kind === 'restart' && e.team === 0 && e.taker === gkIdx;
      if ((caught || goalKick) && humanIdle < 8 && cursor.isCaptain) {
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
      if (e.kind === 'fulltime') {
        fulltimeDelay = 1.5;
        if (netRole === 'host' && party) party.broadcast({ t: 'end', score: [world.score.left, world.score.right] });
      }
      if (e.kind === 'half') halfCountdown = 4.3; // HALF TIME banner first, then 3-2-1
      if (e.kind === 'goal') pads.rumble(1, 350);
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
    // The sight is never a missed beat: as long as OUR keeper still holds his
    // ball (goal kick, catch, pickup), waking the hands reopens the menu
    if (!keeperAiming && gkIdx >= 0 && world.holdingGk === gkIdx && humanIdle < 2.5 && cursor.isCaptain) {
      keeperAiming = true;
      world.holdLock = true;
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
      // on the training ground the sight WAITS while you think — no idle punt
      if ((humanIdle >= 6 && !match.practice) || world.restartLock <= 0) {
        launchKeeper(vec(clamp(gk.pos.x + world.attackSign(0) * 38, 8, 97), world.ball.pos.y < 34 ? 22 : 46), 'punt', 5);
      } else {
        const sight = readKeeperSight(gk.pos, gk.stats);
        scene.setKeeperAim(sight);
        if (mouse.clicked) launchKeeper(sight.target, sight.kind, sight.scatter);
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
        if (humanIdle >= 6 && !match.practice) {
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
    } else if (controls.flickAim && ballIsMine()) {
      // the pad's wind-up wears the same arrow the mouse sling does
      scene.setKickDrag({ from: world.players[cursor.idx].pos, dir: controls.flickAim.dir, power: controls.flickAim.power });
    } else {
      scene.setKickDrag(null);
    }

    scene.setControlled(cursor.idx);
    scene.setSwitchTarget(cursor.suggested);
    scene.setBallGlow(ballIsMine());
    scene.setPing(netRole && net && net.rtt > 0 ? net.rtt : null);
    // stoppage time wears a plus — the referee is letting the move breathe
    const et = match.halfLength > 0 && match.clock > match.halfLength ? '+' : '';
    scene.setClock(match.halfLength > 0 ? `${match.half === 1 ? '1ST' : '2ND'} ${fmtClock(match.clock)}${et}` : '');
    // the coach speaks on the training ground — one line at a time, unhurried
    if (match.practice) {
      trainT -= dt;
      if (trainT <= 0) {
        scene.toast(TRAINING_TIPS[trainIdx % TRAINING_TIPS.length][pads.connected ? 1 : 0]);
        trainIdx++;
        trainT = 13;
      }
    }
    matchAudio.tick(match, cursor.idx, dt);
    // The whole truth ships LAST — this tick's launches and reassignments
    // included — ~30 times a second, and never onto a choking socket: a
    // queued snapshot is a stale snapshot, and a queue that only grows is
    // the lag that "gets worse and worse". Events wait for the next send.
    if (netRole === 'host' && party && net) {
      pendingNetEvents.push(...world.events);
      if (pendingNetEvents.length > 240) pendingNetEvents.splice(0, pendingNetEvents.length - 240);
      netTick++;
      if (netTick % 2 === 0 && net.backlog < 12_000) {
        const cursors: Record<number, number> = { 0: cursor.idx };
        const suggest: Record<number, number> = { 0: cursor.suggested };
        for (const [seat, sc] of seatCursors) {
          cursors[seat] = sc.cursor.idx;
          suggest[seat] = sc.cursor.suggested;
        }
        const gkAim = remoteGk && world.holdingGk === remoteGk.gkIdx ? remoteGk.seat : -1;
        party.broadcast({ t: 'snap', snap: takeSnap(match, netTick, cursors, suggest, pendingNetEvents, gkAim) });
        pendingNetEvents = [];
      }
      const tags: Record<number, string> = {};
      for (const [seat, sc] of seatCursors) {
        if (sc.team === 0) tags[sc.cursor.idx] = party.seats.get(seat)?.name ?? '';
      }
      scene.setSeatTags(tags);
    }
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
      tickPad(dt); // pads are read first so every consumer shares one poll
      if (leaveArm > 0) {
        leaveArm -= dt;
        if (leaveArm <= 0) { leaveArm = 0; shellHint(null); } // the armed door swings shut
      }
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
      get seatCursors() { return [...seatCursors.entries()].map(([s, sc]) => ({ seat: s, team: sc.team, captain: sc.cursor.isCaptain, idx: sc.cursor.idx })); },
      get remoteGk() { return remoteGk; },
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
