import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDiskSpace, INSTALL_SIZE_BYTES } from "../disk-check";
import {
  VoiceRuntimeInstaller,
  applyUserPreference,
  checkRuntimeModeCompatibility,
  expectedTorchChannel,
  getDefaultRuntimePaths,
} from "../index";
import type { GpuDetection } from "../gpu-detect";

vi.mock("../compiler-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compiler-check")>();
  return { ...actual, ensureCxxToolchain: vi.fn().mockResolvedValue(null) };
});

vi.mock("../system-libs-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../system-libs-check")>();
  return { ...actual, ensurePortAudio: vi.fn().mockResolvedValue(undefined) };
});

const CUDA_535: GpuDetection = {
  kind: "cuda",
  driverVersion: "596.21",
  torchWheelChannel: "cu121",
  smiPath: "nvidia-smi",
};
const CUDA_525: GpuDetection = {
  kind: "cuda",
  driverVersion: "528.00",
  torchWheelChannel: "cu118",
  smiPath: "/usr/lib/wsl/lib/nvidia-smi",
};
const CPU_NO_SMI: GpuDetection = { kind: "cpu", reason: "no-smi" };
const CPU_OLD: GpuDetection = { kind: "cpu", reason: "driver-too-old" };

describe("disk-check", () => {
  it("flags insufficient space when free < required × 1.5", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "damocles-disk-"));
    try {
      const result = await checkDiskSpace(tmp, INSTALL_SIZE_BYTES.cudaWindows * 1000);
      expect(result.requiredBytes).toBe(Math.ceil(INSTALL_SIZE_BYTES.cudaWindows * 1000 * 1.5));
      expect(result.ok).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("clears check for tiny install size", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "damocles-disk-"));
    try {
      const result = await checkDiskSpace(tmp, 1024);
      expect(result.ok).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("VoiceRuntimeInstaller — smoke-check error path", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-runtime-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("surfaces ImportError text from a failing user-supplied Python", async () => {
    const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(tmp));
    const events: string[] = [];
    const result = await installer.installAll({
      userSpecifiedPython: "/this/path/does/not/exist/python",
      onProgress: (p) => events.push(`${p.stage}:${p.message}`),
    });
    expect(result.ok).toBe(false);
    expect(events.some((e) => e.startsWith("error:"))).toBe(true);
  });

  it("reports ok=false when installed runtime missing and full-install path fails", async () => {
    const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(tmp));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("network blocked in unit test"),
    );
    try {
      const result = await installer.installAll({ onProgress: () => {} });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toMatch(/network|download|smoke check/i);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("getDefaultRuntimePaths", () => {
  it("places venv python under runtime/venv/{Scripts|bin}", () => {
    const paths = getDefaultRuntimePaths("/tmp/test");
    expect(paths.pythonExe.includes("venv")).toBe(true);
    expect(paths.modelsDir.endsWith("models")).toBe(true);
  });
});

describe("checkRuntimeModeCompatibility", () => {
  it("rejects cuda request when detection is cpu (the silent install/runtime mismatch)", () => {
    const result = checkRuntimeModeCompatibility(CPU_NO_SMI, "cuda");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.message).toContain("voice.localGpu");
      expect(result.message).toContain("nvidia-smi");
    }
  });

  it("names the driver-too-old reason in the failure message", () => {
    const result = checkRuntimeModeCompatibility(CPU_OLD, "cuda");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.message).toMatch(/525\.x/);
    }
  });

  it("accepts cuda request when detection is cuda", () => {
    expect(checkRuntimeModeCompatibility(CUDA_535, "cuda").ok).toBe(true);
    expect(checkRuntimeModeCompatibility(CUDA_525, "cuda").ok).toBe(true);
  });

  it("accepts auto and cpu requests against any detection (no strict mode mismatch)", () => {
    expect(checkRuntimeModeCompatibility(CPU_NO_SMI, "auto").ok).toBe(true);
    expect(checkRuntimeModeCompatibility(CPU_NO_SMI, "cpu").ok).toBe(true);
    expect(checkRuntimeModeCompatibility(CUDA_535, "auto").ok).toBe(true);
    expect(checkRuntimeModeCompatibility(CUDA_535, "cpu").ok).toBe(true);
  });
});

describe("applyUserPreference", () => {
  it("downgrades cuda detection to cpu when user opts out (saves 2 GB torch download)", () => {
    const result = applyUserPreference(CUDA_535, "cpu");
    expect(result.kind).toBe("cpu");
    if (result.kind === "cpu") expect(result.reason).toBe("user-opted-out");
  });

  it("preserves cuda detection when user wants cuda or auto", () => {
    expect(applyUserPreference(CUDA_535, "cuda")).toBe(CUDA_535);
    expect(applyUserPreference(CUDA_535, "auto")).toBe(CUDA_535);
  });

  it("preserves cpu detection regardless of user preference", () => {
    expect(applyUserPreference(CPU_NO_SMI, "auto")).toBe(CPU_NO_SMI);
    expect(applyUserPreference(CPU_NO_SMI, "cpu")).toBe(CPU_NO_SMI);
  });
});

describe("expectedTorchChannel", () => {
  it("returns torchWheelChannel for cuda detection", () => {
    expect(expectedTorchChannel(CUDA_535)).toBe("cu121");
    expect(expectedTorchChannel(CUDA_525)).toBe("cu118");
  });

  it("returns cpu for cpu detection", () => {
    expect(expectedTorchChannel(CPU_NO_SMI)).toBe("cpu");
    expect(expectedTorchChannel(CPU_OLD)).toBe("cpu");
  });
});

describe("VoiceRuntimeInstaller — runtime-mode compatibility gate", () => {
  it("fails fast (no Python download) when localGpu=cuda but no GPU detected", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "damocles-rtm-"));
    try {
      const installer = new VoiceRuntimeInstaller(getDefaultRuntimePaths(tmp));
      vi.spyOn(installer, "detectDevice").mockResolvedValue(CPU_NO_SMI);
      const events: { stage: string; message: string }[] = [];
      const result = await installer.installAll({
        runtimeMode: "cuda",
        onProgress: (p) => events.push({ stage: p.stage, message: p.message }),
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain("voice.localGpu");

      // Defense-in-depth: the gate must fire BEFORE any of the downstream
      // pre-flights (compiler probe, PortAudio probe, disk check) or any
      // download. If any of those run, the gate is no longer fail-fast.
      const errorEvent = events.find((e) => e.stage === "error");
      expect(errorEvent?.message).toContain("nvidia-smi");
      expect(events.some((e) => e.message.includes("C++ toolchain"))).toBe(false);
      expect(events.some((e) => e.message.includes("PortAudio"))).toBe(false);
      expect(events.some((e) => e.stage === "checking-disk")).toBe(false);
      expect(events.some((e) => e.stage === "downloading-python")).toBe(false);
      expect(events.some((e) => e.stage === "installing-pip")).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
