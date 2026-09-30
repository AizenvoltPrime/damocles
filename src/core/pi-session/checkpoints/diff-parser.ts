import type { FileChange } from './types';

/** A numstat count is either a non-negative integer or `-` for binary files (no line counts). */
function parseCount(token: string | undefined): number {
  if (token === undefined || token === '-') return 0;
  const n = Number.parseInt(token, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse the output of `git diff --numstat` into structured per-file change counts. Each non-blank
 * line is `<added>\t<removed>\t<path>`; binary files surface as `-\t-\t<path>`, which we normalise
 * to `{ added: 0, removed: 0 }`. Paths may contain tabs in pathological cases, so everything past
 * the second tab is rejoined into the path. Blank lines are skipped.
 */
export function parseDiffStats(stdout: string): readonly FileChange[] {
  const changes: FileChange[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parseCount(parts[0]);
    const removed = parseCount(parts[1]);
    const filePath = parts.slice(2).join('\t');
    if (filePath === '') continue;
    changes.push({ path: filePath, added, removed });
  }
  return changes;
}
