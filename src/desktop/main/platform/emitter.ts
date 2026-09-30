import type { Disposable } from '../../../platform/disposable';

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

/** Listeners called in the order they were added; one that throws is logged and the rest still run, as with VS Code's Emitter. */
export class Emitter<A extends unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>();
  private readonly name: string;
  private readonly log: (line: string) => void;

  constructor(name: string, log: (line: string) => void) {
    this.name = name;
    this.log = log;
  }

  add(listener: (...args: A) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  fire(...args: A): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(...args);
      } catch (err) {
        this.log(`[${this.name}] a listener threw: ${errorText(err)}`);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
