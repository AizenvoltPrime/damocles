// Open in Browser: one loopback server per previewed project root, guarded by a one-time token swapped for a per-port cookie
// (docs/invariants.md "Desktop host", HTML previews). Tokens, secrets and file contents never reach a log.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PreviewAnswer, PreviewRequest } from './preview-reader';
import { previewHeaders, previewUrlPath, RESERVED_PREVIEW_SEGMENT } from './serve-policy';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../../shared/relative-path';
import { SERVED_OPEN_QUERY } from '../../../shared/served-file-url';

export const OPEN_TOKEN_TTL_MS = 60_000;
const OPEN_PATH = `/${RESERVED_PREVIEW_SEGMENT}/open`;
// 256 bits each
const SECRET_BYTES = 32;
// a query as the URL serializer writes one: printable ASCII, no space or '#', so it is safe in a Location header
const URL_QUERY = /^[!"$-~]*$/;

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
// ports and a page on another loopback port can plant this server's cookie in its own jar. A browser that sends no
// Sec-Fetch-Site passes to the cookie check.
function crossOriginRefused(request: http.IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'none' && site !== 'same-origin';
}

// A top-level navigation shows its refusal to the user who followed a link; a subresource's stays empty.
function isDocumentNavigation(request: http.IncomingMessage): boolean {
  return request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
}

export class PreviewHttpServer {
  private readonly deps: PreviewHttpServerDeps;
  private readonly server: http.Server;
  // drawn per server, so a cookie a browser kept for an earlier server on the same port is refused
  private readonly secret = randomBytes(SECRET_BYTES).toString('base64url');
  // one-time tokens: token → the project path it opens and when it expires
  private readonly tokens = new Map<string, { readonly relativePath: string; readonly expires: number }>();
  private listening = 0;

  private constructor(deps: PreviewHttpServerDeps) {
    this.deps = deps;
    this.server = http.createServer((request, response) => {
      this.answer(request, response).catch((err: unknown) => {
        this.deps.log(`[html-preview] answering a browser request failed: ${err instanceof Error ? err.message : String(err)}`);
        response.destroy();
      });
    });
  }

  /** Listens on 127.0.0.1 at a free port; the server never holds the process open. */
  static async start(deps: PreviewHttpServerDeps): Promise<PreviewHttpServer> {
    const preview = new PreviewHttpServer(deps);
    await new Promise<void>((resolve, reject) => {
      preview.server.once('error', reject);
      preview.server.listen(0, '127.0.0.1', () => {
        preview.server.off('error', reject);
        resolve();
      });
    });
    // a later accept failure (EMFILE) with no listener would throw in main
    preview.server.on('error', (err) => deps.log(`[html-preview] a preview's browser port failed: ${err.message}`));
    preview.server.unref();
    preview.listening = (preview.server.address() as AddressInfo).port;
    return preview;
  }

  get port(): number {
    return this.listening;
  }

  private get cookieName(): string {
    return `damocles_preview_${this.listening}`;
  }

  /**
   * A one-time URL that opens relativePath in the browser: valid once, for OPEN_TOKEN_TTL_MS. Its SERVED_OPEN_QUERY, which the
   * opener may add, becomes the query of the redirect to the file.
   */
  openUrl(relativePath: string): string {
    const now = this.now();
    for (const [token, entry] of this.tokens) if (entry.expires <= now) this.tokens.delete(token);
    const token = randomBytes(SECRET_BYTES).toString('base64url');
    this.tokens.set(token, { relativePath, expires: now + OPEN_TOKEN_TTL_MS });
    const query = new URLSearchParams({ t: token, p: relativePath });
    return `http://127.0.0.1:${this.listening}${OPEN_PATH}?${query.toString()}`;
  }

  /** Closes the port and every connection to it; tokens and the secret die with it. */
  async close(): Promise<void> {
    this.tokens.clear();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
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

  // The checks run in this order: Host (DNS rebinding), method, Fetch Metadata, then the token exchange or the cookie.
  private async answer(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${this.listening}` && host !== `localhost:${this.listening}`) return this.refuse(response, 421);
    const method = request.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return this.refuse(response, 405);
    if (crossOriginRefused(request)) return this.refuse(response, 403, isDocumentNavigation(request) ? this.deps.refusalText() : undefined);
    const target = request.url ?? '';
    const queryAt = target.indexOf('?');
    const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
    if (pathname === OPEN_PATH) return this.exchange(response, method, new URLSearchParams(queryAt < 0 ? '' : target.slice(queryAt + 1)));
    const presented = cookieValue(request.headers.cookie, this.cookieName);
    if (presented === undefined || !sameSecret(presented, this.secret)) return this.refuse(response, 403, this.deps.refusalText());
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

  // A GET spends the token on its first use, valid or not for that path; the cookie then carries the server's secret. The query
  // the opener added is not bound to the token: it only shapes the address of the file the token opens.
  private exchange(response: http.ServerResponse, method: string, query: URLSearchParams): void {
    if (method !== 'GET') {
      this.refuse(response, 403, this.deps.refusalText());
      return;
    }
    const token = query.get('t') ?? '';
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    const relativePath = query.get('p');
    const search = query.get(SERVED_OPEN_QUERY) ?? '';
    if (!entry || entry.expires <= this.now() || relativePath !== entry.relativePath || !isRelativeFilePath(relativePath) || hasUnsafeWindowsSegment(relativePath) || !URL_QUERY.test(search)) {
      this.refuse(response, 403, this.deps.refusalText());
      return;
    }
    response.writeHead(303, {
      ...previewHeaders(this.deps.trusted(), 'browser'),
      'Set-Cookie': `${this.cookieName}=${this.secret}; HttpOnly; SameSite=Strict; Path=/`,
      Location: `${previewUrlPath(relativePath)}${search === '' ? '' : `?${search}`}`,
    }).end();
  }
}
