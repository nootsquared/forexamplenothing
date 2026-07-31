// Render-side mood per pitch variant: sprite tint + atmosphere overlay
export interface VariantMood {
  id: string;
  name: string;
  spriteTint: number;   // multiplied onto players/ball/tufts
  overlayColor: number; // fullscreen wash
  overlayAlpha: number;
  shadowAlpha: number;
}

export const MOODS: VariantMood[] = [
  // Even "day" carries a whisper of warm grade so sprites sit in the scene
  { id: 'day', name: 'Lush Day', spriteTint: 0xfdf7ec, overlayColor: 0xffdfae, overlayAlpha: 0.025, shadowAlpha: 0.75 },
  { id: 'dusk', name: 'Golazo Dusk', spriteTint: 0xf5ddc0, overlayColor: 0xd97a2e, overlayAlpha: 0.1, shadowAlpha: 0.85 },
  { id: 'night', name: 'Floodlight Night', spriteTint: 0xc9d6ee, overlayColor: 0x0d1834, overlayAlpha: 0.24, shadowAlpha: 0.55 },
];
