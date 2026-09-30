import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger';
import { CATEGORY_CHECKPOINT_EXCLUDES, SECURITY_CHECKPOINT_EXCLUDES } from './types';
import type { SkippedFile, SkippedPattern, SkippedSummary, SkippedTally, SkipReason } from './types';

/** Default size cap when the host passes none: `damocles.checkpoints.maxFileSizeMB` defaults to 25. */
export const DEFAULT_MAX_FILE_SIZE_BYTES: number = 25 * 1024 * 1024;

const LFS_SECTION = '# damocles: git lfs patterns from .gitattributes';
const SIZE_SECTION = '# damocles: files over the size cap';
const EMBEDDED_SECTION = '# damocles: embedded repositories with no commit';

/**
 * Commit-message trailers naming what a snapshot left out, read back by every rewind to that commit. A
 * path is a JSON string, so a line break in it cannot split the trailer.
 */
const SKIP_PATH_TRAILER = 'damocles-skip-path: ';
const SKIP_PATTERN_TRAILER = 'damocles-skip-pattern: ';

/**
 * An exclude line matching exactly one work-tree-relative path: anchored with `/` so `big.bin` does not
 * also match `sub/big.bin`, and every glob or comment metacharacter escaped so `[x].bin` matches itself.
 * A line break cannot be escaped in an exclude file, so it becomes `?`, which also matches it.
 */
export function excludeLineForPath(relPath: string): string {
  const escaped = relPath
    .replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)
    .replace(/ $/, '\\ ')
    .replace(/[\r\n]/g, '?');
  return `/${escaped}`;
}

/**
 * The `filter=lfs` patterns of a `.gitattributes` text. Quoted patterns are unquoted; a macro line
 * (`[attr]...`), a pattern whose `filter` is unset (`-filter`, `!filter`), and a negative pattern
 * (`!...`, which gitattributes forbids and an exclude file would read as a re-include) are ignored.
 */
export function parseLfsPatterns(gitattributes: string): string[] {
  const patterns: string[] = [];
  for (const raw of gitattributes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[attr]')) continue;
    let pattern: string;
    let rest: string;
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      if (end < 0) continue;
      pattern = line.slice(1, end).replace(/\\(.)/g, '$1');
      rest = line.slice(end + 1);
    } else {
      const space = line.search(/\s/);
      if (space < 0) continue;
      pattern = line.slice(0, space);
      rest = line.slice(space);
    }
    if (pattern.startsWith('!') || /[\r\n]/.test(pattern)) continue;
    if (rest.split(/\s+/).includes('filter=lfs')) patterns.push(pattern);
  }
  return patterns;
}

/** Read the work tree's root `.gitattributes`; a missing file has no LFS patterns, and an unreadable one is logged and read as none. */
export async function readLfsPatterns(workTree: string): Promise<string[]> {
  const file = path.join(workTree, '.gitattributes');
  try {
    return parseLfsPatterns(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    if (code === 'EISDIR' || code === 'EACCES' || code === 'EPERM') {
      log('[Checkpoints] %s is unreadable (%s); no LFS patterns are excluded', file, code);
      return [];
    }
    throw err;
  }
}

/** The full `info/exclude` of a folder repo: the static set, then the generated LFS, size and embedded-repository sections. */
export function buildExcludeFile(
  staticPatterns: readonly string[],
  lfsPatterns: readonly string[],
  sizePaths: readonly string[],
  embeddedRepos: readonly string[],
): string {
  return (
    [
      ...staticPatterns,
      LFS_SECTION,
      ...lfsPatterns,
      SIZE_SECTION,
      ...sizePaths.map(excludeLineForPath),
      EMBEDDED_SECTION,
      ...embeddedRepos.map((dir) => `${excludeLineForPath(dir)}/`),
    ].join('\n') + '\n'
  );
}

/** Snapshot commit message: a subject, then one trailer per skipped path and LFS pattern. */
export function buildSnapshotMessage(subject: string, sizePaths: readonly string[], lfsPatterns: readonly string[]): string {
  const trailers = [...sizePaths.map((p) => `${SKIP_PATH_TRAILER}${JSON.stringify(p)}`), ...lfsPatterns.map((p) => `${SKIP_PATTERN_TRAILER}${p}`)];
  return trailers.length > 0 ? `${subject}\n\n${trailers.join('\n')}\n` : `${subject}\n`;
}

/** The paths and patterns a snapshot commit recorded as skipped; legacy commits record nothing. A malformed path trailer throws. */
export function skipsFromCommitMessage(message: string): { paths: string[]; patterns: string[] } {
  const paths: string[] = [];
  const patterns: string[] = [];
  for (const line of message.split('\n')) {
    if (line.startsWith(SKIP_PATH_TRAILER)) {
      const value: unknown = JSON.parse(line.slice(SKIP_PATH_TRAILER.length));
      if (typeof value !== 'string') throw new Error(`malformed skip trailer: ${line}`);
      paths.push(value);
    } else if (line.startsWith(SKIP_PATTERN_TRAILER)) {
      patterns.push(line.slice(SKIP_PATTERN_TRAILER.length));
    }
  }
  return { paths, patterns };
}

export interface SizedPath {
  readonly path: string;
  readonly bytes: number;
}

/**
 * lstat every path (relative to `workTree`) with bounded concurrency: files and symlinks, never
 * directories. A path that vanished is left out, and one that cannot be read is logged and left out.
 * lstat, so a symlink counts as the link, never as its target.
 */
export async function lstatFiles(workTree: string, relPaths: Iterable<string>): Promise<SizedPath[]> {
  const queue = [...new Set(relPaths)];
  const out: SizedPath[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const rel = queue[next++]!;
      try {
        const stat = await fs.promises.lstat(path.join(workTree, rel));
        if (stat.isFile() || stat.isSymbolicLink()) out.push({ path: rel, bytes: stat.size });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          log('[Checkpoints] cannot stat %s (%s); left out of the size check', rel, code);
          continue;
        }
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, queue.length) }, worker));
  return out;
}

/** Split a NUL-terminated git listing. */
export function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((p) => p.length > 0);
}

const CATEGORY_SET = new Set(CATEGORY_CHECKPOINT_EXCLUDES);

export function isCategoryPattern(pattern: string): boolean {
  return CATEGORY_SET.has(pattern);
}

const fold = (s: string, ignoreCase: boolean): string => (ignoreCase ? s.toLowerCase() : s);

/**
 * The category pattern matching `relPath`. Every category pattern is `*.<ext>` (the last component's
 * suffix) or `<name>/` (a directory component), which is all this matcher implements.
 */
export function categoryPatternFor(relPath: string, ignoreCase: boolean): string | null {
  const parts = fold(relPath, ignoreCase).split('/');
  const base = parts[parts.length - 1]!;
  const dirs = new Set(parts.slice(0, -1));
  for (const pattern of CATEGORY_CHECKPOINT_EXCLUDES) {
    const p = fold(pattern, ignoreCase);
    if (p.startsWith('*.') ? base.endsWith(p.slice(1)) : dirs.has(p.slice(0, -1))) return pattern;
  }
  return null;
}

/** Whether a security exclude (`.git` anywhere, or an anchored `.damocles` settings path) covers `relPath`. */
export function isSecurityExcluded(relPath: string, ignoreCase: boolean): boolean {
  const rel = fold(relPath, ignoreCase);
  const parts = rel.split('/');
  for (const pattern of SECURITY_CHECKPOINT_EXCLUDES) {
    const p = fold(pattern, ignoreCase);
    if (p.includes('/') ? rel === p || rel.startsWith(`${p}/`) : parts.includes(p)) return true;
  }
  return false;
}

/** One thing a snapshot left out; `pattern` is the exclude line that matched, when the folder's rules name one. */
export interface SkipItem {
  readonly path: string;
  readonly bytes: number | null;
  readonly reason: SkipReason;
  readonly pattern: string | null;
}

/**
 * Summarise what a snapshot left out, and the full list its manifest stores. The first item for a path
 * wins. A directory (path ending in `/`, `bytes` null) counts once and adds no bytes.
 */
export function summarizeSkipped(items: readonly SkipItem[]): { summary: Omit<SkippedSummary, 'manifest'>; files: SkippedFile[] } {
  const seen = new Set<string>();
  const files: SkippedFile[] = [];
  const byReason: { -readonly [R in SkipReason]?: SkippedTally } = {};
  const patterns = new Map<string, SkippedPattern>();
  let totalBytes = 0;
  for (const item of items) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    const bytes = item.bytes ?? 0;
    files.push({ path: item.path, bytes: item.bytes, reason: item.reason });
    totalBytes += bytes;
    const tally = byReason[item.reason] ?? { count: 0, bytes: 0 };
    byReason[item.reason] = { count: tally.count + 1, bytes: tally.bytes + bytes };
    if (item.pattern !== null && item.reason !== 'size') {
      const key = `${item.reason}\0${item.pattern}`;
      const entry = patterns.get(key) ?? { pattern: item.pattern, reason: item.reason, count: 0, bytes: 0 };
      patterns.set(key, { ...entry, count: entry.count + 1, bytes: entry.bytes + bytes });
    }
  }
  return { summary: { totalCount: files.length, totalBytes, byReason, patterns: [...patterns.values()] }, files };
}
