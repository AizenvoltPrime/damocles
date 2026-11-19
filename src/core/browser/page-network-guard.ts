import type { CDPSession } from 'patchright';
import type { PageController } from './page-controller';
import { isNavigableUrl } from './net-guard';
import { isServedGrantHost } from '../../shared/served-file-url';
import { log } from '../logger';

// The per-page network guard (docs/invariants.md "Browser"): Chrome pauses each matching request for this client and for
// Playwright's own (Patchright's route, BrowserIntercept rules), so no route answer skips it. A service worker's answer
// never pauses here, so the page's session bypasses service workers before any request of the page is guarded.

// Response stage: Chrome pauses each redirect hop of a document here, before it follows the Location. Request stage: every
// request to a grant-shaped host, before it leaves Chrome, so a served grant's host is reached only from its chat's pages.
// Chrome matches urlPattern against the whole URL, '*' as zero or more characters and '?' as exactly one: the 32 '?' are the
// label length isServedGrantHost reads, and the leading '*' also takes a userinfo part.
export const PAGE_GUARD_PATTERNS = [
  { resourceType: 'Document', requestStage: 'Response' },
  { urlPattern: 'http://*????????????????????????????????.localhost:*', requestStage: 'Request' },
] as const;

// The statuses Chrome follows a Location for (net::HttpResponseHeaders::IsRedirectResponseCode).
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The fields of a `Fetch.requestPaused` event the verdict reads. */
export interface PausedDocument {
  readonly request: { readonly url: string };
  readonly responseStatusCode?: number;
  readonly responseHeaders?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** A redirect the guard failed: the URL of the hop that sent it, and the scheme its Location named, or undefined for a Location that is not a URL. */
export interface RefusedRedirect {
  readonly kind: 'redirect';
  readonly hop: string;
  readonly scheme: string | undefined;
}

/** A request the guard failed because its served grant host is not one the page's chat holds. */
export interface RefusedGrant {
  readonly kind: 'foreignGrant';
  readonly url: string;
}

export type GuardRefusal = RefusedRedirect | RefusedGrant;

/**
 * The guard's answer to a paused document: a redirect whose Location, resolved against the request URL, is not an address
 * isNavigableUrl passes is refused; everything else continues. Every Location header is checked, so a duplicate cannot
 * carry a refused address past the first.
 */
export function redirectVerdict(paused: PausedDocument): RefusedRedirect | undefined {
  if (paused.responseStatusCode === undefined || !REDIRECT_STATUSES.has(paused.responseStatusCode)) return undefined;
  for (const header of paused.responseHeaders ?? []) {
    if (header.name.toLowerCase() !== 'location') continue;
    if (!URL.canParse(header.value, paused.request.url)) return { kind: 'redirect', hop: paused.request.url, scheme: undefined };
    const target = new URL(header.value, paused.request.url);
    if (!isNavigableUrl(target.href)) return { kind: 'redirect', hop: paused.request.url, scheme: target.protocol.slice(0, 40) };
  }
  return undefined;
}

/** The port of the served grant host `url` names when the page's chat does not hold that origin; undefined for any other request. */
export function foreignGrantPort(url: string, ownsOrigin: (origin: string) => boolean): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return isServedGrantHost(parsed.hostname) && !ownsOrigin(parsed.origin) ? parsed.port : undefined;
}

function redirectTarget(refused: RefusedRedirect): string {
  return refused.scheme === undefined ? 'an address that is not a complete URL' : `a ${refused.scheme} address`;
}

/** Why an agent navigation failed at a refused redirect sent by `origin`, worded as agentNavigationRefusal words a refused address. */
export function redirectRefusalMessage(origin: string, refused: RefusedRedirect): string {
  return `${origin} redirected to ${redirectTarget(refused)}; the browser opens only http and https URLs and about:blank, at every redirect.`;
}

/** Why an agent navigation failed at a request to `origin`, a served grant host the guard refused. */
export function grantRefusalMessage(origin: string): string {
  return `Navigation to ${origin} failed: that served page belongs to another chat (net::ERR_BLOCKED_BY_CLIENT).`;
}

export interface PageNetworkGuard {
  /** What the guard refused in the navigation whose network request id is `loaderId`, if the last refusal was in it. */
  refusal(loaderId: string): GuardRefusal | undefined;
}

/**
 * Starts the guard on the page's own session; resolves once Chrome sends the page's requests that start from then on to the
 * network, never to a service worker, and pauses them. `ownsOrigin`: whether the page's chat holds a served grant origin,
 * read at each request.
 */
export async function installPageNetworkGuard(session: CDPSession, controller: PageController, ownsOrigin: (origin: string) => boolean): Promise<PageNetworkGuard> {
  let lastRefusal: { readonly networkId: string; readonly refusal: GuardRefusal } | undefined;
  // one line per port and per scheme, since a page can make such requests without end
  const loggedPorts = new Set<string>();
  const loggedSchemes = new Set<string | undefined>();
  let loggedVerdictFailure = false;
  const verdict = (event: PausedDocument): GuardRefusal | undefined => {
    const foreignPort = foreignGrantPort(event.request.url, ownsOrigin);
    if (foreignPort !== undefined) {
      if (!loggedPorts.has(foreignPort)) {
        loggedPorts.add(foreignPort);
        log(`[Browser] Refused a page's request to a served page on port ${foreignPort}, which its chat does not hold`);
      }
      return { kind: 'foreignGrant', url: event.request.url };
    }
    const refused = redirectVerdict(event);
    if (refused !== undefined && !loggedSchemes.has(refused.scheme)) {
      loggedSchemes.add(refused.scheme);
      log(`[Browser] Refused a page's redirect to ${redirectTarget(refused)}`);
    }
    return refused;
  };
  // Each paused request gets exactly one answer, sent from the event alone: any other await here holds the document.
  session.on('Fetch.requestPaused', (event) => {
    let refuse: boolean;
    try {
      const refusal = verdict(event);
      if (refusal !== undefined && event.networkId !== undefined) lastRefusal = { networkId: event.networkId, refusal };
      refuse = refusal !== undefined;
    } catch (err) {
      // A CDP event is a system boundary: a verdict that throws fails its request rather than leave it paused or let it through.
      refuse = true;
      if (!loggedVerdictFailure) {
        loggedVerdictFailure = true;
        log(`[Browser] Navigation guard refused a request it could not judge — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const answer = refuse ? controller.failRequest(event.requestId, 'BlockedByClient') : controller.continueRequest(event.requestId);
    answer.catch((err: unknown) => log(`[Browser] Navigation guard could not answer a paused request — ${err instanceof Error ? err.message : String(err)}`));
  });
  // Sent back to back on the one session, which keeps their order: Network is on before the bypass, and both precede Fetch.
  await Promise.all([controller.bypassServiceWorkers(), controller.enableFetch(PAGE_GUARD_PATTERNS)]);
  return {
    // A navigation's network request id is its loaderId, unchanged across its redirects.
    refusal: (loaderId) => (lastRefusal?.networkId === loaderId ? lastRefusal.refusal : undefined),
  };
}
