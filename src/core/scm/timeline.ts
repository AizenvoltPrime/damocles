// A file's timeline: the commits that touched it, newest first, through renames (`git log --follow`), as VS Code's
// extensions/git/src/timelineProvider.ts lists them, with the file's path at each commit.
import { revision } from './git-runner';
import { checkRepoPath, MAX_MESSAGE_CHARS, type Repository } from './repository';

export interface TimelineEntry {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly message: string;
  readonly author: string;
  readonly email: string;
  // ms since the epoch
  readonly committerDate: number;
  // repo-relative, the file's path at this commit
  readonly path: string;
}

// VS Code's timeline page size.
export const TIMELINE_PAGE = 50;

// %x1e opens each record so a reader can check it is at one; the message comes last, since it is the one free-text field.
// The author is mailmapped (%aN, %aE), as blame and the Graph name it.
export const TIMELINE_FORMAT = '%x1e%H%x00%P%x00%aN%x00%aE%x00%ct%x00%B';

// TIMELINE_FORMAT's record separator, which opens each record's first token
const RECORD_START = '\u001e';
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATUS = /^[ACDMRTUXB]\d*$/;

/**
 * Parses `log --follow -z --name-status --format=TIMELINE_FORMAT`: per commit the format's NUL-separated fields, then the
 * file's status entries (status, path, and a second path for a rename or copy). A commit that lists no entry, such as a merge
 * git shows without its diff, takes the path of the nearest older commit that lists one (its first parent's side), else of
 * the nearest newer one, else path.
 */
export function parseTimeline(output: string, path: string): TimelineEntry[] {
  const listed = parseRecords(output);
  return listed.map((entry, index) => {
    if (entry.path !== undefined) return { ...entry, path: entry.path };
    const older = listed.slice(index + 1).find((candidate) => candidate.path !== undefined)?.path;
    const newer = listed.slice(0, index).reverse().find((candidate) => candidate.path !== undefined)?.path;
    return { ...entry, path: older ?? newer ?? path };
  });
}

function parseRecords(output: string): Array<Omit<TimelineEntry, 'path'> & { readonly path: string | undefined }> {
  const tokens = output.split('\0');
  const entries: Array<Omit<TimelineEntry, 'path'> & { readonly path: string | undefined }> = [];
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at]!;
    const hash = token.startsWith(RECORD_START) && HASH.test(token.slice(1)) ? token.slice(1) : undefined;
    if (hash === undefined) {
      at++;
      continue;
    }
    const [parents, author, email, time, body] = tokens.slice(at + 1, at + 6);
    at += 6;
    let entryPath: string | undefined;
    for (;;) {
      const token = (tokens[at] ?? '').replace(/^\n/, '');
      if (!STATUS.test(token)) break;
      const two = token.startsWith('R') || token.startsWith('C');
      entryPath = tokens[at + (two ? 2 : 1)];
      at += two ? 3 : 2;
    }
    const message = (body ?? '').replace(/\n+$/, '').slice(0, MAX_MESSAGE_CHARS);
    entries.push({
      hash,
      parents: (parents ?? '').split(' ').filter((parent) => parent !== ''),
      subject: message.split('\n', 1)[0]!.trim(),
      message,
      author: author ?? '',
      email: email ?? '',
      committerDate: Number(time ?? 0) * 1000,
      path: entryPath === '' ? undefined : entryPath,
    });
  }
  return entries;
}

// Where a page starts: the last entry of the page before, with the file's path at that commit.
export interface TimelineCursor {
  readonly hash: string;
  readonly path: string;
}

export interface TimelinePage {
  readonly entries: readonly TimelineEntry[];
  // the last entry listed, while more follow
  readonly next?: TimelineCursor;
}

/**
 * One page of the file's timeline: from HEAD, or after a cursor (git log --follow takes no --skip, so a page starts at the
 * previous page's last commit, at the path the file had there, and leaves that commit out). An unborn HEAD lists nothing.
 */
export async function readTimeline(repo: Repository, relativePath: string, after?: TimelineCursor): Promise<TimelinePage> {
  checkRepoPath(relativePath);
  const from = after?.path ?? relativePath;
  checkRepoPath(from);
  const start = after ? [...repo.endOfOptions(), revision(after.hash)] : [];
  const count = TIMELINE_PAGE + (after ? 2 : 1);
  const args = ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '--follow', '-z', '--name-status', '--no-color', '--no-show-signature', `--format=${TIMELINE_FORMAT}`, `-n${count}`, ...start, '--', from];
  const result = await repo.read(args, { literalPathspecs: true, allowFailure: true, maxOutputBytes: 64 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    const born = await repo.read(['rev-parse', '-q', '--verify', 'HEAD'], { allowFailure: true });
    if (born.exitCode !== 0) return { entries: [] };
    throw new Error(`git log exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  const listed = parseTimeline(result.stdout.toString('utf8'), from);
  const parsed = after && listed[0]?.hash === after.hash ? listed.slice(1) : listed;
  if (parsed.length <= TIMELINE_PAGE) return { entries: parsed };
  const entries = parsed.slice(0, TIMELINE_PAGE);
  const last = entries[entries.length - 1]!;
  return { entries, next: { hash: last.hash, path: last.path } };
}
