import { log } from '../../../core/logger';
import type { Disposable } from '../../../platform/disposable';

/** Listeners called in the order they were added; one that throws is logged and the rest still run, as with VS Code's Emitter. */
export class Listeners<A extends unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>();
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
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
        log(`[core-host] a ${this.name} listener threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
