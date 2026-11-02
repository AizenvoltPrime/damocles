// Client-side tunnel listeners (docs/invariants.md "Ports and the remote browser"): a forward listens on this computer's
// loopback and carries each accepted connection over its own `tunnel` stream to the daemon, which connects the remote port.
import * as net from 'node:net';
import type { Disposable } from '../../../../platform/disposable';
import { listeners } from '../../../../remote/listeners';
import type { StreamChannel } from '../../../../remote/mux';
import { abandonStream, pipeTunnel, type TunnelPipe } from '../../../../remote/tunnel-pipe';
import { candidatePorts, refusalOf, type PortRefusal } from './reserved-ports';

export type { PortRefusal } from './reserved-ports';

/** A remote address as the daemon connects it: a loopback form of what the program bound, or a host the target reaches. */
export interface TunnelTarget {
  readonly host: string;
  readonly port: number;
}

export interface Tunnel {
  readonly authority: string;
  readonly key: string;
  readonly remote: TunnelTarget;
  readonly localPort: number;
  readonly localAddresses: readonly string[];
  readonly liveConnections: number;
}

export class PortRefusedError extends Error {
  override readonly name: string = 'PortRefusedError';
  readonly code: PortRefusal;
  readonly port: number;

  constructor(code: PortRefusal, port: number) {
    super(`Local port ${port} cannot be used: ${code}`);
    this.code = code;
    this.port = port;
  }
}

// live forwards of one authority, whoever asked: a target can name every port, and each forward listens on two loopbacks
export const MAX_FORWARDS_PER_HOST = 256;

/** Refused: the authority already has MAX_FORWARDS_PER_HOST live forwards. */
export class ForwardLimitError extends Error {
  override readonly name: string = 'ForwardLimitError';

  constructor(authority: string) {
    super(`${authority} already has ${MAX_FORWARDS_PER_HOST} forwarded ports`);
  }
}

/** Opens a tunnel stream to one authority's daemon; rejects when the daemon could not connect the target. */
export type TunnelOpener = (target: TunnelTarget) => Promise<StreamChannel>;

export interface TunnelManagerDeps {
  // the authority's opener while its connection serves ports, else undefined
  readonly opener: (authority: string) => TunnelOpener | undefined;
  readonly reserved: ReadonlySet<number>;
  readonly clientPlatform: NodeJS.Platform;
  readonly log: (line: string) => void;
}

export function tunnelKey(remote: TunnelTarget): string {
  return remote.host.includes(':') ? `[${remote.host}]:${remote.port}` : `${remote.host}:${remote.port}`;
}

// both loopbacks: a port anything here accepts or holds on either is taken, and `localhost` reaches the forward whichever it resolves to
const LOOPBACKS = ['127.0.0.1', '::1'] as const;
export type LoopbackAddress = (typeof LOOPBACKS)[number];
// a client without IPv6 has no ::1 to connect or take
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH']);

interface Forward {
  readonly authority: string;
  readonly key: string;
  readonly remote: TunnelTarget;
  localPort: number;
  servers: net.Server[];
  readonly pipes: Set<TunnelPipe>;
  stopped: boolean;
}

// a loopback connect is answered at once; one a listener's full accept queue drops is never answered, and that listener holds the
// port. Also the longest a probe's socket waits for the listener to close its side
const PROBE_DEADLINE_MS = 1000;

// connects only: binding a wildcard address to probe can raise the Windows Defender Firewall prompt for the app. The probe
// half-closes and reads what the listener sends until it closes too: a close with unread data resets the listener's connection
export function accepts(host: LoopbackAddress, port: number, deadlineMs: number = PROBE_DEADLINE_MS, connect: (options: net.NetConnectOpts) => net.Socket = net.connect): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const deadline = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, deadlineMs);
    socket.once('close', () => clearTimeout(deadline));
    socket.once('connect', () => {
      resolve(true);
      socket.end();
      socket.resume();
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === 'ECONNREFUSED' || (host === '::1' && NO_IPV6.has(err.code ?? ''))) resolve(false);
      // a listener that resets or never answers the connect still holds the port
      else if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') resolve(true);
      else reject(err);
    });
  });
}

function bindLoopbacks(port: number): Promise<net.Server[]> {
  const servers: net.Server[] = [];
  const close = (): void => {
    for (const server of servers) server.close();
  };
  return LOOPBACKS.reduce<Promise<void>>((previous, host) => previous.then(() => new Promise<void>((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (host === '::1' && NO_IPV6.has(err.code ?? '')) resolve();
      else reject(err);
    });
    server.listen({ port, host, exclusive: true }, () => {
      servers.push(server);
      resolve();
    });
  })), Promise.resolve()).then(() => servers, (err: unknown) => {
    close();
    throw err;
  });
}

const inUse = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  // Windows reports a port Hyper-V or another user reserves as EACCES
  return code === 'EADDRINUSE' || code === 'EACCES';
};

/**
 * The port's loopback listeners, or undefined when the port is taken. Windows, and macOS through libuv's SO_REUSEADDR, let a
 * loopback bind succeed beside another program's wildcard listener and then route loopback connections to it, so the bind
 * alone cannot tell; a connect that reaches a listener can.
 */
async function listen(port: number): Promise<net.Server[] | undefined> {
  if ((await Promise.all(LOOPBACKS.map((host) => accepts(host, port)))).includes(true)) return undefined;
  // a program that starts listening between this probe and the bind is still shadowed on loopback
  try {
    return await bindLoopbacks(port);
  } catch (err) {
    if (inUse(err)) return undefined;
    throw err;
  }
}

export class TunnelManager {
  private readonly deps: TunnelManagerDeps;
  private readonly forwards = new Map<string, Map<string, Forward>>();
  private readonly changes = listeners<[string]>();
  // authorities whose refusal at MAX_FORWARDS_PER_HOST was logged, until one of their forwards stops
  private readonly limitLogged = new Set<string>();

  constructor(deps: TunnelManagerDeps) {
    this.deps = deps;
  }

  onDidChange(listener: (authority: string) => void): Disposable {
    return this.changes.add(listener);
  }

  get(authority: string, key: string): Tunnel | undefined {
    const forward = this.forwards.get(authority)?.get(key);
    return forward ? this.snapshot(forward) : undefined;
  }

  list(authority: string): readonly Tunnel[] {
    return [...(this.forwards.get(authority)?.values() ?? [])].map((forward) => this.snapshot(forward));
  }

  /**
   * Listens for the remote target, or returns its live forward. localPort is tried first; requireLocalPort refuses any other
   * (an OAuth redirect_uri names its port exactly). Otherwise the rules of reserved-ports.ts pick the port.
   */
  async forward(authority: string, remote: TunnelTarget, options: { readonly localPort?: number; readonly requireLocalPort?: boolean } = {}): Promise<Tunnel> {
    const key = tunnelKey(remote);
    const live = this.forwards.get(authority)?.get(key);
    if (live && (options.requireLocalPort !== true || live.localPort === options.localPort)) return this.snapshot(live);
    if (live) throw new PortRefusedError('inUse', options.localPort ?? remote.port);
    this.checkLimit(authority, key);
    const { port, servers } = await this.bind(remote.port, options.localPort, options.requireLocalPort === true);
    // a second forward of the same target that raced this one keeps the first
    const raced = this.forwards.get(authority)?.get(key);
    if (raced) {
      for (const server of servers) server.close();
      return this.snapshot(raced);
    }
    try {
      this.checkLimit(authority, key);
    } catch (err) {
      for (const server of servers) server.close();
      throw err;
    }
    const forward: Forward = { authority, key, remote, localPort: port, servers, pipes: new Set(), stopped: false };
    this.accept(forward);
    let byKey = this.forwards.get(authority);
    if (!byKey) {
      byKey = new Map();
      this.forwards.set(authority, byKey);
    }
    byKey.set(key, forward);
    this.deps.log(`[ports] ${authority}: forwarding ${key} on local port ${port}`);
    this.changes.fire(authority);
    return this.snapshot(forward);
  }

  /** Moves a forward to localPort; a refused or taken port leaves it where it was. */
  async changeLocalPort(authority: string, key: string, localPort: number): Promise<Tunnel> {
    const forward = this.forwards.get(authority)?.get(key);
    if (!forward) throw new Error(`No forward of ${key} on ${authority}`);
    if (forward.localPort === localPort) return this.snapshot(forward);
    const { servers } = await this.bind(forward.remote.port, localPort, true);
    if (forward.stopped) {
      for (const server of servers) server.close();
      throw new Error(`The forward of ${key} stopped`);
    }
    for (const server of forward.servers) server.close();
    forward.servers = servers;
    forward.localPort = localPort;
    this.accept(forward);
    this.changes.fire(authority);
    return this.snapshot(forward);
  }

  /** Closes the forward's listeners and every connection it carries. */
  stop(authority: string, key: string): void {
    const byKey = this.forwards.get(authority);
    const forward = byKey?.get(key);
    if (!byKey || !forward) return;
    byKey.delete(key);
    if (byKey.size === 0) this.forwards.delete(authority);
    this.limitLogged.delete(authority);
    forward.stopped = true;
    for (const server of forward.servers) server.close();
    for (const pipe of [...forward.pipes]) pipe.close();
    this.deps.log(`[ports] ${authority}: stopped forwarding ${key}`);
    this.changes.fire(authority);
  }

  stopAll(authority: string): void {
    for (const key of [...(this.forwards.get(authority)?.keys() ?? [])]) this.stop(authority, key);
  }

  /** Resets every connection the authority's forwards carry and keeps the listeners: its connection was lost. */
  resetConnections(authority: string): void {
    const pipes = [...(this.forwards.get(authority)?.values() ?? [])].flatMap((forward) => [...forward.pipes]);
    if (pipes.length === 0) return;
    for (const pipe of pipes) pipe.close();
    this.deps.log(`[ports] ${authority}: the connection was lost; reset ${pipes.length} forwarded connections`);
  }

  private checkLimit(authority: string, key: string): void {
    if ((this.forwards.get(authority)?.size ?? 0) < MAX_FORWARDS_PER_HOST) return;
    if (!this.limitLogged.has(authority)) {
      this.limitLogged.add(authority);
      this.deps.log(`[ports] ${authority}: refused forwarding ${key}: ${MAX_FORWARDS_PER_HOST} ports are forwarded; later refusals are not logged until one stops`);
    }
    throw new ForwardLimitError(authority);
  }

  private snapshot(forward: Forward): Tunnel {
    return {
      authority: forward.authority,
      key: forward.key,
      remote: forward.remote,
      localPort: forward.localPort,
      localAddresses: forward.servers.map((server) => (server.address() as net.AddressInfo).address),
      liveConnections: forward.pipes.size,
    };
  }

  private async bind(remotePort: number, localPort: number | undefined, exact: boolean): Promise<{ port: number; servers: net.Server[] }> {
    if (localPort !== undefined) {
      const refusal = refusalOf(localPort, this.deps.reserved, this.deps.clientPlatform);
      if (refusal !== undefined && exact) throw new PortRefusedError(refusal, localPort);
      if (refusal === undefined) {
        const servers = await listen(localPort);
        if (servers) return { port: localPort, servers };
        if (exact) throw new PortRefusedError('inUse', localPort);
      }
    }
    for (const port of candidatePorts(remotePort, this.deps.reserved, this.deps.clientPlatform)) {
      if (port === localPort) continue;
      const servers = await listen(port);
      if (servers) return { port, servers };
    }
    throw new PortRefusedError('inUse', remotePort);
  }

  private accept(forward: Forward): void {
    for (const server of forward.servers) {
      server.on('connection', (socket: net.Socket) => void this.carry(forward, socket));
      server.on('error', (err) => this.deps.log(`[ports] ${forward.authority}: the listener of ${forward.key} failed: ${err.message}`));
    }
  }

  private async carry(forward: Forward, socket: net.Socket): Promise<void> {
    // a reset before the stream opened ends the socket alone
    socket.on('error', () => socket.destroy());
    const opener = this.deps.opener(forward.authority);
    if (!opener || forward.stopped) {
      socket.resetAndDestroy();
      return;
    }
    let stream: StreamChannel;
    try {
      stream = await opener(forward.remote);
    } catch (err) {
      this.deps.log(`[ports] ${forward.authority}: a connection to ${forward.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.resetAndDestroy();
      return;
    }
    if (forward.stopped || socket.destroyed) {
      abandonStream(stream);
      socket.destroy();
      return;
    }
    const pipe = pipeTunnel(socket, stream, () => {
      forward.pipes.delete(pipe);
      if (!forward.stopped) this.changes.fire(forward.authority);
    });
    forward.pipes.add(pipe);
    socket.resume();
    this.changes.fire(forward.authority);
  }
}
