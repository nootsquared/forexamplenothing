import { Container } from 'pixi.js';
import { Vec2, vec, add, clampLen, scale, expDecay, clamp, dist } from '../core/math';
import { PITCH } from '../sim/constants';
import { project, pxPerMeter, squash } from './projection';

// THE CAMERA LAW: nothing beyond the baked art is ever on screen. The art's
// ceiling is the grandstand's crown — pitchLayer.buildArena pins the stand
// tile's foot on the y=-2.1 row and hangs its whole height above it, so the
// top edge lands one tile higher on the ground plane (-9.71m at the shipped
// 16px/m, 0.788 squash). Everything under it is baked pitch, -apron..+apron.
const STAND_FOOT_Y = -2.1;
const STAND_TILE_H = 96; // manifest.stand.h, drawn unscaled in screen px
// The follow camera keeps a metre of art in hand so a goal can rattle the
// frame. A DIRECTED shot (the tutorial's field tour, a keeper's sight line)
// is locked off and asks for none — it may sit flush against the world's edge.
const SHAKE_ROOM = 1;
// How wide the game breathes. The ceiling is a scramble in a six-yard box; the
// floor is the shape of a phase of play — an 11v11 framed at 3.0 shows six men
// and a lot of grass, which is no way to sell a per-player AI.
const ZOOM_CEIL = 3.0;
const ZOOM_FLOOR = 1.75;
const HERO_EASE = 9; // rad-ish/s the frame walks between bodies — ~0.3s to settle
const LEASH_MARGIN = 5; // metres of air between any held man and the frame edge
// Winding up is looking up: a full charge eases the lens out this fraction —
// the tap pass stays tight, the 40-yard diagonal costs a visible beat
const CHARGE_BREATH = 0.12;
// Facing forward shows forward: metres the frame leans toward where the man
// you hold is pointed — head-up posture literally buys sight
const FACE_LEAD = 2.6;

// What the frame answers to beyond the ball: the man you hold, where he is
// looking, every other body a couch seat is wearing, and the charge in his boot
export interface CameraFocus {
  hero?: Vec2 | null;
  face?: Vec2 | null;
  couch?: Vec2[];
  charge?: number;
}

// The drawn world's edges in ground meters, pulled in by whatever room the
// shot wants to keep spare
function fence(pad: number) {
  return {
    x0: -PITCH.apron + pad,
    x1: PITCH.length + PITCH.apron - pad,
    y0: STAND_FOOT_Y - STAND_TILE_H / (pxPerMeter() * squash()) + pad,
    y1: PITCH.width + PITCH.apron - pad,
  };
}

// The zoom floor: cover-fit of the fence — any wider and the void leaks in
function coverFitZoom(viewW: number, viewH: number, pad: number): number {
  const f = fence(pad);
  return Math.max(viewW / ((f.x1 - f.x0) * pxPerMeter()), viewH / ((f.y1 - f.y0) * pxPerMeter() * squash()));
}

// One shared broadcast camera: leads the ball, keeps the man you are holding
// inside the frame, and widens to the shape of the phase — nobody plays
// off-screen, least of all you.
export class FollowCamera {
  center: Vec2 = vec(PITCH.length / 2, PITCH.width / 2);
  zoom = 3.0;
  // The lens density: how tight live football is framed. 1 is broadcast;
  // above it the same action fills more of the screen (V cycles it in-match).
  // CLOSE by default — the verdict from the couch was that broadcast reads empty.
  density = 1.16;
  // A distribution beat pulls the view wide onto a chosen spot (keeper aiming)
  override: { center: Vec2; zoom: number } | null = null;
  private targetZoom = 3.0;

  // The law itself: floor the zoom, then box the center so the viewport never
  // leaves the world — EVERY path funnels through here, overrides included
  private clampView(center: Vec2, zoom: number, viewW: number, viewH: number, pad: number): number {
    const f = fence(pad);
    const z = Math.max(zoom, coverFitZoom(viewW, viewH, pad));
    const halfW = viewW / 2 / z / pxPerMeter();
    const halfH = viewH / 2 / z / (pxPerMeter() * squash());
    center.x = clamp(center.x, f.x0 + halfW, f.x1 - halfW);
    center.y = clamp(center.y, f.y0 + halfH, f.y1 - halfH);
    return z;
  }

  // The establishing shot: the whole FIELD in frame — touchline to touchline,
  // both goal lines, the stands left as backdrop above. Floored by the law
  // when the window is too odd to hold the pitch whole
  fitFieldZoom(viewW: number, viewH: number): number {
    const fit = Math.min(viewW / (PITCH.length * pxPerMeter()), viewH / (PITCH.width * pxPerMeter() * squash()));
    return Math.max(fit, coverFitZoom(viewW, viewH, 0));
  }

  // The man you hold, as the frame follows him: a switch hands you the new
  // body instantly, but the lens WALKS to him. Leashing straight to a body
  // that teleported across the pitch is the jerk you feel on every E.
  private heroAnchor: Vec2 | null = null;
  private easedHero(hero: Vec2 | null, dt: number): Vec2 | null {
    if (!hero) { this.heroAnchor = null; return null; }
    if (!this.heroAnchor) this.heroAnchor = vec(hero.x, hero.y);
    else {
      this.heroAnchor.x = expDecay(this.heroAnchor.x, hero.x, HERO_EASE, dt);
      this.heroAnchor.y = expDecay(this.heroAnchor.y, hero.y, HERO_EASE, dt);
    }
    return this.heroAnchor;
  }

  update(dt: number, ballPos: Vec2, ballVel: Vec2, players: Vec2[], viewW: number, viewH: number, focus: CameraFocus = {}) {
    const hero = this.easedHero(focus.hero ?? null, dt);
    if (this.override) {
      this.center.x = expDecay(this.center.x, this.override.center.x, 4, dt);
      this.center.y = expDecay(this.center.y, this.override.center.y, 4, dt);
      this.zoom = expDecay(this.zoom, this.override.zoom, 4, dt);
      this.zoom = this.clampView(this.center, this.zoom, viewW, viewH, 0); // the law outranks any director
      return;
    }
    const lookAhead = clampLen(scale(ballVel, 0.4), 7);
    const aim = add(ballPos, lookAhead);
    const couch = focus.couch ?? [];

    // Frame = ball, YOUR man, EVERY man a couch seat is wearing, and everyone
    // near the action. The held bodies are not negotiable: a chevron half-
    // clipped by the left edge is the frame lying about who somebody is.
    let minX = ballPos.x, maxX = ballPos.x, minY = ballPos.y, maxY = ballPos.y;
    const stretch = (p: Vec2) => {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    };
    if (hero) stretch(hero);
    for (const p of couch) stretch(p);
    for (const p of players) {
      if (dist(p, ballPos) > 26) continue; // stragglers don't drag the frame
      stretch(p);
    }
    // Facing forward shows forward: the frame leans a few metres toward where
    // the held man is pointed, so looking up the pitch buys sight up the pitch
    const lean = focus.face ? scale(focus.face, FACE_LEAD) : vec();
    const target = add(add(scale(aim, 0.6), scale(vec((minX + maxX) / 2, (minY + maxY) / 2), 0.4)), lean);
    this.center.x = expDecay(this.center.x, target.x, 3.2, dt);
    this.center.y = expDecay(this.center.y, target.y, 3.2, dt);

    // Zoom out only as far as the action demands, breathe with ball pace
    const M = pxPerMeter();
    const spanX = (maxX - minX) / 2 + 8;
    const spanY = (maxY - minY) / 2 + 6;
    const fit = Math.min(viewW / (2 * spanX * M), viewH / (2 * spanY * M * squash()));
    const pace = Math.hypot(ballVel.x, ballVel.y) > 15 ? 2.75 : ZOOM_CEIL;
    this.targetZoom = clamp(Math.min(pace, fit) * this.density, ZOOM_FLOOR, ZOOM_CEIL * this.density);
    // Winding up is looking up: the charge eases the head up over the ball
    this.targetZoom *= 1 - CHARGE_BREATH * clamp(focus.charge ?? 0, 0, 1);
    // The couch leash floor: the tight lens is a ceiling, never a promise —
    // the lens breathes out exactly as far as the most spread human and no
    // further. Nobody at the party plays blind.
    if (couch.length > 1) {
      let cMinX = couch[0].x, cMaxX = couch[0].x, cMinY = couch[0].y, cMaxY = couch[0].y;
      for (const p of couch) {
        cMinX = Math.min(cMinX, p.x); cMaxX = Math.max(cMaxX, p.x);
        cMinY = Math.min(cMinY, p.y); cMaxY = Math.max(cMaxY, p.y);
      }
      const needX = (cMaxX - cMinX) / 2 + LEASH_MARGIN;
      const needY = (cMaxY - cMinY) / 2 + LEASH_MARGIN;
      const couchFit = Math.min(viewW / (2 * needX * M), viewH / (2 * needY * M * squash()));
      this.targetZoom = Math.min(this.targetZoom, couchFit);
    }
    this.zoom = expDecay(this.zoom, this.targetZoom, 1.8, dt);

    this.zoom = this.clampView(this.center, this.zoom, viewW, viewH, SHAKE_ROOM);
    if (hero) this.leashTo(hero, viewW, viewH, SHAKE_ROOM);
    for (const p of couch) this.leashTo(p, viewW, viewH, SHAKE_ROOM);
  }

  // The last word on framing: if the smooth follow has let a held man past the
  // safe box, the frame is dragged back by exactly the difference — then the
  // law re-boxes it, because the world's edge outranks even this.
  private leashTo(hero: Vec2, viewW: number, viewH: number, pad: number) {
    const halfW = Math.max(0, viewW / 2 / this.zoom / pxPerMeter() - LEASH_MARGIN);
    const halfH = Math.max(0, viewH / 2 / this.zoom / (pxPerMeter() * squash()) - LEASH_MARGIN);
    this.center.x = clamp(this.center.x, hero.x - halfW, hero.x + halfW);
    this.center.y = clamp(this.center.y, hero.y - halfH, hero.y + halfH);
    this.zoom = this.clampView(this.center, this.zoom, viewW, viewH, pad);
  }

  // Shake spends the art that is ACTUALLY left beyond the frame and not a
  // pixel more: a goal at the byline still rattles, and a locked-off shot
  // sitting flush against the world's edge simply doesn't move.
  applyTo(world: Container, viewW: number, viewH: number, shakeX: number, shakeY: number) {
    const p = project(this.center.x, this.center.y, 0);
    const f = fence(0);
    const M = pxPerMeter();
    const halfW = viewW / 2 / this.zoom / M;
    const halfH = viewH / 2 / this.zoom / (M * squash());
    const roomX = Math.max(0, Math.min(SHAKE_ROOM, this.center.x - f.x0 - halfW, f.x1 - halfW - this.center.x));
    const roomY = Math.max(0, Math.min(SHAKE_ROOM, this.center.y - f.y0 - halfH, f.y1 - halfH - this.center.y));
    world.scale.set(this.zoom);
    world.pivot.set(p.sx, p.sy);
    world.position.set(
      viewW / 2 + clamp(shakeX, -roomX * M * this.zoom, roomX * M * this.zoom),
      viewH / 2 + clamp(shakeY, -roomY * M * squash() * this.zoom, roomY * M * squash() * this.zoom),
    );
  }
}
