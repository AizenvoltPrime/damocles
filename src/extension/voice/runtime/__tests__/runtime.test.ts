import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDiskSpace, INSTALL_SIZE_BYTES } from "../disk-check";
import { VoiceRuntimeInstaller, getDefaultRuntimePaths } from "../index";

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
