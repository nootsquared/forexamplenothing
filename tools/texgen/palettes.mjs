// Every color in the game lives here — variants recolor the world, kits recolor players.
// The whole set is deliberately muted broadcast-natural: warm chalk instead of pure
// white, earthy greens instead of neon — cohesion over vibrance.

export const PX_PER_METER = 16;

// One high-angle isometric camera for the whole game, shared by the texture
// bake, the sprite raytracer and the renderer. Elevation ~52°: high enough to
// read omnidirectional movement and the tops of heads, low enough that goals,
// bounces and bodies still have height.
export const ISO_ELEVATION = (52 * Math.PI) / 180;
export const ISO = {
  squash: Math.sin(ISO_ELEVATION), // ground rows compress by this
  zLift: Math.cos(ISO_ELEVATION),  // height climbs the screen by this
};

export const VARIANTS = [
  {
    id: 'day',
    name: 'Lush Day',
    grassA: '#4c8740',
    grassB: '#61a04f',
    apron: '#3d6a32',
    line: '#efe9d8',
    lineAlpha: 0.85,
    worn: '#93854e',
    mow: 'rings', // bold concentric mow rings — the showpiece cut
  },
  {
    id: 'dusk',
    name: 'Golazo Dusk',
    grassA: '#6d8444',
    grassB: '#7b934e',
    apron: '#566c36',
    line: '#e8dfc4',
    lineAlpha: 0.82,
    worn: '#93804a',
    mow: 'stripes',
  },
  {
    id: 'night',
    name: 'Floodlight Night',
    grassA: '#2c6340',
    grassB: '#377252',
    apron: '#234c31',
    line: '#e9edef',
    lineAlpha: 0.9,
    worn: '#5d6b44',
    mow: 'checker',
  },
];

export const KITS = [
  {
    id: 'home',
    shirt: '#c4432f',
    shirtTrim: '#efe0d0',
    shorts: '#e7e0d0',
    socks: '#c4432f',
    skin: '#97673f',
    hair: '#241c17',
  },
  {
    id: 'away',
    shirt: '#3458a8',
    shirtTrim: '#d3ddec',
    shorts: '#1a2947',
    socks: '#3458a8',
    skin: '#d3a87e',
    hair: '#a8894a',
  },
];
