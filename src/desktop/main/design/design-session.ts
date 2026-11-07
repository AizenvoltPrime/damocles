// The design preview's session (PD-7, PD-31): one in-memory partition whose only loadable scheme is the design scheme, served
// from the chat's own core through design.read (docs/invariants.md "Design mode").
import { session as electronSession, type Session } from 'electron';
import { servedContentType, servedHeaders } from '../../../core/design/serve-policy';
import type { DesignPreviewFile } from '../../../shared/types/design';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../../shared/relative-path';
import { DESIGN_SCHEME } from '../protocol';
import { loggableUrl, restrictPermissions } from '../security';

// No `persist:` prefix, so nothing a design stores outlives the run.
export const DESIGN_PARTITION = 'design-preview';
// a loopback port nothing normally listens on (tcpmux)
const REFUSING_PROXY = 'http://127.0.0.1:1';

/** A design as a view token names it: the authority whose core holds it, and its id. */
export interface DesignViewTarget {
  readonly authority: string;
  readonly designId: string;
}

export interface DesignSessionDeps {
  // the design of a live view's token (the URL's host), else undefined
  readonly targetOf: (viewToken: string) => DesignViewTarget | undefined;
  // design.read on the authority's own core
  readonly read: (target: DesignViewTarget, relPath: string) => Promise<DesignPreviewFile | 'tooLarge' | undefined>;
  readonly log: (line: string) => void;
}

const STATUS_TEXT: Readonly<Record<number, string>> = { 404: 'Not found', 405: 'Method not allowed', 500: 'Internal server error' };

// The served headers (D77) with the document sandboxed: no modals flag, so Blink refuses a page's print() and
// execCommand('print'), whose print dialog would stall main's event loop (D85). Scripts and same-origin storage stay.
export function previewHeaders(fidelity: DesignPreviewFile['fidelity']): Record<string, string> {
  const headers = servedHeaders(fidelity);
  return { ...headers, 'Content-Security-Policy': `${headers['Content-Security-Policy']}; sandbox allow-scripts allow-same-origin` };
}

function refusal(status: 404 | 405 | 500): Response {
  return new Response(STATUS_TEXT[status], { status, headers: { ...previewHeaders(null), 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** The once-decoded '/' separated path of a design URL, or undefined when it is no relative file path. */
export function designRequestPath(url: URL): string | undefined {
  let relPath: string;
  try {
    relPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
  return isRelativeFilePath(relPath) && !hasUnsafeWindowsSegment(relPath) ? relPath : undefined;
}

/** Answers one design scheme request: GET only, a live view's token, a served type, the file through its core, D77's `servedHeaders` plus the sandbox. */
export async function serveDesignRequest(request: Pick<Request, 'method' | 'url'>, deps: DesignSessionDeps): Promise<Response> {
  if (request.method !== 'GET') return refusal(405);
  const url = new URL(request.url);
  const target = deps.targetOf(url.host);
  if (!target) return refusal(404);
  const relPath = designRequestPath(url);
  const contentType = relPath === undefined ? undefined : servedContentType(relPath);
  if (relPath === undefined || contentType === undefined) {
    deps.log(`[design] refused ${loggableUrl(url.pathname)} of design ${target.designId}`);
    return refusal(404);
  }
  let file: DesignPreviewFile | 'tooLarge' | undefined;
  try {
    file = await deps.read(target, relPath);
  } catch (err) {
    deps.log(`[design] reading ${loggableUrl(relPath)} of design ${target.designId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return refusal(500);
  }
  if (file === undefined || file === 'tooLarge') {
    deps.log(`[design] refused ${loggableUrl(relPath)} of design ${target.designId}: ${file ?? 'missing'}`);
    return refusal(404);
  }
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...previewHeaders(file.fidelity), 'Content-Type': contentType } });
}

/** The design-preview session, and its proxy's setting, which every design view waits on before its first load. */
export interface DesignSession {
  readonly session: Session;
  readonly ready: Promise<void>;
}

/**
 * Builds the design-preview partition's session: the design scheme answered by `handle` (main's `serveDesignRequest`, or in
 * the design renderer a relay to main), every other request cancelled, no permission, no download, no spellcheck. Call once
 * per process.
 */
export function createDesignSession(handle: (request: Request) => Promise<Response>): DesignSession {
  const session = electronSession.fromPartition(DESIGN_PARTITION);
  session.protocol.handle(DESIGN_SCHEME, handle);
  // The network requests a page makes (http, https, ws, wss) are cancelled here; data: and blob: stay in the renderer and
  // the served CSP bounds them to the page itself. Coverage per scheme: docs/invariants.md "Design mode".
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${DESIGN_SCHEME}://`) });
  });
  restrictPermissions(session);
  session.on('will-download', (event) => event.preventDefault());
  session.setSpellCheckerEnabled(false);
  // Whatever bypasses webRequest (WebRTC's TCP candidates, a prefetch) meets a proxy nothing normally serves; loopback is not exempt.
  const ready = session.setProxy({ mode: 'fixed_servers', proxyRules: REFUSING_PROXY, proxyBypassRules: '<-loopback>' });
  return { session, ready };
}
