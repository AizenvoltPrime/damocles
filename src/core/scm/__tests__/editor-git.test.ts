import { describe, expect, it } from 'vitest';
import { parseBlamePorcelain } from '../blame';
import { isStashConflict, mergeOperationOf, mergeTitles, refNames, type MergeTitles } from '../merge';
import { decodeBlob, detectCodec, encodeBlob } from '../staging';
import { parseTimeline } from '../timeline';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('blame porcelain', () => {
  it('maps each final line to its commit, reading a commit\'s fields only the first time it shows', () => {
    const output = [
      `${A} 1 1 2`,
      'author Ann',
      'author-mail <ann@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Cat',
      'committer-mail <cat@example.com>',
      'committer-time 1700000100',
      'committer-tz +0000',
      'summary First commit',
      'filename f.txt',
      '\tline one',
      `${A} 2 2`,
      '\tline two',
      `${B} 3 3 1`,
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1700001000',
      'committer-time 1700001000',
      'summary Second',
      'previous ' + A + ' f.txt',
      'filename f.txt',
      '\tline three',
      `${A} 3 4 1`,
      'filename f.txt',
      '\tline four',
      '',
    ].join('\n');
    const { commits, lines } = parseBlamePorcelain(output);
    expect(commits).toEqual([
      { hash: A, author: 'Ann', authorEmail: 'ann@example.com', authorTime: 1_700_000_000_000, committerTime: 1_700_000_100_000, summary: 'First commit' },
      { hash: B, author: 'Bob', authorEmail: 'bob@example.com', authorTime: 1_700_001_000_000, committerTime: 1_700_001_000_000, summary: 'Second' },
    ]);
    expect(lines).toEqual([0, 0, 1, 0]);
  });

  it('reads a content line that looks like a header as content', () => {
    const output = [`${A} 1 1 1`, 'author Ann', 'summary s', 'filename f', `\t${B} 1 1 1`, ''].join('\n');
    expect(parseBlamePorcelain(output).lines).toEqual([0]);
  });
});

describe('timeline log', () => {
  const record = (hash: string, parents: string, subject: string, status: string[]): string =>
    [`\x1e${hash}`, parents, 'Ann', 'ann@example.com', '1700000000', `${subject}\n\nbody\n`, ...status.map((token, index) => (index === 0 ? `\n${token}` : token))].join('\0');

  it('gives each entry the file\'s path at that commit through a rename, and a merge without its diff the path below it', () => {
    const output = [
      record(A, `${B} ${C}`, 'Merge side', []),
      record(B, C, 'Edit', ['M', 'new.txt']),
      record(C, '', 'Rename', ['R100', 'old.txt', 'new.txt']),
      record('d'.repeat(40), '', 'Create', ['A', 'old.txt']),
    ].join('\0') + '\0';
    const entries = parseTimeline(output, 'new.txt');
    expect(entries.map((entry) => [entry.subject, entry.path])).toEqual([
      ['Merge side', 'new.txt'],
      ['Edit', 'new.txt'],
      ['Rename', 'new.txt'],
      ['Create', 'old.txt'],
    ]);
    expect(entries[0]!.parents).toEqual([B, C]);
    expect(entries[0]!.message).toBe('Merge side\n\nbody');
    expect(entries[0]!.committerDate).toBe(1_700_000_000_000);
  });
});

describe('merge editor labels', () => {
  const titles: MergeTitles = { current: 'Current', incoming: 'Incoming', base: 'Base', stash: 'Stashed Changes', worktree: (branch) => `${branch} (worktree)` };

  it('names the operation from the repository, else a stash apply from its markers', () => {
    expect(mergeOperationOf('rebase', '')).toBe('rebase');
    expect(mergeOperationOf('cherryPick', '')).toBe('cherryPick');
    expect(mergeOperationOf(null, '<<<<<<< Updated upstream\na\n=======\nb\n>>>>>>> Stashed changes\n')).toBe('stash');
    expect(mergeOperationOf(null, '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> side\n')).toBe('merge');
    expect(isStashConflict('>>>>>>> Stashed changes\r\n')).toBe(true);
  });

  it('tells a stash apply from markers of a conflict-marker-size longer than seven', () => {
    expect(mergeOperationOf(null, '<<<<<<<<< Updated upstream\na\n=========\nb\n>>>>>>>>> Stashed changes\n')).toBe('stash');
    expect(isStashConflict('>>>>>> Stashed changes\n')).toBe(false);
  });

  it('labels Incoming "Stashed Changes" for a stash and "{branch} (worktree)" for a worktree apply', () => {
    expect(mergeTitles('merge', titles)).toEqual({ current: 'Current', incoming: 'Incoming', base: 'Base' });
    expect(mergeTitles('rebase', titles)).toEqual({ current: 'Current', incoming: 'Incoming', base: 'Base' });
    expect(mergeTitles('stash', titles).incoming).toBe('Stashed Changes');
    expect(mergeTitles('worktreeApply', titles, 'damocles/fix').incoming).toBe('damocles/fix (worktree)');
  });

  it('details a commit by its ref names, HEAD\'s arrow dropped', () => {
    expect(refNames('HEAD -> main, origin/main')).toBe('main, origin/main');
    expect(refNames('HEAD')).toBe('');
    expect(refNames('feature')).toBe('feature');
  });
});

describe('blob text', () => {
  it('decodes in the document\'s encoding, dropping its byte order mark, and refuses bytes that do not decode', () => {
    expect(decodeBlob(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), { encoding: 'utf8', bom: true })).toBe('a');
    expect(decodeBlob(Buffer.from([0xff, 0xfe, 0x61, 0x00]), { encoding: 'utf16le', bom: true })).toBe('a');
    expect(decodeBlob(Buffer.from([0xfe, 0xff, 0x00, 0x61]), { encoding: 'utf16be', bom: true })).toBe('a');
    expect(decodeBlob(Buffer.from([0xc3, 0x28]), { encoding: 'utf8', bom: false })).toBeUndefined();
    expect(decodeBlob(Buffer.from([0x61, 0x00, 0x62]), { encoding: 'utf16le', bom: false })).toBeUndefined();
  });

  it('encodes with the byte order mark when the codec has one, and detects a blob\'s own codec', () => {
    expect([...encodeBlob('a', { encoding: 'utf16be', bom: true })]).toEqual([0xfe, 0xff, 0x00, 0x61]);
    expect([...encodeBlob('a', { encoding: 'utf8', bom: false })]).toEqual([0x61]);
    expect(detectCodec(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({ encoding: 'utf16le', bom: true });
    expect(detectCodec(Buffer.from('plain'))).toEqual({ encoding: 'utf8', bom: false });
  });
});
