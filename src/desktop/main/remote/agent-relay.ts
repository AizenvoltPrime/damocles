// A container's daemon only asks (agent.request); main alone decides to connect this computer's SSH agent, and the bytes
// cross unread (docs/invariants.md "Remote connections and credentials").
import type * as net from 'node:net';
import type { StreamChannel } from '../../../remote/mux';
import { pipeStream, type TunnelPipe } from '../../../remote/tunnel-pipe';
import { MAX_AGENT_CONNECTIONS } from '../../daemon/agent-relay';
import type { RemoteConnection } from './connection';
import { authorityKeyOfHost, forwardsAgent, type HostRecord } from './host-store';

// The daemon relays this device's agent (agent.relay, agent.request, agent.connect, agent.refuse).
export const AGENT_RELAY_FEATURE = 'agent.relay';
// Win32-OpenSSH's agent, which its ssh uses when SSH_AUTH_SOCK is unset
export const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * This computer's agent as the ssh main starts finds it: main's SSH_AUTH_SOCK (on macOS and Linux the login environment
 * merged at startup), else on Windows the OpenSSH agent's pipe; undefined for none.
 */
export function localAgentPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const configured = env['SSH_AUTH_SOCK'];
  if (configured !== undefined && configured !== '') return configured;
  return platform === 'win32' ? WINDOWS_AGENT_PIPE : undefined;
}

export type AgentRelayConnection = Pick<RemoteConnection, 'features' | 'control' | 'openStream' | 'onLost' | 'onClose' | 'lost'>;

export interface AgentRelaysDeps {
  // this computer's host record of an authority
  readonly record: (authorityKey: string) => HostRecord | undefined;
  // the authority's connection now, held or usable
  readonly connection: (authorityKey: string) => AgentRelayConnection | undefined;
  readonly agentPath: () => string | undefined;
  readonly connectAgent: (path: string) => net.Socket;
  readonly log: (line: string) => void;
}

interface Relayed {
  // ends the agent connection and the stream at once
  reset(): void;
}

interface Relaying {
  readonly authorityKey: string;
  readonly relayed: Set<Relayed>;
}

export class AgentRelays {
  private readonly deps: AgentRelaysDeps;
  private readonly connections = new Map<AgentRelayConnection, Relaying>();

  constructor(deps: AgentRelaysDeps) {
    this.deps = deps;
  }

  /** A fresh connection of a container authority: answers its agent requests, then tells its daemon it relays. */
  attach(authorityKey: string, connection: AgentRelayConnection): void {
    if (!connection.features.includes(AGENT_RELAY_FEATURE)) return;
    const relaying: Relaying = { authorityKey, relayed: new Set() };
    this.connections.set(connection, relaying);
    const requests = connection.control.onEvent('agent.request', ({ request }) => this.request(relaying, connection, request));
    const resetAll = (): void => {
      for (const relayed of [...relaying.relayed]) relayed.reset();
    };
    const lost = connection.onLost(resetAll);
    connection.onClose(() => {
      requests.dispose();
      lost.dispose();
      resetAll();
      this.connections.delete(connection);
    });
    connection.control.request('agent.relay', {}).catch((err: unknown) => this.deps.log(`[agent] ${authorityKey} could not start the SSH agent relay: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The authority's host settings changed: once it no longer forwards, every agent connection relayed to it ends at once. */
  policyChanged(authorityKey: string): void {
    for (const relaying of this.connections.values()) {
      if (relaying.authorityKey !== authorityKey || this.forwards(authorityKey)) continue;
      for (const relayed of [...relaying.relayed]) relayed.reset();
    }
  }

  private forwards(authorityKey: string): boolean {
    const record = this.deps.record(authorityKey);
    return record?.kind === 'container' && authorityKeyOfHost(record) === authorityKey && forwardsAgent(record);
  }

  // checked again after every wait: the switch, the record of exactly this authority, and this connection being its own
  private allowed(relaying: Relaying, connection: AgentRelayConnection): string | undefined {
    if (!this.forwards(relaying.authorityKey)) return 'its host does not forward the SSH agent';
    if (this.deps.connection(relaying.authorityKey) !== connection || connection.lost()) return 'the request came on a connection that is not the host\'s';
    return undefined;
  }

  private request(relaying: Relaying, connection: AgentRelayConnection, request: number): void {
    const { log } = this.deps;
    const refuse = (why: string): void => {
      log(`[agent] refused agent request ${request} of ${relaying.authorityKey}: ${why}`);
      connection.control.request('agent.refuse', { request }).catch((err: unknown) => log(`[agent] refusing agent request ${request} of ${relaying.authorityKey} failed: ${err instanceof Error ? err.message : String(err)}`));
    };
    const why = this.allowed(relaying, connection) ?? (relaying.relayed.size >= MAX_AGENT_CONNECTIONS ? `${MAX_AGENT_CONNECTIONS} agent connections are open` : undefined);
    if (why !== undefined) {
      refuse(why);
      return;
    }
    const agentPath = this.deps.agentPath();
    if (agentPath === undefined) {
      refuse('this computer has no SSH agent (SSH_AUTH_SOCK is not set)');
      return;
    }
    const socket = this.deps.connectAgent(agentPath);
    let stream: StreamChannel | undefined;
    let pipe: TunnelPipe | undefined;
    // the daemon still waits for an answer until agent.connect is sent
    let answered = false;
    const entry: Relayed = {
      reset: () => {
        if (!relaying.relayed.delete(entry)) return;
        if (pipe) {
          pipe.close();
          return;
        }
        socket.destroy();
        stream?.end();
        if (!answered) {
          answered = true;
          refuse('the relay was reset before it connected');
        }
      },
    };
    relaying.relayed.add(entry);
    socket.on('error', (err) => log(`[agent] this computer's SSH agent at ${agentPath} failed for ${relaying.authorityKey}: ${err.message}`));
    socket.once('close', () => {
      if (!pipe) entry.reset();
    });
    socket.once('connect', () => {
      if (!relaying.relayed.has(entry)) return;
      const refused = this.allowed(relaying, connection);
      if (refused !== undefined) {
        entry.reset();
        return;
      }
      try {
        stream = connection.openStream();
      } catch (err) {
        log(`[agent] no stream for agent request ${request} of ${relaying.authorityKey}: ${err instanceof Error ? err.message : String(err)}`);
        entry.reset();
        return;
      }
      // held, and paused for credit, until the pipe reads it (holdStream)
      const opened = stream;
      answered = true;
      connection.control.request('agent.connect', { request, stream: opened.id }).then(({ ok }) => {
        if (!relaying.relayed.has(entry)) return;
        if (!ok || this.allowed(relaying, connection) !== undefined) {
          entry.reset();
          return;
        }
        // a pipe or Unix socket has no RST: destroy is its reset
        pipe = pipeStream(socket, opened, () => relaying.relayed.delete(entry), (agent) => agent.destroy());
      }, (err: unknown) => {
        log(`[agent] connecting agent request ${request} of ${relaying.authorityKey} failed: ${err instanceof Error ? err.message : String(err)}`);
        entry.reset();
      });
    });
  }
}
