import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChecksumMismatchError, ModelLockBusyError, downloadModel } from "../downloader";
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

  it("blocks concurrent download of same model with a fresh lock", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({}, body);
    const lockDir = join(tmp, "parakeet", ".lock");
    await mkdir(lockDir, { recursive: true });
    await expect(
      downloadModel({
        entry,
        modelsRoot: tmp,
        fetchImpl: fetchOk(body),
      }),
    ).rejects.toBeInstanceOf(ModelLockBusyError);
  });

  it("reclaims a stale lock older than 10 minutes", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const entry = makeEntry({}, body);
    const lockDir = join(tmp, "parakeet", ".lock");
    await mkdir(lockDir, { recursive: true });
    const oldTime = new Date(Date.now() - 11 * 60 * 1000);
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
