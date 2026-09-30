import { describe, expect, it } from "vitest";
import {
  cxxToolchainEnv,
  ensureCxxToolchain,
  getCxxCandidates,
  getCxxInstallInstructions,
  MissingCxxToolchainError,
} from "../compiler-check";

describe("getCxxCandidates", () => {
  it("prefers g++ first on Linux (build-essential default)", () => {
    const candidates = getCxxCandidates("linux");
    expect(candidates[0]).toEqual({ cc: "gcc", cxx: "g++" });
  });

  it("prefers clang++ first on macOS (Xcode CLT default)", () => {
    const candidates = getCxxCandidates("darwin");
    expect(candidates[0]).toEqual({ cc: "clang", cxx: "clang++" });
  });

  it("includes the POSIX `c++` symlink as a final fallback on every Unix", () => {
    expect(getCxxCandidates("linux").map((c) => c.cxx)).toContain("c++");
    expect(getCxxCandidates("darwin").map((c) => c.cxx)).toContain("c++");
  });
});

describe("getCxxInstallInstructions", () => {
  it("names xcode-select on macOS", () => {
    expect(getCxxInstallInstructions("darwin")).toContain("xcode-select --install");
  });

  it("names build-essential, gcc-c++ and base-devel on Linux", () => {
    const msg = getCxxInstallInstructions("linux");
    expect(msg).toContain("build-essential");
    expect(msg).toContain("gcc-c++");
    expect(msg).toContain("base-devel");
  });
});

describe("cxxToolchainEnv", () => {
  it("emits CC and CXX env vars", () => {
    expect(cxxToolchainEnv({ cc: "gcc", cxx: "g++" })).toEqual({ CC: "gcc", CXX: "g++" });
  });
});

describe("ensureCxxToolchain", () => {
  it("returns null on Windows without invoking the probe", async () => {
    let probeCalls = 0;
    const result = await ensureCxxToolchain({
      platform: "win32",
      probe: async () => { probeCalls++; return true; },
    });
    expect(result).toBeNull();
    expect(probeCalls).toBe(0);
  });

  it("returns the first candidate that the probe accepts", async () => {
    const result = await ensureCxxToolchain({
      platform: "linux",
      probe: async (cxx) => cxx === "g++",
    });
    expect(result).toEqual({ cc: "gcc", cxx: "g++" });
  });

  it("falls back to clang++ when g++ probe fails (WSL with clang only)", async () => {
    const tried: string[] = [];
    const result = await ensureCxxToolchain({
      platform: "linux",
      probe: async (cxx) => { tried.push(cxx); return cxx === "clang++"; },
    });
    expect(result).toEqual({ cc: "clang", cxx: "clang++" });
    expect(tried).toEqual(["g++", "clang++"]);
  });

  it("throws MissingCxxToolchainError when no probe succeeds (bare WSL with no toolchain)", async () => {
    await expect(
      ensureCxxToolchain({
        platform: "linux",
        probe: async () => false,
      }),
    ).rejects.toBeInstanceOf(MissingCxxToolchainError);
  });

  it("error message names the right Linux packages", async () => {
    await expect(
      ensureCxxToolchain({
        platform: "linux",
        probe: async () => false,
      }),
    ).rejects.toThrow(/build-essential/);
  });

  it("error message names xcode-select on macOS", async () => {
    await expect(
      ensureCxxToolchain({
        platform: "darwin",
        probe: async () => false,
      }),
    ).rejects.toThrow(/xcode-select --install/);
  });
});
