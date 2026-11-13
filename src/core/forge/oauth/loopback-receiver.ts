import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { l } from '../../l10n';
import { ForgeSignInError } from '../types';
import { sameSecret } from './pkce';

// The RFC 8252 loopback redirect receiver of a browser sign-in, after VS Code's github-authentication flows.ts 288 (MIT).
// It binds a free port of 127.0.0.1 only, takes one GET on the exact path after a Host check, compares state in constant time, serves a
// static page that reflects nothing, and never logs the code.

export const CALLBACK_PATH = '/callback';
// GitHub and GitLab (Doorkeeper) ignore the port of a loopback IP redirect (RFC 8252 7.3), so an app registers it portless
export const REGISTERED_REDIRECT_URI: string = `http://127.0.0.1${CALLBACK_PATH}`;
export const RECEIVER_TIMEOUT_MS: number = 5 * 60_000;

const PAGE_CSP = "default-src 'none'";
const DONE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Damocles</title></head><body><h1>You are signed in</h1><p>You can close this tab and return to Damocles.</p></body></html>';
const FAILED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Damocles</title></head><body><h1>The sign-in did not finish</h1><p>Return to Damocles and start the sign-in again.</p></body></html>';

export interface LoopbackReceiver {
  readonly port: number;
  /** http://127.0.0.1:<port>/callback */
  readonly redirectUri: string;
  /** The authorization code of the one callback with the right state. */
  readonly code: Promise<string>;
  close(): void;
}

export interface LoopbackOptions {
  readonly state: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly log: (line: string) => void;
}

function respond(response: http.ServerResponse, status: number, page?: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  response.end(page ?? '');
}

export async function startLoopbackReceiver(options: LoopbackOptions): Promise<LoopbackReceiver> {
  const { signal, log } = options;
  if (signal.aborted) throw new ForgeSignInError('cancelled', l('Sign-in cancelled.'));
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  // the caller may close before awaiting the code
  code.catch(() => undefined);
  let port = 0;
  let done = false;
  const server = http.createServer((request, response) => {
    request.resume();
    const expectedHost = `127.0.0.1:${port}`;
    if (done) return respond(response, 410, FAILED_PAGE);
    if (request.headers.host !== expectedHost) return respond(response, 400);
    if (request.method !== 'GET') return respond(response, 405);
    // a crafted request target must not throw inside the listener
    if (!URL.canParse(request.url ?? '/', `http://${expectedHost}`)) return respond(response, 400);
    const url = new URL(request.url ?? '/', `http://${expectedHost}`);
    if (url.pathname !== CALLBACK_PATH) return respond(response, 404);
    const state = url.searchParams.get('state');
    if (state === null || !sameSecret(state, options.state)) {
      log('[forge] the sign-in callback had another sign-in\'s state; ignored');
      return respond(response, 400, FAILED_PAGE);
    }
    const error = url.searchParams.get('error');
    const received = url.searchParams.get('code');
    if (error !== null || received === null || received === '') {
      respond(response, 200, FAILED_PAGE);
      finish(new ForgeSignInError('denied', l('The sign-in was denied.')));
      return;
    }
    respond(response, 200, DONE_PAGE);
    finish(received);
  });
  const timer = setTimeout(() => finish(new ForgeSignInError('expired', l('The browser sign-in timed out. Start it again.'))), options.timeoutMs ?? RECEIVER_TIMEOUT_MS);
  timer.unref();
  const onAbort = (): void => finish(new ForgeSignInError('cancelled', l('Sign-in cancelled.')));
  signal.addEventListener('abort', onAbort, { once: true });

  function close(): void {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    server.close();
    server.closeIdleConnections();
    // the last page may still be flushing; a browser holding its connection open is cut after that
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  }

  function finish(result: string | Error): void {
    if (done) return;
    done = true;
    close();
    if (typeof result === 'string') settle!.resolve(result);
    else settle!.reject(result);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // close during listen cancels the listen, which then never calls back, so finish's rejection ends the wait
      code.catch(reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', finish);
        resolve();
      });
    });
  } catch (err) {
    done = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    throw err;
  }
  // finish may run between the listen callback and here; it closed the server, and code holds its rejection
  if (done) await code;
  port = (server.address() as AddressInfo).port;
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    code,
    close: () => finish(new ForgeSignInError('cancelled', l('Sign-in cancelled.'))),
  };
}
