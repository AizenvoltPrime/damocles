import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export type LockContents = {
  pid: number;
  port: number;
  token: string;
  protocolVersion: number;
  startedAt: number;
};

export type AcquireResult =
  | {
      kind: "owned";
      commit: (contents: LockContents) => Promise<void>;
      release: () => Promise<void>;
    }
  | { kind: "attached"; existing: LockContents };

const STALE_LOCK_AGE_MS = 10 * 60 * 1000;
// Must be strictly larger than VoiceSidecarManager.COLD_START_TIMEOUT_MS
// (60s). Otherwise a second window can give up waiting for the owner
// to commit and delete the live owner's lockdir while it's still
// loading models. A 30s buffer leaves room for slow disks / cold
// PyTorch imports beyond the manager's own deadline.
const CLAIMING_GRACE_MS = 90_000;
const CLAIMING_POLL_INTERVAL_MS = 250;
// Absolute cap on how long we'll wait for a claiming writer that's
// still alive. First-time installs of torch + parakeet on a cold disk
// can take minutes; without this cap a slow writer indefinitely
// blocks the second window's start(), but eternal waiting is worse
// than a clean failure.
const HARD_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

type LockFileOnDisk = LockContents & { state: "claiming" | "ready" };

export async function acquireSidecarLock(lockDir: string): Promise<AcquireResult> {
  const dataPath = join(lockDir, "data.json");
  const hardDeadline = Date.now() + HARD_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const ready = await waitForReady(dataPath, CLAIMING_GRACE_MS);
      if (ready !== null && (await isLockOwnerAlive(ready))) {
        return { kind: "attached", existing: stripState(ready) };
      }
      // Before evicting: re-read and confirm the claimer is actually
      // dead. Nuking a live writer's lockdir lets two managers race
      // for ownership and spawn duplicate sidecars on a slow first
      // run that exceeded CLAIMING_GRACE_MS but hasn't crashed.
      const current = await readLockFile(dataPath);
      const liveSlowClaimer =
        current !== null &&
        current.state === "claiming" &&
        (await isProcessAlive(current.pid)) &&
        !(await isStaleByAge(lockDir));
      if (liveSlowClaimer) {
        if (Date.now() >= hardDeadline) {
          throw new Error(
            "voice sidecar lock held by a still-claiming writer past " +
              `${HARD_LOCK_TIMEOUT_MS}ms; aborting to prevent indefinite wait`,
          );
        }
        await sleep(CLAIMING_POLL_INTERVAL_MS * 4);
        continue;
      }
      await removeLockDir(lockDir);
      continue;
    }

    await writeAtomic(dataPath, {
      pid: process.pid,
      port: 0,
      token: "",
      protocolVersion: 0,
      startedAt: Date.now(),
      state: "claiming",
    });

    return {
      kind: "owned",
      commit: async (contents: LockContents) => {
        await writeAtomic(dataPath, { ...contents, state: "ready" });
      },
      release: async () => removeLockDir(lockDir),
    };
  }
}

async function waitForReady(dataPath: string, timeoutMs: number): Promise<LockFileOnDisk | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const file = await readLockFile(dataPath);
    if (file !== null && file.state === "ready") return file;
    if (Date.now() >= deadline) return null;
    await sleep(CLAIMING_POLL_INTERVAL_MS);
  }
}

async function readLockFile(dataPath: string): Promise<LockFileOnDisk | null> {
  try {
    const text = await fs.readFile(dataPath, "utf8");
    const parsed = JSON.parse(text) as Partial<LockFileOnDisk>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.protocolVersion !== "number" ||
      typeof parsed.startedAt !== "number"
    ) {
      return null;
    }
    const state: "claiming" | "ready" = parsed.state === "claiming" ? "claiming" : "ready";
    return {
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      protocolVersion: parsed.protocolVersion,
      startedAt: parsed.startedAt,
      state,
    };
  } catch {
    return null;
  }
}

function stripState(file: LockFileOnDisk): LockContents {
  return {
    pid: file.pid,
    port: file.port,
    token: file.token,
    protocolVersion: file.protocolVersion,
    startedAt: file.startedAt,
  };
}

async function writeAtomic(dataPath: string, payload: LockFileOnDisk): Promise<void> {
  const tmp = `${dataPath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
  // POSIX honors the 0o600 mode passed to writeFile. Windows ignores
  // it — file inherits the user's home-dir ACL, which on a default
  // install permits the local Authenticated Users / Users groups. Run
  // icacls to (a) drop inheritance and (b) grant only the current user.
  // This matches the security posture of POSIX 0o600: protects
  // against cross-user processes, not same-user ones (same as
  // chmod 600 on Linux — a same-uid process can always read).
  await applyOwnerOnlyAcl(tmp);
  await fs.rename(tmp, dataPath);
}

async function applyOwnerOnlyAcl(filePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const username = userInfo().username;
  if (username.length === 0) return;
  await new Promise<void>((resolve) => {
    const proc = spawn(
      "icacls",
      [filePath, "/inheritance:r", "/grant:r", `${username}:F`],
      { stdio: "ignore", windowsHide: true },
    );
    proc.once("error", () => resolve());
    proc.once("exit", () => resolve());
  });
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Combine PID-liveness with a coarse start-time sanity check so a recycled
 * Windows PID owned by an unrelated process doesn't masquerade as our owner.
 *
 * On Windows ``process.kill(pid, 0)`` returns ``EPERM`` for any PID owned by
 * a process the current user can't query — including a fresh, unrelated
 * process that happens to have inherited the recycled number. The PID alone
 * therefore can't tell "our sidecar is alive" from "some other program got
 * our old PID after we crashed."
 *
 * The lockfile's ``startedAt`` is recorded at lock acquire and is only
 * minutes old in normal operation. Reject any owner whose declared start
 * time is implausibly old (older than the stale-by-age threshold) — that
 * combination can only happen if the lockfile was orphaned and the PID was
 * recycled to something unrelated.
 */
async function isLockOwnerAlive(file: LockFileOnDisk): Promise<boolean> {
  if (!(await isProcessAlive(file.pid))) return false;
  const ageMs = Date.now() - file.startedAt;
  if (ageMs > STALE_LOCK_AGE_MS) return false;
  if (ageMs < -60_000) {
    // startedAt in the future by more than a minute — clock skew or
    // tampering. Treat as not-alive and let the caller reclaim.
    return false;
  }
  return true;
}

async function isStaleByAge(lockDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS;
  } catch {
    return true;
  }
}

async function removeLockDir(lockDir: string): Promise<void> {
  try {
    await fs.rm(lockDir, { recursive: true, force: true });
  } catch {
    /* swallowed: best-effort cleanup */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
