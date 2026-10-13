// The git every host process spawns: docs/invariants.md "Source control".
import * as fs from 'node:fs';
import * as path from 'node:path';
import { searchPathEntries } from './executable-path';

export const GIT_NOT_FOUND = 'git was not found in an absolute PATH folder';

let cached: { readonly key: string; readonly git: string | undefined } | undefined;

/**
 * The first absolute PATH folder's `git` (`git.exe` on Windows) as an absolute path, or undefined when none holds one.
 * Cached per PATH value, so desktop's login-shell PATH, merged before the first call, is the one searched.
 */
export function resolveGitExecutable(platform: NodeJS.Platform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const entries = searchPathEntries(platform, env);
  const key = `${platform}\0${entries.join('\0')}`;
  if (cached?.key !== key) {
    const join = platform === 'win32' ? path.win32.join : path.posix.join;
    const name = platform === 'win32' ? 'git.exe' : 'git';
    cached = { key, git: entries.map((dir) => join(dir, name)).find(isFile) };
  }
  return cached.git;
}

/** `resolveGitExecutable` for a spawn; throws `GIT_NOT_FOUND` rather than ever naming a bare `git`. */
export function gitExecutable(): string {
  const git = resolveGitExecutable();
  if (git === undefined) throw new Error(GIT_NOT_FOUND);
  return git;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
