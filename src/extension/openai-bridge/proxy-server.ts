import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { BridgeRouteEntry, BridgeHealth, OpenAIBridgeAuthMode } from './types';
import type {
  AnthropicRequest,
  CodexEffort,
  CodexToAnthropicStream,
  TranslateRequestOptions,
  TranslatedRequest,
} from './openai-transform';
import { log } from '../logger';

const LOG_PREFIX = '[OpenAIBridge]';

/** Translator constructor; typed locally so tests can mock it. */
export type CodexToAnthropicStreamCtor = new (opts: {
  anthropicModel: string;
  toolNameMap: Map<string, string>;
}) => CodexToAnthropicStream;

export interface AuthResolveResult {
  mode: OpenAIBridgeAuthMode;
  token: string;
  accountId?: string;
  expiresAt?: number;
}

export type ResolveAuth = (mode: OpenAIBridgeAuthMode) => Promise<AuthResolveResult | null>;

export interface AuthStatusSnapshot {
  codex: { signedIn: boolean; accountId?: string; expiresAt?: number };
  apikey: { configured: boolean };
}

export type GetAuthStatus = () => Promise<AuthStatusSnapshot>;

export interface BridgeProxyDeps {
  translateAnthropicToCodex: (
    req: AnthropicRequest,
    options: TranslateRequestOptions,
  ) => TranslatedRequest;
  CodexToAnthropicStream: CodexToAnthropicStreamCtor;
  resolveAuth: ResolveAuth;
  getAuthStatus: GetAuthStatus;
  recordModelForPanel: (panelId: string, model: string) => void;
  output: vscode.OutputChannel;
  /** Per-(panel, model) reasoning-effort resolver. Required: translator throws if absent. */
  effortForPanelAndModel: (panelId: string, modelId: string) => CodexEffort | undefined;
  promptCacheKeyForPanel?: (panelId: string) => string | undefined;
}

const ALLOWED_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const HEALTH_PATH = '/health';
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_CONCURRENT = 10;
const DRAIN_TIMEOUT_MS = 5000;
const UPSTREAM_FETCH_TIMEOUT_MS = 120_000;
const REQUEST_SOCKET_IDLE_TIMEOUT_MS = 60_000;
const SHUTDOWN_HEADERS = { 'Content-Type': 'application/json' } as const;
const JSON_CONTENT_TYPE = 'application/json';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const APIKEY_URL = 'https://api.openai.com/v1/responses';

export class OpenAIBridgeProxy {
  private server: http.Server | null = null;
  private port = 0;
  private readonly startedAt = Date.now();
  private readonly routes = new Map<string, BridgeRouteEntry>();
  private readonly inflight = new Set<string>();
  private readonly slotWaiters: Array<() => void> = [];
  private drainedSignal: (() => void) | null = null;
  private disposed = false;
  private readonly deps: BridgeProxyDeps;

  constructor(deps: BridgeProxyDeps) {
    this.deps = deps;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  registerRoute(panelId: string, backend: OpenAIBridgeAuthMode, currentModel: string): BridgeRouteEntry {
    for (const [bearer, entry] of this.routes) {
      if (entry.panelId === panelId) {
        if (entry.backend === backend) {
          entry.currentModel = currentModel;
          return entry;
        }
        this.routes.delete(bearer);
        break;
      }
    }
    const bearer = crypto.randomBytes(32).toString('hex');
    const entry: BridgeRouteEntry = {
      panelId,
      backend,
      bearer,
      currentModel,
      createdAt: Date.now(),
    };
    this.routes.set(bearer, entry);
    return entry;
  }

  getRouteEntry(bearer: string): BridgeRouteEntry | null {
    return this.routes.get(bearer) ?? null;
  }

  removeRoutesForPanel(panelId: string): void {
    for (const [bearer, entry] of this.routes) {
      if (entry.panelId === panelId) this.routes.delete(bearer);
    }
  }

  /** Evict every bearer; next request fails 401 and the caller re-mints. */
  rotateAllBearers(): void {
    this.routes.clear();
  }

  async start(): Promise<void> {
    if (this.server || this.disposed) return;

    if (!vscode.workspace.isTrusted) {
      throw new Error('OpenAI bridge requires a trusted workspace. Trust this workspace or use the Anthropic backend.');
    }

    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch(err => {
        this.log('error', null, null, null, `Unhandled error: ${stringifyError(err)}`);
        if (!res.headersSent) res.writeHead(500, SHUTDOWN_HEADERS);
        if (!res.writableEnded) {
          res.end(JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'Internal proxy error' } }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.removeListener('error', onError);
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.log('info', null, null, null, `Started on 127.0.0.1:${this.port}`);
        log('%s started on 127.0.0.1:%d', LOG_PREFIX, this.port);
        resolve();
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const server = this.server;
    this.server = null;
    this.routes.clear();
    if (!server) return;

    server.close();
    if (this.inflight.size > 0) {
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.drainedSignal = null;
          resolve();
        };
        const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
        this.drainedSignal = finish;
      });
    }
    server.closeAllConnections();
    this.log('info', null, null, null, `Stopped (drained ${this.inflight.size} in-flight)`);
  }

  private isAuthorized(req: http.IncomingMessage): { ok: boolean; entry: BridgeRouteEntry | null } {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return { ok: false, entry: null };
    const provided = header.slice(7);
    const providedBuf = Buffer.from(provided, 'utf8');

    let match: BridgeRouteEntry | null = null;
    for (const entry of this.routes.values()) {
      const entryBuf = Buffer.from(entry.bearer, 'utf8');
      if (providedBuf.length !== entryBuf.length) continue;
      if (crypto.timingSafeEqual(providedBuf, entryBuf)) {
        match = entry;
        break;
      }
    }
    return { ok: match !== null, entry: match };
  }

  private hasForbiddenOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && origin.length > 0) return true;
    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && fetchSite.length > 0) return true;
    return false;
  }

  private requireJsonContentType(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const ct = req.headers['content-type'];
    const value = typeof ct === 'string' ? ct.split(';')[0]?.trim().toLowerCase() : '';
    if (value === JSON_CONTENT_TYPE) return true;
    res.writeHead(415, SHUTDOWN_HEADERS);
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Content-Type must be ${JSON_CONTENT_TYPE}` } }));
    return false;
  }

  /** Drain the request body, enforcing MAX_BODY_BYTES via Content-Length + cumulative-chunk guard. Returns null on rejection. */
  private async readBoundedBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
    const declared = parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.writeHead(413, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Request body exceeds ${MAX_BODY_BYTES} bytes` } }));
      return null;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      received += buf.byteLength;
      if (received > MAX_BODY_BYTES) {
        if (!res.headersSent) res.writeHead(413, SHUTDOWN_HEADERS);
        if (!res.writableEnded) {
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Request body exceeds ${MAX_BODY_BYTES} bytes` } }));
        }
        return null;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.hasForbiddenOrigin(req)) {
      res.writeHead(403, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({ type: 'error', error: { type: 'forbidden', message: 'Cross-origin requests not allowed' } }));
      return;
    }

    const urlPath = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && urlPath === HEALTH_PATH) {
      const { ok: authed } = this.isAuthorized(req);
      await this.handleHealth(res, authed);
      return;
    }

    if (req.method === 'POST' && urlPath === COUNT_TOKENS_PATH) {
      await this.handleCountTokens(req, res);
      return;
    }

    if (req.method !== 'POST' || urlPath !== ALLOWED_PATH) {
      res.writeHead(404, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Path ${urlPath} not allowed` } }));
      return;
    }

    if (!this.requireJsonContentType(req, res)) return;

    const { ok, entry } = this.isAuthorized(req);
    if (!ok || !entry) {
      this.log('warn', null, null, null, `Rejected unauthorized request from ${req.socket.remoteAddress ?? 'unknown'}`);
      res.writeHead(401, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token' } }));
      return;
    }

    await this.handleMessages(req, res, entry);
  }

  /**
   * Synthesize an Anthropic-shaped `{ input_tokens }` for `POST /v1/messages/count_tokens`.
   * Codex has no equivalent endpoint; forwarding would 404, and a real 404 would produce
   * a 40+ request storm per turn. Local UTF-8 byte estimate via the standard ~4-bytes-per-token
   * heuristic is sufficient for the SDK's threshold decisions.
   */
  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { ok } = this.isAuthorized(req);
    if (!ok) {
      res.writeHead(401, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token' } }));
      return;
    }
    if (!this.requireJsonContentType(req, res)) return;
    const body = await this.readBoundedBody(req, res);
    if (body === null) return;
    const estimatedTokens = Math.ceil(Buffer.byteLength(body, 'utf8') / 4);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: estimatedTokens }));
  }

  /**
   * Liveness probe. Unauthenticated callers see only `{ status, uptime }` — bearer-gated
   * callers receive the full snapshot with auth identifiers, in-flight count, and the
   * panel's current model. Sibling Damocles processes that share secret storage can
   * supply a bearer; arbitrary loopback peers cannot harvest the Codex accountId.
   */
  private async handleHealth(res: http.ServerResponse, authed: boolean): Promise<void> {
    if (!authed) {
      res.writeHead(200, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({ status: 'ok', uptime: Date.now() - this.startedAt }));
      return;
    }
    const lastEntry = lastRouteEntry(this.routes);
    let authStatus: AuthStatusSnapshot;
    try {
      authStatus = await this.deps.getAuthStatus();
    } catch {
      authStatus = { codex: { signedIn: false }, apikey: { configured: false } };
    }
    const payload: BridgeHealth = {
      status: 'ok',
      backend: lastEntry?.backend ?? null,
      model: lastEntry?.currentModel ?? null,
      codexAuth: authStatus.codex,
      apikeyAuth: authStatus.apikey,
      inflightRequests: this.inflight.size,
      uptime: Date.now() - this.startedAt,
    };
    res.writeHead(200, SHUTDOWN_HEADERS);
    res.end(JSON.stringify(payload));
  }

  private async acquireSlot(abort: AbortSignal): Promise<boolean> {
    while (this.inflight.size >= MAX_CONCURRENT) {
      if (abort.aborted) return false;
      let waiter: (() => void) | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          waiter = resolve;
          this.slotWaiters.push(resolve);
          const onAbort = (): void => {
            const i = this.slotWaiters.indexOf(resolve);
            if (i >= 0) this.slotWaiters.splice(i, 1);
            abort.removeEventListener('abort', onAbort);
            reject(new Error('aborted'));
          };
          if (abort.aborted) {
            onAbort();
            return;
          }
          abort.addEventListener('abort', onAbort, { once: true });
        });
      } catch {
        if (waiter) {
          const i = this.slotWaiters.indexOf(waiter);
          if (i >= 0) this.slotWaiters.splice(i, 1);
        }
        return false;
      }
    }
    return !abort.aborted;
  }

  private releaseSlot(): void {
    const nextSlot = this.slotWaiters.shift();
    if (nextSlot) nextSlot();
    if (this.inflight.size === 0 && this.drainedSignal) {
      this.drainedSignal();
    }
  }

  private async handleMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    entry: BridgeRouteEntry,
  ): Promise<void> {
    const reqId = crypto.randomBytes(6).toString('hex');

    /** Slow-loris guard: destroy the socket if no bytes arrive for N ms so a stalled client can't hold an inflight slot. */
    req.socket.setTimeout(REQUEST_SOCKET_IDLE_TIMEOUT_MS);
    const onSocketTimeout = (): void => {
      this.log('warn', reqId, entry.backend, entry.currentModel, `Request socket idle ${REQUEST_SOCKET_IDLE_TIMEOUT_MS}ms — destroying`);
      req.destroy();
    };
    req.socket.once('timeout', onSocketTimeout);

    const abort = new AbortController();
    /**
     * Detect genuine client disconnect. Hooking `req.on('close')` would fire after the body
     * is consumed by `for await`; `res.on('close')` with `!res.writableEnded` distinguishes
     * "client gave up" from "we successfully ended the response." Attached BEFORE the slot
     * is acquired so a client that disconnects while queued releases its waiter immediately
     * instead of consuming an inflight slot.
     */
    const onClientDisconnect = (): void => {
      if (res.writableEnded) return;
      abort.abort();
    };
    res.on('close', onClientDisconnect);

    const acquired = await this.acquireSlot(abort.signal);
    if (!acquired) {
      res.removeListener('close', onClientDisconnect);
      return;
    }
    this.inflight.add(reqId);

    try {
      const rawBody = await this.readBoundedBody(req, res);
      if (rawBody === null) return;

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, SHUTDOWN_HEADERS);
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
        return;
      }

      const sdkModel = typeof body['model'] === 'string' ? (body['model'] as string) : '';

      const auth = await this.deps.resolveAuth(entry.backend);
      if (!auth) {
        res.writeHead(401, SHUTDOWN_HEADERS);
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: entry.backend === 'codex'
              ? 'Codex OAuth not signed in. Run "Damocles: Sign in to ChatGPT".'
              : 'OpenAI API key not configured. Run "Damocles: Set OpenAI API Key".',
          },
        }));
        return;
      }

      let translated: TranslatedRequest;
      try {
        const translateOpts: TranslateRequestOptions = { codexModel: sdkModel };
        const effort = this.deps.effortForPanelAndModel(entry.panelId, sdkModel);
        if (effort) translateOpts.effort = effort;
        const promptCacheKey = this.deps.promptCacheKeyForPanel?.(entry.panelId);
        if (promptCacheKey) translateOpts.promptCacheKey = promptCacheKey;
        translated = this.deps.translateAnthropicToCodex(body as unknown as AnthropicRequest, translateOpts);
      } catch (err) {
        res.writeHead(400, SHUTDOWN_HEADERS);
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: `Translation failed: ${stringifyError(err)}` },
        }));
        return;
      }

      if (sdkModel) {
        entry.currentModel = sdkModel;
        this.deps.recordModelForPanel(entry.panelId, sdkModel);
      }

      const requestBody = JSON.stringify(translated.body);
      const requestBytes = Buffer.byteLength(requestBody, 'utf8');
      if (requestBytes > MAX_BODY_BYTES) {
        const mb = (requestBytes / (1024 * 1024)).toFixed(1);
        const message = `Request body too large for OpenAI backend (${mb}mb). Trim attachments or compact context.`;
        this.writeAnthropicSseError(res, sdkModel, 'invalid_request_error', message);
        this.log('warn', reqId, entry.backend, sdkModel, `Oversized translated body ${mb}mb rejected`);
        return;
      }

      this.log('info', reqId, entry.backend, sdkModel, `→ upstream ${entry.backend === 'codex' ? CODEX_URL : APIKEY_URL} (${requestBytes}B)`);

      await this.forward({
        reqId,
        entry,
        sdkModel,
        auth,
        requestBody,
        toolNameMap: translated.toolNameMap,
        abort,
        res,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      this.log('error', reqId, entry.backend, entry.currentModel, `Forward error: ${stringifyError(err)}`);
      if (!res.headersSent) res.writeHead(502, SHUTDOWN_HEADERS);
      if (!res.writableEnded) {
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream error' } }));
      }
    } finally {
      res.removeListener('close', onClientDisconnect);
      req.socket.removeListener('timeout', onSocketTimeout);
      req.socket.setTimeout(0);
      this.inflight.delete(reqId);
      this.releaseSlot();
    }
  }

  private async forward(args: {
    reqId: string;
    entry: BridgeRouteEntry;
    sdkModel: string;
    auth: AuthResolveResult;
    requestBody: string;
    toolNameMap: Map<string, string>;
    abort: AbortController;
    res: http.ServerResponse;
  }): Promise<void> {
    const { reqId, entry, sdkModel, auth, requestBody, toolNameMap, abort, res } = args;
    const headers = buildUpstreamHeaders(entry.backend, auth);
    const targetUrl = entry.backend === 'codex' ? CODEX_URL : APIKEY_URL;

    let upstream: Response | null = null;
    let lastRateLimitBody = '';
    let retryAfterSeconds: number | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abort.signal.aborted) return;
      const timeoutSignal = AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS);
      const combinedSignal = AbortSignal.any([abort.signal, timeoutSignal]);
      try {
        upstream = await fetch(targetUrl, { method: 'POST', headers, body: requestBody, signal: combinedSignal });
      } catch (err) {
        const isTimeout = (err as Error)?.name === 'TimeoutError' || timeoutSignal.aborted;
        if (isTimeout) {
          this.log('error', reqId, entry.backend, sdkModel, `Upstream timeout after ${UPSTREAM_FETCH_TIMEOUT_MS / 1000}s`);
          this.writeAnthropicSseError(res, sdkModel, 'api_error', `Upstream timeout after ${UPSTREAM_FETCH_TIMEOUT_MS / 1000}s — Codex did not respond. Retry or switch to the Anthropic backend.`);
          return;
        }
        throw err;
      }
      if (upstream.status !== 429) break;

      lastRateLimitBody = await upstream.text();
      const ra = upstream.headers.get('Retry-After');
      if (ra) {
        const parsed = parseInt(ra, 10);
        if (Number.isFinite(parsed) && parsed > 0) retryAfterSeconds = parsed;
      }
      this.log('warn', reqId, entry.backend, sdkModel, `429 attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
      if (attempt < MAX_RETRIES) {
        await this.backoff(attempt, abort, retryAfterSeconds);
      }
    }

    if (!upstream || upstream.status === 429) {
      this.writeRateLimitResponse(res, retryAfterSeconds, lastRateLimitBody);
      return;
    }

    if (upstream.status === 401) {
      this.writeAnthropicSseError(
        res,
        sdkModel,
        'authentication_error',
        'OAuth token expired mid-stream; please retry the turn',
      );
      this.log('warn', reqId, entry.backend, sdkModel, '401 from upstream — background refresh expected');
      return;
    }

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      this.log('error', reqId, entry.backend, sdkModel, `Upstream ${upstream.status}: ${errorBody.slice(0, 200)}`);
      res.writeHead(upstream.status >= 500 ? 502 : 400, SHUTDOWN_HEADERS);
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: upstream.status >= 500 ? 'api_error' : 'invalid_request_error',
          message: `OpenAI backend error ${upstream.status}`,
        },
      }));
      return;
    }

    this.log('info', reqId, entry.backend, sdkModel, `← ${upstream.status}`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (!upstream.body) {
      if (!res.destroyed) res.end();
      return;
    }

    const transformer = new this.deps.CodexToAnthropicStream({ anthropicModel: sdkModel, toolNameMap });
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.destroyed) break;
        if (value) {
          const emits = transformer.write(value);
          if (emits.length > 0) res.write(emits.join(''));
        }
      }
      const tail = transformer.end();
      if (tail.length > 0 && !res.destroyed) res.write(tail.join(''));
    } catch (err) {
      this.log('error', reqId, entry.backend, sdkModel, `Stream error: ${stringifyError(err)}`);
    } finally {
      reader.releaseLock();
    }

    if (!res.destroyed) res.end();
  }

  private backoff(attempt: number, abort: AbortController, retryAfterSeconds: number | null): Promise<void> {
    const baseDelay = BASE_DELAY_MS * Math.pow(2, attempt);
    const delay = retryAfterSeconds !== null
      ? Math.max(baseDelay, retryAfterSeconds * 1000)
      : baseDelay;
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, delay);
      abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private writeRateLimitResponse(
    res: http.ServerResponse,
    retryAfterSeconds: number | null,
    lastRateLimitBody: string,
  ): void {
    res.writeHead(429, SHUTDOWN_HEADERS);
    const message = `OpenAI backend rate limit exceeded after ${MAX_RETRIES + 1} attempts. ${lastRateLimitBody.slice(0, 200)}`;
    const payload: Record<string, unknown> = {
      type: 'error',
      error: { type: 'rate_limit_error', message },
    };
    if (retryAfterSeconds !== null) payload['retry_after_seconds'] = retryAfterSeconds;
    res.end(JSON.stringify(payload));
  }

  /** Emit a single Anthropic-format SSE error event so the SDK's retry layer engages. */
  private writeAnthropicSseError(
    res: http.ServerResponse,
    _sdkModel: string,
    type: string,
    message: string,
  ): void {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const payload = JSON.stringify({ type: 'error', error: { type, message } });
    res.write(`event: error\ndata: ${payload}\n\n`);
    res.end();
  }

  private log(
    level: 'info' | 'warn' | 'error',
    reqId: string | null,
    backend: OpenAIBridgeAuthMode | null,
    model: string | null,
    message: string,
  ): void {
    const ts = new Date().toISOString();
    const parts = [
      `[${ts}]`,
      `[${level}]`,
      `[${reqId ?? '-'}]`,
      `[backend=${backend ?? '-'}]`,
      `[model=${model ?? '-'}]`,
      message,
    ];
    this.deps.output.appendLine(parts.join(' '));
  }
}

function buildUpstreamHeaders(backend: OpenAIBridgeAuthMode, auth: AuthResolveResult): Record<string, string> {
  if (backend === 'codex') {
    if (!auth.accountId) {
      throw new Error('Codex auth missing chatgpt-account-id');
    }
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${auth.token}`,
      'chatgpt-account-id': auth.accountId,
      'OpenAI-Beta': 'responses=experimental',
      'originator': 'codex_cli_rs',
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.token}`,
  };
}

function lastRouteEntry(routes: Map<string, BridgeRouteEntry>): BridgeRouteEntry | null {
  let latest: BridgeRouteEntry | null = null;
  for (const entry of routes.values()) {
    if (!latest || entry.createdAt > latest.createdAt) latest = entry;
  }
  return latest;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
