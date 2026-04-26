import { statfs } from "node:fs/promises";

export type DiskCheck = {
  ok: boolean;
  freeBytes: number;
  requiredBytes: number;
};

const SAFETY_MULTIPLIER = 1.5;

export async function checkDiskSpace(targetDir: string, installSizeBytes: number): Promise<DiskCheck> {
  const required = Math.ceil(installSizeBytes * SAFETY_MULTIPLIER);
  const stats = await statfs(targetDir);
  const free = stats.bavail * stats.bsize;
  return { ok: free >= required, freeBytes: free, requiredBytes: required };
}

export const INSTALL_SIZE_BYTES: {
  cudaWindows: number;
  cudaLinux: number;
  cpuAny: number;
} = {
  cudaWindows: 11 * 1024 * 1024 * 1024,
  cudaLinux: 10 * 1024 * 1024 * 1024,
  cpuAny: 6 * 1024 * 1024 * 1024,
};
