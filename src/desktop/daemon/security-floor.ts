// The host's security floor (docs/invariants.md "Remote daemon and wire", the update flow): the highest minimum server
// version a daemon on this host ran under, an app version in <installDir>/security-floor. A bridge whose app version is below
// it starts no daemon. It guards against an outdated app, not against the user, who can delete the file.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { compareAppVersions, isAppVersion } from '../../shared/app-version';
import { readSmallFile } from './small-file';

export const FLOOR_FILE = 'security-floor';
export const MAX_FLOOR_BYTES = 256;
// past proper-lockfile's 10 s stale time, so the lock of a daemon that died holding it is taken over
const FLOOR_LOCK_WAIT_MS = 15_000;
const FLOOR_LOCK_RETRY_MS = 100;

/**
 * The install folder of the server under `root`, which stage 1 unpacked as <installDir>/<serverVersion>-<target>; undefined
 * for a checkout or the desktop app's own loopback daemon, which no install folder holds.
 */
export function installDirOf(root: string, serverVersion: string): string | undefined {
  return path.basename(root).startsWith(`${serverVersion}-`) ? path.dirname(root) : undefined;
}

/**
 * The floor, or undefined when there is none; a file that holds anything but an app version, or is no regular file of at most
 * MAX_FLOOR_BYTES, reads as none and is logged. Throws when the file cannot be read, which is not the same as no floor.
 */
export async function readFloor(installDir: string, log: (line: string) => void): Promise<string | undefined> {
  const file = path.join(installDir, FLOOR_FILE);
  const read = await readSmallFile(file, MAX_FLOOR_BYTES);
  if (read === undefined) return undefined;
  if ('refused' in read) {
    log(`[floor] ${file} is refused, so the host has no security floor: ${read.refused}`);
    return undefined;
  }
  const floor = read.text.trim();
  if (isAppVersion(floor)) return floor;
  log(`[floor] ${file} holds no version, so the host has no security floor`);
  return undefined;
}

async function lockFloor(file: string, log: (line: string) => void): Promise<() => Promise<void>> {
  const deadline = Date.now() + FLOOR_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await lockfile.lock(file, { lockfilePath: `${file}.lock`, realpath: false, onCompromised: (err) => log(`[floor] the lock of ${file} was compromised: ${err.message}`) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, FLOOR_LOCK_RETRY_MS));
  }
}

/**
 * Raises the floor to `minimum` when it is higher, never lowering it. The read and the rename hold <installDir>/security-floor.lock,
 * since the daemons of machines that share the install folder each hold only their own run folder's daemon lock.
 */
export async function raiseFloor(installDir: string, minimum: string, log: (line: string) => void): Promise<void> {
  if (!isAppVersion(minimum)) throw new Error(`The minimum server version ${minimum} is no app version`);
  const file = path.join(installDir, FLOOR_FILE);
  const release = await lockFloor(file, log);
  try {
    const floor = await readFloor(installDir, log);
    if (floor !== undefined && compareAppVersions(minimum, floor) <= 0) return;
    // a reader sees the old floor or the new one, never a partial write
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, `${minimum}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
    log(`[floor] the host's security floor is now ${minimum}${floor !== undefined ? `, raised from ${floor}` : ''}`);
  } finally {
    await release();
  }
}

/** Whether an app of `appVersion` is below `floor`; one that names no app version is. */
export function belowFloor(appVersion: string, floor: string): boolean {
  return !isAppVersion(appVersion) || compareAppVersions(appVersion, floor) < 0;
}
