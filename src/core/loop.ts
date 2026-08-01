// Fixed-timestep simulation with interpolated rendering and hitstop support
export class GameLoop {
  timeScale = 1;
  fpsCap: number | null = null; // frames wait for the cap window; the sim catches up
  private acc = 0;
  private last = 0;
  private raf = 0;
  private hitstopUntil = 0;

  constructor(
    private fixedDt: number,
    private update: (dt: number) => void,
    private render: (alpha: number, renderDt: number) => void,
  ) {}

  start() {
    this.last = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      if (this.fpsCap && now - this.last < 1000 / this.fpsCap - 0.5) return;
      if (now >= this.hitstopUntil && this.timeScale !== 1) this.timeScale = 1;
      const renderDt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += renderDt * this.timeScale;
      let steps = 0;
      while (this.acc >= this.fixedDt && steps < 5) {
        this.update(this.fixedDt);
        this.acc -= this.fixedDt;
        steps++;
      }
      this.render(this.acc / this.fixedDt, renderDt);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  // Brief slow-motion punch on big hits — pure arcade feel
  hitstop(ms: number, scale = 0.12) {
    this.timeScale = scale;
    this.hitstopUntil = performance.now() + ms;
  }
}
