// The HTML preview's session: one in-memory partition whose only local scheme is damocles-preview, each view loading only
// its own project root's token (docs/invariants.md "Desktop host", HTML previews).
import { session as electronSession, type Session } from 'electron';
import { PREVIEW_SCHEME } from '../protocol';
import { loggableUrl, restrictPermissions } from '../security';
import type { PreviewAnswer } from './preview-reader';
import { privateDestination, type ResolveHost } from './private-network';

// No `persist:` prefix, so nothing a page stores outlives the run.
export const HTML_PREVIEW_PARTITION = 'html-preview';

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

export interface PreviewSessionDeps {
  // the root token the preview view of this webContents loads; undefined for any other webContents
  readonly tokenOf: (webContentsId: number) => string | undefined;
  // whether the preview view of this webContents runs its root's scripts; false for any other webContents
  readonly trustedOf: (webContentsId: number) => boolean;
  // a preview URL path (still percent-encoded) a view was served a file for, so its folder is watched for the reload
  readonly served: (webContentsId: number, pathname: string) => void;
  // answers a damocles-preview request; its host is a live root token
  readonly handle: (request: Request) => Promise<Response>;
  readonly log: (line: string) => void;
}

/**
 * Whether a request on the partition may go: a preview URL of the requesting view's own root, or a web request, which for
 * an untrusted root (or no known view) must not reach loopback or a private network; nothing else. privateRefused hears why a
 * web request was refused.
 */
export async function previewRequestAllowed(url: string, webContentsId: number | undefined, deps: Pick<PreviewSessionDeps, 'tokenOf' | 'trustedOf'> & { readonly resolveHost: ResolveHost }, privateRefused: (reason: string) => void): Promise<boolean> {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol === `${PREVIEW_SCHEME}:`) return webContentsId !== undefined && parsed.host === deps.tokenOf(webContentsId);
  if (!WEB_PROTOCOLS.has(parsed.protocol)) return false;
  if (webContentsId !== undefined && deps.trustedOf(webContentsId)) return true;
  const reason = await privateDestination(parsed, deps.resolveHost);
  if (reason === undefined) return true;
  privateRefused(reason);
  return false;
}

/**
 * A body read one chunk per pull, with at most one chunk read ahead, so a file of any size streams at the page's pace; a cancel
 * (a closed view, a media seek that drops its request) releases the read at once.
 */
function pulledBody(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const step = await iterator.next();
      if (cancelled) return;
      if (step.done === true) controller.close();
      else controller.enqueue(step.value);
    },
    cancel: async () => {
      cancelled = true;
      await iterator.return?.();
    },
  }, { highWaterMark: 1 });
}

/** A preview answer as the scheme handler returns it. */
export function previewResponse(answer: PreviewAnswer): Response {
  const body = answer.body === undefined || typeof answer.body === 'string' ? answer.body : pulledBody(answer.body);
  return new Response(body, { status: answer.status, headers: answer.headers });
}

/** The html-preview session, and its proxy's setting, which every preview view waits on before its first load. */
export interface PreviewSession {
  readonly session: Session;
  readonly ready: Promise<void>;
}

/**
 * Builds the html-preview partition's session: damocles-preview answered by `handle` for a view's own root, web requests
 * through the system proxy (an untrusted root's never to loopback or a private network), everything else cancelled; no
 * permission, no download, no spellcheck. Call once per process.
 */
export function createPreviewSession(deps: PreviewSessionDeps): PreviewSession {
  const session = electronSession.fromPartition(HTML_PREVIEW_PARTITION);
  session.protocol.handle(PREVIEW_SCHEME, deps.handle);
  const resolveHost: ResolveHost = (host) => session.resolveHost(host);
  // a page can name private hosts in a loop, so each view logs only its first refusal
  const refusalLogged = new Set<number | undefined>();
  session.webRequest.onBeforeRequest((details, callback) => {
    const refused = (reason: string): void => {
      if (refusalLogged.has(details.webContentsId)) return;
      refusalLogged.add(details.webContentsId);
      deps.log(`[html-preview] refused an untrusted preview's request to ${loggableUrl(new URL(details.url).origin)}, ${reason}; this view's further ones are not logged`);
    };
    previewRequestAllowed(details.url, details.webContentsId, { ...deps, resolveHost }, refused).then((allowed) => callback({ cancel: !allowed }), (err: unknown) => {
      deps.log(`[html-preview] checking a preview's request failed, so it was cancelled: ${err instanceof Error ? err.message : String(err)}`);
      callback({ cancel: true });
    });
  });
  session.webRequest.onCompleted((details) => {
    const status = details.statusCode;
    if (details.webContentsId === undefined || (status !== 200 && status !== 206) || !details.url.startsWith(`${PREVIEW_SCHEME}:`)) return;
    try {
      deps.served(details.webContentsId, new URL(details.url).pathname);
    } catch (err) {
      deps.log(`[html-preview] watching a served file's folder failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  restrictPermissions(session);
  session.on('will-download', (event) => event.preventDefault());
  session.setSpellCheckerEnabled(false);
  // A page loads CDN scripts, fonts and APIs, so the session takes the system's proxy, never the design session's refusing one.
  const ready = session.setProxy({ mode: 'system' });
  return { session, ready };
}
