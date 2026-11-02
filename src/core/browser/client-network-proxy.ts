// The filtering proxy a remote authority's browser context sends all its traffic through: it resolves each name once,
// checks every answer and connects to the address it checked (docs/invariants.md "Ports and the remote browser").
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type AddressInfo, type LookupFunction, type Socket } from 'node:net';
import { pipeline, type Duplex } from 'node:stream';
import { log } from '../logger';
import { connectAddress, resolveAddresses, resolveClientTarget, type AddressResolver, type ClientNetworkPolicy, type ResolvedAddress } from './client-network-policy';

// Appended after Playwright's own proxy flags, so the loopback bypass stays removed even when
// PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK drops Playwright's <-loopback>.
export const REMOTE_CONTEXT_CHROME_ARGS: readonly string[] = [
  '--proxy-bypass-list=<-loopback>',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

// Connects to one of the checked addresses (several only for a name), never resolving `name` again.
export type AddressConnector = (name: string, addresses: readonly string[], port: number) => Socket;

export interface ClientNetworkProxy {
  // http://127.0.0.1:<port>, the context's `proxy.server`
  readonly url: string;
  // applies to every later request and closes the open connections the new policy refuses
  update(policy: ClientNetworkPolicy): void;
  close(): Promise<void>;
}

export interface ClientNetworkProxyOptions {
  readonly resolve?: AddressResolver;
  readonly connect?: AddressConnector;
  readonly now?: () => number;
}

// Chrome keeps at most 32 sockets per proxy plus 255 websockets per profile.
const MAX_CLIENT_CONNECTIONS = 512;

// Hop-by-hop headers (RFC 9110 7.6.1) and the proxy's own, never passed on.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// getaddrinfo runs on libuv's threadpool (4 threads, shared with core's file IO), so a page naming many slow names gets
// at most this many lookups at once
const MAX_CONCURRENT_LOOKUPS = 2;
// a name's answers serve its requests this long; each use checks them against the policy in force then
const ANSWER_TTL_MS = 10_000;
const MAX_CACHED_NAMES = 1024;
// a name past this many waiting lookups is answered 502 at once, so a slow nameserver bounds the backlog
export const MAX_QUEUED_LOOKUPS = 64;

interface Upstream {
  readonly socket: Socket;
  readonly addresses: readonly string[];
  readonly port: number;
}

// Several checked addresses race as Happy Eyeballs (RFC 8305) through a lookup that answers only them.
const connectChecked: AddressConnector = (name, addresses, port) => {
  if (addresses.length === 1) return netConnect({ host: addresses[0], port });
  const answers = addresses.map((address) => ({ address, family: isIP(address) }));
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all === true) callback(null, answers);
    else callback(null, answers[0]!.address, answers[0]!.family);
  };
  return netConnect({ host: name, port, lookup, autoSelectFamily: true });
};

// A lookup of a name for the requests whose signals are passed; it rejects once each of them has aborted while it waited.
export type SharedResolver = (hostname: string, signal: AbortSignal) => Promise<readonly ResolvedAddress[]>;

/**
 * One lookup per name at a time, at most MAX_CONCURRENT_LOOKUPS running and MAX_QUEUED_LOOKUPS waiting (a name past them is
 * refused at once), its answers kept ANSWER_TTL_MS after they arrive. A waiting lookup whose requesters have all gone leaves
 * the queue and the cache, so a page that churns names leaves no backlog behind.
 */
export function sharedResolver(resolve: AddressResolver, now: () => number): SharedResolver {
  interface Lookup {
    readonly answers: Promise<readonly ResolvedAddress[]>;
    // when the answers arrived; undefined while the lookup waits or runs
    settledAt: number | undefined;
    holders: number;
    // takes the lookup out of the queue; undefined once it runs
    leave: (() => void) | undefined;
  }
  const lookups = new Map<string, Lookup>();
  const waiting: Array<() => void> = [];
  let running = 0;
  // a waiting lookup takes the finished one's place, so the count never passes the cap
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  const start = (hostname: string): Lookup | Promise<never> => {
    if (running >= MAX_CONCURRENT_LOOKUPS && waiting.length >= MAX_QUEUED_LOOKUPS) return Promise.reject(new Error('too many names are waiting for a lookup'));
    let settle!: { resolve: (answers: readonly ResolvedAddress[]) => void; reject: (err: Error) => void };
    const answers = new Promise<readonly ResolvedAddress[]>((resolveAnswers, rejectAnswers) => {
      settle = { resolve: resolveAnswers, reject: rejectAnswers };
    });
    const lookup: Lookup = { answers, settledAt: undefined, holders: 0, leave: undefined };
    const run = (): void => {
      lookup.leave = undefined;
      resolve(hostname).then(settle.resolve, settle.reject).finally(() => {
        lookup.settledAt = now();
        release();
      });
    };
    if (running < MAX_CONCURRENT_LOOKUPS) {
      running++;
      run();
    } else {
      waiting.push(run);
      lookup.leave = () => {
        waiting.splice(waiting.indexOf(run), 1);
        if (lookups.get(hostname) === lookup) lookups.delete(hostname);
        settle.reject(new Error('every request for the name went away'));
      };
    }
    return lookup;
  };
  return (hostname, signal) => {
    let lookup = lookups.get(hostname);
    if (!lookup || (lookup.settledAt !== undefined && now() - lookup.settledAt >= ANSWER_TTL_MS)) {
      lookups.delete(hostname);
      const started = start(hostname);
      if (started instanceof Promise) return started;
      if (lookups.size >= MAX_CACHED_NAMES) lookups.delete(lookups.keys().next().value!);
      lookups.set(hostname, started);
      lookup = started;
    }
    const held = lookup;
    held.holders++;
    const gone = (): void => {
      held.holders--;
      if (held.holders === 0) held.leave?.();
    };
    if (signal.aborted) gone();
    else signal.addEventListener('abort', gone, { once: true });
    return held.answers.finally(() => signal.removeEventListener('abort', gone));
  };
}

export async function startClientNetworkProxy(initial: ClientNetworkPolicy, options: ClientNetworkProxyOptions = {}): Promise<ClientNetworkProxy> {
  const resolve = sharedResolver(options.resolve ?? resolveAddresses, options.now ?? Date.now);
  const connect = options.connect ?? connectChecked;
  let policy = initial;
  const clients = new Set<Socket>();
  const upstreams = new Set<Upstream>();

  // Resolves once, so the addresses checked are the addresses connected to; undefined after answering the refusal itself.
  // gone aborts once the client went away, which takes its share of a lookup that still waits.
  const target = async (host: string, port: number, refuse: (status: 403 | 502) => void, gone: AbortSignal): Promise<readonly string[] | undefined> => {
    try {
      const verdict = await resolveClientTarget(host, port, policy, (name) => resolve(name, gone));
      if (verdict.allowed) return verdict.addresses;
      log(`[Browser] The client network proxy refused ${host}:${port} (${verdict.address})`);
      refuse(403);
    } catch (err) {
      if (gone.aborted) return undefined;
      log(`[Browser] The client network proxy could not resolve ${host} — ${err instanceof Error ? err.message : String(err)}`);
      refuse(502);
    }
    return undefined;
  };

  // The policy may have changed while the name resolved, and update() checks only connections already open: undefined when
  // the current policy refuses an address.
  const open = (name: string, addresses: readonly string[], port: number): Socket | undefined => {
    const refused = addresses.find((address) => connectAddress(address, port, policy) === undefined);
    if (refused !== undefined) {
      log(`[Browser] The client network proxy refused ${refused}:${port}, which the policy no longer allows`);
      return undefined;
    }
    const socket = connect(name, addresses, port);
    const upstream: Upstream = { socket, addresses, port };
    upstreams.add(upstream);
    socket.on('close', () => upstreams.delete(upstream));
    return socket;
  };

  const forwardRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = absoluteHttpUrl(req.url);
    if (!url) {
      res.writeHead(400, { 'content-length': '0' }).end();
      return;
    }
    // heard before the name resolves, so a client gone meanwhile opens nothing
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const port = url.port === '' ? 80 : Number(url.port);
    const addresses = await target(url.hostname, port, (status) => {
      if (!gone.signal.aborted) res.writeHead(status, { 'content-length': '0' }).end();
    }, gone.signal);
    if (addresses === undefined || gone.signal.aborted) return;
    const socket = open(url.hostname, addresses, port);
    if (!socket) {
      res.writeHead(403, { 'content-length': '0' }).end();
      return;
    }
    const upstream = httpRequest({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: endToEndHeaders(req.rawHeaders),
      setHost: false,
      createConnection: () => socket,
    });
    upstream.on('response', (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, endToEndHeaders(answer.rawHeaders));
      // an upstream closed before its body ended (update() destroying it included) ends the client's response with it
      pipeline(answer, res, () => undefined);
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { 'content-length': '0' }).end();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };

  const tunnel = (client: Duplex, head: Buffer, name: string, addresses: readonly string[], port: number, established: string, firstBytes: Buffer): void => {
    // a client gone while the name resolved opens nothing; its socket allows half-open, so its end alone does not destroy it
    if (client.destroyed || client.readableEnded) {
      client.destroy();
      return;
    }
    const upstream = open(name, addresses, port);
    if (!upstream) {
      refuseRaw(client)(403);
      return;
    }
    let connected = false;
    // Before the connect the client still waits for an answer; after it, the two sockets end together.
    upstream.on('error', () => {
      if (!connected) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    upstream.on('close', () => {
      if (connected) client.destroy();
    });
    client.on('close', () => upstream.destroy());
    upstream.on('connect', () => {
      connected = true;
      if (established !== '') client.write(established);
      upstream.write(firstBytes);
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  };

  // a raw client allows half-open, so its end counts as gone too, as tunnel() reads it
  const goneSignal = (client: Duplex): AbortSignal => {
    const gone = new AbortController();
    client.once('close', () => gone.abort());
    client.once('end', () => gone.abort());
    return gone.signal;
  };

  const refuseRaw = (client: Duplex) => (status: 403 | 502): void => {
    client.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };

  const server = createServer({ maxHeaderSize: 16 * 1024 });
  server.maxConnections = MAX_CLIENT_CONNECTIONS;
  server.on('connection', (socket: Socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void forwardRequest(req, res);
  });
  // CONNECT carries https, ws and wss; its target is host:port.
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    const url = authorityUrl(req.url);
    if (!url) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const port = url.port === '' ? 80 : Number(url.port);
    void target(url.hostname, port, refuseRaw(client), goneSignal(client)).then((addresses) => {
      if (addresses !== undefined) tunnel(client, head, url.hostname, addresses, port, 'HTTP/1.1 200 Connection Established\r\n\r\n', Buffer.alloc(0));
    });
  });
  // A websocket sent as an absolute-form upgrade instead of CONNECT.
  server.on('upgrade', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    const url = absoluteHttpUrl(req.url);
    if (!url) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const port = url.port === '' ? 80 : Number(url.port);
    void target(url.hostname, port, refuseRaw(client), goneSignal(client)).then((addresses) => {
      if (addresses !== undefined) tunnel(client, head, url.hostname, addresses, port, '', upgradeHead(req, `${url.pathname}${url.search}`));
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  server.on('error', (err) => log(`[Browser] The client network proxy failed — ${err.message}`));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    update: (next) => {
      policy = next;
      for (const upstream of upstreams) {
        if (upstream.addresses.some((address) => connectAddress(address, upstream.port, next) === undefined)) upstream.socket.destroy();
      }
    },
    close: () => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      for (const client of clients) client.destroy();
      for (const upstream of upstreams) upstream.socket.destroy();
    }),
  };
}

// Chrome sends a plain http request to a proxy in absolute form; anything else is not a proxy request.
function absoluteHttpUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === 'http:' && url.username === '' && url.password === '' ? url : undefined;
}

// CONNECT's authority form, host:port with nothing else; the URL parser canonicalizes decimal, hex and mapped literals.
function authorityUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined || !/^[^\s/?#@\\]+$/.test(raw) || !URL.canParse(`http://${raw}`)) return undefined;
  return new URL(`http://${raw}`);
}

function endToEndHeaders(raw: readonly string[]): string[] {
  const named = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === 'connection') for (const name of raw[i + 1]!.split(',')) named.add(name.trim().toLowerCase());
  }
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (!HOP_BY_HOP.has(name) && !named.has(name)) kept.push(raw[i]!, raw[i + 1]!);
  }
  return kept;
}

// The upgrade request in origin form, keeping its Connection and Upgrade headers and dropping the proxy's own.
function upgradeHead(req: IncomingMessage, path: string): Buffer {
  const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (!name.toLowerCase().startsWith('proxy-')) lines.push(`${name}: ${req.rawHeaders[i + 1]!}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}
