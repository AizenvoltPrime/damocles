// When the daemon exits: 5 minutes after it has no connected client, no run and no terminal; after control.shutdownWhenIdle,
// once it has no run, no terminal and no connected client but those that asked; at once on control.shutdownNow (the caller
// ends everything first). After control.handOver: idle, once it has no chat run, no pending damocles --wait and no connected
// client but those that asked either way; now, at once. After control.handOverIfIdle, decided on the registry as it arrives: as
// now, once its answer went out, when no chat run and no damocles --wait is pending, whoever is connected; else as idle. A
// hand-over never waits for a terminal, which stays with its terminal host.
import type { ConnectionPresence } from './connections';
import type { RunRegistry } from './run-registry';

// VS Code's serverLifetimeService.ts waits the same 5 minutes
export const IDLE_EXIT_MS: number = 5 * 60 * 1000;

export interface Lifetime {
  connectionsChanged(connections: readonly ConnectionPresence[]): void;
  // connectionId: the connection that asked, welcomed or refused; its ask holds through its grace and ends when it closes
  shutdownWhenIdle(connectionId: string): void;
  // idle: an ask as shutdownWhenIdle's, which no terminal holds back; now: exits
  handOver(connectionId: string, when: 'idle' | 'now'): void;
  // now, exiting once `answered` settles, or idle, as handOver's; an exit already under way answers now
  handOverIfIdle(connectionId: string, answered: () => Promise<void>): 'idle' | 'now';
  connectionClosed(connectionId: string): void;
  dispose(): void;
}

// exit's handedOver: a control.handOver ended the daemon, so another version starts in its place; asker: the connection whose
// ask ended it (the one whose ask an idle switch was evaluating, else the earliest still asking), undefined for the idle exit
export function createLifetime(registry: RunRegistry, exit: (reason: string, handedOver: boolean, asker: string | undefined) => void, log: (line: string) => void, idleMs: number = IDLE_EXIT_MS): Lifetime {
  let connected: readonly string[] = [];
  // the connections that asked; a client that did not ask uses this daemon as it is, which keeps it
  const asked = new Set<string>();
  // those of them that asked through handOver; one is enough for the switch to stop waiting for terminals
  const handingOver = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  let disposed = false;
  // what the asked switch waits for, as last logged
  let logged = '';

  const end = (reason: string, handedOver = false, asker?: string): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    exit(reason, handedOver, asker);
  };

  const blockers = (): string => {
    const runs = registry.runs();
    const agents = runs.filter((run) => run.kind === 'chat').length;
    const others = connected.filter((connectionId) => !asked.has(connectionId));
    return `${agents} agent runs, ${handingOver.size > 0 ? `${registry.cliWaits().length} damocles --wait requests, ` : `${runs.length - agents} terminals, `}connected clients that did not ask: ${others.length === 0 ? 'none' : others.join(', ')}`;
  };

  // asker: the connection whose ask this evaluates
  const evaluate = (asker?: string): void => {
    if (ended) return;
    const handOver = handingOver.size > 0;
    if (asked.size > 0 && (handOver ? !registry.hasChatRun() && registry.cliWaits().length === 0 : registry.isEmpty()) && connected.every((connectionId) => asked.has(connectionId))) {
      if (asker !== undefined) log(`[lifetime] ${asker} asks to switch once idle; nothing blocks it`);
      end(handOver ? 'handOver, and no agent run, damocles --wait or other client is left' : 'shutdownWhenIdle, and no run, terminal or other client is left', handOver, asker ?? [...asked][0]);
      return;
    }
    if (asked.size > 0) {
      const waiting = blockers();
      if (asker !== undefined) log(`[lifetime] ${asker} asks to switch once idle; it waits for ${waiting}`);
      else if (waiting !== logged) log(`[lifetime] the switch now waits for ${waiting}`);
      logged = waiting;
    }
    const idle = connected.length === 0 && registry.isEmpty();
    if (!idle) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    timer ??= setTimeout(() => end(`no client, run or terminal for ${idleMs} ms`), idleMs);
  };

  registry.onChange(() => evaluate());
  evaluate();
  return {
    // a connection inside its grace is not connected: it keeps its state, never the daemon
    connectionsChanged: (connections) => {
      connected = connections.filter((connection) => connection.state === 'connected').map((connection) => connection.id);
      evaluate();
    },
    shutdownWhenIdle: (connectionId) => {
      asked.add(connectionId);
      evaluate(connectionId);
    },
    handOver: (connectionId, when) => {
      if (when === 'now') {
        log(`[lifetime] ${connectionId} asks to switch now`);
        end('handOver now', true, connectionId);
        return;
      }
      asked.add(connectionId);
      handingOver.add(connectionId);
      evaluate(connectionId);
    },
    handOverIfIdle: (connectionId, answered) => {
      if (ended) return 'now';
      if (registry.hasChatRun() || registry.cliWaits().length > 0) {
        asked.add(connectionId);
        handingOver.add(connectionId);
        evaluate(connectionId);
        return 'idle';
      }
      log(`[lifetime] ${connectionId} asks to switch now if idle; no agent run or damocles --wait is pending`);
      // no other exit runs while the answer drains
      ended = true;
      clearTimeout(timer);
      void answered().then(() => {
        if (!disposed) exit('handOver now, and no agent run or damocles --wait was pending', true, connectionId);
      });
      return 'now';
    },
    // a withdrawn ask can only keep the daemon, so nothing is evaluated
    connectionClosed: (connectionId) => {
      asked.delete(connectionId);
      handingOver.delete(connectionId);
    },
    dispose: () => {
      ended = true;
      disposed = true;
      clearTimeout(timer);
    },
  };
}
