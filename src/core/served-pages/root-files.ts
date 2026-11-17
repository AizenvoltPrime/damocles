// What a served root answers for one of its files, the same for every host that serves roots (docs/invariants.md "Ports and the
// remote browser", "Design mode"): a project's files by the preview policy, a design's by the design's own.
import { servedContentType, servedHeaders } from '../design/serve-policy';
import { NotConnectedError } from '../not-connected-error';
import type { DesignPreviewFile } from '../../shared/types/design';
import { loggablePath, type PreviewAnswer, type PreviewRequest } from './preview-reader';
import { isServablePreviewPath, previewRequestPath } from './serve-policy';

// a folder the permission gate granted a chat is served by the project policy, untrusted
export type ServedRoot = { readonly kind: 'project' } | { readonly kind: 'design'; readonly designId: string } | { readonly kind: 'folder' };

/** Why a root's file is never served, as the agent reads it; undefined when it is served. */
export function servedPathRefusal(root: ServedRoot, relPath: string): string | undefined {
  if (!isServablePreviewPath(relPath)) return `${relPath} is not opened: files and folders whose names start with a dot, keys, certificates and 8.3 short names are never served.`;
  if (root.kind === 'design' && servedContentType(relPath) === undefined) return `${relPath} is not opened: a design folder serves only pages, styles, scripts, JSON, images, fonts and text.`;
  return undefined;
}

/** GET or HEAD of one design file: the design's bytes with its fidelity CSP, 404 with no bytes for anything refused. */
export async function answerDesign(request: Pick<PreviewRequest, 'method' | 'pathname'>, read: (relPath: string) => Promise<DesignPreviewFile | 'tooLarge' | undefined>, log: (line: string) => void): Promise<PreviewAnswer> {
  const empty = (status: number, extra: Record<string, string> = {}): PreviewAnswer => ({ status, headers: { ...servedHeaders(null), ...extra } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405, { Allow: 'GET, HEAD' });
  const path = previewRequestPath(request.pathname);
  const type = path === undefined ? undefined : servedContentType(path.relativePath);
  if (!path || type === undefined) return empty(404);
  let file: DesignPreviewFile | 'tooLarge' | undefined;
  try {
    file = await read(path.relativePath);
  } catch (err) {
    if (err instanceof NotConnectedError) return { status: 503, headers: { ...servedHeaders(null), 'Content-Type': 'text/plain; charset=utf-8' }, body: err.message };
    log(`[served-roots] reading the design file ${loggablePath(path.relativePath)} failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty(500);
  }
  if (file === undefined || file === 'tooLarge') return empty(404);
  const bytes = file.bytes;
  const headers = { ...servedHeaders(file.fidelity), 'Content-Type': type, 'Content-Length': String(bytes.byteLength) };
  return request.method === 'HEAD' ? { status: 200, headers } : { status: 200, headers, body: (async function* () { yield bytes; })() };
}
