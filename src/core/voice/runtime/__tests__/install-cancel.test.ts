import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";

const calls = vi.hoisted(() => ({
  smoke: vi.fn(),
  pip: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../gpu-detect", () => ({ detectGpu: async () => ({ kind: "cpu", reason: "no-smi" }) }));
vi.mock("../smoke-check", () => ({ runImportSmokeCheck: calls.smoke }));
vi.mock("../compiler-check", async (importOriginal) => ({ ...(await importOriginal<object>()), ensureCxxToolchain: async () => null }));
vi.mock("../system-libs-check", async (importOriginal) => ({ ...(await importOriginal<object>()), ensurePortAudio: async () => undefined }));
vi.mock("../disk-check", async (importOriginal) => ({ ...(await importOriginal<object>()), checkDiskSpace: async () => ({ ok: true, freeBytes: 1e12, requiredBytes: 1 }) }));
vi.mock("../installed-runtime", () => ({ detectInstalledRuntime: async () => ({ present: true }), detectInstalledTorchChannel: async () => "cpu" }));
vi.mock("../python-installer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  installPipRequirements: calls.pip,
  downloadAndExtractPython: calls.download,
}));

const { VoiceRuntimeInstaller, getDefaultRuntimePaths } = await import("../index");
const { CancelledError } = await import("../python-installer");

const noExtractWorker = (): never => {
  throw new Error("these tests never extract");
};
const noModelsMissing = { missing: async () => [], download: async () => undefined };
const failedSmoke = { ok: false, stderr: "ModuleNotFoundError: No module named 'pyarrow'", exitCode: 1, failedModule: "nemo.collections.asr" };

describe("cancelling a repair of the installed runtime", () => {
  let tmp: string;
  let runtimeFile: string;

  beforeEach(async () => {
    installFakePlatform();
    tmp = await mkdtemp(join(tmpdir(), "damocles-install-cancel-"));
    await writeFile(join(tmp, "requirements.txt"), "");
    runtimeFile = join(tmp, "voice", "runtime", "venv", "marker");
    await mkdir(join(tmp, "voice", "runtime", "venv"), { recursive: true });
    await writeFile(runtimeFile, "installed");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  function install(signal: AbortSignal) {
    return new VoiceRuntimeInstaller(getDefaultRuntimePaths(join(tmp, "voice")), noExtractWorker, noModelsMissing).installAll({
      requirementsFile: join(tmp, "requirements.txt"),
      allowInstall: true,
      signal,
    });
  }

  it("keeps the installed runtime when Cancel stops the repair's pip", async () => {
    const controller = new AbortController();
    calls.smoke.mockResolvedValue(failedSmoke);
    calls.pip.mockImplementation(async () => {
      controller.abort();
      throw new CancelledError();
    });

    await expect(install(controller.signal)).rejects.toBeInstanceOf(CancelledError);

    expect(await stat(runtimeFile).then(() => true, () => false)).toBe(true);
    expect(calls.download).not.toHaveBeenCalled();
  });

  it("keeps the installed runtime when Cancel stops the smoke check", async () => {
    const controller = new AbortController();
    calls.smoke.mockImplementation(async () => {
      controller.abort();
      throw new CancelledError();
    });

    await expect(install(controller.signal)).rejects.toBeInstanceOf(CancelledError);

    expect(await stat(runtimeFile).then(() => true, () => false)).toBe(true);
    expect(calls.pip).not.toHaveBeenCalled();
    expect(calls.download).not.toHaveBeenCalled();
  });

  it("still reinstalls a runtime the repair could not fix", async () => {
    calls.smoke.mockResolvedValue(failedSmoke);
    calls.pip.mockRejectedValue(new Error("pip install failed (exit 1)"));
    calls.download.mockRejectedValue(new Error("network blocked in unit test"));

    const result = await install(new AbortController().signal);

    expect(result).toMatchObject({ ok: false, errorMessage: "network blocked in unit test" });
    expect(await stat(runtimeFile).then(() => true, () => false)).toBe(false);
  });
});
