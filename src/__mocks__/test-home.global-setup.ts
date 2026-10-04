import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testHomeRoot: string;
    /** The real temp dir, for a fixture whose path length cannot afford the sandboxed `os.tmpdir()`. It must remove what it creates. */
    realTmpDir: string;
  }
}

export const ROOT_PREFIX = "dth-";
export const OWNER_FILE = "owner.pid";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerOf(root: string): number | null {
  try {
    return Number(readFileSync(join(root, OWNER_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Removes the roots of runs whose Vitest process has exited without its teardown (Ctrl+C, a killed
 * terminal, a crash). A root without an owner file is skipped, since a concurrent run may have just
 * created it. A reused PID only delays a removal; it never removes a live run's root.
 */
export function removeAbandonedRoots(parent: string): void {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(ROOT_PREFIX)) continue;
    const root = join(parent, entry.name);
    const owner = ownerOf(root);
    if (owner === null || !Number.isInteger(owner) || isRunning(owner)) continue;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      // A process the abandoned run spawned can still hold a file; the next run retries.
      console.warn(`[test-home] could not remove abandoned test root ${root}: ${(err as Error).message}`);
    }
  }
}

/** One root per run for every test file's home and temp dir. The teardown runs after the fork workers exit, so
 *  Windows has released their file handles, and it runs even for files whose own hooks were skipped. */
export default function setup(project: TestProject): () => void {
  removeAbandonedRoots(tmpdir());
  // Kept short with `h-` in hermetic-home.setup.ts: Windows paths under a test home run into MAX_PATH and
  // git's 220-char GIT_DIR limit, which the legacy per-session checkpoint layout nests a cwd under.
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  writeFileSync(join(root, OWNER_FILE), String(process.pid));
  project.provide("testHomeRoot", root);
  project.provide("realTmpDir", tmpdir());
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
