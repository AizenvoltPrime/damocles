// The Graph's Add to Chat and Explain Changes: a commit read through the repository's gated runner into a bounded attachment
// (terminal-attachment.ts frames it as data). Repository text is shown escaped (visible-text.ts), never interpreted.
import {
  MAX_COMMIT_ATTACHMENT_CHARS,
  MAX_COMMIT_ATTACHMENT_LINES,
  MAX_COMMIT_LABEL_CHARS,
  type CommitAttachmentInput,
} from '../../shared/types/chat-attachment';
import { visibleLines, visibleText } from '../../shared/visible-text';
import { emptyTreeOf, readCommitFields } from './history';
import { DIFF, type Repository } from './repository';

// Characters of git's diff read past the kept start only to count the lines left out; past it the count is a floor.
const MAX_COUNTED_CHARS = 8 * 1024 * 1024;
// git's --stat width, wide enough for most paths.
const STAT_WIDTH = 120;

/** A text's first lines within the attachment's bounds; once one does not fit, every later line only counts. */
class HeadLines {
  private readonly kept: string[] = [];
  private chars = 0;
  omitted = 0;

  get full(): boolean {
    return this.omitted > 0;
  }

  add(line: string): void {
    const cost = line.length + (this.kept.length > 0 ? 1 : 0);
    if (!this.full && this.kept.length < MAX_COMMIT_ATTACHMENT_LINES && this.chars + cost <= MAX_COMMIT_ATTACHMENT_CHARS) {
      this.kept.push(line);
      this.chars += cost;
    } else this.omitted++;
  }

  text(): string {
    return this.kept.join('\n');
  }
}

// Cuts escaped text: a `\u{…}` escape the cut would split goes whole, as does a lone high surrogate.
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).replace(/\\(?:u(?:\{[0-9A-F]*)?)?$|[\uD800-\uDBFF]$/, '')}…` : text);
// git's %s: the first paragraph, its lines joined by a space.
const subjectOf = (message: string): string => (message.split(/\n[ \t]*\n/)[0] ?? '').replace(/[ \t]*\n[ \t]*/g, ' ').trim();
const isoDate = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// One line of git's output: a CRLF file's line loses its CR, and every other control or bidi character is escaped.
const clean = (line: string): string => visibleLines(line.replace(/\r$/, ''));

/**
 * A commit of the repository as `git show` lays it out: its header, message, `--stat` and patch against its first parent, or
 * the empty tree for a root commit, so a merge shows what it brought into its first parent. The patch is the commit's own
 * bytes, never a textconv driver's output. The start is kept within MAX_COMMIT_ATTACHMENT_LINES and _CHARS; every line is
 * escaped with visibleLines. A message cut at MAX_MESSAGE_CHARS makes the count of lines left out a floor. The caller has
 * checked hash is a commit.
 */
export async function readCommitAttachment(repo: Repository, hash: string): Promise<CommitAttachmentInput> {
  const fields = await readCommitFields(repo, hash);
  const head = new HeadLines();
  const header = [
    `commit ${hash}`,
    ...(fields.parents.length > 1 ? [`Merge: ${fields.parents.join(' ')}`] : []),
    `Author: ${fields.author} <${fields.email}>`,
    `Date:   ${isoDate(fields.authorDate)}`,
    '',
    ...fields.message.split('\n').map((line) => (line === '' ? '' : `    ${line}`)),
    '',
  ];
  for (const line of header) head.add(clean(line));
  const left = fields.parents[0] ?? (await emptyTreeOf(repo));
  let carry = '';
  let read = 0;
  let counted = true;
  await repo.read(['-c', 'core.quotePath=false', ...DIFF, '--no-textconv', `--stat=${STAT_WIDTH}`, '--patch', '--find-renames', ...repo.endOfOptions(), left, hash, '--'], {
    onData: (chunk) => {
      read += chunk.length;
      const lines = `${carry}${chunk}`.split('\n');
      carry = lines.pop()!;
      for (const line of lines) {
        if (head.full) head.omitted++;
        else head.add(clean(line));
      }
      if (read <= MAX_COUNTED_CHARS) return undefined;
      counted = false;
      return 'stop';
    },
  });
  if (counted && carry !== '') head.add(clean(carry));
  return {
    kind: 'commit',
    hash,
    subject: cut(visibleText(subjectOf(fields.message)), MAX_COMMIT_LABEL_CHARS),
    author: cut(visibleText(fields.author), MAX_COMMIT_LABEL_CHARS),
    authorDate: fields.authorDate,
    text: head.text(),
    omittedLines: head.omitted,
    ...(!counted || fields.messageTruncated ? { omittedAtLeast: true as const } : {}),
  };
}
