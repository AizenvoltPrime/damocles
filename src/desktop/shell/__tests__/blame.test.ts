import { describe, expect, it } from 'vitest';
import type { ScmBlameResult } from '../../preload/scm-channels';
import { blameText, lineBlame } from '../editor/blame';
import { computeQuickDiff } from '../editor/quick-diff/quick-diff-compute';
import type { QuickDiffState } from '../editor/quick-diff/quick-diff-model';

const MARIA = { hash: 'a'.repeat(40), author: 'Maria', authorEmail: 'maria@example.com', authorTime: 1000, committerTime: 1000, summary: 'Tighten CORS' };
const KOSTAS = { hash: 'b'.repeat(40), author: 'Kostas', authorEmail: 'kostas@example.com', authorTime: 2000, committerTime: 2000, summary: 'Initial routes' };
// HEAD's lines 1-2 by Kostas, 3-4 by Maria
const BLAME: ScmBlameResult = { ok: true, head: 'c'.repeat(40), commits: [KOSTAS, MARIA], lines: [0, 0, 1, 1] };

function state(indexText: string, headText: string | null, buffer: string): QuickDiffState {
  const result = computeQuickDiff({ indexText, headText }, buffer);
  return { versionId: 1, indexText, headText, indexOid: 'd'.repeat(40), headOid: headText === null ? null : 'e'.repeat(40), primary: result.primary!, secondary: result.secondary, staged: result.staged, head: result.head };
}

describe('inline blame line mapping (blame.ts)', () => {
  const head = 'one\ntwo\nthree\nfour\n';

  it('blames an unchanged line on HEAD\'s commit for it', () => {
    expect(lineBlame(3, state(head, null, head), BLAME)).toEqual({ kind: 'commit', commit: MARIA });
    expect(lineBlame(1, state(head, null, head), BLAME)).toEqual({ kind: 'commit', commit: KOSTAS });
  });

  it('says an edited line is not committed and maps the lines after an insertion back to HEAD', () => {
    const buffer = 'one\nnew\ntwo\nthree\nfour\n';
    expect(lineBlame(2, state(head, null, buffer), BLAME)).toEqual({ kind: 'uncommitted' });
    expect(lineBlame(4, state(head, null, buffer), BLAME)).toEqual({ kind: 'commit', commit: MARIA });
  });

  it('says a staged line is not committed (staged) while the buffer matches the index', () => {
    const index = 'one\nTWO\nthree\nfour\n';
    expect(lineBlame(2, state(index, head, index), BLAME)).toEqual({ kind: 'staged' });
    expect(lineBlame(3, state(index, head, index), BLAME)).toEqual({ kind: 'commit', commit: MARIA });
  });

  it('shows not committed for every line of a file HEAD lacks, and nothing without a diff to map through', () => {
    expect(lineBlame(1, null, { ok: false, reason: 'notCommitted' })).toEqual({ kind: 'uncommitted' });
    expect(lineBlame(1, null, BLAME)).toBeNull();
  });

  it('words a commit as author, age and subject', () => {
    const text = { uncommitted: 'You, Not Committed Yet', staged: 'You, Not Committed Yet (Staged)', line: (commit: typeof MARIA, ago: string) => `${commit.author}, ${ago} • ${commit.summary}`, ago: () => '2 days ago' };
    expect(blameText({ kind: 'commit', commit: MARIA }, text)).toBe('Maria, 2 days ago • Tighten CORS');
    expect(blameText({ kind: 'staged' }, text)).toBe('You, Not Committed Yet (Staged)');
  });

  it('shows the author and subject\'s bidi and zero-width characters as escapes, so they cannot reorder the line', () => {
    const text = { uncommitted: '', staged: '', line: (commit: typeof MARIA, ago: string) => `${commit.author}, ${ago} • ${commit.summary}`, ago: () => 'now' };
    const commit = { ...MARIA, author: 'Ma\u202Eria', summary: 'Fix\u200B it' };
    expect(blameText({ kind: 'commit', commit }, text)).toBe('Ma\\u{202E}ria, now • Fix\\u{200B} it');
  });
});
