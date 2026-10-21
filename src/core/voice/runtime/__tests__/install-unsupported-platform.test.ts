import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";

const calls = vi.hoisted(() => ({
  detectGpu: vi.fn(),
  checkDiskSpace: vi.fn(),
  ensureCxxToolchain: vi.fn(),
  ensurePortAudio: vi.fn(),
  runImportSmokeCheck: vi.fn(),
  downloadAndExtractPython: vi.fn(),
  createVenv: vi.fn(),
  installPipRequirements: vi.fn(),
  detectInstalledTorchChannel: vi.fn(),
}));

vi.mock("../gpu-detect", () => ({ detectGpu: calls.detectGpu }));
vi.mock("../disk-check", async (importOriginal) => ({ ...(await importOriginal<typeof import("../disk-check")>()), checkDiskSpace: calls.checkDiskSpace }));
vi.mock("../compiler-check", async (importOriginal) => ({ ...(await importOriginal<typeof import("../compiler-check")>()), ensureCxxToolchain: calls.ensureCxxToolchain }));
vi.mock("../system-libs-check", async (importOriginal) => ({ ...(await importOriginal<typeof import("../system-libs-check")>()), ensurePortAudio: calls.ensurePortAudio }));
vi.mock("../smoke-check", () => ({ runImportSmokeCheck: calls.runImportSmokeCheck }));
vi.mock("../installed-runtime", async (importOriginal) => ({ ...(await importOriginal<typeof import("../installed-runtime")>()), detectInstalledTorchChannel: calls.detectInstalledTorchChannel }));
vi.mock("../python-installer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../python-installer")>()),
  downloadAndExtractPython: calls.downloadAndExtractPython,
  createVenv: calls.createVenv,
  installPipRequirements: calls.installPipRequirements,
}));

const { VoiceRuntimeInstaller, getDefaultRuntimePaths } = await import("../index");
const { UnsupportedPlatformError } = await import("../supported-platforms");

const noExtractWorker = (): never => {
  throw new Error("these tests never extract");
};
const noModelsMissing = { missing: async () => [], download: async () => undefined };

function hostAs(platform: NodeJS.Platform, arch: string): () => void {
  const original = { platform: process.platform, arch: process.arch };
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  return () => {
    Object.defineProperty(process, "platform", { value: original.platform, configurable: true });
    Object.defineProperty(process, "arch", { value: original.arch, configurable: true });
  };
}

describe("VoiceRuntimeInstaller.installAll platform gate", () => {
  let tmp: string;
  let root: string;
  let restoreHost: (() => void) | null = null;

  beforeEach(async () => {
    installFakePlatform();
    tmp = await mkdtemp(join(tmpdir(), "damocles-unsupported-"));
    root = join(tmp, "voice");
    calls.detectGpu.mockResolvedValue({ kind: "cpu", reason: "no-smi" });
    calls.checkDiskSpace.mockResolvedValue({ ok: true, freeBytes: 1, requiredBytes: 1 });
    calls.ensureCxxToolchain.mockResolvedValue(null);
    calls.ensurePortAudio.mockResolvedValue(undefined);
    calls.runImportSmokeCheck.mockResolvedValue({ ok: true });
    calls.detectInstalledTorchChannel.mockResolvedValue("cpu");
    calls.downloadAndExtractPython.mockRejectedValue(new Error("offline"));
  });

  afterEach(async () => {
    restoreHost?.();
    restoreHost = null;
    vi.clearAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  function expectNothingRan(): void {
    for (const [name, fn] of Object.entries(calls)) expect(fn, name).not.toHaveBeenCalled();
  }

  it.each([
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["linux", "arm64"],
  ] as const)("refuses %s %s before any probe, disk write, download or pip run", async (platform, arch) => {
    const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(root), noExtractWorker, noModelsMissing);
    const progress = vi.fn();
    restoreHost = hostAs(platform, arch);
    await expect(installer.installAll({ extensionRoot: tmp, onProgress: progress, allowInstall: true })).rejects.toBeInstanceOf(UnsupportedPlatformError);
    restoreHost();
    restoreHost = null;
    expectNothingRan();
    expect(progress).not.toHaveBeenCalled();
    await expect(access(root)).rejects.toThrow();
  });

  it("refuses a user-supplied runtimePath on an unsupported host without smoke-checking it", async () => {
    const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(root), noExtractWorker, noModelsMissing);
    restoreHost = hostAs("win32", "arm64");
    await expect(installer.installAll({ userSpecifiedPython: "C:\\venv\\python.exe", extensionRoot: tmp, allowInstall: true })).rejects.toBeInstanceOf(UnsupportedPlatformError);
    restoreHost();
    restoreHost = null;
    expectNothingRan();
    await expect(access(root)).rejects.toThrow();
  });

  it("runs the probes on a supported host, so the mocks above observe the real install path", async () => {
    restoreHost = hostAs("win32", "x64");
    const withPath = await new VoiceRuntimeInstaller(getDefaultRuntimePaths(root), noExtractWorker, noModelsMissing).installAll({ userSpecifiedPython: "C:\\venv\\python.exe", extensionRoot: tmp, allowInstall: true });
    expect(withPath.ok).toBe(true);
    expect(calls.detectGpu).toHaveBeenCalled();
    expect(calls.runImportSmokeCheck).toHaveBeenCalled();

    await new VoiceRuntimeInstaller(getDefaultRuntimePaths(join(tmp, "fresh")), noExtractWorker, noModelsMissing).installAll({ extensionRoot: tmp, allowInstall: true });
    expect(calls.ensureCxxToolchain).toHaveBeenCalled();
    expect(calls.checkDiskSpace).toHaveBeenCalled();
    expect(calls.downloadAndExtractPython).toHaveBeenCalled();
  });

  describe("without allowInstall", () => {
    const installSteps = ["ensureCxxToolchain", "ensurePortAudio", "checkDiskSpace", "downloadAndExtractPython", "createVenv", "installPipRequirements"] as const;

    it("reports a missing runtime without installing it", async () => {
      restoreHost = hostAs("win32", "x64");
      const result = await new VoiceRuntimeInstaller(getDefaultRuntimePaths(root), noExtractWorker, noModelsMissing).installAll({ extensionRoot: tmp, allowInstall: false });
      expect(result).toMatchObject({ ok: false, errorMessage: "The voice runtime is not installed." });
      for (const step of [...installSteps, "runImportSmokeCheck"] as const) expect(calls[step], step).not.toHaveBeenCalled();
    });

    it("reports a runtime that fails its smoke check without repairing or reinstalling it", async () => {
      restoreHost = hostAs("win32", "x64");
      const paths = getDefaultRuntimePaths(root);
      await mkdir(dirname(paths.pythonExe), { recursive: true });
      // An installed venv's python, which the real presence check finds; the mocked probes never run it.
      await writeFile(paths.pythonExe, "");
      calls.runImportSmokeCheck.mockResolvedValue({ ok: false, stderr: "ImportError: pyarrow requires NumPy 2.0 or newer", failedModule: "nemo.collections.asr" });
      const result = await new VoiceRuntimeInstaller(paths, noExtractWorker, noModelsMissing).installAll({ extensionRoot: tmp, allowInstall: false });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain("while importing `nemo.collections.asr`");
      expect(calls.detectInstalledTorchChannel).toHaveBeenCalledWith(paths.pythonExe);
      for (const step of installSteps) expect(calls[step], step).not.toHaveBeenCalled();
      await expect(access(paths.pythonExe)).resolves.toBeUndefined();
    });
  });

  describe("concurrent runs", () => {
    function holdGpuDetection(): () => void {
      let release!: () => void;
      calls.detectGpu.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ kind: "cpu", reason: "no-smi" }))));
      return () => release();
    }

    it("installs for a caller that may, arriving while a run only verifies", async () => {
      restoreHost = hostAs("win32", "x64");
      const release = holdGpuDetection();
      const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(root), noExtractWorker, noModelsMissing);
      const verify = installer.installAll({ extensionRoot: tmp, allowInstall: false });
      const install = installer.installAll({ extensionRoot: tmp, allowInstall: true });
      await vi.waitFor(() => expect(calls.detectGpu).toHaveBeenCalled());
      release();
      expect(await verify).toMatchObject({ ok: false, errorMessage: "The voice runtime is not installed." });
      expect(await install).toMatchObject({ ok: false, errorMessage: "offline" });
      expect(calls.ensureCxxToolchain).toHaveBeenCalledTimes(1);
      expect(calls.downloadAndExtractPython).toHaveBeenCalledTimes(1);
    });

    it("lets a caller that only verifies join a run that installs", async () => {
      restoreHost = hostAs("win32", "x64");
      const release = holdGpuDetection();
      const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(root), noExtractWorker, noModelsMissing);
      const install = installer.installAll({ extensionRoot: tmp, allowInstall: true });
      const verify = installer.installAll({ extensionRoot: tmp, allowInstall: false });
      await vi.waitFor(() => expect(calls.detectGpu).toHaveBeenCalled());
      release();
      expect(await verify).toBe(await install);
      expect(calls.detectGpu).toHaveBeenCalledTimes(1);
      expect(calls.downloadAndExtractPython).toHaveBeenCalledTimes(1);
    });
  });
});
