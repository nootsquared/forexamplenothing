// Every color in the game lives here — variants recolor the world, kits recolor players.
// The whole set is deliberately muted broadcast-natural: warm chalk instead of pure
// white, earthy greens instead of neon — cohesion over vibrance.

export const PX_PER_METER = 16;

export const VARIANTS = [
  {
    id: 'day',
    name: 'Lush Day',
    grassA: '#4f8a40',
    grassB: '#578f46',
    apron: '#3d6a32',
    line: '#efe9d8',
    lineAlpha: 0.85,
    worn: '#93854e',
    mow: 'checker',
  },
  {
    id: 'dusk',
    name: 'Golazo Dusk',
    grassA: '#6d8444',
    grassB: '#758c4a',
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
    grassB: '#326a4a',
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
