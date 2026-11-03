import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import {
  ChecksumMismatchError,
  DownloadHttpError,
  EmptyDownloadError,
  downloadAndExtractPython,
  downloadWithResumeAndVerify,
  getPbsCandidates,
  getPbsTarballUrl,
  pickPbsTriple,
  pickTorchWheelChannel,
} from "../python-installer";
import type { ExtractWorkerData } from "../extract-protocol";
import { UnsupportedPlatformError } from "../supported-platforms";
import { LocalizedError } from "../../../../shared/localized-text";

// A second release after the pinned one, whose checksum is the archive the fallback tests serve.
const fallback = vi.hoisted(() => ({ release: "20240909", archive: "fallback python archive" }));
vi.mock("../tarball-checksums.json", async (importOriginal) => {
  const { createHash: hash } = await import("node:crypto");
  const actual = (await importOriginal<{ default: { releases: Array<{ checksums: Record<string, string> }> } }>()).default;
  const sha = hash("sha256").update(fallback.archive).digest("hex");
  const checksums = Object.fromEntries(Object.keys(actual.releases[0]!.checksums).map((triple) => [triple, sha]));
  return { default: { releases: [...actual.releases, { release: fallback.release, python_version: "3.11.9", checksums }] } };
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe("pickPbsTriple", () => {
  beforeEach(() => {
    installFakePlatform();
  });

  it.each([
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["darwin", "arm64", "aarch64-apple-darwin"],
  ] as const)("maps %s %s to %s", (platform, arch, triple) => {
    expect(pickPbsTriple(platform, arch)).toBe(triple);
  });

  it.each([
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["linux", "arm64"],
  ] as const)("refuses %s %s", (platform, arch) => {
    expect(() => pickPbsTriple(platform, arch)).toThrow(UnsupportedPlatformError);
  });
});

describe("getPbsTarballUrl", () => {
  it("constructs install_only URL for windows x64", () => {
    const url = getPbsTarballUrl("win32", "x64", "cuda");
    expect(url).toContain("cpython-");
    expect(url).toContain("x86_64-pc-windows-msvc-install_only.tar.gz");
    expect(url.startsWith("https://github.com/indygreg/python-build-standalone/releases/download/")).toBe(true);
  });
  it("includes pinned release tag", () => {
    const url = getPbsTarballUrl("linux", "x64", "cpu");
    expect(url).toContain("/20241016/");
  });
});

describe("pickTorchWheelChannel", () => {
  it("returns cpu for cpu detection", () => {
    expect(pickTorchWheelChannel("cpu", undefined)).toBe("cpu");
  });
  it("uses provided cuda channel for cuda detection", () => {
    expect(pickTorchWheelChannel("cuda", "cu118")).toBe("cu118");
  });
  it("defaults to cu121 for cuda detection without explicit channel", () => {
    expect(pickTorchWheelChannel("cuda", undefined)).toBe("cu121");
  });
});

describe("downloadWithResumeAndVerify", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-pbs-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeFetchOk(body: Uint8Array, expectsRange: { from: number } | null): typeof fetch {
    return async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers["Range"];
      if (expectsRange !== null) {
        if (range !== `bytes=${expectsRange.from}-`) {
          throw new Error(`Expected Range bytes=${expectsRange.from}-, got '${range}'`);
        }
      }
      return new Response(body, {
        status: range !== undefined ? 206 : 200,
        headers: { "content-length": String(body.byteLength) },
      });
    };
  }

  it("downloads a small payload to dest and removes .partial", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await downloadWithResumeAndVerify({
      url: "https://example/test.tar.gz",
      destFile,
      expectedSha256: "PLACEHOLDER_TEST",
      fetchImpl: makeFetchOk(payload, null),
    });
    const written = await readFile(destFile);
    expect(written.length).toBe(8);
  });

  it("rejects on SHA-256 mismatch when checksum is real", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      downloadWithResumeAndVerify({
        url: "https://example/test.tar.gz",
        destFile,
        expectedSha256: "deadbeef0000000000000000000000000000000000000000000000000000beef",
        fetchImpl: makeFetchOk(payload, null),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("sends Range header on resume from existing .partial", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const partial = `${destFile}.partial`;
    await writeFile(partial, Buffer.from([1, 2, 3, 4]));
    const remainder = new Uint8Array([5, 6, 7, 8]);
    await downloadWithResumeAndVerify({
      url: "https://example/test.tar.gz",
      destFile,
      expectedSha256: "PLACEHOLDER_TEST",
      fetchImpl: makeFetchOk(remainder, { from: 4 }),
    });
    const written = await readFile(destFile);
    expect(written.length).toBe(8);
    expect(Array.from(written)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("propagates HTTP error responses", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const errorFetch: typeof fetch = async () => new Response("not found", { status: 404, statusText: "Not Found" });
    await expect(
      downloadWithResumeAndVerify({
        url: "https://example/missing.tar.gz",
        destFile,
        expectedSha256: "PLACEHOLDER_TEST",
        fetchImpl: errorFetch,
      }),
    ).rejects.toThrow(/404/);
  });

  it("throws localized errors that keep their classes", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const errorFetch: typeof fetch = async () => new Response("gone", { status: 503, statusText: "Service Unavailable" });
    const failure = await downloadWithResumeAndVerify({
      url: "https://example/missing.tar.gz",
      destFile,
      expectedSha256: "PLACEHOLDER_TEST",
      fetchImpl: errorFetch,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DownloadHttpError);
    expect(failure).toBeInstanceOf(LocalizedError);
    expect((failure as LocalizedError).text).toEqual({
      message: "Download failed ({0} {1}): {2}",
      args: ["503", "Service Unavailable", "https://example/missing.tar.gz"],
    });

    const mismatch = await downloadWithResumeAndVerify({
      url: "https://example/test.tar.gz",
      destFile,
      expectedSha256: "deadbeef0000000000000000000000000000000000000000000000000000beef",
      fetchImpl: makeFetchOk(new Uint8Array([1]), null),
    }).catch((err: unknown) => err);
    expect(mismatch).toBeInstanceOf(ChecksumMismatchError);
    expect(mismatch).toBeInstanceOf(LocalizedError);
  });

  it("leaves the status text out of an HTTP failure that has none, as HTTP/2 answers do", async () => {
    const failure = await downloadWithResumeAndVerify({
      url: "https://example/missing.tar.gz",
      destFile: join(tmp, "tarball.tar.gz"),
      expectedSha256: "PLACEHOLDER_TEST",
      fetchImpl: async () => new Response("not found", { status: 404 }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DownloadHttpError);
    expect((failure as LocalizedError).text).toEqual({ message: "Download failed ({0}): {1}", args: ["404", "https://example/missing.tar.gz"] });
  });

  it("names the address of a download that returned no body", async () => {
    const failure = await downloadWithResumeAndVerify({
      url: "https://example/empty.tar.gz",
      destFile: join(tmp, "tarball.tar.gz"),
      expectedSha256: "PLACEHOLDER_TEST",
      fetchImpl: async () => new Response(null, { status: 200 }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EmptyDownloadError);
    expect((failure as LocalizedError).text).toEqual({ message: "The download of {0} returned no data.", args: ["https://example/empty.tar.gz"] });
  });

  it("finishes a partial file that already holds the whole verified archive without downloading", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const archive = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await writeFile(`${destFile}.partial`, archive);
    let fetched = false;
    await downloadWithResumeAndVerify({
      url: "https://example/test.tar.gz",
      destFile,
      expectedSha256: sha256(archive),
      fetchImpl: async () => {
        fetched = true;
        return new Response(null, { status: 416 });
      },
    });
    expect(fetched).toBe(false);
    expect(Array.from(await readFile(destFile))).toEqual(Array.from(archive));
    expect(await exists(`${destFile}.partial`)).toBe(false);
  });

  it("starts over once when the server holds nothing past the partial file", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    const archive = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await writeFile(`${destFile}.partial`, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
    const ranges: Array<string | undefined> = [];
    await downloadWithResumeAndVerify({
      url: "https://example/test.tar.gz",
      destFile,
      expectedSha256: sha256(archive),
      fetchImpl: async (_input, init) => {
        const range = (init?.headers as Record<string, string>)["Range"];
        ranges.push(range);
        return range !== undefined ? new Response(null, { status: 416, statusText: "Range Not Satisfiable" }) : new Response(archive);
      },
    });
    expect(ranges).toEqual(["bytes=8-", undefined]);
    expect(Array.from(await readFile(destFile))).toEqual(Array.from(archive));
  });

  it("fails on a second 416 instead of starting over again", async () => {
    const destFile = join(tmp, "tarball.tar.gz");
    await writeFile(`${destFile}.partial`, new Uint8Array([1, 2, 3, 4]));
    let requests = 0;
    const failure = await downloadWithResumeAndVerify({
      url: "https://example/test.tar.gz",
      destFile,
      expectedSha256: "PLACEHOLDER_TEST",
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 416, statusText: "Range Not Satisfiable" });
      },
    }).catch((err: unknown) => err);
    expect(requests).toBe(2);
    expect((failure as DownloadHttpError).status).toBe(416);
  });
});

describe("downloadAndExtractPython release fallback", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-pbs-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const candidateUrls = getPbsCandidates("linux", "x64").map((candidate) => candidate.url);
  let fetched: string[];
  let extracted: ExtractWorkerData[];
  beforeEach(() => {
    fetched = [];
    extracted = [];
  });

  const run = (answer: (url: string) => Response): Promise<unknown> =>
    downloadAndExtractPython({
      targetDir: tmp,
      createExtractWorker: (data) => {
        extracted.push(data);
        throw new Error("no extraction in these tests");
      },
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return answer(String(input));
      },
      platform: "linux",
      arch: "x64",
      gpuKind: "cpu",
    }).catch((err: unknown) => err);

  it("tries every release in order on a 404 by its status, and names the last error", async () => {
    const failure = await run(() => new Response("x", { status: 404, statusText: "Gone Away" }));
    expect(candidateUrls).toHaveLength(2);
    expect(fetched).toEqual(candidateUrls);
    expect(failure).toBeInstanceOf(LocalizedError);
    expect(failure).not.toBeInstanceOf(DownloadHttpError);
    expect((failure as LocalizedError).text).toEqual({
      message: "No python-build-standalone release could be downloaded. Most recent error: {0}",
      args: [{ message: "Download failed ({0} {1}): {2}", args: ["404", "Gone Away", candidateUrls[1]] }],
    });
  });

  it("extracts the next release after a 404", async () => {
    const failure = await run((url) => url === candidateUrls[0] ? new Response("x", { status: 404 }) : new Response(fallback.archive));
    expect(fetched).toEqual(candidateUrls);
    expect(extracted).toEqual([expect.objectContaining({ file: join(tmp, `python-${fallback.release}.tar.gz`), cwd: tmp })]);
    expect((failure as Error).message).toBe("no extraction in these tests");
  });

  it("stops at another status even when its text says Not Found", async () => {
    const failure = await run(() => new Response("x", { status: 500, statusText: "Not Found" }));
    expect(fetched).toEqual([candidateUrls[0]]);
    expect(failure).toBeInstanceOf(DownloadHttpError);
    expect((failure as DownloadHttpError).status).toBe(500);
  });
});
