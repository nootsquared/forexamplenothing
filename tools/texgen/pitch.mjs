import { makeCanvas, mulberry32, shade, hash2, vnoise } from './lib.mjs';
import { PX_PER_METER, ISO } from './palettes.mjs';

export const PITCH = { length: 114, width: 74, apron: 6 };
const M = PX_PER_METER;

// Full pitch + apron: mowing, then a per-pixel blade pass that turns flat paint
// into turf, scars of play, chalk lines, grown-over fringes, baked lighting
export function generatePitchTexture(variant) {
  const w = (PITCH.length + PITCH.apron * 2) * M;
  const h = (PITCH.width + PITCH.apron * 2) * M;
  const { canvas, ctx } = makeCanvas(w, h);
  const rng = mulberry32(1337);
  const ox = PITCH.apron * M;
  const oy = PITCH.apron * M;

  ctx.fillStyle = variant.apron;
  ctx.fillRect(0, 0, w, h);

  paintMowing(ctx, variant, ox, oy);
  paintBlades(ctx, w, h);
  paintWalkway(ctx, rng, w, oy);
  paintDirtScrapes(ctx, rng, ox, oy);
  paintWear(ctx, rng, variant, ox, oy);
  paintLines(ctx, variant, ox, oy);
  paintFringe(ctx, rng, variant, ox, oy);
  paintLighting(ctx, variant, w, h);

  return squashRows(canvas);
}

// Bake the iso camera into the texture: art is painted top-down in meters,
// then rows compress uniformly by the shared squash — a parallel-projection
// ground plane that matches every raytraced sprite standing on it
function squashRows(src) {
  const w0 = src.width;
  const h0 = src.height;
  const outH = Math.round(h0 * ISO.squash);
  const { canvas, ctx } = makeCanvas(w0, outH);
  ctx.imageSmoothingEnabled = false;
  for (let Y = 0; Y < outH; Y++) {
    const srcY = Math.min(h0 - 1, Math.floor((Y + 0.5) / ISO.squash));
    ctx.drawImage(src, 0, srcY, w0, 1, 0, Y, w0, 1);
  }
  return canvas;
}

function paintMowing(ctx, variant, ox, oy) {
  const pw = PITCH.length * M;
  const ph = PITCH.width * M;
  if (variant.mow === 'checker') {
    const cell = 8.75 * M;
    for (let cy = 0; cy * cell < ph; cy++) {
      for (let cx = 0; cx * cell < pw; cx++) {
        // Every mow cell cut a hair differently — no two panels identical
        const base = (cx + cy) % 2 === 0 ? variant.grassA : variant.grassB;
        ctx.fillStyle = shade(base, 0.985 + hash2(cx, cy) * 0.03);
        ctx.fillRect(ox + cx * cell, oy + cy * cell, Math.min(cell, pw - cx * cell), Math.min(cell, ph - cy * cell));
      }
    }
  } else if (variant.mow === 'rings') {
    // Concentric mow rings spreading from the center spot — the showpiece cut
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, pw, ph);
    ctx.clip();
    const band = 5.5 * M;
    const maxR = Math.hypot(pw / 2, ph / 2) + band;
    for (let r = maxR, i = Math.round(maxR / band); r > 0; r -= band, i--) {
      const base = i % 2 === 0 ? variant.grassA : variant.grassB;
      ctx.fillStyle = shade(base, 0.985 + hash2(i, 55) * 0.03);
      ctx.beginPath();
      ctx.arc(ox + pw / 2, oy + ph / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else {
    const band = 5.25 * M;
    for (let bx = 0; bx * band < pw; bx++) {
      const base = bx % 2 === 0 ? variant.grassA : variant.grassB;
      ctx.fillStyle = shade(base, 0.985 + hash2(bx, 77) * 0.03);
      ctx.fillRect(ox + bx * band, oy, Math.min(band, pw - bx * band), ph);
    }
  }
  // Apron mowing continues faint so the world doesn't stop at the touchline
  ctx.globalAlpha = 0.35;
  const band = 8.75 * M;
  for (let bx = 0; bx * band < ox * 2 + PITCH.length * M; bx++) {
    ctx.fillStyle = bx % 2 === 0 ? shade(variant.apron, 1.08) : variant.apron;
    ctx.fillRect(bx * band, 0, band, oy);
    ctx.fillRect(bx * band, oy + PITCH.width * M, band, oy);
  }
  ctx.globalAlpha = 1;
}

// The heart of the field: every pixel column is a stack of short blades, each
// with its own tone and a sunlit tip, modulated by clump patches, dry spots and
// dark soil gaps — grass as a material, not a color
function paintBlades(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let x = 0; x < w; x++) {
    const colJitter = hash2(x, 9999) * 8;
    const segLen = 3 + Math.floor(hash2(x, 7777) * 2); // blades 3-4px tall
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      const seg = Math.floor((y + colJitter) / segLen);
      const blade = 0.88 + hash2(x, seg) * 0.24;                  // per-blade value
      const tip = (y + colJitter) % segLen < 1 ? 1.09 : 1;        // lit blade tip
      const clump = 0.93 + vnoise(x, y, 13) * 0.13;               // ~0.8m clumps
      const patch = 0.94 + vnoise(x + 311, y + 149, 57) * 0.12;   // broad unevenness
      const soil = hash2(x * 7, y * 13) < 0.015 ? 0.62 : 1;       // gaps to the dirt
      const f = blade * tip * clump * patch * soil;
      const dry = Math.max(0, vnoise(x + 431, y + 917, 89) - 0.74) * 1.6; // sun-bleached spots
      d[i] = Math.min(255, d[i] * f * (1 + dry * 0.55));
      d[i + 1] = Math.min(255, d[i + 1] * f * (1 + dry * 0.18));
      d[i + 2] = Math.min(255, d[i + 2] * f * (1 - dry * 0.28));
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Trodden dirt walkway in front of the ad boards — groundskeepers, subs and
// photographers wear the grass down to earth along the far side
function paintWalkway(ctx, rng, w, oy) {
  const tones = ['#a08a58', '#96814f', '#8b7748'];
  const y0 = oy - 2.1 * M;
  const y1 = oy - 0.9 * M;
  for (let x = 0; x < w; x += 2) {
    for (let y = y0; y < y1; y += 2) {
      if (rng() < 0.9) {
        ctx.fillStyle = tones[Math.floor(rng() * 3)];
        ctx.globalAlpha = 0.55 + rng() * 0.4;
        const ragged = rng() < 0.14 ? (rng() < 0.5 ? -2 : 2) : 0; // chewed edges
        ctx.fillRect(x, y + ragged, 2, 2);
      }
    }
  }
  ctx.globalAlpha = 1;
}

// Little scars of play: skid scrapes scattered where boots actually tear grass
function paintDirtScrapes(ctx, rng, ox, oy) {
  const spots = [];
  for (let i = 0; i < 26; i++) {
    const roll = rng();
    let x, y;
    if (roll < 0.35) { // central corridor
      x = ox + (20 + rng() * 65) * M;
      y = oy + (PITCH.width / 2 - 12 + rng() * 24) * M;
    } else if (roll < 0.65) { // goal approaches
      x = ox + (rng() < 0.5 ? rng() * 22 : PITCH.length - 22 + rng() * 22) * M;
      y = oy + (PITCH.width / 2 - 10 + rng() * 20) * M;
    } else { // anywhere, touchline hustle included
      x = ox + rng() * PITCH.length * M;
      y = oy + rng() * PITCH.width * M;
    }
    spots.push({ x, y });
  }
  for (const s of spots) {
    const ang = rng() * Math.PI;
    const steps = 5 + Math.floor(rng() * 12);
    const tone = rng() < 0.5 ? '#9a8a52' : '#8a7a46';
    for (let j = 0; j < steps; j++) {
      ctx.fillStyle = tone;
      ctx.globalAlpha = 0.14 + rng() * 0.16;
      ctx.fillRect(
        s.x + Math.cos(ang) * j * 2 + (rng() - 0.5) * 3,
        s.y + Math.sin(ang) * j * 1.2 + (rng() - 0.5) * 3,
        2, 2,
      );
    }
  }
  ctx.globalAlpha = 1;
}

function paintWear(ctx, rng, variant, ox, oy) {
  const cy = PITCH.width / 2;
  const spots = [
    { x: PITCH.length / 2, y: cy, r: 6.5, a: 0.1 },
    { x: 11, y: cy, r: 4.5, a: 0.13 },
    { x: PITCH.length - 11, y: cy, r: 4.5, a: 0.13 },
    { x: 2.2, y: cy, r: 5.5, a: 0.16 },
    { x: PITCH.length - 2.2, y: cy, r: 5.5, a: 0.16 },
  ];
  for (const s of spots) {
    const cx = ox + s.x * M;
    const cy = oy + s.y * M;
    const r = s.r * M;
    for (let i = 0; i < r * r * 0.55; i++) {
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * r;
      ctx.fillStyle = variant.worn;
      ctx.globalAlpha = s.a * (1 - dist / r) * (0.4 + rng() * 0.6);
      ctx.fillRect(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist * 0.7, 2, 2);
    }
  }
  ctx.globalAlpha = 1;
}

// Chalk is SPRAYED, not vector-drawn: chunky 2px blocks stepped along each
// line with paint breakup, a little drift, and overspray specks — the lines
// sit in the same pixel grid as the turf instead of floating above it
function paintLines(ctx, variant, ox, oy) {
  const L = PITCH.length * M;
  const W = PITCH.width * M;
  const lw = 3; // bold chalk — survives the perspective compression at distance
  const rng = mulberry32(4242);
  ctx.fillStyle = variant.line;

  const dot = (x, y) => {
    if (rng() < 0.05) return; // the sprayer skipped a patch
    const jx = rng() < 0.12 ? (rng() < 0.5 ? -1 : 1) : 0;
    const jy = rng() < 0.12 ? (rng() < 0.5 ? -1 : 1) : 0;
    ctx.globalAlpha = variant.lineAlpha * (0.75 + rng() * 0.25);
    ctx.fillRect(Math.round(x - lw / 2 + jx), Math.round(y - lw / 2 + jy), lw, lw);
    if (rng() < 0.16) { // overspray speck drifting off the line
      ctx.globalAlpha = variant.lineAlpha * 0.22;
      ctx.fillRect(Math.round(x + (rng() - 0.5) * 7), Math.round(y + (rng() - 0.5) * 7), 1, 1);
    }
  };
  const line = (x1, y1, x2, y2) => {
    const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (lw * 0.85));
    for (let i = 0; i <= n; i++) dot(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n);
  };
  const arc = (cx, cy, r, a0, a1) => {
    const n = Math.ceil((r * (a1 - a0)) / (lw * 0.8));
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  const spot = (x, y) => {
    ctx.globalAlpha = variant.lineAlpha;
    ctx.fillRect(Math.round(x - 1), Math.round(y - 1), 3, 3);
  };

  line(ox, oy, ox + L, oy);
  line(ox, oy + W, ox + L, oy + W);
  line(ox, oy, ox, oy + W);
  line(ox + L, oy, ox + L, oy + W);
  line(ox + L / 2, oy, ox + L / 2, oy + W);

  const cy = oy + W / 2;
  arc(ox + L / 2, cy, 9.15 * M, 0, Math.PI * 2);
  spot(ox + L / 2, cy);

  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;
    const gx = side === 0 ? ox : ox + L;
    for (const [bw, bh] of [[16.5, 20.16], [5.5, 9.16]]) {
      line(gx, cy - bh * M, gx + dir * bw * M, cy - bh * M);
      line(gx, cy + bh * M, gx + dir * bw * M, cy + bh * M);
      line(gx + dir * bw * M, cy - bh * M, gx + dir * bw * M, cy + bh * M);
    }
    spot(gx + dir * 11 * M, cy);
    const spread = Math.acos(5.5 / 9.15);
    const base = side === 0 ? 0 : Math.PI;
    arc(gx + dir * 11 * M, cy, 9.15 * M, base - spread, base + spread);
  }

  arc(ox, oy, 1 * M, 0, Math.PI / 2);
  arc(ox + L, oy, 1 * M, Math.PI / 2, Math.PI);
  arc(ox + L, oy + W, 1 * M, Math.PI, Math.PI * 1.5);
  arc(ox, oy + W, 1 * M, Math.PI * 1.5, Math.PI * 2);
  ctx.globalAlpha = 1;
}

// Blades overhang every boundary and the apron grows wild — the bounds look
// grown-in, not vector-drawn
function paintFringe(ctx, rng, variant, ox, oy) {
  const L = PITCH.length * M;
  const W = PITCH.width * M;
  const dark = shade(variant.grassA, 0.55);
  const mid = shade(variant.grassA, 0.78);
  const lit = shade(variant.grassB, 1.35);
  const blade = (x, y) => {
    const tall = 2 + Math.floor(rng() * 4);
    ctx.fillStyle = rng() < 0.3 ? mid : dark;
    ctx.fillRect(x, y - tall, 1, tall);
    ctx.fillStyle = lit;
    ctx.fillRect(x, y - tall, 1, 1);
  };
  for (let x = ox - 4; x < ox + L + 4; x += 2 + rng() * 4) {
    if (rng() < 0.75) blade(x, oy + 1 + rng() * 3);
    if (rng() < 0.75) blade(x, oy + W + 2 + rng() * 3);
  }
  // Goal-line fringe sits just outside the chalk so the line stays readable
  for (let y = oy - 4; y < oy + W + 4; y += 2 + rng() * 4) {
    if (rng() < 0.75) blade(ox - 4 + rng() * 3.2, y);
    if (rng() < 0.75) blade(ox + L + 1 + rng() * 3.2, y);
  }
  for (let i = 0; i < 2600; i++) {
    const x = rng() * (ox * 2 + L);
    const y = rng() * (oy * 2 + W);
    const onPitch = x > ox && x < ox + L && y > oy && y < oy + W;
    if (!onPitch) blade(x, y + 2);
  }
}

// Baked light with a real SUN, not universal brightness: day rakes warm from
// the top-left with a soft hot patch and cool shade creeping into the far
// corner; dusk is a low western sun; night is floodlight pools on dark turf.
// Applied last so the chalk lines catch it too.
function paintLighting(ctx, variant, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const floods = [
    { x: 12 * M, y: 6 * M }, { x: (PITCH.length + PITCH.apron) * M, y: 6 * M },
    { x: 12 * M, y: (PITCH.width + PITCH.apron) * M }, { x: (PITCH.length + PITCH.apron) * M, y: (PITCH.width + PITCH.apron) * M },
  ];
  const floodR = 30 * M;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = x / w;
      const ny = y / h;
      const edge = Math.max(Math.abs(nx - 0.5), Math.abs(ny - 0.5)) * 2;
      const vignette = 1 - Math.max(0, edge - 0.62) * 0.28;
      let r = 1, g = 1, b = 1;
      if (variant.id === 'day') {
        const sunAxis = nx * 0.62 + ny * 0.38; // 0 at the sunlit corner, 1 in the shade
        const hot = Math.exp(-(((nx - 0.26) ** 2) + ((ny - 0.3) ** 2) * 1.8) / 0.055) * 0.055;
        const f = (1.12 - 0.22 * sunAxis + hot) * vignette;
        const warmth = 1 - sunAxis; // sunlit grass runs warm, shaded grass runs cool
        r = f * (1 + 0.025 * warmth);
        g = f;
        b = f * (1 - 0.035 * warmth + 0.02 * sunAxis);
      } else if (variant.id === 'dusk') {
        const sunAxis = nx * 0.75 + ny * 0.25; // low sun from the west end
        const f = (1.16 - 0.3 * sunAxis) * vignette;
        r = f * 1.08; g = f * 0.97; b = f * 0.84;
      } else {
        let pool = 0;
        for (const fl of floods) {
          const dx = x - fl.x;
          const dy = y - fl.y;
          pool += Math.exp(-(dx * dx + dy * dy) / (floodR * floodR));
        }
        const f = (0.74 + Math.min(0.55, pool * 0.62)) * vignette;
        r = f * 0.96; g = f; b = f * 1.07;
      }
      d[i] = Math.min(255, d[i] * r);
      d[i + 1] = Math.min(255, d[i + 1] * g);
      d[i + 2] = Math.min(255, d[i + 2] * b);
    }
  }
  ctx.putImageData(img, 0, 0);
}
