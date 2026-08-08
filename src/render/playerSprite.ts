import { Container, Sprite, Graphics } from 'pixi.js';
import { lerp } from './interp';
import { Vec2, len, norm, signedAngle } from '../core/math';
import { PITCH } from '../sim/constants';
import { PlayerBody } from '../sim/player';
import { GameAssets, Manifest } from './assets';
import { Celebration, celebrationFor } from './celebrations';
import { PixelText } from './pixelText';
import { project, pxPerMeter, squash } from './projection';

// Charge + resolved aim the local player's view needs to draw its tell —
// `dir` is the world-space strike line (field-locked J/L already applied)
export interface AimState {
  charge: number;
  move: Vec2;
  dir: Vec2 | null;
}

// A run whose legs go this far off the shoulders is a sideways/backward
// shuffle, not a run — past it the strafe cycle takes over
const STRAFE_ANGLE = 1.0;
// crown height in meters — the shirt number hangs from there down the back,
// pinned to the RIG rather than to whatever the frame box happens to be
const BACK_NUMBER_Z = 1.75;
const LAUNCH_BEAT = 0.1;  // the push-off before he is truly flying
const LAND_HOLD = 0.4;    // the crumple after he comes back down
const SAVE_HOLD = 0.6;    // gloves latched on the ball for the rest of the flight
const SIG_ARRIVE_FPS = 9; // how fast he gets INTO his celebration; the hold is slower

export class PlayerView {
  root = new Container();
  private shadow: Sprite;
  private body: Sprite;
  private aimArrow: Sprite;
  private marker: Sprite;
  private openHint: Sprite;
  private youChev: Sprite;
  private nextChev: Sprite;
  private chargeBar = new Graphics();
  private animPhase = 0;
  private idlePhase = 0;
  private kickTimer = 0;
  private aimPulse = 0;
  private markerPulse = 0;
  private hintPulse = 0;
  private chevPulse = 0;
  private aiCharge = 0; // estimated windup of an AI body, for the charge tell
  private celebrating = false;
  private signature: Celebration | null;
  private sigColumn = 0; // where his own celebration starts in the strip
  private diveClock = 0;  // seconds since the keeper left his feet
  private landTimer = 0;
  private saveStage: 'catch' | 'parry' | null = null;
  private saveTimer = 0;
  private diveSide = 0; // the flight's shoulder + compass row, held through the landing
  private diveRow = 0;
  private sheet: string;
  private nameLabel: PixelText;
  private backNo: PixelText;
  private seatChev!: Sprite;
  private seatName!: PixelText;

  constructor(private assets: GameAssets, sheet: string, name = '', number = 0) {
    this.sheet = sheet;
    const anims = assets.manifest.player.anims;
    this.signature = celebrationFor(name);
    const block = this.signature ? anims.celebSigs.indexOf(this.signature.id) : -1;
    if (block < 0) this.signature = null; // a pose the bake no longer carries
    else this.sigColumn = anims.celebSigStart + block * anims.celebSigLen;
    this.shadow = new Sprite(assets.shadow);
    this.shadow.anchor.set(0.5, 0.5);
    this.shadow.alpha = 0.75;
    this.body = new Sprite(assets.players[sheet][0][0]);
    const { frameH, baseline } = assets.manifest.player;
    this.body.anchor.set(0.5, baseline / frameH);
    this.body.position.y = 1; // boots settle INTO the turf, not on top of it
    this.aimArrow = new Sprite(assets.aimFrames[0]);
    this.aimArrow.anchor.set(0.5, 0.5);
    this.aimArrow.visible = false;
    // "You are here": a chalk ring pooled under the controlled player's feet
    this.marker = new Sprite(assets.ringFrames[0]);
    this.marker.anchor.set(0.5, 0.5);
    this.marker.visible = false;
    this.marker.tint = 0xffe27a;
    // "I'm open!": a smaller mint ring under a reachable pass option
    this.openHint = new Sprite(assets.ringFrames[0]);
    this.openHint.anchor.set(0.5, 0.5);
    this.openHint.visible = false;
    this.openHint.tint = 0x8ef0c0;
    // Overhead identity: gold chevron = YOU, white chevron = who E takes
    this.youChev = new Sprite(assets.chevFrames[0]);
    this.nextChev = new Sprite(assets.chevFrames[1]);
    for (const chev of [this.youChev, this.nextChev]) {
      chev.anchor.set(0.5, 1);
      chev.visible = false;
      chev.scale.set(1.4);
    }
    // Who IS this body: a whisper of a name at the boots, the shirt number
    // between the shoulders whenever the back is turned. The name is off by
    // default — the scene lights it only for the bodies that matter.
    this.nameLabel = new PixelText(assets, 1, 0xdfe4ee, 'micro');
    this.nameLabel.text = name;
    this.nameLabel.alpha = 0.8;
    this.nameLabel.visible = false;
    this.nameLabel.centerAt(0, 6);
    this.backNo = new PixelText(assets, 1, 0xf4f6fa, 'micro');
    this.backNo.text = number > 0 ? String(number) : '';
    this.backNo.visible = false;
    // Online: a teammate seat wears a cool-blue chevron with their username —
    // you always know which bodies are PEOPLE
    this.seatChev = new Sprite(assets.chevFrames[1]);
    this.seatChev.anchor.set(0.5, 1);
    this.seatChev.tint = 0x9cc4f0;
    this.seatChev.visible = false;
    this.seatChev.scale.set(1.2);
    this.seatName = new PixelText(assets, 1, 0x9cc4f0, 'micro');
    this.seatName.visible = false;
    this.root.addChild(this.marker, this.openHint, this.shadow, this.aimArrow, this.body, this.backNo, this.chargeBar, this.nameLabel, this.youChev, this.nextChev, this.seatChev, this.seatName);
  }

  // A human teammate's calling card (null clears it)
  setSeatTag(name: string | null) {
    this.seatChev.visible = name !== null;
    this.seatName.visible = name !== null;
    if (name !== null) {
      this.seatName.text = name;
      this.seatName.centerAt(0, -46);
    }
  }

  // Worth naming this frame — your man, the switch target, whoever carries
  setNamed(on: boolean) {
    this.nameLabel.visible = on;
  }

  setControlled(on: boolean) {
    this.marker.visible = on;
    this.youChev.visible = on;
    this.nameLabel.tint = on ? 0xffe27a : 0xdfe4ee;
    this.nameLabel.alpha = on ? 1 : 0.8;
  }

  setSwitchTarget(on: boolean) {
    this.nextChev.visible = on;
  }

  setOpenHint(on: boolean) {
    this.openHint.visible = on;
  }

  triggerKick() {
    this.kickTimer = 0.26;
  }

  // The goal party: the marquee men do their OWN thing — Ronaldo's landing,
  // Haaland sitting down, Salah on the turf — and everybody else wheels away
  // with their arms up. Off again the moment the ball is respotted.
  setCelebrating(on: boolean) {
    if (on && !this.celebrating) this.animPhase = 0; // always from the first beat
    this.celebrating = on;
  }

  // What the goal card can call this man's celebration, if he has one
  get celebrationLabel(): string | null {
    return this.signature?.label ?? null;
  }

  // How the flight ENDS — gloves wrapped around it, or a hand flung through
  // it. Fired from the sim's save/parry, latched over the rest of the dive.
  triggerSave(kind: 'catch' | 'parry') {
    this.saveStage = kind;
    this.saveTimer = SAVE_HOLD;
  }

  update(p: PlayerBody, dt: number, alpha: number, aim: AimState | null) {
    const x = lerp(p.prev.x, p.pos.x, alpha);
    const y = lerp(p.prev.y, p.pos.y, alpha);
    const proj = project(x, y, 0);
    this.root.position.set(proj.sx, proj.sy);
    this.root.zIndex = proj.depth;
    this.shadow.position.set(0.5, 0.5); // pooled right under the feet
    if (this.marker.visible) {
      this.markerPulse += dt * 6;
      this.marker.scale.set(0.62 + 0.05 * Math.sin(this.markerPulse), 0.44 + 0.035 * Math.sin(this.markerPulse));
      this.marker.alpha = 0.85;
    }
    if (this.openHint.visible) {
      this.hintPulse += dt * 7;
      this.openHint.scale.set(0.42 + 0.04 * Math.sin(this.hintPulse), 0.3 + 0.028 * Math.sin(this.hintPulse));
      this.openHint.alpha = 0.55 + 0.15 * Math.sin(this.hintPulse * 0.7);
    }
    // The chevrons breathe on their own clocks — a calm float, not a strobe
    if (this.youChev.visible) {
      this.chevPulse += dt * 5;
      this.youChev.position.y = -33 + Math.sin(this.chevPulse) * 1.6;
    }
    if (this.nextChev.visible) {
      this.chevPulse += dt * 5;
      this.nextChev.position.y = -31 + Math.sin(this.chevPulse * 0.8) * 1.2;
      this.nextChev.alpha = 0.8 + 0.2 * Math.sin(this.chevPulse * 0.8);
    }
    if (this.seatChev.visible) {
      this.chevPulse += dt * 2;
      this.seatChev.position.y = -33 + Math.sin(this.chevPulse * 0.6) * 1.4;
    }
    this.updateAimArrow(p, dt, aim);

    const speed = p.speed();
    const anims = this.assets.manifest.player.anims;
    this.kickTimer = Math.max(0, this.kickTimer - dt);
    this.saveTimer = Math.max(0, this.saveTimer - dt);
    const airborne = p.id.role === 'GK' && p.diveTimer > 0;
    if (airborne) {
      this.diveClock += dt;
      this.landTimer = LAND_HOLD;
    } else {
      this.diveClock = 0;
      this.landTimer = Math.max(0, this.landTimer - dt);
    }
    // Sideways or backwards travel: the legs know it even though the eyes are
    // still on the ball. Sign of the turn from facing to velocity picks which
    // shoulder leads, and the shuffle replaces the run outright.
    const strafe = speed > 0.7 ? signedAngle(p.look, p.vel) : 0;

    let frame: number;
    if (this.celebrating && this.signature) {
      frame = this.sigColumn + this.signatureStep(this.signature, dt, anims.celebSigLen);
    } else if (this.celebrating) {
      this.animPhase += dt * (4.5 + speed * 1.2);
      frame = anims.celebStart + (speed > 0.7 ? Math.floor(this.animPhase) % anims.celebLen : 0);
    } else if (airborne) {
      frame = this.diveFrame(p, anims);
    } else if (this.landTimer > 0) {
      frame = this.diveFrame(p, anims, anims.diveStage.land);
    } else if (p.lungeTimer > 0) {
      frame = anims.lunge; // flying: the outfielder's slide tackle
    } else if (p.recoverTimer > 0.15) {
      frame = anims.recover; // picking himself back up
    } else if (this.kickTimer > 0) {
      // Coil → whip → follow-through, riding the event timer
      frame = anims.kickStart + (this.kickTimer > 0.18 ? 0 : this.kickTimer > 0.09 ? 1 : 2);
    } else if (p.isCharging && speed < 0.7) {
      frame = anims.kickStart; // planted and wound up, ready to strike
    } else if (Math.abs(strafe) > STRAFE_ANGLE) {
      this.animPhase += dt * (4 + speed * 0.9);
      frame = anims.shuffleStart + (strafe < 0 ? anims.shuffleSideStride : 0) +
        (Math.floor(this.animPhase) % anims.shuffleLen);
    } else if (speed > 0.7) {
      this.animPhase += dt * (5.5 + speed * 1.7);
      frame = anims.runStart + (Math.floor(this.animPhase) % anims.runLen);
    } else {
      this.idlePhase += dt * 1.4;
      frame = anims.idleStart + (Math.floor(this.idlePhase) % anims.idleLen);
      this.animPhase = 0;
    }
    // A body on the ground does not pivot: the leap's compass row outlives it
    let row = this.headingRow(p);
    if (airborne) this.diveRow = row;
    else if (this.landTimer > 0) row = this.diveRow;
    this.body.texture = this.assets.players[this.sheet][row][frame];

    // The shirt number lives between the shoulders — visible whenever the
    // back is turned to camera, riding the run cycle's bob
    const backTurned = row >= 10 && row <= 14 && p.lungeTimer <= 0 && p.recoverTimer <= 0.15 &&
      this.landTimer <= 0;
    this.backNo.visible = backTurned;
    if (backTurned) {
      const bob = speed > 0.7 && frame % 2 === 1 ? -1 : 0;
      this.backNo.position.set(Math.round(-this.backNo.textWidth / 2), Math.round(project(0, 0, BACK_NUMBER_Z).sy) + bob);
    }

    // Charge tell above EVERY head, human or brain: you can read a wound-up
    // strike coming across the pitch — and brace for it
    this.aiCharge = p.isCharging ? Math.min(0.85, this.aiCharge + dt) : 0;
    const charge = aim ? aim.charge : this.aiCharge / 0.85;
    this.chargeBar.clear();
    if (charge > 0.02) {
      const w = 16;
      this.chargeBar.rect(-w / 2, -30, w, 3).fill({ color: 0x1a1626, alpha: 0.7 });
      this.chargeBar.rect(-w / 2 + 0.5, -29.5, (w - 1) * charge, 2).fill(charge > 0.8 ? 0xff5340 : 0xffdf5e);
    }
  }

  // The shot sight: a chalk arrow orbiting the feet at the FINAL aim — stick
  // line bent by J/L — so you always see where the strike will leave
  private updateAimArrow(p: PlayerBody, dt: number, aim: AimState | null) {
    if (!aim || aim.charge <= 0) {
      this.aimArrow.visible = false;
      return;
    }
    this.aimPulse += dt * 9;
    const dir = aim.dir ?? (len(aim.move) > 0.25 ? norm(aim.move) : p.facing);
    const dirs = this.assets.manifest.fx.aim.frames;
    const bin = Math.round(Math.atan2(dir.y, dir.x) / ((Math.PI * 2) / dirs));
    this.aimArrow.texture = this.assets.aimFrames[((bin % dirs) + dirs) % dirs];
    const M = pxPerMeter();
    this.aimArrow.position.set(dir.x * 1.7 * M, dir.y * 1.7 * M * squash() - 2);
    this.aimArrow.visible = true;
    this.aimArrow.alpha = 0.82 + 0.18 * Math.sin(this.aimPulse);
  }

  // His block lands him in the pose at speed, then settles into its tail —
  // a slow breath for a held shape, a kept beat for a dance. animPhase counts
  // plain seconds here, which is why the goal press rewinds it.
  private signatureStep(sig: Celebration, dt: number, len: number): number {
    this.animPhase += dt;
    const arrive = len / SIG_ARRIVE_FPS;
    if (this.animPhase < arrive) return Math.floor(this.animPhase * SIG_ARRIVE_FPS);
    const held = len - sig.loopFrom;
    return sig.loopFrom + Math.floor((this.animPhase - arrive) * sig.loopFps) % held;
  }

  // The keeper flies ALONG his heading, so the sheet's two side blocks are
  // chosen by the shoulder the shot comes over — which is simply the field
  // side of the goal he is defending. Latched so the landing matches the leap.
  private diveFrame(p: PlayerBody, anims: Manifest['player']['anims'], stage?: number): number {
    if (p.diveTimer > 0) {
      const outward = p.pos.x < PITCH.length / 2 ? 1 : -1;
      this.diveSide = p.facing.y * outward > 0 ? 0 : anims.diveSideStride;
    }
    const d = anims.diveStage;
    const at = stage ?? (
      this.saveTimer > 0 && this.saveStage ? (this.saveStage === 'catch' ? d.catch : d.parry)
        : this.diveClock < LAUNCH_BEAT ? d.launch
          : p.diveHeight === 1 ? d.high : d.low);
    return anims.diveStart + this.diveSide + at;
  }

  // Continuous heading → nearest of the 16 baked compass rows. The EYES pick
  // the row, so a man watching the ball keeps his shoulders open while his
  // legs carry him elsewhere — the feet answer to facing, the sprite to look.
  private headingRow(p: PlayerBody): number {
    const dirs = this.assets.manifest.player.dirs;
    const angle = Math.atan2(p.look.y, p.look.x);
    const bin = Math.round(angle / ((Math.PI * 2) / dirs));
    return ((bin % dirs) + dirs) % dirs;
  }
}
