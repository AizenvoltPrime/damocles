import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelEntry, ModelFileEntry } from "./manifest";
import { modelVersionDir } from "./manifest";

const STALE_LOCK_AGE_MS: number = 10 * 60 * 1000;

export type DownloadProgress = {
  modelId: string;
  filename: string;
  bytesReceived: number;
  bytesTotal: number;
  status: "downloading" | "verifying" | "done" | "error";
  message?: string;
};

export type DownloadProgressCallback = (p: DownloadProgress) => void;

export type DownloadModelStatus =
  | { status: "ok" }
  | { status: "license-required"; licenseUrl: string; modelId: string };

export class ChecksumMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly url: string;
  constructor(url: string, expected: string, actual: string) {
    super(
      `SHA-256 mismatch for ${url}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    );
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.url = url;
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "CancelledError";
  }
}

export class ModelLockBusyError extends Error {
  constructor(modelId: string) {
    super(`Another download is already in progress for model ${modelId}`);
    this.name = "ModelLockBusyError";
  }
}

export type DownloadModelOptions = {
  entry: ModelEntry;
  modelsRoot: string;
  signal?: AbortSignal;
  onProgress?: DownloadProgressCallback;
  fetchImpl?: typeof fetch;
  acceptLicense?: boolean;
};

export async function downloadModel(opts: DownloadModelOptions): Promise<DownloadModelStatus> {
  if (opts.entry.gated && opts.acceptLicense !== true) {
    return { status: "license-required", licenseUrl: opts.entry.license_url, modelId: opts.entry.id };
  }

  const versionDir = modelVersionDir(opts.modelsRoot, opts.entry);
  const lockDir = join(opts.modelsRoot, opts.entry.id, ".lock");
  const release = await acquireModelLock(lockDir);
  try {
    await fs.mkdir(versionDir, { recursive: true });
    for (const file of opts.entry.files) {
      await downloadOneFile({
        entry: opts.entry,
        file,
        versionDir,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    return { status: "ok" };
  } finally {
    await release();
  }
}

type SingleFileOptions = {
  entry: ModelEntry;
  file: ModelFileEntry;
  versionDir: string;
  signal?: AbortSignal;
  onProgress?: DownloadProgressCallback;
  fetchImpl?: typeof fetch;
};

async function downloadOneFile(opts: SingleFileOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const finalPath = join(opts.versionDir, opts.file.filename);
  const partialPath = `${finalPath}.partial`;
  await fs.mkdir(dirname(finalPath), { recursive: true });

  try {
    await fs.access(finalPath);
    if (opts.onProgress !== undefined) {
      opts.onProgress({
        modelId: opts.entry.id,
        filename: opts.file.filename,
        bytesReceived: opts.file.bytes,
        bytesTotal: opts.file.bytes,
        status: "done",
      });
    }
    return;
  } catch {
    /* file does not yet exist; proceed to download */
  }

  let resumeFrom = 0;
  try {
    const stat = await fs.stat(partialPath);
    resumeFrom = stat.size;
  } catch {
    resumeFrom = 0;
  }

  const headers: Record<string, string> = {};
  if (resumeFrom > 0) headers["Range"] = `bytes=${resumeFrom}-`;

  const response = await fetchImpl(opts.file.url, {
    headers,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (!(response.ok || response.status === 206)) {
    throw new Error(
      `Download failed (${response.status} ${response.statusText}): ${opts.file.url}`,
    );
  }
  if (resumeFrom > 0 && response.status === 200) {
    await fs.rm(partialPath, { force: true });
    resumeFrom = 0;
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? 0 : Number(contentLengthHeader);
  const totalBytes = resumeFrom + (contentLength > 0 ? contentLength : Math.max(0, opts.file.bytes - resumeFrom));

  const writeStream = createWriteStream(partialPath, { flags: resumeFrom > 0 ? "a" : "w" });
  let receivedSinceStart = 0;

  if (response.body === null) {
    writeStream.end();
    throw new Error(`Empty response body for ${opts.file.url}`);
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (opts.signal?.aborted === true) {
        await new Promise<void>((resolve) => writeStream.end(resolve));
        throw new CancelledError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      const ok = writeStream.write(chunk);
      if (!ok) await new Promise<void>((resolve) => writeStream.once("drain", () => resolve()));
      receivedSinceStart += chunk.byteLength;
      if (opts.onProgress !== undefined) {
        opts.onProgress({
          modelId: opts.entry.id,
          filename: opts.file.filename,
          bytesReceived: resumeFrom + receivedSinceStart,
          bytesTotal: totalBytes,
          status: "downloading",
        });
      }
    }
  } finally {
    await new Promise<void>((resolve) => writeStream.end(resolve));
  }

  if (opts.onProgress !== undefined) {
    opts.onProgress({
      modelId: opts.entry.id,
      filename: opts.file.filename,
      bytesReceived: resumeFrom + receivedSinceStart,
      bytesTotal: totalBytes,
      status: "verifying",
    });
  }

  // Fail-closed checksum verification, regardless of manifest_status.
  // Previously gated behind status === "production", which let placeholder
  // SHAs in a development manifest pass through unchecked at runtime —
  // exactly the H3 hole.
  const actual = await sha256OfFile(partialPath);
  if (actual.toLowerCase() !== opts.file.sha256.toLowerCase()) {
    await fs.rm(partialPath, { force: true });
    throw new ChecksumMismatchError(opts.file.url, opts.file.sha256, actual);
  }

  await fs.rename(partialPath, finalPath);
  if (opts.onProgress !== undefined) {
    opts.onProgress({
      modelId: opts.entry.id,
      filename: opts.file.filename,
      bytesReceived: totalBytes,
      bytesTotal: totalBytes,
      status: "done",
    });
  }
}

async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

async function acquireModelLock(lockDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      return async (): Promise<void> => {
        try {
          await fs.rm(lockDir, { recursive: true, force: true });
        } catch {
          /* swallowed: best-effort cleanup */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat === null) continue;
      const age = Date.now() - stat.mtimeMs;
      if (age > STALE_LOCK_AGE_MS) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      throw new ModelLockBusyError(dirname(lockDir).split(/[/\\]/).pop() ?? "?");
    }
  }
}
