// When the daemon exits: 5 minutes after it has no connected client, no run and no terminal; after control.shutdownWhenIdle,
// once it has no run, no terminal and no connected client but those that asked; at once on control.shutdownNow (the caller
// ends everything first).
import type { ConnectionPresence } from './connections';
import type { RunRegistry } from './run-registry';

// VS Code's serverLifetimeService.ts waits the same 5 minutes
export const IDLE_EXIT_MS: number = 5 * 60 * 1000;

export interface Lifetime {
  connectionsChanged(connections: readonly ConnectionPresence[]): void;
  // connectionId: the connection that asked, welcomed or refused; its ask holds through its grace and ends when it closes
  shutdownWhenIdle(connectionId: string): void;
  connectionClosed(connectionId: string): void;
  dispose(): void;
}

export function createLifetime(registry: RunRegistry, exit: (reason: string) => void, idleMs: number = IDLE_EXIT_MS): Lifetime {
  let connected: readonly string[] = [];
  // the connections that asked; a client that did not ask uses this daemon as it is, which keeps it
  const asked = new Set<string>();
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
    if (asked.size > 0 && registry.isEmpty() && connected.every((connectionId) => asked.has(connectionId))) {
      end('shutdownWhenIdle, and no run, terminal or other client is left');
      return;
    }
    const idle = connected.length === 0 && registry.isEmpty();
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
    // a connection inside its grace is not connected: it keeps its state, never the daemon
    connectionsChanged: (connections) => {
      connected = connections.filter((connection) => connection.state === 'connected').map((connection) => connection.id);
      evaluate();
    },
    shutdownWhenIdle: (connectionId) => {
      asked.add(connectionId);
      evaluate();
    },
    // a withdrawn ask can only keep the daemon, so nothing is evaluated
    connectionClosed: (connectionId) => {
      asked.delete(connectionId);
    },
    dispose: () => {
      ended = true;
      clearTimeout(timer);
    },
  };
}
