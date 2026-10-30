import { describe, expect, it } from "vitest";
import { englishText } from "../../../../shared/localized-text";
import {
  cxxToolchainEnv,
  ensureCxxToolchain,
  getCxxCandidates,
  getCxxInstallInstructions,
  MissingCxxToolchainError,
} from "../compiler-check";

/** A PATH holding every compiler name in /usr/bin, except the ones left out. */
function findIn(...missing: string[]): (name: string) => Promise<string | undefined> {
  return async (name) => (missing.includes(name) ? undefined : `/usr/bin/${name}`);
}

const find = findIn();

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
    expect(englishText(getCxxInstallInstructions("darwin"))).toContain("xcode-select --install");
  });

  it("names build-essential, gcc-c++ and base-devel on Linux", () => {
    const msg = englishText(getCxxInstallInstructions("linux"));
    expect(msg).toContain("build-essential");
    expect(msg).toContain("gcc-c++");
    expect(msg).toContain("base-devel");
  });
});

describe("cxxToolchainEnv", () => {
  it("emits CC and CXX env vars", () => {
    expect(cxxToolchainEnv({ cc: "/usr/bin/gcc", cxx: "/usr/bin/g++" })).toEqual({ CC: "/usr/bin/gcc", CXX: "/usr/bin/g++" });
  });
});

describe("ensureCxxToolchain", () => {
  it("returns null on Windows without invoking the probe", async () => {
    let probeCalls = 0;
    const result = await ensureCxxToolchain({
      platform: "win32",
      find,
      probe: async () => { probeCalls++; return true; },
    });
    expect(result).toBeNull();
    expect(probeCalls).toBe(0);
  });

  it("probes and returns the compilers by the absolute paths it found", async () => {
    const probed: string[] = [];
    const result = await ensureCxxToolchain({
      platform: "linux",
      find,
      probe: async (cxx) => { probed.push(cxx); return true; },
    });
    expect(result).toEqual({ cc: "/usr/bin/gcc", cxx: "/usr/bin/g++" });
    expect(probed).toEqual(["/usr/bin/g++"]);
  });

  it("skips a candidate a PATH folder lacks either compiler of, without probing it", async () => {
    const probed: string[] = [];
    const result = await ensureCxxToolchain({
      platform: "linux",
      find: findIn("gcc"),
      probe: async (cxx) => { probed.push(cxx); return true; },
    });
    expect(result).toEqual({ cc: "/usr/bin/clang", cxx: "/usr/bin/clang++" });
    expect(probed).toEqual(["/usr/bin/clang++"]);
  });

  it("falls back to clang++ when g++ probe fails (WSL with clang only)", async () => {
    const tried: string[] = [];
    const result = await ensureCxxToolchain({
      platform: "linux",
      find,
      probe: async (cxx) => { tried.push(cxx); return cxx === "/usr/bin/clang++"; },
    });
    expect(result).toEqual({ cc: "/usr/bin/clang", cxx: "/usr/bin/clang++" });
    expect(tried).toEqual(["/usr/bin/g++", "/usr/bin/clang++"]);
  });

  it("throws MissingCxxToolchainError when no compiler is found (bare WSL with no toolchain)", async () => {
    let probeCalls = 0;
    await expect(
      ensureCxxToolchain({
        platform: "linux",
        find: async () => undefined,
        probe: async () => { probeCalls++; return true; },
      }),
    ).rejects.toBeInstanceOf(MissingCxxToolchainError);
    expect(probeCalls).toBe(0);
  });

  it("throws MissingCxxToolchainError when no probe succeeds", async () => {
    await expect(
      ensureCxxToolchain({
        platform: "linux",
        find,
        probe: async () => false,
      }),
    ).rejects.toBeInstanceOf(MissingCxxToolchainError);
  });

  it("error message names the right Linux packages", async () => {
    await expect(
      ensureCxxToolchain({
        platform: "linux",
        find,
        probe: async () => false,
      }),
    ).rejects.toThrow(/build-essential/);
  });

  it("error message names xcode-select on macOS", async () => {
    await expect(
      ensureCxxToolchain({
        platform: "darwin",
        find,
        probe: async () => false,
      }),
    ).rejects.toThrow(/xcode-select --install/);
  });
});
