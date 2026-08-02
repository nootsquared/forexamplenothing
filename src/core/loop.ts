// Fixed-timestep simulation with interpolated rendering and hitstop support
export class GameLoop {
  timeScale = 1;
  fpsCap: number | null = null; // frames wait for the cap window; the sim catches up
  private acc = 0;
  private last = 0;
  private raf = 0;
  private hitstopUntil = 0;
  private worker: Worker | null = null;

  constructor(
    private fixedDt: number,
    private update: (dt: number) => void,
    private render: (alpha: number, renderDt: number) => void,
  ) {}

  // Advance the clock and run due sim steps; rendering is the caller's call
  private pump(now: number): number {
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
    // Debt the step cap couldn't repay is FORGIVEN, not hoarded: a machine
    // that can't hold 60Hz runs slightly slow instead of drifting ever
    // further behind real time (online, that drift reads as growing lag)
    this.acc = Math.min(this.acc, this.fixedDt);
    return renderDt;
  }

  start() {
    this.last = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      if (this.fpsCap && now - this.last < 1000 / this.fpsCap - 0.5) return;
      const renderDt = this.pump(now);
      this.render(this.acc / this.fixedDt, renderDt);
    };
    this.raf = requestAnimationFrame(frame);
    // A hidden tab must NOT pause the world: an online HOST is the match
    // itself, and rAF stops cold in background tabs. Worker timers keep
    // firing, so the sim ticks on (render skipped) until the tab returns.
    const src = 'setInterval(() => postMessage(0), 33)';
    this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    this.worker.onmessage = () => {
      if (document.hidden) this.pump(performance.now());
    };
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.worker = null;
  }

  // Brief slow-motion punch on big hits — pure arcade feel
  hitstop(ms: number, scale = 0.12) {
    this.timeScale = scale;
    this.hitstopUntil = performance.now() + ms;
  }
}
