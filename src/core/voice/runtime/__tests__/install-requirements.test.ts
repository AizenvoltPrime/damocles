import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import type { InstallAllOptions } from "../index";

const calls = vi.hoisted(() => ({ pip: vi.fn() }));
vi.mock("../gpu-detect", () => ({ detectGpu: async () => ({ kind: "cpu", reason: "no-smi" }) }));
vi.mock("../smoke-check", () => ({ runImportSmokeCheck: async () => ({ ok: true }) }));
vi.mock("../compiler-check", async (importOriginal) => ({ ...(await importOriginal<object>()), ensureCxxToolchain: async () => null }));
vi.mock("../system-libs-check", async (importOriginal) => ({ ...(await importOriginal<object>()), ensurePortAudio: async () => undefined }));
vi.mock("../disk-check", async (importOriginal) => ({ ...(await importOriginal<object>()), checkDiskSpace: async () => ({ ok: true, freeBytes: 1e12, requiredBytes: 1 }) }));
vi.mock("../installed-runtime", () => ({ detectInstalledRuntime: async () => ({ present: false }), detectInstalledTorchChannel: async () => null }));
vi.mock("../python-installer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadAndExtractPython: async () => ({ pythonExe: "python", pythonHomeDir: "python" }),
  createVenv: async () => "venv-python",
  installPipRequirements: calls.pip,
}));

const { VoiceRuntimeInstaller, getDefaultRuntimePaths } = await import("../index");

const noExtractWorker = (): never => {
  throw new Error("these tests never extract");
};
const noModelsMissing = { missing: async () => [], download: async () => undefined };

describe("a full voice runtime install without its requirements file", () => {
  let tmp: string;

  beforeEach(async () => {
    installFakePlatform();
    tmp = await mkdtemp(join(tmpdir(), "damocles-install-requirements-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  function install(opts: Partial<InstallAllOptions>) {
    return new VoiceRuntimeInstaller(getDefaultRuntimePaths(join(tmp, "voice")), noExtractWorker, noModelsMissing).installAll({ allowInstall: true, ...opts });
  }

  it("says it was started without the install folder when neither a file nor the folder is given", async () => {
    const result = await install({});

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toEqual({ message: "The voice installer was started without Damocles' install folder, so it cannot find its requirements file." });
    expect(calls.pip).not.toHaveBeenCalled();
  });

  it("names the requirements file the install folder lacks", async () => {
    const result = await install({ extensionRoot: tmp });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toEqual({
      message: "The voice requirements file was not found at {0}. Reinstall Damocles.",
      args: [join(tmp, "python", "damocles_voice_sidecar", "requirements.txt")],
    });
    expect(calls.pip).not.toHaveBeenCalled();
  });

  it("names a given requirements file that is missing", async () => {
    const missing = join(tmp, "missing-requirements.txt");

    const result = await install({ requirementsFile: missing });

    expect(result.errorMessage).toEqual({ message: "The voice requirements file was not found at {0}. Reinstall Damocles.", args: [missing] });
    expect(calls.pip).not.toHaveBeenCalled();
  });
});
