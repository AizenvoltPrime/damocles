// A daemon that hands over for a switch leaves a mark in the run folder. Every connected app then starts a bridge at once, and
// without the mark the bridge of an older app could win that race and start the version that just left.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { appVersionOf, compareAppVersions, isAppVersion } from '../../shared/app-version';
import { readSmallFile } from './small-file';
import type { RunPaths } from './token';

// how long after a hand-over a bridge of the version that left, or of an older one, lets a newer bridge start its daemon first
export const HAND_OVER_YIELD_MS = 15_000;
export const MAX_MARK_BYTES = 512;
const MARK_FILE = 'handed-over.json';

const markPath = (paths: Pick<RunPaths, 'runDir'>): string => path.join(paths.runDir, MARK_FILE);

/** The daemon of `version` hands over now. */
export async function markHandedOver(paths: Pick<RunPaths, 'runDir'>, version: string, now: number = Date.now()): Promise<void> {
  await fs.writeFile(markPath(paths), `${JSON.stringify({ version, at: now })}\n`, { mode: 0o600 });
}

/**
 * Until when (epoch ms) the bridge of server version `own` waits for another bridge's daemon before it starts its own: within
 * HAND_OVER_YIELD_MS of a hand-over by a daemon of `own` or of a newer app version. Undefined otherwise: no mark or one that
 * does not parse, an old one, or a daemon of an older app version or of another build of this one, which this bridge replaces.
 * A mark that is no regular file of at most MAX_MARK_BYTES is logged.
 */
export async function yieldsUntil(paths: Pick<RunPaths, 'runDir'>, own: string, log: (line: string) => void, now: number = Date.now()): Promise<number | undefined> {
  const file = markPath(paths);
  let mark: { version?: unknown; at?: unknown } | null;
  try {
    const read = await readSmallFile(file, MAX_MARK_BYTES);
    if (read === undefined) return undefined;
    if ('refused' in read) {
      log(`[attach] the hand-over mark ${file} is refused, so this bridge does not yield: ${read.refused}`);
      return undefined;
    }
    mark = JSON.parse(read.text) as { version?: unknown; at?: unknown } | null;
  } catch {
    return undefined;
  }
  const { version, at } = mark ?? {};
  if (typeof version !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || at > now || now - at >= HAND_OVER_YIELD_MS) return undefined;
  const [left, mine] = [appVersionOf(version), appVersionOf(own)];
  const older = isAppVersion(left) && isAppVersion(mine) && compareAppVersions(mine, left) < 0;
  return version === own || older ? at + HAND_OVER_YIELD_MS : undefined;
}
