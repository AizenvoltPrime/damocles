// A process on a relaying client's proxy socket waits, paused, until that client's main connects it over a stream main opens,
// or refuses it; the daemon only asks (docs/invariants.md "Remote connections and credentials").
import type { Socket } from 'node:net';
import type { StreamChannel } from '../../remote/mux';
import { pipeStream, type TunnelPipe } from '../../remote/tunnel-pipe';

// waiting and relayed connections of one client connection at once; another is closed at once
export const MAX_AGENT_CONNECTIONS = 32;

export interface AgentRelayDeps {
  // the agent.request event, on this connection only
  readonly ask: (request: number) => void;
  readonly log: (line: string) => void;
}

export interface AgentRelay {
  /** A process connected to the client's proxy socket: held until connect or refuse names its request. */
  request(incoming: Socket): void;
  /** Pipes the request's connection to stream; false, with the stream ended, when that connection is gone. */
  connect(request: number, stream: StreamChannel): boolean;
  refuse(request: number): void;
  /** Closes every waiting and relayed connection; later requests are closed at once. */
  close(): void;
}

export function createAgentRelay(deps: AgentRelayDeps): AgentRelay {
  let next = 0;
  let closed = false;
  const waiting = new Map<number, Socket>();
  const pipes = new Set<TunnelPipe>();
  const take = (request: number): Socket | undefined => {
    const incoming = waiting.get(request);
    waiting.delete(request);
    return incoming;
  };
  return {
    request: (incoming) => {
      if (closed || waiting.size + pipes.size >= MAX_AGENT_CONNECTIONS) {
        deps.log(closed ? '[agent] closed a connection: its client connection no longer relays' : `[agent] closed a connection: ${MAX_AGENT_CONNECTIONS} are already relayed or waiting`);
        incoming.destroy();
        return;
      }
      const request = ++next;
      incoming.pause();
      waiting.set(request, incoming);
      incoming.once('close', () => {
        if (waiting.get(request) === incoming) waiting.delete(request);
      });
      deps.ask(request);
    },
    connect: (request, stream) => {
      const incoming = take(request);
      if (!incoming || incoming.destroyed) {
        stream.end();
        return false;
      }
      // a Unix socket has no RST: destroy is its reset
      const pipe = pipeStream(incoming, stream, () => pipes.delete(pipe), (socket) => socket.destroy());
      pipes.add(pipe);
      incoming.resume();
      return true;
    },
    refuse: (request) => {
      take(request)?.destroy();
    },
    close: () => {
      closed = true;
      for (const incoming of waiting.values()) incoming.destroy();
      waiting.clear();
      for (const pipe of [...pipes]) pipe.close();
    },
  };
}
