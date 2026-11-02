// The forwarded SSH agent as the daemon's spawned processes reach it: one socket per client in the agent folder, listening
// while that client forwards its agent and has an upstream (the agent socket its bridge named, or its connection's relay),
// whose every connection reaches that client's agent only (docs/invariants.md "Remote connections and credentials").
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import { agentSocketFile } from '../core-protocol/agent-sockets';
import type { AgentRelay } from './agent-relay';
import type { KeptFolder } from './endpoint-server';
import { createSocketFolder, socketFolderBase } from './token';

// a POSIX socket path the bridge may name: absolute, one line, within sun_path's bound
const AGENT_SOCK = /^\/[^\0\r\n]{1,106}$/;

export interface AgentProxyDeps {
  // whether a client's policy forwards its agent to this host
  readonly forwarding: (clientId: string) => boolean;
  // the daemon's uid, which owns every agent socket it proxies to; undefined on Windows, which forwards none
  readonly uid: number | undefined;
  readonly log: (line: string) => void;
  // where the agent folder is made; default socketFolderBase()
  readonly base?: () => Promise<string>;
}

// Where a client's agent is: the socket an ssh session forwarded to its bridge, or its connection's relay to its own computer.
export type AgentUpstream = { readonly kind: 'socket'; readonly path: string } | { readonly kind: 'relay'; readonly relay: AgentRelay };

export interface AgentProxy {
  /** The client's upstream as its latest connection names it (undefined: none, or the connection dropped or closed). */
  setClient(clientId: string, upstream: AgentUpstream | undefined): void;
  /** A client's policy changed: its socket listens only while it forwards, and stops with every connection once it does not. */
  policyChanged(): void;
  /** Makes the agent folder (POSIX); a no-op on Windows. */
  start(): Promise<void>;
  /** The agent folder once made; each client's socket in it is agentSocketFile(folder, clientId). */
  folder(): string | undefined;
  /** The client's socket while it listens and the client forwards its agent, else undefined. */
  socketFor(clientId: string): string | undefined;
  /** The folder and its listening sockets; a rebind moves every socket to a new folder, which folder() then names. */
  kept(): KeptFolder | undefined;
  /** Settles once every socket setClient asked for listens or failed, and every one it dropped closed. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

/** Whether a bridge's agentSock may be proxied to: an absolute POSIX path of one line. */
export const isAgentSock = (value: string): boolean => AGENT_SOCK.test(value);

interface Listener {
  readonly server: net.Server;
  readonly file: string;
  readonly connections: Set<net.Socket>;
}

function listenOn(server: net.Server, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export function createAgentProxy(deps: AgentProxyDeps): AgentProxy {
  // each client's upstream as its latest connection named it
  const wanted = new Map<string, AgentUpstream>();
  const listeners = new Map<string, Listener>();
  let folder: string | undefined;
  let closed = false;
  // listens, closes and moves run one at a time
  let queue: Promise<void> = Promise.resolve();
  const serially = (run: () => Promise<void>): Promise<void> => {
    const next = queue.then(run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  // Each connection reaches the agent of the client whose socket it came in on; that agent's socket must be the user's own.
  const proxy = (clientId: string, connections: Set<net.Socket>, incoming: net.Socket): void => {
    connections.add(incoming);
    incoming.once('close', () => connections.delete(incoming));
    incoming.on('error', (err) => deps.log(`[agent] a proxied connection failed: ${err.message}`));
    const upstream = deps.forwarding(clientId) ? wanted.get(clientId) : undefined;
    if (upstream === undefined) {
      deps.log('[agent] refused a connection: its client does not forward its SSH agent');
      incoming.destroy();
      return;
    }
    if (upstream.kind === 'relay') {
      upstream.relay.request(incoming);
      return;
    }
    const agent = upstream.path;
    incoming.pause();
    fs.lstat(agent).then((stat) => {
      if (deps.uid === undefined || !stat.isSocket() || stat.uid !== deps.uid) throw new Error(`${agent} is not a socket of this user`);
      // the process that connected went away during the lstat
      if (incoming.destroyed) return;
      const outgoing = net.connect(agent);
      connections.add(outgoing);
      outgoing.once('close', () => connections.delete(outgoing));
      outgoing.on('error', (err) => {
        deps.log(`[agent] the forwarded agent at ${agent} failed: ${err.message}`);
        incoming.destroy();
      });
      incoming.once('close', () => outgoing.destroy());
      outgoing.once('connect', () => {
        incoming.pipe(outgoing);
        outgoing.pipe(incoming);
      });
    }).catch((err: unknown) => {
      deps.log(`[agent] refused a connection: ${err instanceof Error ? err.message : String(err)}`);
      incoming.destroy();
    });
  };

  const listen = async (clientId: string, into: string): Promise<void> => {
    const file = agentSocketFile(into, clientId);
    const connections = new Set<net.Socket>();
    const server = net.createServer((incoming) => proxy(clientId, connections, incoming));
    try {
      await listenOn(server, file);
      // the folder is 0700, so the moment before this chmod exposes nothing
      await fs.chmod(file, 0o600);
    } catch (err) {
      server.close();
      throw err;
    }
    server.on('error', (err) => deps.log(`[agent] the proxy socket ${file} failed: ${err.message}`));
    listeners.set(clientId, { server, file, connections });
    deps.log(`[agent] listening on ${file}`);
  };

  const stop = async (clientId: string): Promise<void> => {
    const listener = listeners.get(clientId);
    if (!listener) return;
    listeners.delete(clientId);
    for (const socket of listener.connections) socket.destroy();
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
    await fs.rm(listener.file, { force: true });
  };

  // a failed listen leaves that client without a socket; its next attach or policy change tries again
  const listening = (clientId: string): boolean => wanted.has(clientId) && deps.forwarding(clientId);
  const sync = (): Promise<void> => serially(async () => {
    if (closed || folder === undefined) return;
    for (const clientId of [...listeners.keys()]) if (!listening(clientId)) await stop(clientId);
    for (const clientId of wanted.keys()) {
      if (listeners.has(clientId) || !listening(clientId)) continue;
      await listen(clientId, folder).catch((err: unknown) => deps.log(`[agent] could not listen for ${clientId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  });

  // only the sockets this proxy made, then the folder; one already gone is done
  const removeFolder = async (gone: string): Promise<void> => {
    for (const clientId of [...listeners.keys()]) await stop(clientId);
    await fs.rmdir(gone).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  };

  return {
    setClient: (clientId, upstream) => {
      if (upstream?.kind === 'socket' && !isAgentSock(upstream.path)) {
        deps.log(`[agent] ignoring the agent socket of ${clientId}: not an absolute socket path`);
        upstream = undefined;
      }
      // a new connection's upstream: connections already piped keep theirs
      if (upstream === undefined) wanted.delete(clientId);
      else wanted.set(clientId, upstream);
      void sync();
    },
    policyChanged: () => void sync(),
    start: () => serially(async () => {
      if (deps.uid === undefined || folder !== undefined || closed) return;
      folder = await createSocketFolder(await (deps.base ?? socketFolderBase)());
      deps.log(`[agent] made the agent folder ${folder}`);
    }).then(sync),
    folder: () => folder,
    socketFor: (clientId) => (deps.forwarding(clientId) ? listeners.get(clientId)?.file : undefined),
    kept: () => {
      const current = folder;
      if (current === undefined) return undefined;
      return {
        folder: current,
        files: [current, ...[...listeners.values()].map((listener) => listener.file)],
        rebind: () => serially(async () => {
          if (closed || folder !== current) return;
          deps.log(`[agent] the agent folder ${current} or one of its sockets was removed; making a new one`);
          await removeFolder(current);
          folder = undefined;
          folder = await createSocketFolder(await (deps.base ?? socketFolderBase)());
          deps.log(`[agent] made the agent folder ${folder}`);
        }).then(sync),
      };
    },
    settled: () => serially(async () => undefined),
    close: () => serially(async () => {
      closed = true;
      wanted.clear();
      const current = folder;
      folder = undefined;
      if (current !== undefined) await removeFolder(current);
    }),
  };
}
