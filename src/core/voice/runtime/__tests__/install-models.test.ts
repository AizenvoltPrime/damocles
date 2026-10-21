import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import type { ModelEntry } from "../../models";
import type { VoiceModels } from "../../models/provision";
import type { RuntimeProgress } from "../index";

const calls = vi.hoisted(() => ({ detectGpu: vi.fn(), runImportSmokeCheck: vi.fn() }));
vi.mock("../gpu-detect", () => ({ detectGpu: calls.detectGpu }));
vi.mock("../smoke-check", () => ({ runImportSmokeCheck: calls.runImportSmokeCheck }));

const { VoiceRuntimeInstaller, getDefaultRuntimePaths } = await import("../index");

const noExtractWorker = (): never => {
  throw new Error("these tests never extract");
};

function model(id: string, bytes: number): ModelEntry {
  return { id, version: "1.0.0", description: id, license: "MIT", license_url: "", huggingface_repo: "", files: [{ filename: `${id}.bin`, url: "", sha256: "", bytes }], gated: false };
}

function hostAs(platform: NodeJS.Platform, arch: string): () => void {
  const original = { platform: process.platform, arch: process.arch };
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  return () => {
    Object.defineProperty(process, "platform", { value: original.platform, configurable: true });
    Object.defineProperty(process, "arch", { value: original.arch, configurable: true });
  };
}

describe("VoiceRuntimeInstaller.installAll and the voice models", () => {
  let tmp: string;
  let restoreHost: () => void;
  let progress: RuntimeProgress[];
  let downloaded: string[];

  beforeEach(async () => {
    installFakePlatform();
    restoreHost = hostAs("win32", "x64");
    tmp = await mkdtemp(join(tmpdir(), "damocles-install-models-"));
    progress = [];
    downloaded = [];
    calls.detectGpu.mockResolvedValue({ kind: "cpu", reason: "no-smi" });
    calls.runImportSmokeCheck.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    restoreHost();
    vi.clearAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  function models(missing: ModelEntry[], download?: VoiceModels["download"]): VoiceModels {
    return {
      missing: async () => missing.filter((entry) => !downloaded.includes(entry.id)),
      download: download ?? (async (entry, _signal, onBytes) => {
        onBytes(modelBytesOf(entry) / 2);
        onBytes(modelBytesOf(entry));
        downloaded.push(entry.id);
      }),
    };
  }
  const modelBytesOf = (entry: ModelEntry): number => entry.files[0]!.bytes;

  // The user's own Python is the runtime path that needs no install, so these tests reach the models with no mocks of it.
  function install(source: VoiceModels, allowInstall: boolean) {
    return new VoiceRuntimeInstaller(getDefaultRuntimePaths(join(tmp, "voice")), noExtractWorker, source).installAll({
      userSpecifiedPython: "C:\\venv\\python.exe",
      extensionRoot: tmp,
      allowInstall,
      onProgress: (p) => progress.push(p),
    });
  }

  it("downloads every missing model after the runtime, and reports ready only once they are on disk", async () => {
    const result = await install(models([model("asr", 100), model("tts", 300)]), true);

    expect(result.ok).toBe(true);
    expect(downloaded).toEqual(["asr", "tts"]);
    const stages = progress.map((p) => p.stage);
    expect(stages.indexOf("downloading-models")).toBeGreaterThan(stages.indexOf("smoke-check"));
    expect(stages.filter((stage) => stage === "done")).toEqual(["done"]);
    expect(stages.at(-1)).toBe("done");
    const pcts = progress.filter((p) => p.stage === "downloading-models").map((p) => p.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(pcts).toContain(25);
  });

  it("a start that may not install names the missing models and downloads none", async () => {
    const download = vi.fn();
    const result = await install(models([model("asr", 100)], download), false);

    expect(result).toMatchObject({ ok: false, errorMessage: "The voice models are not downloaded (asr).", missing: "models" });
    expect(download).not.toHaveBeenCalled();
  });

  it.each(["venv\\Scripts\\python.exe", "python", "\\\\server\\share\\python.exe"])("refuses the relative or remote runtimePath %s before running it", async (python) => {
    const download = vi.fn();
    const result = await new VoiceRuntimeInstaller(getDefaultRuntimePaths(join(tmp, "voice")), noExtractWorker, models([model("asr", 100)], download)).installAll({
      userSpecifiedPython: python,
      extensionRoot: tmp,
      allowInstall: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("damocles.voice.runtimePath");
    expect(result.missing).toBeUndefined();
    expect(calls.runImportSmokeCheck).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("ends the install with the download's own error, a cancel included", async () => {
    const cancelled = Object.assign(new Error("Download cancelled"), { name: "CancelledError" });
    await expect(install(models([model("asr", 100)], async () => Promise.reject(cancelled)), true)).rejects.toBe(cancelled);
    expect(progress.map((p) => p.stage)).not.toContain("done");
  });
});
