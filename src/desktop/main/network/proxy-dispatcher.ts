import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { powerMonitor, type Session } from 'electron';
import {
  Agent,
  Client,
  Dispatcher,
  EnvHttpProxyAgent,
  Pool,
  ProxyAgent,
  Socks5ProxyAgent,
  getGlobalDispatcher,
  install,
  setGlobalDispatcher,
} from 'undici';
import type { Disposable } from '../../../platform/disposable';
import { PI_AGENT_DIR } from '../../../core/pi-session/agent-dir';
import type { StartupLog } from '../shell-env';

// pi's configureHttpDispatcher defaults (dist/core/http-dispatcher.js), which its CLI applies and its library entry does not.
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
// Electron exposes no network-change event, so a PAC or OS proxy change reaches new connections within a minute.
const PROXY_DECISION_TTL_MS = 60_000;
const ENV_PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

const ignoreDispatcherError = (): void => undefined;

// undici can emit an internal Client "error" while ending a mid-stream body; the body stream still rejects.
function withErrorListener<T extends Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, 'error', ignoreDispatcherError);
  return dispatcher;
}

function createClient(origin: URL | string, options: object): Dispatcher {
  return withErrorListener(new Client(origin, options));
}

function createOriginDispatcher(origin: URL | string, options: object): Dispatcher {
  if ((options as { connections?: number | null }).connections === 1) return createClient(origin, options);
  return withErrorListener(new Pool(origin, { ...options, factory: createClient }));
}

/** pi's `httpIdleTimeoutMs` setting, read the way pi's SettingsManager parses it. */
function httpIdleTimeoutMs(log: StartupLog): number {
  const file = path.join(PI_AGENT_DIR, 'settings.json');
  let raw: unknown;
  try {
    raw = (JSON.parse(fs.readFileSync(file, 'utf8')) as { httpIdleTimeoutMs?: unknown }).httpIdleTimeoutMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[network] ${file} unreadable, using the default idle timeout: ${String(err)}`);
    return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  }
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'disabled') return 0;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
}

/** Fail a request that never reached a real dispatcher, which would otherwise hang its caller. */
function failRequest(handler: Dispatcher.DispatchHandler, err: Error): void {
  const controller: Dispatcher.DispatchController = {
    aborted: true,
    paused: false,
    reason: err,
    abort: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
  };
  handler.onResponseError?.(controller, err);
}

type ProxyRoute = { kind: 'direct' } | { kind: 'proxy'; uri: string };

/** Only scheme, host and port: a proxy URI may carry credentials, which never reach a log. */
function describe(route: ProxyRoute): string {
  if (route.kind === 'direct') return 'DIRECT';
  const url = new URL(route.uri);
  return `${url.protocol}//${url.host}`;
}

/**
 * The first route in a Chromium proxy list (`PROXY h:p; SOCKS5 h:p; DIRECT`) that undici can take.
 * `SOCKS` is SOCKS v4 in Chromium's notation, which undici lacks, as it lacks QUIC.
 */
export function parseProxyList(list: string): { route: ProxyRoute; skipped: string[] } {
  const skipped: string[] = [];
  for (const entry of list.split(';').map((e) => e.trim()).filter(Boolean)) {
    const [type = '', hostPort = ''] = entry.split(/\s+/, 2);
    const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5' }[type.toUpperCase()];
    if (type.toUpperCase() === 'DIRECT') return { route: { kind: 'direct' }, skipped };
    if (scheme && /^[A-Za-z0-9.\-[\]:]+:\d+$/.test(hostPort)) return { route: { kind: 'proxy', uri: `${scheme}://${hostPort}` }, skipped };
    skipped.push(type);
  }
  return { route: { kind: 'direct' }, skipped };
}

interface CachedRoute {
  readonly dispatcher: Dispatcher;
  readonly expires: number;
}

/**
 * Routes each origin the way Chromium would: HTTP(S)_PROXY/NO_PROXY when set (Chromium ignores them on
 * Windows and macOS), else `session.resolveProxy`, which applies the OS settings, PAC and WPAD.
 */
class ChromiumProxyDispatcher extends Dispatcher {
  private readonly routes = new Map<string, CachedRoute | Promise<Dispatcher>>();
  private readonly proxies = new Map<string, Dispatcher>();
  private readonly session: Session;
  private readonly idleTimeoutMs: number;
  private readonly log: StartupLog;
  private readonly direct: Dispatcher;
  private readonly env: Dispatcher | null;

  constructor(session: Session, idleTimeoutMs: number, log: StartupLog) {
    super();
    this.session = session;
    this.idleTimeoutMs = idleTimeoutMs;
    this.log = log;
    this.direct = withErrorListener(new Agent(this.agentOptions()));
    this.env = ENV_PROXY_KEYS.some((key) => process.env[key])
      ? withErrorListener(new EnvHttpProxyAgent({ ...this.agentOptions(), proxyTunnel: true }))
      : null;
  }

  private timeouts(): Pick<Pool.Options, 'allowH2' | 'bodyTimeout' | 'headersTimeout'> {
    return { allowH2: false, bodyTimeout: this.idleTimeoutMs, headersTimeout: this.idleTimeoutMs };
  }

  private agentOptions(): Agent.Options & Pick<ProxyAgent.Options, 'clientFactory'> {
    return {
      ...this.timeouts(),
      connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
      clientFactory: createClient,
      factory: createOriginDispatcher,
    };
  }

  clearRoutes(): void {
    this.routes.clear();
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this.env) return this.env.dispatch(options, handler);
    const origin = new URL(String(options.origin)).origin;
    const cached = this.routes.get(origin);
    if (cached && !(cached instanceof Promise) && cached.expires > Date.now()) return cached.dispatcher.dispatch(options, handler);
    const pending = cached instanceof Promise ? cached : this.resolve(origin);
    void pending
      .then((dispatcher) => dispatcher.dispatch(options, handler))
      .catch((err: unknown) => failRequest(handler, err instanceof Error ? err : new Error(String(err))));
    return true;
  }

  private resolve(origin: string): Promise<Dispatcher> {
    // Each lookup drops the answers that expired, or every origin ever contacted would stay cached for the whole run.
    const now = Date.now();
    for (const [cachedOrigin, route] of this.routes) if (!(route instanceof Promise) && route.expires <= now) this.routes.delete(cachedOrigin);
    const pending = this.session.resolveProxy(origin).then(
      (list) => {
        const { route, skipped } = parseProxyList(list);
        if (skipped.length > 0) this.log(`[network] ${origin}: skipped unsupported proxy types ${skipped.join(', ')}; using ${describe(route)}`);
        return this.dispatcherFor(route);
      },
      (err: unknown) => {
        this.log(`[network] resolving the proxy for ${origin} failed, connecting directly: ${err instanceof Error ? err.message : String(err)}`);
        return this.direct;
      },
    ).then((dispatcher) => {
      if (this.routes.get(origin) === pending) this.routes.set(origin, { dispatcher, expires: Date.now() + PROXY_DECISION_TTL_MS });
      return dispatcher;
    });
    this.routes.set(origin, pending);
    return pending;
  }

  private dispatcherFor(route: ProxyRoute): Dispatcher {
    if (route.kind === 'direct') return this.direct;
    let proxy = this.proxies.get(route.uri);
    if (!proxy) {
      proxy = route.uri.startsWith('socks5:')
        ? withErrorListener(new Socks5ProxyAgent(route.uri, this.timeouts()))
        : withErrorListener(new ProxyAgent({ ...this.agentOptions(), uri: route.uri, proxyTunnel: true }));
      this.proxies.set(route.uri, proxy);
      this.log(`[network] routing through proxy ${describe(route)}`);
    }
    return proxy;
  }

  private all(): Dispatcher[] {
    return [this.direct, ...(this.env ? [this.env] : []), ...this.proxies.values()];
  }

  override async close(): Promise<void> {
    await Promise.all(this.all().map((d) => d.close()));
  }

  override async destroy(): Promise<void> {
    await Promise.all(this.all().map((d) => d.destroy()));
  }
}

/**
 * Install the process-wide undici dispatcher that pi's providers, the MCP SDK and WebFetch reach through
 * `fetch`, with the settings pi's own CLI dispatcher uses. Call after `installCaCertificates`.
 */
export function installProxyDispatcher(session: Session, log: StartupLog): Disposable {
  const idleTimeoutMs = httpIdleTimeoutMs(log);
  const dispatcher = withErrorListener(new ChromiumProxyDispatcher(session, idleTimeoutMs, log));
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  // pi does the same: fetch and the dispatcher must be one undici implementation. Kept after dispose.
  install();
  const onResume = (): void => dispatcher.clearRoutes();
  powerMonitor.on('resume', onResume);
  log(`[network] dispatcher installed (${ENV_PROXY_KEYS.some((key) => process.env[key]) ? 'proxy from environment' : 'proxy per origin from Chromium'}, idle timeout ${idleTimeoutMs} ms)`);
  return {
    dispose: () => {
      powerMonitor.off('resume', onResume);
      setGlobalDispatcher(previous);
      void dispatcher.close().catch((err: unknown) => log(`[network] closing the dispatcher failed: ${String(err)}`));
    },
  };
}
