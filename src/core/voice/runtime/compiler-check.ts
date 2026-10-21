import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../process-launcher";
import { findOnAbsolutePathAsync } from "../../system-tools";

/**
 * texterrors (a transitive dep of nemo-toolkit[asr]) is source-only on Linux
 * and macOS for Python 3.11 — it ships no manylinux wheel, so pip must invoke
 * a C++ compiler at install time. python-build-standalone records `clang`/
 * `clang++` in `_sysconfigdata` because PBS itself was built with LLVM, but
 * the standard Linux developer toolchain is `gcc`/`g++` (Debian/Ubuntu's
 * `build-essential`, Fedora's `gcc-c++`). On a fresh WSL or minimal Linux
 * install neither compiler is present, and the `cpp_flag` probe in texterrors'
 * setup.py silently fails — pip surfaces a 60-line traceback ending in the
 * misleading "Unsupported compiler -- at least C++11 support is needed!"
 *
 * `ensureCxxToolchain` runs a short pre-flight compile of `int main() {}`
 * against each candidate compiler in distro-preference order and returns the
 * first one that works, as absolute paths from absolute PATH folders, for the
 * `CC`/`CXX` overrides of the pip subprocess. On Windows, MSVC is auto-discovered by setuptools via the
 * registry and no override is needed. The Linux candidate ordering puts `g++`
 * first because `build-essential` (the standard) ships only g++; PBS Linux
 * dynamically links libstdc++, so g++-built extensions are ABI-compatible
 * with the PBS runtime.
 *
 * Failing pre-flight throws `MissingCxxToolchainError` with per-distro install
 * commands rather than letting pip emit the inscrutable texterrors traceback.
 */

export class MissingCxxToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCxxToolchainError";
  }
}

export type CxxToolchain = { readonly cc: string; readonly cxx: string };

const TEST_PROGRAM: string = "int main(int argc, char **argv) { return 0; }\n";

export function getCxxCandidates(platform: NodeJS.Platform): readonly CxxToolchain[] {
  if (platform === "darwin") {
    return [
      { cc: "clang", cxx: "clang++" },
      { cc: "gcc", cxx: "g++" },
      { cc: "cc", cxx: "c++" },
    ];
  }
  return [
    { cc: "gcc", cxx: "g++" },
    { cc: "clang", cxx: "clang++" },
    { cc: "cc", cxx: "c++" },
  ];
}

export function getCxxInstallInstructions(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return (
      "Voice runtime needs a C++ compiler to build texterrors (no prebuilt wheel " +
      "for macOS + Python 3.11). Install Xcode Command Line Tools:\n" +
      "  xcode-select --install"
    );
  }
  return (
    "Voice runtime needs a C++ compiler to build texterrors (no prebuilt wheel " +
    "for Linux + Python 3.11). Install your distro's build toolchain:\n" +
    "  Debian / Ubuntu / WSL:  sudo apt update && sudo apt install build-essential\n" +
    "  Fedora / RHEL:          sudo dnf install gcc-c++ make\n" +
    "  Arch:                   sudo pacman -S --needed base-devel"
  );
}

export function cxxToolchainEnv(toolchain: CxxToolchain): Record<string, string> {
  return { CC: toolchain.cc, CXX: toolchain.cxx };
}

/** Compiles and links a test program with the absolute compiler `cxx`; rejects when `signal` aborted. */
export type CompilerProbe = (cxx: string, signal?: AbortSignal) => Promise<boolean>;

/** The absolute path of a program found in an absolute PATH folder, or undefined. */
export type ProgramFinder = (name: string) => Promise<string | undefined>;

async function defaultCompilerProbe(cxx: string, signal?: AbortSignal): Promise<boolean> {
  // Full compile-AND-link (not `-c` compile-only). The link step exercises
  // libstdc++ / libc++ resolution, catching the rare case where the compiler
  // binary is installed but the matching C++ standard library isn't (e.g.
  // partial `apt install g++` without `libstdc++-dev`). Cost is ~30 ms per
  // probe — acceptable since this runs once per install.
  const dir = await mkdtemp(join(tmpdir(), "damocles-cxx-")).catch(() => null);
  if (dir === null) return false;
  try {
    const srcPath = join(dir, "test.cpp");
    const exePath = join(dir, "test.out");
    await writeFile(srcPath, TEST_PROGRAM);
    const run = await runProcess(
      { file: cxx, args: ["-std=c++11", srcPath, "-o", exePath], stdio: ["ignore", "ignore", "ignore"] },
      signal !== undefined ? { signal } : {},
    ).catch((err: unknown) => {
      if (signal?.aborted === true) throw err;
      return undefined;
    });
    return run?.exit?.code === 0;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type EnsureCxxToolchainOptions = {
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  probe?: CompilerProbe;
  find?: ProgramFinder;
};

/** The first candidate whose compilers are both in an absolute PATH folder and build a test program, as absolute paths. */
export async function ensureCxxToolchain(
  opts: EnsureCxxToolchainOptions = {},
): Promise<CxxToolchain | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return null;

  const probe = opts.probe ?? defaultCompilerProbe;
  const find = opts.find ?? ((name: string) => findOnAbsolutePathAsync(name, platform, process.env));
  for (const names of getCxxCandidates(platform)) {
    const [cc, cxx] = await Promise.all([find(names.cc), find(names.cxx)]);
    if (cc === undefined || cxx === undefined) continue;
    if (await probe(cxx, opts.signal)) return { cc, cxx };
  }
  throw new MissingCxxToolchainError(getCxxInstallInstructions(platform));
}
