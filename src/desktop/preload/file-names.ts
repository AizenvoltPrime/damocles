import { isUnsafeWindowsName } from '../../shared/relative-path';
import { MAX_FILE_NAME_LENGTH } from './shell-channels';

/** A name for create and rename: one segment the OS accepts, VS Code's validateFileName rules. platform: process.platform. */
export function isValidFileName(name: unknown, platform: string): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_FILE_NAME_LENGTH) return false;
  if (name === '.' || name === '..' || /[/\\\0]/.test(name) || name.trim() !== name) return false;
  return platform !== 'win32' || !isUnsafeWindowsName(name);
}

export type FileNameProblem = 'empty' | 'invalidName' | 'exists';

/**
 * Why a typed name cannot be created or renamed to, else undefined (validateFileName, fileActions.ts). siblings: the names in
 * the target folder, the renamed entry's own name excluded; Windows and macOS compare them ignoring case, as their default file
 * systems do.
 */
export function fileNameProblem(name: string, siblings: readonly string[], platform: string): FileNameProblem | undefined {
  if (name.length === 0) return 'empty';
  if (!isValidFileName(name, platform)) return 'invalidName';
  const fold = (value: string): string => (platform === 'linux' ? value : value.toLowerCase());
  const folded = fold(name);
  return siblings.some((sibling) => fold(sibling) === folded) ? 'exists' : undefined;
}
