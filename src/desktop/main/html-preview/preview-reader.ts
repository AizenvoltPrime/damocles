// One preview request answered from a project root, for the damocles-preview scheme and the loopback server alike.
import type { ReadRangeResult } from '../../workspace/transfer-ops';
import { loggableUrl } from '../security';
import { NotConnectedError } from '../workspace/workspaces';
import { CHARSET_PRESCAN_BYTES, declaresCharset, isDeniedResolvedPath, isHtmlType, previewContentType, previewHeaders, previewRequestPath, previewUrlPath, requestedRange, type ByteRangeSpec, type PreviewTarget } from './serve-policy';

/** A preview response before it meets its transport; a body iterable is released (return()) by whoever drops it. */
export interface PreviewAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | AsyncIterable<Uint8Array>;
}

export interface PreviewRequest {
  readonly method: string;
  // the URL's path, still percent-encoded
  readonly pathname: string;
  readonly trusted: boolean;
  readonly target: PreviewTarget;
  // the Range and If-Range headers as received
  readonly range: string | undefined;
  readonly ifRange: string | undefined;
}

// The root's confined reads (workspaces.forProject(rootKey).files); each throws NotConnectedError while its host is away.
export interface PreviewFileReads {
  // files.readFileRange; it throws for a host that reads no range with a resolved path, whose files are never served
  readonly range: (relativePath: string, offset: number, length: number) => Promise<ReadRangeResult>;
}

async function release(chunks: AsyncIterable<Uint8Array>): Promise<void> {
  await chunks[Symbol.asyncIterator]().return?.();
}

/**
 * Exactly count bytes of source, the body of a response whose Content-Length is count: cut there, with source released, and
 * failing when source ends sooner, so the transport aborts the response instead of completing it short.
 */
export function exactBytes(source: AsyncIterable<Uint8Array>, count: number): AsyncIterable<Uint8Array> {
  // hand-written, not an async generator: return() on a generator that never started skips its body, leaking source's read
  const inner = source[Symbol.asyncIterator]();
  let left = count;
  let finished = false;
  const finish = async (): Promise<IteratorReturnResult<undefined>> => {
    if (!finished) {
      finished = true;
      await inner.return?.();
    }
    return { done: true, value: undefined };
  };
  const iterator: AsyncIterator<Uint8Array, undefined> = {
    next: async () => {
      if (left === 0) return finish();
      if (finished) return { done: true, value: undefined };
      let step: IteratorResult<Uint8Array>;
      try {
        step = await inner.next();
      } catch (err) {
        finished = true;
        throw err;
      }
      if (step.done === true) {
        finished = true;
        throw new Error(`the file ended ${left} bytes short of the ${count} bytes its response declared`);
      }
      const chunk = step.value.byteLength > left ? step.value.subarray(0, left) : step.value;
      left -= chunk.byteLength;
      return { done: false, value: chunk };
    },
    return: finish,
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

// The bytes a request reads: a GET's range, else the whole file; HEAD reads none, or an HTML file's charset prescan. The host
// clamps a span to the file, and a suffix's offset counts from the end. Lengths stay safe integers, which the ranged read and
// its wire request require.
function spanOf(method: string, range: ByteRangeSpec | undefined, html: boolean): { readonly offset: number; readonly length: number } {
  if (method === 'HEAD') return { offset: 0, length: html ? CHARSET_PRESCAN_BYTES : 0 };
  if (!range) return { offset: 0, length: Number.MAX_SAFE_INTEGER };
  if ('suffix' in range) return { offset: 0 - range.suffix, length: range.suffix };
  return { offset: range.first, length: range.last === undefined ? Number.MAX_SAFE_INTEGER : Math.min(range.last - range.first + 1, Number.MAX_SAFE_INTEGER) };
}

/** The first `need` bytes of source, read as its consumer would, and source again from its start; its return() releases source. */
async function peek(source: AsyncIterable<Uint8Array>, need: number): Promise<{ readonly head: Uint8Array; readonly chunks: AsyncIterable<Uint8Array> }> {
  const inner = source[Symbol.asyncIterator]();
  const held: Uint8Array[] = [];
  let count = 0;
  let ended = false;
  while (count < need) {
    const step = await inner.next();
    if (step.done === true) {
      ended = true;
      break;
    }
    held.push(step.value);
    count += step.value.byteLength;
  }
  const iterator: AsyncIterator<Uint8Array, undefined> = {
    next: async () => {
      const chunk = held.shift();
      if (chunk !== undefined) return { done: false, value: chunk };
      if (ended) return { done: true, value: undefined };
      return inner.next();
    },
    return: async () => {
      held.length = 0;
      ended = true;
      await inner.return?.();
      return { done: true, value: undefined };
    },
  };
  return { head: Buffer.concat(held).subarray(0, need), chunks: { [Symbol.asyncIterator]: () => iterator } };
}

/**
 * GET or HEAD of one project file: the folder's index.html for a folder path, 404 with no bytes for anything refused, on the
 * path asked for or on the file's real path, and a GET's single byte range as 206, or 416 when no byte of the file is in it
 * (RFC 9110 §14). An HTML file whose first CHARSET_PRESCAN_BYTES declare its encoding is sent with no charset.
 */
export async function answerPreview(request: PreviewRequest, reads: PreviewFileReads, log: (line: string) => void): Promise<PreviewAnswer> {
  const headers = previewHeaders(request.trusted, request.target);
  const empty = (status: number, extra: Record<string, string> = {}): PreviewAnswer => ({ status, headers: { ...headers, ...extra } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405, { Allow: 'GET, HEAD' });
  const path = previewRequestPath(request.pathname);
  if (!path) return empty(404);
  // GET is the only method with range handling (RFC 9110 §14.2)
  const range = request.method === 'GET' ? requestedRange(request.range, request.ifRange) : undefined;
  const contentType = previewContentType(path.relativePath);
  const html = isHtmlType(contentType);
  const failed = (err: unknown): PreviewAnswer => {
    if (err instanceof NotConnectedError) return { status: 503, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: err.message };
    log(`[html-preview] reading ${loggableUrl(path.relativePath)} failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty(500);
  };
  let result: ReadRangeResult;
  try {
    const span = spanOf(request.method, range, html);
    result = await reads.range(path.relativePath, span.offset, span.length);
  } catch (err) {
    return failed(err);
  }
  if (!result.ok) {
    // a folder named without its '/' resolves its page's relative URLs one level up, so it moves to the folder's own path
    if (result.reason === 'notAFile' && result.folder && !path.folderIndex) return empty(308, { Location: `${previewUrlPath(path.relativePath)}/` });
    if (result.reason === 'failed') log(`[html-preview] reading ${loggableUrl(path.relativePath)} failed${result.code !== undefined ? ` (${result.code})` : ''}`);
    return empty(result.reason === 'failed' ? 500 : 404);
  }
  if (isDeniedResolvedPath(result.resolvedPath)) {
    await release(result.chunks);
    return empty(404);
  }
  const { size, offset, length } = result;
  let chunks = result.chunks;
  if (range && ('suffix' in range ? range.suffix === 0 : range.first >= size)) {
    await release(chunks);
    return empty(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` });
  }
  let type = contentType;
  if (html) {
    const need = Math.min(CHARSET_PRESCAN_BYTES, size);
    let head: Uint8Array;
    try {
      if (offset === 0 && length >= need) {
        ({ head, chunks } = await peek(chunks, need));
      } else {
        const start = await reads.range(path.relativePath, 0, need);
        if (!start.ok) {
          await release(chunks);
          if (start.reason === 'failed') log(`[html-preview] reading the start of ${loggableUrl(path.relativePath)} failed${start.code !== undefined ? ` (${start.code})` : ''}`);
          return empty(start.reason === 'failed' ? 500 : 404);
        }
        ({ head } = await peek(start.chunks, need));
        await release(start.chunks);
      }
    } catch (err) {
      await release(chunks);
      return failed(err);
    }
    if (declaresCharset(head)) type = 'text/html';
  }
  const fileHeaders = { ...headers, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  // a suffix of an empty file selects no byte, which no Content-Range can name, so the whole (empty) file is sent
  if (range && length > 0) return { status: 206, headers: { ...fileHeaders, 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`, 'Content-Length': String(length) }, body: exactBytes(chunks, length) };
  const wholeHeaders = { ...fileHeaders, 'Content-Length': String(size) };
  if (request.method === 'HEAD') {
    await release(chunks);
    return { status: 200, headers: wholeHeaders };
  }
  return { status: 200, headers: wholeHeaders, body: exactBytes(chunks, size) };
}
