import { l } from '../../l10n';
import type { ForgeHttp } from '../http';
import type { ForgeProvider, TokenGrant } from '../providers/provider';
import { ForgeHttpError, ForgeSignInError, type ForgeServer, type OAuthClient } from '../types';

// The device authorization grant (RFC 8628), after VS Code's github-authentication flows.ts 389 (MIT): GitHub's
// /login/device/code, GitLab's /oauth/authorize_device. slow_down adds 5 s to the interval.

const SLOW_DOWN_STEP_S = 5;
// a code's lifetime and poll interval, in seconds, are taken only within (0, MAX_CODE_SECONDS]
const MAX_CODE_SECONDS = 3600;

export interface DeviceFlowDeps {
  readonly http: ForgeHttp;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Waits ms, rejecting when signal aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface DeviceCodeShown {
  readonly userCode: string;
  readonly verificationUri: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export interface DeviceFlowOptions {
  readonly client: OAuthClient;
  readonly signal: AbortSignal;
  readonly onCode: (code: DeviceCodeShown) => void;
}

const cancelled = (): ForgeSignInError => new ForgeSignInError('cancelled', l('Sign-in cancelled.'));

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function usableSeconds(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_CODE_SECONDS;
}

/** The page the code is entered on, only when it is https on one of the server's own origins. */
function ownPage(server: ForgeServer, uri: string): string | undefined {
  if (!URL.canParse(uri)) return undefined;
  const url = new URL(uri);
  return url.protocol === 'https:' && server.origins.has(url.origin) ? url.href : undefined;
}

export async function runDeviceFlow(deps: DeviceFlowDeps, server: ForgeServer, provider: ForgeProvider, options: DeviceFlowOptions): Promise<TokenGrant> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const { signal, client } = options;
  const code = await provider.startDevice(deps.http, server, client, signal);
  if (signal.aborted) throw cancelled();
  if (code === undefined) throw new ForgeSignInError('provider', l('This server does not offer device code sign-in. Use the browser or a token.'));
  const verificationUri = ownPage(server, code.verificationUri);
  if (verificationUri === undefined) throw new ForgeSignInError('provider', l('The server named a sign-in page that is not its own. Use the browser or a token.'));
  if (!usableSeconds(code.expiresIn) || !usableSeconds(code.interval)) {
    throw new ForgeSignInError('provider', l('The server answered with a device code Damocles cannot use. Use the browser or a token.'));
  }
  const expiresAt = now() + code.expiresIn * 1000;
  options.onCode({ userCode: code.userCode, verificationUri, expiresAt });
  let interval = code.interval;
  for (;;) {
    // the last wait ends at the expiry, which no poll follows, so no poll comes sooner than the interval
    await sleep(Math.min(interval * 1000, Math.max(0, expiresAt - now())), signal);
    if (now() >= expiresAt) throw new ForgeSignInError('expired', l('Code expired. Start the sign-in again.'));
    let poll;
    try {
      poll = await provider.pollDevice(deps.http, server, client, code.deviceCode, signal, now);
    } catch (err) {
      if (signal.aborted) throw cancelled();
      // a dropped connection is retried at the next interval until the code expires
      if (err instanceof ForgeHttpError && err.kind === 'network') {
        deps.log(`[forge] ${server.id} device code poll could not reach the server; retrying`);
        continue;
      }
      throw err;
    }
    switch (poll.kind) {
      case 'pending': continue;
      case 'slowDown':
        // RFC 8628 3.5: at least 5 s more, for this and every later poll
        interval = Math.max(poll.interval ?? 0, interval + SLOW_DOWN_STEP_S);
        continue;
      case 'expired': throw new ForgeSignInError('expired', l('Code expired. Start the sign-in again.'));
      case 'denied': throw new ForgeSignInError('denied', l('The sign-in was denied.'));
      case 'granted': return poll.grant;
    }
  }
}
