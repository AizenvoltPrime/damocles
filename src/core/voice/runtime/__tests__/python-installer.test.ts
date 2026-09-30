import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  UnsupportedPlatformError,
  downloadWithResumeAndVerify,
  getPbsTarballUrl,
  pickPbsTriple,
  pickTorchWheelChannel,
} from "../python-installer";

describe("pickPbsTriple", () => {
  it("maps win32 x64 to MSVC triple", () => {
    expect(pickPbsTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });
  it("maps darwin x64 to apple-darwin", () => {
    expect(pickPbsTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
  });
  it("maps darwin arm64 to aarch64-apple-darwin", () => {
    expect(pickPbsTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
  });
  it("maps linux x64 to gnu triple", () => {
    expect(pickPbsTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
  });
  it("throws UnsupportedPlatformError on win32 arm64", () => {
    expect(() => pickPbsTriple("win32", "arm64")).toThrow(UnsupportedPlatformError);
  });
  it("throws UnsupportedPlatformError on linux arm64", () => {
    expect(() => pickPbsTriple("linux", "arm64")).toThrow(UnsupportedPlatformError);
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
});
