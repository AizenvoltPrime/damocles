import type { GitVersion } from './git-runner';

/** `git version 2.45.1.windows.1` → 2.45.1; undefined when the text names no version. Stateless, for main's startup probe. */
export function parseGitVersion(text: string): GitVersion | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) } : undefined;
}
