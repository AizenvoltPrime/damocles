import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelledError, ChecksumMismatchError, downloadModel } from "../downloader";
import type { ModelEntry } from "../manifest";

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeEntry(overrides: Partial<ModelEntry> = {}, fakeBody: Uint8Array | null = null): ModelEntry {
  const expected = fakeBody === null ? "deadbeef".padEnd(64, "0") : sha256OfBytes(fakeBody);
  return {
    id: "parakeet",
    version: "2.0.0",
    description: "Parakeet ASR",
    license: "CC-BY-4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    huggingface_repo: "nvidia/parakeet-tdt-0.6b-v2",
    files: [
      {
        filename: "model.bin",
        url: "https://example/model.bin",
        sha256: expected,
        bytes: fakeBody?.byteLength ?? 4,
      },
    ],
    gated: false,
    ...overrides,
  };
}

function fetchOk(body: Uint8Array, expectsRange: { from: number } | null = null): typeof fetch {
  return async (_input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers["Range"];
    if (expectsRange !== null && range !== `bytes=${expectsRange.from}-`) {
      throw new Error(`Expected Range bytes=${expectsRange.from}-, got '${range}'`);
    }
    return new Response(body, {
      status: range !== undefined ? 206 : 200,
      headers: { "content-length": String(body.byteLength) },
    });
  };
}

describe("downloadModel", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-dl-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns license-required for gated entry without acceptance", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({ gated: true }, body);
    const result = await downloadModel({
      entry,
      modelsRoot: tmp,
      fetchImpl: fetchOk(body),
    });
    expect(result.status).toBe("license-required");
    if (result.status === "license-required") {
      expect(result.licenseUrl).toBe(entry.license_url);
    }
  });

  it("downloads gated entry once acceptance is set", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({ gated: true }, body);
    const result = await downloadModel({
      entry,
      modelsRoot: tmp,
      acceptLicense: true,
      fetchImpl: fetchOk(body),
    });
    expect(result.status).toBe("ok");
    const written = await readFile(join(tmp, "parakeet", "v2.0.0", "model.bin"));
    expect(written.length).toBe(4);
  });

  it("verifies SHA-256 and rejects on mismatch", async () => {
    const entry = makeEntry({
      files: [
        {
          filename: "model.bin",
          url: "https://example/model.bin",
          sha256: "deadbeef".padEnd(64, "0"),
          bytes: 4,
        },
      ],
    });
    await expect(
      downloadModel({
        entry,
        modelsRoot: tmp,
        fetchImpl: fetchOk(new Uint8Array([1, 2, 3, 4])),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("verifies SHA-256 unconditionally — no manifest-status escape hatch", async () => {
    // Regression for H3: previously a manifest declared as
    // "placeholder-checksums" caused the downloader to skip SHA verification
    // entirely. Now the verification runs regardless of how the manifest
    // describes itself; a wrong SHA always rejects.
    const entry = makeEntry({
      files: [
        {
          filename: "model.bin",
          url: "https://example/model.bin",
          sha256: "0".repeat(64),
          bytes: 4,
        },
      ],
    });
    await expect(
      downloadModel({
        entry,
        modelsRoot: tmp,
        fetchImpl: fetchOk(new Uint8Array([1, 2, 3, 4])),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("sends Range header on resume from existing .partial", async () => {
    // The combined body the downloader will end up with is 1,2,3,4.
    const versionDir = join(tmp, "parakeet", "v2.0.0");
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, "model.bin.partial"), Buffer.from([1, 2]));
    const entry = makeEntry({}, new Uint8Array([1, 2, 3, 4]));
    const result = await downloadModel({
      entry,
      modelsRoot: tmp,
      fetchImpl: fetchOk(new Uint8Array([3, 4]), { from: 2 }),
    });
    expect(result.status).toBe("ok");
    const written = await readFile(join(versionDir, "model.bin"));
    expect(Array.from(written)).toEqual([1, 2, 3, 4]);
  });

  it("waits out a download of the same model in flight and keeps the files it finished", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({}, body);
    const lockDir = join(tmp, "parakeet", ".lock");
    await mkdir(lockDir, { recursive: true });
    const statSpy = vi.spyOn(fsPromises, "stat");
    let fetched = false;
    const run = downloadModel({
      entry,
      modelsRoot: tmp,
      fetchImpl: async () => {
        fetched = true;
        return new Response(body);
      },
    });

    // The download saw the lock taken; the holder then finishes its file and lets go.
    await vi.waitFor(() => expect(statSpy).toHaveBeenCalledWith(lockDir));
    await mkdir(join(tmp, "parakeet", "v2.0.0"), { recursive: true });
    await writeFile(join(tmp, "parakeet", "v2.0.0", "model.bin"), body);
    await rm(lockDir, { recursive: true });

    await expect(run).resolves.toEqual({ status: "ok" });
    expect(fetched).toBe(false);
  });

  it("stops waiting for another download's lock on abort", async () => {
    const entry = makeEntry({}, new Uint8Array([1, 2, 3, 4]));
    const lockDir = join(tmp, "parakeet", ".lock");
    await mkdir(lockDir, { recursive: true });
    const statSpy = vi.spyOn(fsPromises, "stat");
    const controller = new AbortController();
    const run = downloadModel({ entry, modelsRoot: tmp, signal: controller.signal, fetchImpl: fetchOk(new Uint8Array([1, 2, 3, 4])) });

    await vi.waitFor(() => expect(statSpy).toHaveBeenCalledWith(lockDir));
    controller.abort();

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(await stat(lockDir).then(() => true, () => false)).toBe(true);
  });

  it("keeps its lock fresh while it downloads, and leaves a lock another process took over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({}, body);
    const lockDir = join(tmp, "parakeet", ".lock");
    let sendRest!: () => void;
    const rest = new Promise<void>((resolve) => (sendRest = resolve));
    const run = downloadModel({
      entry,
      modelsRoot: tmp,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(body.subarray(0, 2));
          await rest;
          controller.enqueue(body.subarray(2));
          controller.close();
        },
      })),
    });
    await vi.waitFor(async () => expect(await stat(join(lockDir, "owner")).then(() => true, () => false)).toBe(true));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockDir, old, old);

    vi.advanceTimersByTime(20_000);

    await vi.waitFor(async () => expect(Date.now() - (await stat(lockDir)).mtimeMs).toBeLessThan(60_000));
    await writeFile(join(lockDir, "owner"), "another process");
    sendRest();
    await expect(run).resolves.toEqual({ status: "ok" });
    expect(await readFile(join(lockDir, "owner"), "utf8")).toBe("another process");
  });

  it("reclaims a lock nobody refreshed for over two minutes", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({}, body);
    const lockDir = join(tmp, "parakeet", ".lock");
    await mkdir(lockDir, { recursive: true });
    const oldTime = new Date(Date.now() - 3 * 60 * 1000);
    await utimes(lockDir, oldTime, oldTime);
    const result = await downloadModel({
      entry,
      modelsRoot: tmp,
      fetchImpl: fetchOk(body),
    });
    expect(result.status).toBe("ok");
    expect(await stat(join(tmp, "parakeet", "v2.0.0", "model.bin"))).toBeTruthy();
  });

  it("skips re-download if final file already exists", async () => {
    const versionDir = join(tmp, "parakeet", "v2.0.0");
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, "model.bin"), Buffer.from([9, 9, 9, 9]));
    const entry = makeEntry({}, new Uint8Array([1, 2, 3, 4]));
    let fetched = false;
    const result = await downloadModel({
      entry,
      modelsRoot: tmp,
      fetchImpl: async () => {
        fetched = true;
        return new Response(new Uint8Array([1, 2, 3, 4]));
      },
    });
    expect(fetched).toBe(false);
    expect(result.status).toBe("ok");
  });
});
