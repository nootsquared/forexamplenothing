// Render-side interpolation between fixed sim steps
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
