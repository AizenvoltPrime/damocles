// The loopback server a design opens in the user's browser from (docs/invariants.md "Design mode"). Desktop main may import
// it (PD-35, MAIN_CORE_IMPORTS), so it imports Node built-ins, the logger, shared helpers and serve-policy only.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DesignFidelity } from '../../shared/types/design';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { log } from '../logger';
import { servedContentType, servedHeaders } from './serve-policy';

// The loopback literal, never `localhost`, which can resolve to another address.
const LOOPBACK_HOST = '127.0.0.1';
const TOKEN_BYTES = 32;
const PATH_PREFIX = '/d/';

/** A design as one host serves it: the authority whose core holds it, and its id. */
export interface DesignServeTarget {
  readonly authority: string;
  readonly designId: string;
}

export type DesignServeRead =
  | { readonly kind: 'file'; readonly bytes: Uint8Array; readonly fidelity: DesignFidelity | null }
  | { readonly kind: 'missing' | 'outside' | 'tooLarge' };

/** Reads `relPath` of `target` for the server; it is called only with a path that passed the server's own checks. */
export type DesignServeReader = (target: DesignServeTarget, relPath: string) => Promise<DesignServeRead>;

const STATUS_TEXT: Readonly<Record<number, string>> = { 404: 'Not found', 405: 'Method not allowed', 421: 'Misdirected request', 500: 'Internal server error' };

function targetKey(target: DesignServeTarget): string {
  return `${target.authority}\0${target.designId}`;
}

/** The token and the once-decoded relative path of a request target `/d/<token>/<relPath>`, or undefined for any other. */
function requestPath(url: string | undefined): { readonly token: string; readonly relPath: string | undefined } | undefined {
  if (url === undefined || !url.startsWith(PATH_PREFIX)) return undefined;
  const query = url.indexOf('?');
  const rest = (query === -1 ? url : url.slice(0, query)).slice(PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return undefined;
  let relPath: string;
  try {
    relPath = decodeURIComponent(rest.slice(slash + 1));
  } catch (err) {
    if (err instanceof URIError) return { token: rest.slice(0, slash), relPath: undefined };
    throw err;
  }
  // Decoded once: `%252e%252e` stays the literal name `%2e%2e`, and a decoded `\`, NUL, `.` or `..` segment is refused.
  const valid = isRelativeFilePath(relPath) && !hasUnsafeWindowsSegment(relPath);
  return { token: rest.slice(0, slash), relPath: valid ? relPath : undefined };
}

/**
 * Serves each open design under `/d/<token>/` on 127.0.0.1, bound on the first open and closed when no token remains. The
 * token is 32 random bytes per `(authority, designId)`; requests are GET only, and their Host must be the loopback
 * authority or one `allowHost` added.
 */
export class DesignHttpServer {
  private readonly read: DesignServeReader;
  private readonly targets = new Map<string, DesignServeTarget>();
  private readonly tokens = new Map<string, string>();
  private readonly allowedHosts = new Set<string>();
  private server: Server | undefined;
  private port: number | undefined;
  private binding: Promise<number> | undefined;
  private disposed = false;

  constructor(read: DesignServeReader) {
    this.read = read;
  }

  /** The loopback URL of `relPath` in `target`, minting the target's token on its first open. */
  async urlOf(target: DesignServeTarget, relPath: string): Promise<string> {
    if (this.disposed) throw new Error('The design server was disposed');
    if (!isRelativeFilePath(relPath) || hasUnsafeWindowsSegment(relPath)) throw new Error(`Not a design file path: ${JSON.stringify(relPath)}`);
    const key = targetKey(target);
    let token = this.tokens.get(key);
    if (token === undefined) {
      token = randomBytes(TOKEN_BYTES).toString('base64url');
      this.tokens.set(key, token);
      this.targets.set(token, { authority: target.authority, designId: target.designId });
    }
    const port = await this.listening();
    if (!this.targets.has(token)) {
      this.closeWhenIdle();
      throw new Error(`Design ${target.designId} was closed while its server started`);
    }
    return `http://${LOOPBACK_HOST}:${port}${PATH_PREFIX}${token}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Accepts requests whose Host is `authority` (`host[:port]`, as a forwarded URL names it) until the server closes. */
  allowHost(authority: string): void {
    if (this.server) this.allowedHosts.add(authority.toLowerCase());
  }

  /** `target`'s URL stops working; with no token left the server closes. */
  revoke(target: DesignServeTarget): void {
    const key = targetKey(target);
    const token = this.tokens.get(key);
    if (token === undefined) return;
    this.tokens.delete(key);
    this.targets.delete(token);
    log('[DesignHttpServer] closed design %s', target.designId);
    this.closeWhenIdle();
  }

  /** Revokes every token and closes the server, cutting open connections. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.tokens.clear();
    this.targets.clear();
    return this.close();
  }

  /** The bound port, or undefined while the server is closed. */
  boundPort(): number | undefined {
    return this.port;
  }

  private listening(): Promise<number> {
    if (this.port !== undefined) return Promise.resolve(this.port);
    this.binding ??= this.bind().finally(() => {
      this.binding = undefined;
    });
    return this.binding;
  }

  private async bind(): Promise<number> {
    const server = createServer((req, res) => this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, LOOPBACK_HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      server.close();
      throw err;
    }
    server.on('error', (err) => log('[DesignHttpServer] server error: %O', err));
    // The browser's tab never keeps the host process alive.
    server.unref();
    if (this.disposed) {
      server.close();
      throw new Error('The design server was disposed');
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    log('[DesignHttpServer] listening on %s:%d', LOOPBACK_HOST, this.port);
    return this.port;
  }

  private closeWhenIdle(): void {
    if (this.targets.size > 0 || this.binding) return;
    void this.close();
  }

  private close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.allowedHosts.clear();
    if (!server) return Promise.resolve();
    log('[DesignHttpServer] closed');
    return new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) log('[DesignHttpServer] close failed: %O', err);
        resolve();
      });
      // A keep-alive connection would otherwise outlive the close and reach the next server's tokens.
      server.closeAllConnections();
    });
  }

  private hostAllowed(host: string | undefined): boolean {
    if (host === undefined || this.port === undefined) return false;
    const authority = host.toLowerCase();
    return authority === `${LOOPBACK_HOST}:${this.port}` || authority === `localhost:${this.port}` || this.allowedHosts.has(authority);
  }

  private refuse(res: ServerResponse, status: 404 | 405 | 421 | 500): void {
    res.writeHead(status, {
      ...servedHeaders(null),
      'Content-Type': 'text/plain; charset=utf-8',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    });
    res.end(STATUS_TEXT[status]);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.hostAllowed(req.headers.host)) return this.refuse(res, 421);
    if (req.method !== 'GET') return this.refuse(res, 405);
    const request = requestPath(req.url);
    if (!request) return this.refuse(res, 404);
    const target = this.targets.get(request.token);
    if (!target) {
      log('[DesignHttpServer] refused a request with an unknown token');
      return this.refuse(res, 404);
    }
    if (request.relPath === undefined) {
      log('[DesignHttpServer] refused a path of design %s that is not a relative file path', target.designId);
      return this.refuse(res, 404);
    }
    const contentType = servedContentType(request.relPath);
    if (contentType === undefined) {
      log('[DesignHttpServer] refused %s of design %s, whose type is not served', request.relPath, target.designId);
      return this.refuse(res, 404);
    }
    this.serve(res, request.token, target, request.relPath, contentType).catch((err: unknown) => {
      log('[DesignHttpServer] reading %s of design %s failed: %O', request.relPath, target.designId, err);
      if (res.headersSent) res.destroy();
      else this.refuse(res, 500);
    });
  }

  private async serve(res: ServerResponse, token: string, target: DesignServeTarget, relPath: string, contentType: string): Promise<void> {
    const file = await this.read(target, relPath);
    if (this.targets.get(token) !== target) return this.refuse(res, 404);
    if (file.kind !== 'file') {
      log('[DesignHttpServer] refused %s of design %s: %s', relPath, target.designId, file.kind);
      return this.refuse(res, 404);
    }
    res.writeHead(200, { ...servedHeaders(file.fidelity), 'Content-Type': contentType, 'Content-Length': String(file.bytes.byteLength) });
    res.end(file.bytes);
  }
}
