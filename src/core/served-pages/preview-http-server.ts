// One loopback server per served root (Open in Browser, the agent's browser). Each holder of the root has a grant of its own: a
// host, a one-time token swapped for a cookie on that host, and its secret (docs/invariants.md "Desktop host", HTML previews,
// and "Browser"). Tokens, secrets, grant hosts and file contents never reach a log.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PreviewAnswer, PreviewRequest } from './preview-reader';
import { previewHeaders, previewUrlPath, RESERVED_PREVIEW_SEGMENT } from './serve-policy';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { SERVED_OPEN_QUERY } from '../../shared/served-file-url';

export const OPEN_TOKEN_TTL_MS = 60_000;
const OPEN_PATH = `/${RESERVED_PREVIEW_SEGMENT}/open`;
// 256 bits each
const SECRET_BYTES = 32;
// a grant host's label: 128 bits, lowercase hex, one DNS label (isServedGrantHost)
const LABEL_BYTES = 16;
// a query as the URL serializer writes one: printable ASCII, no space or '#', so it is safe in a Location header
const URL_QUERY = /^[!"$-~]*$/;
// Chrome connects a *.localhost name to ::1 first, so the port is held there too; these mean this computer has no ::1
const NO_IPV6_LOOPBACK: ReadonlySet<string | undefined> = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
// ports tried when another program holds the chosen port on ::1
const PORT_ATTEMPTS = 3;

export interface PreviewHttpServerDeps {
  // GET or HEAD of a URL path (still percent-encoded) for the system browser, as the scheme serves it
  readonly serve: (request: Pick<PreviewRequest, 'method' | 'pathname' | 'range' | 'ifRange'>) => Promise<PreviewAnswer>;
  // whether the root's pages run scripts now, for the CSP of the server's own refusals
  readonly trusted: () => boolean;
  // "Open this preview from Damocles.", in main's language
  readonly refusalText: () => string;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

/** One holder's access to the root: its origin and the one-time URLs that set its cookie. */
export interface PreviewGrant {
  // http://<label>.localhost:<port>, or http://127.0.0.1:<port> for the loopback grant
  readonly origin: string;
  /**
   * A one-time URL on the grant's origin that opens relativePath: valid once, for OPEN_TOKEN_TTL_MS. Its SERVED_OPEN_QUERY,
   * which the opener may add, becomes the query of the redirect to the file.
   */
  openUrl(relativePath: string): string;
}

// 'own': a host of its own under localhost, for a chat view in the shared agent browser; 'loopback': 127.0.0.1 and localhost,
// for Open in Browser, whose system browser may not resolve *.localhost
export type GrantHost = 'own' | 'loopback';

interface Grant {
  readonly origin: string;
  // the Host values it answers, lowercase with the port
  readonly hosts: readonly string[];
  readonly secret: string;
  // one-time tokens: token → the project path it opens and when it expires
  readonly tokens: Map<string, { readonly relativePath: string; readonly expires: number }>;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function sameSecret(presented: string, secret: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Fetch Metadata: only the browser's own navigation (none) and the page's own origin (same-origin) pass, since cookies ignore
// ports and a page on another loopback port can plant a cookie for a loopback grant's host in its own jar. A browser that sends
// no Sec-Fetch-Site passes to the cookie check.
function crossOriginRefused(request: http.IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'none' && site !== 'same-origin';
}

// A top-level navigation shows its refusal to the user who followed a link; a subresource's stays empty.
function isDocumentNavigation(request: http.IncomingMessage): boolean {
  return request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export class PreviewHttpServer {
  private readonly deps: PreviewHttpServerDeps;
  // on 127.0.0.1
  private readonly server: http.Server;
  // on ::1 at the same port, where this computer has ::1
  private readonly v6Server: http.Server;
  private v6Listening = false;
  // by holder, and by each Host value they answer
  private readonly grants = new Map<string, Grant>();
  private readonly hosts = new Map<string, Grant>();
  private listening = 0;

  private constructor(deps: PreviewHttpServerDeps) {
    this.deps = deps;
    const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      this.answer(request, response).catch((err: unknown) => {
        this.deps.log(`[html-preview] answering a browser request failed: ${err instanceof Error ? err.message : String(err)}`);
        response.destroy();
      });
    };
    this.server = http.createServer(handler);
    this.v6Server = http.createServer(handler);
  }

  /** Listens on 127.0.0.1 and ::1 at one free port; the server never holds the process open. */
  static async start(deps: PreviewHttpServerDeps): Promise<PreviewHttpServer> {
    for (let attempt = 1; ; attempt++) {
      const preview = new PreviewHttpServer(deps);
      await listen(preview.server, 0, '127.0.0.1');
      const port = (preview.server.address() as AddressInfo).port;
      const v6Failure = await listen(preview.v6Server, port, '::1').then(() => undefined, (err: NodeJS.ErrnoException) => err);
      if (v6Failure === undefined || NO_IPV6_LOOPBACK.has(v6Failure.code)) {
        preview.v6Listening = v6Failure === undefined;
        // a later accept failure (EMFILE) with no listener would throw in main
        for (const server of preview.servers()) {
          server.on('error', (err) => deps.log(`[html-preview] a preview's browser port failed: ${err.message}`));
          server.unref();
        }
        preview.listening = port;
        return preview;
      }
      await preview.close();
      if (v6Failure.code !== 'EADDRINUSE' || attempt === PORT_ATTEMPTS) throw v6Failure;
    }
  }

  get port(): number {
    return this.listening;
  }

  private get cookieName(): string {
    return `damocles_preview_${this.listening}`;
  }

  /** The holder's grant, made at its first call: one host, secret and token set per holder, until revoke. */
  grant(holder: string, host: GrantHost): PreviewGrant {
    let grant = this.grants.get(holder);
    if (!grant) {
      const port = this.listening;
      const hosts = host === 'own' ? [`${randomBytes(LABEL_BYTES).toString('hex')}.localhost:${port}`] : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (hosts.some((value) => this.hosts.has(value))) throw new Error('A served root has one loopback grant');
      grant = { origin: `http://${hosts[0]}`, hosts, secret: randomBytes(SECRET_BYTES).toString('base64url'), tokens: new Map() };
      this.grants.set(holder, grant);
      for (const value of hosts) this.hosts.set(value, grant);
    }
    const held = grant;
    return { origin: held.origin, openUrl: (relativePath) => this.openUrl(held, relativePath) };
  }

  /** The holder's host, tokens and secret go at once: every later request on its host is refused, an open connection's too. */
  revoke(holder: string): void {
    const grant = this.grants.get(holder);
    if (!grant) return;
    this.grants.delete(holder);
    for (const value of grant.hosts) this.hosts.delete(value);
  }

  /** Closes the port and every connection to it; grants die with it. */
  async close(): Promise<void> {
    this.grants.clear();
    this.hosts.clear();
    await Promise.all(this.servers().map((server) => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      return closed;
    }));
  }

  private servers(): http.Server[] {
    return this.v6Listening ? [this.server, this.v6Server] : [this.server];
  }

  private openUrl(grant: Grant, relativePath: string): string {
    if (this.hosts.get(grant.hosts[0]!) !== grant) throw new Error('The served grant was revoked');
    const now = this.now();
    for (const [token, entry] of grant.tokens) if (entry.expires <= now) grant.tokens.delete(token);
    const token = randomBytes(SECRET_BYTES).toString('base64url');
    grant.tokens.set(token, { relativePath, expires: now + OPEN_TOKEN_TTL_MS });
    const query = new URLSearchParams({ t: token, p: relativePath });
    return `${grant.origin}${OPEN_PATH}?${query.toString()}`;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private refuse(response: http.ServerResponse, status: number, text?: string): void {
    const headers: Record<string, string> = { ...previewHeaders(this.deps.trusted(), 'browser'), ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) };
    if (text === undefined) {
      response.writeHead(status, headers).end();
      return;
    }
    response.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
  }

  // The checks run in this order: Host (a live grant's, so neither DNS rebinding nor another holder's host passes), method,
  // Fetch Metadata, then the token exchange or the cookie of that grant.
  private async answer(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const grant = this.hosts.get(request.headers.host?.toLowerCase() ?? '');
    if (!grant) return this.refuse(response, 421);
    const method = request.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return this.refuse(response, 405);
    if (crossOriginRefused(request)) return this.refuse(response, 403, isDocumentNavigation(request) ? this.deps.refusalText() : undefined);
    const target = request.url ?? '';
    const queryAt = target.indexOf('?');
    const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
    if (pathname === OPEN_PATH) return this.exchange(grant, response, method, new URLSearchParams(queryAt < 0 ? '' : target.slice(queryAt + 1)));
    const presented = cookieValue(request.headers.cookie, this.cookieName);
    if (presented === undefined || !sameSecret(presented, grant.secret)) return this.refuse(response, 403, this.deps.refusalText());
    const answer = await this.deps.serve({ method, pathname, range: request.headers.range, ifRange: request.headers['if-range']?.toString() });
    response.writeHead(answer.status, answer.headers);
    if (answer.body === undefined || typeof answer.body === 'string') {
      response.end(answer.body);
      return;
    }
    // one chunk read ahead and the socket's backpressure pace the read; a browser that goes away ends the pipeline, which
    // releases the root's read
    await pipeline(Readable.from(answer.body, { highWaterMark: 1 }), response).catch((err: unknown) => {
      if (!response.destroyed) this.deps.log(`[html-preview] sending a file to the browser failed: ${err instanceof Error ? err.message : String(err)}`);
      response.destroy();
    });
  }

  // A GET spends a token of the grant whose host it came on, on its first use, valid or not for that path; the host-only cookie
  // then carries that grant's secret. The query the opener added is not bound to the token: it only shapes the address of the
  // file the token opens.
  private exchange(grant: Grant, response: http.ServerResponse, method: string, query: URLSearchParams): void {
    if (method !== 'GET') {
      this.refuse(response, 403, this.deps.refusalText());
      return;
    }
    const token = query.get('t') ?? '';
    const entry = grant.tokens.get(token);
    grant.tokens.delete(token);
    const relativePath = query.get('p');
    const search = query.get(SERVED_OPEN_QUERY) ?? '';
    if (!entry || entry.expires <= this.now() || relativePath !== entry.relativePath || !isRelativeFilePath(relativePath) || hasUnsafeWindowsSegment(relativePath) || !URL_QUERY.test(search)) {
      this.refuse(response, 403, this.deps.refusalText());
      return;
    }
    response.writeHead(303, {
      ...previewHeaders(this.deps.trusted(), 'browser'),
      'Set-Cookie': `${this.cookieName}=${grant.secret}; HttpOnly; SameSite=Strict; Path=/`,
      Location: `${previewUrlPath(relativePath)}${search === '' ? '' : `?${search}`}`,
    }).end();
  }
}
