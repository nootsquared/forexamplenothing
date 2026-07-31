// Raw key state; one-shot keys (variant switching etc.) subscribe via onPress
export class Keyboard {
  private down = new Set<string>();
  private pressHandlers = new Map<string, () => void>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressHandlers.get(e.code)?.();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  has(code: string): boolean {
    return this.down.has(code);
  }

  onPress(code: string, handler: () => void) {
    this.pressHandlers.set(code, handler);
  }
}
