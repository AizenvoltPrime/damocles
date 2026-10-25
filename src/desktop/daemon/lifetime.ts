// When the daemon exits: 5 minutes after it has no client, no run and no terminal; once
// idle after control.shutdownWhenIdle; at once on control.shutdownNow (the caller ends everything first).
import type { RunRegistry } from './run-registry';

// VS Code's serverLifetimeService.ts waits the same 5 minutes
export const IDLE_EXIT_MS: number = 5 * 60 * 1000;

export interface Lifetime {
  clientsChanged(count: number): void;
  shutdownWhenIdle(): void;
  dispose(): void;
}

export function createLifetime(registry: RunRegistry, exit: (reason: string) => void, idleMs: number = IDLE_EXIT_MS): Lifetime {
  let clients = 0;
  let whenIdle = false;
  let timer: NodeJS.Timeout | undefined;
  let ended = false;

  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    exit(reason);
  };

  const evaluate = (): void => {
    if (ended) return;
    if (whenIdle && registry.isEmpty()) {
      end('shutdownWhenIdle, and no run or terminal is left');
      return;
    }
    const idle = clients === 0 && registry.isEmpty();
    if (!idle) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    timer ??= setTimeout(() => end(`no client, run or terminal for ${idleMs} ms`), idleMs);
  };

  registry.onChange(evaluate);
  evaluate();
  return {
    clientsChanged: (count) => {
      clients = count;
      evaluate();
    },
    shutdownWhenIdle: () => {
      whenIdle = true;
      evaluate();
    },
    dispose: () => {
      ended = true;
      clearTimeout(timer);
    },
  };
}
