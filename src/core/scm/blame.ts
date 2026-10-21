// HEAD's blame of a file, from `git blame --porcelain` (VS Code's extensions/git/src/blame.ts reads the same fields through
// --incremental). Only HEAD is blamed; the shell maps editor lines onto HEAD's through the quick diff's changes, so an edited
// line reads "Not Committed Yet".
import { GitError } from './errors';
import { checkRepoPath, MAX_SHOW_BYTES, type Repository } from './repository';
import { detectCodec, headPathOf, isBinary, readBlob, TREE_BLOB } from './staging';

export interface BlameCommit {
  readonly hash: string;
  readonly author: string;
  readonly authorEmail: string;
  // ms since the epoch
  readonly authorTime: number;
  readonly committerTime: number;
  readonly summary: string;
}

export interface Blame {
  readonly head: string;
  readonly commits: readonly BlameCommit[];
  // lines[i] indexes commits for line i + 1
  readonly lines: readonly number[];
}

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

/**
 * Parses porcelain output: each line's header "<hash> <orig> <final> [<count>]", the commit's fields the first time it shows,
 * then the line's content after a tab. Returns the commits in first-seen order and each final line's commit index.
 */
export function parseBlamePorcelain(output: string): { readonly commits: BlameCommit[]; readonly lines: number[] } {
  const commits: BlameCommit[] = [];
  const index = new Map<string, number>();
  const fields = new Map<string, Record<string, string>>();
  const lines: number[] = [];
  let current: string | undefined;
  let final = 0;
  for (const line of output.split('\n')) {
    if (current === undefined) {
      const match = HEADER.exec(line);
      if (!match) continue;
      current = match[1]!;
      final = Number(match[3]);
      if (!fields.has(current)) fields.set(current, {});
      continue;
    }
    if (line.startsWith('\t')) {
      let at = index.get(current);
      if (at === undefined) {
        const seen = fields.get(current)!;
        at = commits.length;
        index.set(current, at);
        commits.push({
          hash: current,
          author: seen['author'] ?? '',
          authorEmail: (seen['author-mail'] ?? '').replace(/^<(.*)>$/, '$1'),
          authorTime: Number(seen['author-time'] ?? 0) * 1000,
          committerTime: Number(seen['committer-time'] ?? 0) * 1000,
          summary: seen['summary'] ?? '',
        });
      }
      lines[final - 1] = at;
      current = undefined;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const seen = fields.get(current)!;
    if (!(key in seen)) seen[key] = space < 0 ? '' : line.slice(space + 1);
  }
  return { commits, lines };
}

// binary: a blob git calls binary, or a UTF-16 one, whose 0x0A bytes inside characters git would split lines at
export type BlameRead = { readonly ok: true; readonly blame: Blame } | { readonly ok: false; readonly reason: 'notCommitted' | 'tooLarge' | 'binary' };

// Blames held per repository: one entry per file, replaced when HEAD moves (a commit's blame never changes).
const MAX_CACHED_BLAMES = 50;

export class BlameCache {
  private readonly entries = new Map<string, Blame>();

  /** HEAD's blame of the file at its HEAD path (a staged rename's source), from the cache while HEAD is the commit it was read at. */
  async read(repo: Repository, relativePath: string): Promise<BlameRead> {
    checkRepoPath(relativePath);
    const resolved = await repo.read(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFailure: true });
    if (resolved.exitCode !== 0) return { ok: false, reason: 'notCommitted' };
    const head = resolved.stdout.toString('utf8').trim();
    const blamed = headPathOf(repo.lastStatus, relativePath);
    const key = `${head}\0${blamed}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { ok: true, blame: cached };
    }
    const listed = await repo.read(['ls-tree', '-z', head, '--', blamed], { literalPathspecs: true, allowFailure: true });
    const oid = listed.exitCode === 0 ? TREE_BLOB.exec(listed.stdout.toString('utf8'))?.[1] : undefined;
    if (oid === undefined) return { ok: false, reason: 'notCommitted' };
    const bytes = await readBlob(repo, oid);
    if (bytes === 'tooLarge') return { ok: false, reason: 'tooLarge' };
    const codec = detectCodec(bytes);
    if (codec.encoding !== 'utf8' || isBinary(bytes, codec)) return { ok: false, reason: 'binary' };
    const result = await repo
      .read(['-c', 'i18n.logOutputEncoding=UTF-8', 'blame', '--root', '--porcelain', head, '--', blamed], { literalPathspecs: true, allowFailure: true, maxOutputBytes: MAX_SHOW_BYTES * 4 })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'GitOutputTooLargeError') return 'tooLarge' as const;
        throw err;
      });
    if (result === 'tooLarge') return { ok: false, reason: 'tooLarge' };
    if (result.exitCode !== 0) throw new GitError(`git blame exited with ${result.exitCode}`, result.exitCode, '', result.stderr);
    const blame: Blame = { head, ...parseBlamePorcelain(result.stdout.toString('utf8')) };
    for (const held of this.entries.keys()) if (held.endsWith(`\0${blamed}`)) this.entries.delete(held);
    this.entries.set(key, blame);
    while (this.entries.size > MAX_CACHED_BLAMES) this.entries.delete(this.entries.keys().next().value!);
    return { ok: true, blame };
  }
}
