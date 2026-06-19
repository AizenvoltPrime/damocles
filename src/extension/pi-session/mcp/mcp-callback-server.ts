/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Localhost (127.0.0.1 / localhost) HTTP server that captures the OAuth authorization code and
 * CSRF state from the browser redirect. Singleton bound lazily from the auth flow; owns the
 * configured callback port/path so the OAuth provider can derive its redirect URL.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { log } from '../../logger';

const DEFAULT_OAUTH_CALLBACK_PORT = 19876;
const DEFAULT_OAUTH_CALLBACK_PATH = '/callback';
// Bind the loopback literal, not the `localhost` hostname (which can resolve to a non-loopback or
// dual-stack address and is not guaranteed to land on this server) (L2).
const DEFAULT_OAUTH_CALLBACK_HOST = '127.0.0.1';

function resolveConfiguredPort(): number {
  const raw = process.env['MCP_OAUTH_CALLBACK_PORT'];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_OAUTH_CALLBACK_PORT;
}

const configuredOAuthCallbackPort = resolveConfiguredPort();
let oauthCallbackPort = configuredOAuthCallbackPort;
let oauthCallbackPath = DEFAULT_OAUTH_CALLBACK_PATH;
let callbackServerHost = DEFAULT_OAUTH_CALLBACK_HOST;

/** The statically configured (env/default) callback port, before any OS-assigned rebind. */
export function getConfiguredOAuthCallbackPort(): number {
  return configuredOAuthCallbackPort;
}

/** The port the callback server is currently bound to. */
export function getOAuthCallbackPort(): number {
  return oauthCallbackPort;
}

/** The path the callback server currently listens on. */
export function getOAuthCallbackPath(): string {
  return oauthCallbackPath;
}

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Damocles - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Damocles.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MAX_CALLBACK_ERROR_LENGTH = 300;

/**
 * Flatten + cap a server-supplied error string before it becomes a thrown Error (which flows to logs and
 * the webview error surface). Collapsing newlines stops log forging / UI text injection (M4); HTML output
 * is separately escaped via escapeHtml.
 */
function flattenServerError(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_CALLBACK_ERROR_LENGTH ? `${flattened.slice(0, MAX_CALLBACK_ERROR_LENGTH)}…` : flattened;
}

// The authorization code rides in the request URL, so every response must forbid caching and stop the
// page from leaking that URL as a `Referer`; the CSP blocks any subresource/network load (the pages are
// fully self-contained, with only inline style + the success page's inline window.close()) (M1).
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
} as const;

function htmlHeaders(): Record<string, string> {
  return { 'Content-Type': 'text/html', ...SECURITY_HEADERS };
}

function textHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'text/plain', ...SECURITY_HEADERS, ...extra };
}

function htmlError(error: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Damocles - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`;
}

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let server: Server | undefined;
let bindingPromise: Promise<void> | undefined;
const pendingAuths = new Map<string, PendingAuth>();
const reservedAuthStates = new Set<string>();

/** Timeout for callback completion (5 minutes). */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Options controlling how the callback server binds and reserves a flow's CSRF state. */
export interface EnsureCallbackServerOptions {
  strictPort?: boolean;
  port?: number;
  callbackHost?: string;
  callbackPath?: string;
  oauthState?: string;
  reserveState?: boolean;
}

function setOAuthCallbackPath(path: string): void {
  oauthCallbackPath = path.startsWith('/') ? path : `/${path}`;
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method && req.method !== 'GET') {
    res.writeHead(405, textHeaders({ Allow: 'GET' }));
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname !== oauthCallbackPath) {
    res.writeHead(404, textHeaders());
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (!state) {
    res.writeHead(400, htmlHeaders());
    res.end(htmlError('Missing required state parameter - potential CSRF attack'));
    return;
  }

  // State is matched by map lookup (not a constant-time compare): it is a 256-bit CSPRNG value, single-use,
  // 5-min TTL, and the endpoint is loopback-only — a timing side-channel to recover it is not exploitable (M5).
  const pending = pendingAuths.get(state);
  const isReserved = reservedAuthStates.has(state);

  if (error) {
    if (!pending && !isReserved) {
      res.writeHead(400, htmlHeaders());
      res.end(htmlError('Invalid or expired state parameter - potential CSRF attack'));
      return;
    }

    const errorMsg = flattenServerError(errorDescription || error);
    res.writeHead(200, htmlHeaders());
    res.end(htmlError(errorMsg));
    reservedAuthStates.delete(state);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAuths.delete(state);
      setTimeout(() => pending.reject(new Error(errorMsg)), 0);
    }
    return;
  }

  if (!pending) {
    res.writeHead(400, htmlHeaders());
    res.end(htmlError('Invalid or expired state parameter - potential CSRF attack'));
    return;
  }

  if (!code) {
    res.writeHead(400, htmlHeaders());
    res.end(htmlError('No authorization code provided'));
    return;
  }

  clearTimeout(pending.timeout);
  pendingAuths.delete(state);
  pending.resolve(code);

  res.writeHead(200, htmlHeaders());
  res.end(HTML_SUCCESS);
}

/**
 * Ensure the callback server is running. With `strictPort` it binds the exact configured port
 * (required for pre-registered redirect URIs); otherwise it asks the OS for a free local port.
 * Serialized so concurrent callers share one in-flight bind.
 */
export async function ensureCallbackServer(options: EnsureCallbackServerOptions = {}): Promise<void> {
  while (bindingPromise) {
    await bindingPromise;
  }

  const operation = ensureCallbackServerLocked(options);
  bindingPromise = operation;
  try {
    await operation;
  } finally {
    if (bindingPromise === operation) {
      bindingPromise = undefined;
    }
  }
}

async function ensureCallbackServerLocked(options: EnsureCallbackServerOptions = {}): Promise<void> {
  const requiredPort = options.port ?? configuredOAuthCallbackPort;
  const strictPort = options.strictPort === true;
  const requestedHost = options.callbackHost ?? DEFAULT_OAUTH_CALLBACK_HOST;
  const rawRequestedPath = options.callbackPath ?? DEFAULT_OAUTH_CALLBACK_PATH;
  const requestedPath = rawRequestedPath.startsWith('/') ? rawRequestedPath : `/${rawRequestedPath}`;
  if (options.reserveState && !options.oauthState) {
    throw new Error('OAuth callback reservation requires an oauthState');
  }
  let reservedState: string | undefined;

  const previousServer = server;
  const needsStrictRebind = Boolean(previousServer && strictPort && oauthCallbackPort !== requiredPort);
  const needsHostSwitch = Boolean(previousServer && callbackServerHost !== requestedHost);
  const needsPathSwitch = Boolean(previousServer && oauthCallbackPath !== requestedPath);

  if (previousServer) {
    if (!needsStrictRebind && !needsHostSwitch) {
      if (needsPathSwitch) {
        if (pendingAuths.size > 0 || reservedAuthStates.size > 0) {
          throw new Error(
            `OAuth callback server is using path ${oauthCallbackPath}, but callback path ${requestedPath} is required and cannot be switched while authorizations are pending`,
          );
        }
        setOAuthCallbackPath(requestedPath);
      }
      if (options.reserveState && options.oauthState) {
        reservedAuthStates.add(options.oauthState);
        reservedState = options.oauthState;
      }
      return;
    }

    if (pendingAuths.size > 0 || reservedAuthStates.size > 0) {
      throw new Error(
        `OAuth callback server is running on ${callbackServerHost}:${oauthCallbackPort}, but strict callback endpoint ${requestedHost}:${requiredPort} is required and cannot be switched while authorizations are pending`,
      );
    }
  }

  const candidateServer = createServer(handleRequest);
  const listenPort = strictPort ? requiredPort : 0;

  try {
    await new Promise<void>((resolve, reject) => {
      candidateServer.once('error', (err) => {
        reject(err);
      });
      candidateServer.listen(listenPort, requestedHost, () => {
        resolve();
      });
    });

    if (strictPort) {
      oauthCallbackPort = requiredPort;
    } else {
      const address = candidateServer.address();
      if (!address || typeof address === 'string' || typeof address.port !== 'number') {
        throw new Error('OAuth callback server did not report an assigned port');
      }
      oauthCallbackPort = address.port;
    }

    if (previousServer && (needsStrictRebind || needsHostSwitch)) {
      await new Promise<void>((resolve) => {
        previousServer.close(() => resolve());
      });
    }

    callbackServerHost = requestedHost;
    setOAuthCallbackPath(requestedPath);
    server = candidateServer;
    if (options.reserveState && options.oauthState) {
      reservedAuthStates.add(options.oauthState);
      reservedState = options.oauthState;
    }
    server.unref();
  } catch (error) {
    if (reservedState) {
      reservedAuthStates.delete(reservedState);
    }
    const nodeError = error as NodeJS.ErrnoException;
    await new Promise<void>((resolve) => {
      candidateServer.close(() => resolve());
    });

    if (strictPort && nodeError.code === 'EADDRINUSE') {
      throw new Error(
        `OAuth callback port ${requiredPort} is already in use. Pre-registered OAuth clients require an exact redirect URI; set MCP_OAUTH_CALLBACK_PORT to your registered port or free port ${requiredPort}`,
        { cause: error },
      );
    }

    throw error;
  }
}

/** Reserve a flow's CSRF state so an in-flight error callback is honored before binding. */
export function reserveCallbackServer(oauthState: string): void {
  reservedAuthStates.add(oauthState);
}

/** Release a previously reserved CSRF state. */
export function releaseCallbackServer(oauthState: string): void {
  reservedAuthStates.delete(oauthState);
}

/** Wait for the browser redirect carrying the given CSRF state; resolves with the auth code. */
export function waitForCallback(oauthState: string): Promise<string> {
  reservedAuthStates.delete(oauthState);
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState);
        reject(new Error('OAuth callback timeout - authorization took too long'));
      }
    }, CALLBACK_TIMEOUT_MS);

    pendingAuths.set(oauthState, { resolve, reject, timeout });
  });
}

/** Cancel a pending authorization by CSRF state, rejecting its waiter. */
export function cancelPendingCallback(oauthState: string): void {
  reservedAuthStates.delete(oauthState);
  const pending = pendingAuths.get(oauthState);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingAuths.delete(oauthState);
    pending.reject(new Error('Authorization cancelled'));
  }
}

/** Stop the callback server, reset bind config, and reject all pending authorizations. */
export async function stopCallbackServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve();
      });
    });
    server = undefined;
  }

  oauthCallbackPort = configuredOAuthCallbackPort;
  callbackServerHost = DEFAULT_OAUTH_CALLBACK_HOST;
  setOAuthCallbackPath(DEFAULT_OAUTH_CALLBACK_PATH);

  const pendingList = Array.from(pendingAuths.entries());
  pendingAuths.clear();
  reservedAuthStates.clear();
  setTimeout(() => {
    for (const [, pending] of pendingList) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('OAuth callback server stopped'));
    }
  }, 0);
  log('[McpCallbackServer] stopped');
}

/** Whether the callback server is currently bound. */
export function isCallbackServerRunning(): boolean {
  return server !== undefined;
}

/** Number of pending (awaiting-callback) authorizations. */
export function getPendingAuthCount(): number {
  return pendingAuths.size;
}
