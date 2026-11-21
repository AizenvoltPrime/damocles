import * as os from 'node:os';
import * as path from 'node:path';
import type { NotificationService } from '../../platform/notification-service';
import { LocalizedError } from '../../shared/localized-text';
import { l } from '../l10n';
import { followsLocalLinksOnly, followsLocalLinksOnlySync, isMissing, linkStaysLocalBesideSync, walkAnswers, type WalkAnswers } from '../local-links';
import { folderKey } from '../workspace-folders/folder-key';

/** Whether a config file may be read or written under the Windows network rule (docs/invariants.md "Platform boundary and shared stores"). */
export type ConfigPathVerdict = 'ok' | { readonly refused: 'share' };

const REFUSED: ConfigPathVerdict = { refused: 'share' };

/** Where a reader tells the user a config file was refused. */
export type ConfigNotices = Pick<NotificationService, 'warn'>;

/** A config write refused because the file links onto a network share or WSL path other than its base folder's. */
export class ConfigWriteRefused extends LocalizedError {
  readonly file: string;

  constructor(file: string) {
    super(l('{0} links to a network share or WSL path, so Damocles does not write it.', file));
    this.name = 'ConfigWriteRefused';
    this.file = file;
  }
}

/** A config read refused because the file links onto a network share or WSL path other than its base folder's. */
export class ConfigReadRefused extends LocalizedError {
  readonly file: string;
  readonly code = 'ELINKPOLICY';

  constructor(file: string) {
    super(l('{0} links to a network share or WSL path, so Damocles does not read it.', file));
    this.name = 'ConfigReadRefused';
    this.file = file;
  }
}

/** Whether file is folder or lies below it, compared as the platform's paths compare. */
export function isWithin(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

// A path outside baseFolder is judged from its own root, a share root included, so only a link off that root is refused.
function walkOf(baseFolder: string, file: string): { base: string; segments: string[] } {
  const base = isWithin(baseFolder, file) ? baseFolder : path.parse(path.resolve(file)).root;
  return { base, segments: path.relative(base, file).split(path.sep).filter(Boolean) };
}

/** The scope root of a config file in the home folder: the Damocles data folder for one in ~/.damocles, else the home folder. */
export function userConfigBase(file: string, home: string = os.homedir()): string {
  const data = path.join(home, '.damocles');
  return isWithin(data, file) ? data : home;
}

/** The network-rule bases of pi's user files under agentDir: the home folder and agentDir's scope root (userConfigBase). */
export function agentConfigBases(agentDir: string, home: string = os.homedir()): string[] {
  return [home, userConfigBase(agentDir, home)];
}

/**
 * 'ok' when following every link on file below baseFolder (its scope root: the home, project or Damocles data folder) stays
 * off UNC, WSL and device roots other than baseFolder's own, decided from local link data alone; always 'ok' off win32.
 * Rejects as followsLocalLinksOnly does for a loop (ELOOP) and for a mapped drive that does not answer (ETIMEDOUT), which a
 * caller takes as its file being unreadable.
 */
export async function checkConfigPath(baseFolder: string, file: string): Promise<ConfigPathVerdict> {
  if (process.platform !== 'win32') return 'ok';
  const { base, segments } = walkOf(baseFolder, file);
  try {
    return (await followsLocalLinksOnly(base, segments)) ? 'ok' : REFUSED;
  } catch (err) {
    // a missing entry stops the walk before anything past it is followed; the caller's own read or write then meets it
    if (isMissing(err)) return 'ok';
    throw err;
  }
}

/**
 * checkConfigPath for a synchronous reader: the same walk from baseFolder, so the two agree, with a drive a link leads onto
 * followed without the drive probe. Throws ELOOP as checkConfigPath rejects; never ETIMEDOUT. answers: what earlier checks of
 * the same run read.
 */
export function checkConfigPathSync(baseFolder: string, file: string, answers?: WalkAnswers): ConfigPathVerdict {
  if (process.platform !== 'win32') return 'ok';
  const { base, segments } = walkOf(baseFolder, file);
  try {
    // eslint-disable-next-line damocles/no-sync -- for readers already synchronous, right before their own sync read of the file
    return followsLocalLinksOnlySync(base, segments, answers) ? 'ok' : REFUSED;
  } catch (err) {
    if (isMissing(err)) return 'ok';
    throw err;
  }
}

/**
 * The synchronous link policy of a reader whose files lie under bases (pi's `linkPolicy`, and Damocles' readers of pi's files):
 * a file inside a base is judged from the deepest base holding it, true only when checkConfigPathSync answers 'ok' (a loop or
 * any other failure is false); a file outside every base is judged by linkStaysLocalBesideSync. Verdicts and the walks' file
 * system answers are kept until the current synchronous run ends, so one burst of probes reads each path once and the next
 * burst, a later reload included, walks again. Always true off win32.
 */
export function configLinkPolicy(bases: readonly string[]): (file: string) => boolean {
  const deepestFirst = [...bases].sort((a, b) => path.resolve(b).length - path.resolve(a).length);
  let burst: { readonly verdicts: Map<string, boolean>; readonly answers: WalkAnswers } | undefined;
  return (file) => {
    if (process.platform !== 'win32') return true;
    if (burst === undefined) {
      const opened = { verdicts: new Map<string, boolean>(), answers: walkAnswers() };
      burst = opened;
      queueMicrotask(() => {
        if (burst === opened) burst = undefined;
      });
    }
    const resolved = path.resolve(file);
    let verdict = burst.verdicts.get(resolved);
    if (verdict === undefined) {
      verdict = judgeFromBases(deepestFirst, resolved, burst.answers);
      burst.verdicts.set(resolved, verdict);
    }
    return verdict;
  };
}

function judgeFromBases(deepestFirst: readonly string[], file: string, answers: WalkAnswers): boolean {
  const base = deepestFirst.find((folder) => isWithin(folder, file));
  // eslint-disable-next-line damocles/no-sync -- pi asks its link policy synchronously, right before its own sync access of the path
  if (base === undefined) return linkStaysLocalBesideSync(file, deepestFirst, answers);
  try {
    // eslint-disable-next-line damocles/no-sync -- as above
    return checkConfigPathSync(base, file, answers) === 'ok';
  } catch {
    // a loop, or a link the walk cannot read, is refused as pi refuses a link it may not follow
    return false;
  }
}

// Shared by every reader, so a file two readers refuse is reported once per process.
const noticed = new Set<string>();

/** Tells the user, once per file for the life of the process, that a refused config file was not read. */
export function noticeRefusedConfigRead(file: string, notifications: ConfigNotices | undefined): void {
  const key = folderKey(file);
  if (notifications === undefined || noticed.has(key)) return;
  noticed.add(key);
  void notifications.warn(l('{0} links to a network share or WSL path, so Damocles does not read it.', file));
}
