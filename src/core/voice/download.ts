import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { l } from "../l10n";
import { LocalizedError } from "../../shared/localized-text";

/** A voice install step or download stopped by its abort signal. */
export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "CancelledError";
  }
}

/** A download the server answered with a status other than 2xx. */
export class DownloadHttpError extends LocalizedError {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  constructor(status: number, statusText: string, url: string) {
    // The status is an identifier, not a quantity; an HTTP/2 answer carries no status text.
    super(statusText.length > 0
      ? l("Download failed ({0} {1}): {2}", String(status), statusText, url)
      : l("Download failed ({0}): {1}", String(status), url));
    this.name = "DownloadHttpError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
  }
}

/** A download the server answered with no body. */
export class EmptyDownloadError extends LocalizedError {
  readonly url: string;
  constructor(url: string) {
    super(l("The download of {0} returned no data.", url));
    this.name = "EmptyDownloadError";
    this.url = url;
  }
}

export class ChecksumMismatchError extends LocalizedError {
  readonly expected: string;
  readonly actual: string;
  readonly url: string;
  constructor(url: string, expected: string, actual: string) {
    super(l("SHA-256 mismatch for {0}: expected {1}…, got {2}…", url, expected.slice(0, 12), actual.slice(0, 12)));
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.url = url;
  }
}

export type PartialDownloadOptions = {
  url: string;
  /** Holds the bytes received so far, which a later call resumes from. */
  partialFile: string;
  /** Undefined when the bytes cannot be verified. */
  expectedSha256: string | undefined;
  expectedBytes?: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
  /** `total` is 0 when neither the server nor the caller knows the size. */
  onBytes?: (received: number, total: number) => void;
  onVerifying?: (received: number, total: number) => void;
};

/**
 * Fills `partialFile` with the whole of `url`, resuming from the bytes it holds, and verifies it; answers its size. The
 * caller renames it into place. A mismatch removes the file, so the next call starts over.
 */
export async function downloadToPartial(opts: PartialDownloadOptions): Promise<number> {
  const held = await heldBytes(opts);
  if (held.complete) return held.bytes;
  let resumeFrom = held.bytes;

  let response = await request(opts, resumeFrom);
  // A partial the server holds no more bytes past, such as a whole file a stop left unverified, starts over once.
  if (response.status === 416 && resumeFrom > 0) {
    await response.body?.cancel();
    await fs.rm(opts.partialFile, { force: true });
    resumeFrom = 0;
    response = await request(opts, resumeFrom);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DownloadHttpError(response.status, response.statusText, opts.url);
  }
  if (resumeFrom > 0 && response.status === 200) resumeFrom = 0;
  if (response.body === null) throw new EmptyDownloadError(opts.url);

  const lengthHeader = response.headers.get("content-length");
  const contentLength = lengthHeader === null ? 0 : Number(lengthHeader);
  const total = contentLength > 0 ? resumeFrom + contentLength : (opts.expectedBytes ?? 0);

  const writeStream = createWriteStream(opts.partialFile, { flags: resumeFrom > 0 ? "a" : "w" });
  let received = resumeFrom;
  const reader = response.body.getReader();
  try {
    while (true) {
      if (opts.signal?.aborted === true) throw new CancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      if (!writeStream.write(chunk)) await new Promise<void>((resolve) => writeStream.once("drain", () => resolve()));
      received += chunk.byteLength;
      opts.onBytes?.(received, total);
    }
  } finally {
    await new Promise<void>((resolve) => writeStream.end(resolve));
  }

  if (opts.expectedSha256 !== undefined) {
    opts.onVerifying?.(received, total);
    const actual = await sha256OfFile(opts.partialFile);
    if (actual !== opts.expectedSha256.toLowerCase()) {
      await fs.rm(opts.partialFile, { force: true });
      throw new ChecksumMismatchError(opts.url, opts.expectedSha256, actual);
    }
  }
  return received;
}

/** The bytes of the partial file a resume keeps; `complete` when it already is the whole verified file. */
async function heldBytes(opts: PartialDownloadOptions): Promise<{ bytes: number; complete: boolean }> {
  const bytes = await fs.stat(opts.partialFile).then((stat) => stat.size, () => 0);
  if (bytes === 0) return { bytes, complete: false };
  if (opts.expectedBytes !== undefined && bytes < opts.expectedBytes) return { bytes, complete: false };
  const complete = opts.expectedSha256 !== undefined
    ? (await sha256OfFile(opts.partialFile)) === opts.expectedSha256.toLowerCase()
    : bytes === opts.expectedBytes;
  if (complete || opts.expectedBytes === undefined) return { bytes, complete };
  // At or past the known size with the wrong bytes: a resume could only add to them.
  await fs.rm(opts.partialFile, { force: true });
  return { bytes: 0, complete: false };
}

function request(opts: PartialDownloadOptions, resumeFrom: number): Promise<Response> {
  return opts.fetchImpl(opts.url, {
    headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {},
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

export async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}
