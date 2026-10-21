import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { create, list } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtractWorkerData } from "../extract-protocol";
import { isSafeEntry } from "../extract-worker";
import { CancelledError, extractTarball, extractWorkerAt, type ExtractWorkerFactory } from "../python-installer";

let bundleDir: string;
let workerPath: string;
let tmp: string;

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "damocles-voice-extract-bundle-"));
  workerPath = join(bundleDir, "dist", "voice-extract-worker.js");
  // The real worker bundle, tar included, as esbuild.config.mjs builds it.
  await build({
    entryPoints: [join(__dirname, "..", "extract-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile: workerPath,
    logLevel: "silent",
  });
});

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "damocles-voice-extract-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function archive(entries: string[], sourceDir: string): Promise<string> {
  const file = join(tmp, "python.tar.gz");
  await create({ file, cwd: sourceDir, gzip: true, preservePaths: true }, entries);
  return file;
}

function countingFactory(inner: ExtractWorkerFactory): { factory: ExtractWorkerFactory; started: ExtractWorkerData[] } {
  const started: ExtractWorkerData[] = [];
  return { started, factory: (data) => (started.push(data), inner(data)) };
}

describe("isSafeEntry", () => {
  const file = { type: "File" as const, linkpath: undefined };

  it.each([
    "python/bin/python3",
    "python\\Lib\\os.py",
    "python/lib/..data",
    "./python/x",
  ])("keeps %s", (path) => {
    expect(isSafeEntry(path, file)).toBe(true);
  });

  it.each([
    ["an empty path", ""],
    ["a POSIX absolute path", "/etc/passwd"],
    ["a backslash-rooted path", "\\Windows\\x"],
    ["a drive-absolute path", "C:\\Windows\\x"],
    ["a drive-relative path", "C:x"],
    ["a UNC path", "\\\\server\\share\\x"],
    ["a leading climb", "../x"],
    ["a climb in the middle", "python/../../x"],
    ["a mixed-separator climb", "a\\../b"],
    ["a trailing climb", "python/.."],
    ["a lone climb", ".."],
  ])("drops %s", (_case, path) => {
    expect(isSafeEntry(path, file)).toBe(false);
  });

  it("keeps a symbolic link whose target stays inside, and a hard link to an entry inside", () => {
    expect(isSafeEntry("python/bin/python3", { type: "SymbolicLink", linkpath: "python3.11" })).toBe(true);
    expect(isSafeEntry("python/share/a/b", { type: "SymbolicLink", linkpath: "../c/b" })).toBe(true);
    expect(isSafeEntry("python/bin/python", { type: "Link", linkpath: "python/bin/python3.11" })).toBe(true);
  });

  it.each([
    ["a symbolic link climbing out of the folder", "python/bin/x", "SymbolicLink", "../../../etc/passwd"],
    ["a symbolic link to an absolute target", "python/bin/x", "SymbolicLink", "/etc/passwd"],
    ["a symbolic link to a drive", "python/bin/x", "SymbolicLink", "C:\\Windows"],
    ["a symbolic link to a UNC share", "python/bin/x", "SymbolicLink", "\\\\server\\share"],
    ["a hard link climbing out", "python/bin/x", "Link", "../outside"],
    ["a hard link to an absolute target", "python/bin/x", "Link", "/etc/passwd"],
    ["a link with no target", "python/bin/x", "SymbolicLink", undefined],
  ] as const)("drops %s", (_case, path, type, linkpath) => {
    expect(isSafeEntry(path, { type, linkpath })).toBe(false);
  });
});

describe("extractTarball", () => {
  it("extracts on the worker the injected factory starts", async () => {
    const source = join(tmp, "source");
    await mkdir(join(source, "python", "bin"), { recursive: true });
    await writeFile(join(source, "python", "bin", "python3"), "interpreter");
    const file = await archive(["python"], source);
    const target = join(tmp, "target");
    await mkdir(target);
    const { factory, started } = countingFactory(extractWorkerAt(workerPath));

    await extractTarball(file, target, undefined, factory);

    expect(started).toEqual([expect.objectContaining({ file, cwd: target })]);
    expect(await readFile(join(target, "python", "bin", "python3"), "utf8")).toBe("interpreter");
  });

  it("skips an entry that climbs out of the target with ../", async () => {
    const source = join(tmp, "a", "source");
    await mkdir(join(source, "python"), { recursive: true });
    await writeFile(join(source, "python", "ok.txt"), "ok");
    await writeFile(join(tmp, "a", "escape.txt"), "escaped");
    const file = await archive(["python", "../escape.txt"], source);
    const listed: string[] = [];
    await list({ file, onReadEntry: (entry) => void listed.push(entry.path) });
    expect(listed).toContain("../escape.txt");
    const target = join(tmp, "b", "target");
    await mkdir(target, { recursive: true });

    await extractTarball(file, target, undefined, extractWorkerAt(workerPath));

    expect(await exists(join(target, "python", "ok.txt"))).toBe(true);
    expect(await exists(join(tmp, "b", "escape.txt"))).toBe(false);
  });

  it("rejects with the worker's error and removes the partial python folder", async () => {
    await mkdir(join(tmp, "python", "lib"), { recursive: true });
    await writeFile(join(tmp, "python", "lib", "half.py"), "partial");
    const file = join(tmp, "not-an-archive.tar.gz");
    await writeFile(file, "plain text");

    await expect(extractTarball(file, tmp, undefined, extractWorkerAt(workerPath))).rejects.toThrow();
    expect(await exists(join(tmp, "python"))).toBe(false);
  });

  it("ends the worker on abort and removes the partial python folder", async () => {
    await mkdir(join(tmp, "python", "lib"), { recursive: true });
    await writeFile(join(tmp, "python", "lib", "half.py"), "partial");
    let worker: Worker | undefined;
    // A worker that never answers, standing in for one partway through a large archive.
    const factory: ExtractWorkerFactory = () => (worker = new Worker("setInterval(() => {}, 1000)", { eval: true }));
    const controller = new AbortController();
    const run = extractTarball(join(tmp, "python.tar.gz"), tmp, controller.signal, factory);
    const exited = new Promise<number>((resolve) => worker!.once("exit", resolve));
    await new Promise((resolve) => worker!.once("online", resolve));

    controller.abort();

    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(await exited).toBe(1);
    expect(await exists(join(tmp, "python"))).toBe(false);
  });

  it("starts no worker when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory, started } = countingFactory(extractWorkerAt(workerPath));

    await expect(extractTarball(join(tmp, "python.tar.gz"), tmp, controller.signal, factory)).rejects.toBeInstanceOf(CancelledError);
    expect(started).toEqual([]);
  });
});
