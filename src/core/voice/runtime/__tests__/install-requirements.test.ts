import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import type { InstallAllOptions } from "../index";

const calls = vi.hoisted(() => ({
  pip: vi.fn(),
  extract: vi.fn(async () => ({ pythonExe: "python", pythonHomeDir: "python" })),
  venv: vi.fn(async () => "venv-python"),
  smoke: vi.fn(async () => ({ ok: true })),
  installed: vi.fn(async () => ({ present: false })),
  channel: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../gpu-detect", () => ({ detectGpu: async () => ({ kind: "cpu", reason: "no-smi" }) }));
vi.mock("../smoke-check", () => ({ runImportSmokeCheck: calls.smoke }));
vi.mock("../compiler-check", async (importOriginal) => ({ ...(await importOriginal<object>()), ensureCxxToolchain: async () => null }));
vi.mock("../system-libs-check", async (importOriginal) => ({ ...(await importOriginal<object>()), ensurePortAudio: async () => undefined }));
vi.mock("../disk-check", async (importOriginal) => ({ ...(await importOriginal<object>()), checkDiskSpace: async () => ({ ok: true, freeBytes: 1e12, requiredBytes: 1 }) }));
vi.mock("../installed-runtime", () => ({ detectInstalledRuntime: calls.installed, detectInstalledTorchChannel: calls.channel }));
vi.mock("../python-installer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadAndExtractPython: calls.extract,
  createVenv: calls.venv,
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
    calls.smoke.mockImplementation(async () => ({ ok: true }));
    calls.installed.mockImplementation(async () => ({ present: false }));
    calls.channel.mockImplementation(async () => null);
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

  async function installedRuntimeMarker(): Promise<string> {
    const runtimeDir = join(tmp, "voice", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const marker = join(runtimeDir, "marker.txt");
    await writeFile(marker, "installed");
    calls.installed.mockImplementation(async () => ({ present: true }));
    return marker;
  }

  function expectNothingInstalled(): void {
    expect(calls.extract).not.toHaveBeenCalled();
    expect(calls.venv).not.toHaveBeenCalled();
    expect(calls.pip).not.toHaveBeenCalled();
  }

  it("keeps an installed runtime whose torch channel no longer fits", async () => {
    const marker = await installedRuntimeMarker();
    calls.channel.mockImplementation(async () => "cu121");

    const result = await install({ extensionRoot: tmp });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatchObject({ message: "The voice requirements file was not found at {0}. Reinstall Damocles." });
    expect(await readFile(marker, "utf8")).toBe("installed");
    expectNothingInstalled();
  });

  it("keeps an installed runtime whose smoke check fails", async () => {
    const marker = await installedRuntimeMarker();
    calls.smoke.mockImplementation(async () => ({ ok: false }));

    const result = await install({ extensionRoot: tmp });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatchObject({ message: "The voice requirements file was not found at {0}. Reinstall Damocles." });
    expect(await readFile(marker, "utf8")).toBe("installed");
    expect(calls.smoke).not.toHaveBeenCalled();
    expectNothingInstalled();
  });
});
