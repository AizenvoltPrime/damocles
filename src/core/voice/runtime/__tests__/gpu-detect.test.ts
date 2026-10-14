import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nvidiaSmiCandidates, WSL_NVIDIA_SMI_PATH } from "../gpu-detect";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dam-gpu-detect-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("nvidiaSmiCandidates", () => {
  it("looks in System32 and NVSMI on Windows, never by a bare name", () => {
    expect(nvidiaSmiCandidates("win32", { SystemRoot: "D:\\Windows", ProgramFiles: "D:\\Program Files" })).toEqual([
      "D:\\Windows\\System32\\nvidia-smi.exe",
      "D:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
    ]);
  });

  it("skips a ProgramFiles that is not a local absolute path", () => {
    expect(nvidiaSmiCandidates("win32", { SystemRoot: "C:\\Windows", ProgramFiles: "Program Files" })).toEqual(["C:\\Windows\\System32\\nvidia-smi.exe"]);
  });

  it("takes the WSL2 passthrough binary on Linux when no absolute PATH folder holds nvidia-smi", () => {
    expect(nvidiaSmiCandidates("linux", { PATH: "bin:." })).toEqual([WSL_NVIDIA_SMI_PATH]);
  });

  it("puts an absolute PATH folder's nvidia-smi first and never a relative one's", () => {
    const name = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
    const planted = path.join(root, "planted");
    const bin = path.join(root, "bin");
    for (const dir of [planted, bin]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, name), "");
    }
    const candidates = nvidiaSmiCandidates(process.platform, { PATH: [path.relative(process.cwd(), planted), bin].join(path.delimiter) });
    expect(candidates[0]).toBe(path.join(bin, name));
    expect(candidates.every((candidate) => path.isAbsolute(candidate))).toBe(true);
  });
});
