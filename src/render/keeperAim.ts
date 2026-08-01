import { Container, Graphics } from 'pixi.js';
import { Vec2 } from '../core/math';
import { GameAssets } from './assets';
import { PixelText } from './pixelText';
import { project, pxPerMeter, squash } from './projection';

export interface KeeperAimState {
  gk: Vec2;
  target: Vec2;
  throwR: number;   // inside this: the accurate arm
  puntR: number;    // out to this: the big leg
  scatter: number;  // the honesty zone — this ball lands somewhere in here
  kind: 'throw' | 'punt';
  pCenter: number;  // odds it drops in the inner half of the zone
}

// The keeper's distribution sight: two range rings painted on the turf, a
// reticle wearing its scatter zone, and the odds written underneath — throws
// are surgical, punts are a gamble you can read before you take it.
export class KeeperAim {
  rings = new Graphics();  // ground layer: under the bodies
  top = new Container();   // above play: reticle + numbers
  private reticle = new Graphics();
  private label: PixelText;
  private sub: PixelText;
  private pulse = 0;

  constructor(assets: GameAssets) {
    this.label = new PixelText(assets, 2, 0xfff3c4);
    this.sub = new PixelText(assets, 2, 0xcfdcea);
    this.top.addChild(this.reticle, this.label, this.sub);
    this.hide();
  }

  hide() {
    this.rings.visible = false;
    this.top.visible = false;
  }

  update(dt: number, state: KeeperAimState | null) {
    if (!state) return this.hide();
    this.rings.visible = true;
    this.top.visible = true;
    this.pulse += dt * 6;
    const M = pxPerMeter();
    const sq = squash();

    const g = project(state.gk.x, state.gk.y, 0);
    this.rings.clear();
    this.rings.ellipse(g.sx, g.sy, state.throwR * M, state.throwR * M * sq)
      .stroke({ width: 1.4, color: 0x9ff0b8, alpha: 0.6 });
    this.rings.ellipse(g.sx, g.sy, state.puntR * M, state.puntR * M * sq)
      .stroke({ width: 1.4, color: 0xffd95e, alpha: 0.45 });

    const accent = state.kind === 'punt' ? 0xffd95e : 0x9ff0b8;
    const t = project(state.target.x, state.target.y, 0);
    this.reticle.clear();
    this.reticle.ellipse(t.sx, t.sy, state.scatter * M, state.scatter * M * sq)
      .fill({ color: accent, alpha: 0.12 })
      .stroke({ width: 1.2, color: accent, alpha: 0.75 });
    // crosshair ticks breathing on the spot itself
    const r = 4 + Math.sin(this.pulse) * 1.2;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      this.reticle.moveTo(t.sx + dx * r, t.sy + dy * r * sq)
        .lineTo(t.sx + dx * (r + 4), t.sy + dy * (r + 4) * sq)
        .stroke({ width: 1.4, color: 0xffffff, alpha: 0.9 });
    }

    const pc = Math.round(state.pCenter * 100);
    this.label.text = `${state.kind} - ${pc}% CENTER`;
    this.sub.text = `${100 - pc}% WIDE`;
    const below = t.sy + state.scatter * M * sq + 8;
    this.label.centerAt(t.sx, below);
    this.sub.centerAt(t.sx, below + 14);
  }
}
