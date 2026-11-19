import { statfs } from "node:fs/promises";

export type DiskCheck = {
  ok: boolean;
  freeBytes: number;
  requiredBytes: number;
};

const SAFETY_MULTIPLIER = 1.5;

/** Whether the volume holding targetDir, an existing folder, has 1.5 times sizeBytes free for this user. */
export async function checkDiskSpace(targetDir: string, sizeBytes: number): Promise<DiskCheck> {
  const required = Math.ceil(sizeBytes * SAFETY_MULTIPLIER);
  const stats = await statfs(targetDir);
  const free = stats.bavail * stats.bsize;
  return { ok: free >= required, freeBytes: free, requiredBytes: required };
}
