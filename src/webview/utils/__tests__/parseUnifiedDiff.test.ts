import { describe, it, expect } from 'vitest';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import type { ToolCall } from '@shared/types/session';
import { buildFileDiff, fileChangeSource, type DiffLine } from '../parseUnifiedDiff';

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** The shape pi's `generateUnifiedPatch` records: four lines of context and file headers only. */
const patchOf = (before: string, after: string): string =>
  createTwoFilesPatch('f.ts', 'f.ts', before, after, undefined, undefined, { context: 4, headerOptions: FILE_HEADERS_ONLY })!;

const numbers = (diffLines: DiffLine[]) => diffLines.map((l) => [l.type, l.oldLineNum, l.newLineNum]);

describe('a recorded patch', () => {
  it('numbers each line as it is in the file', () => {
    const before = lines(200);
    const diff = buildFileDiff({ kind: 'patch', patch: patchOf(before, before.replace('line 120\n', 'changed 120\n')) });

    expect(diff.numbered).toBe(true);
    expect(diff.stats).toEqual({ added: 1, removed: 1 });
    expect(diff.lines.find((l) => l.type === 'deletion')).toMatchObject({ oldLineNum: 120, content: 'line 120' });
    expect(diff.lines.find((l) => l.type === 'addition')).toMatchObject({ newLineNum: 120, content: 'changed 120' });
    expect(diff.lines[0]).toMatchObject({ type: 'context', oldLineNum: 116, newLineNum: 116 });
  });

  it('shows hunks, not the file, with the unchanged lines between them counted', () => {
    const before = lines(100);
    const after = before.replace('line 10\n', 'ten\n').replace('line 80\n', '');
    const diff = buildFileDiff({ kind: 'patch', patch: patchOf(before, after) });

    const gap = diff.lines.find((l) => l.type === 'gap');
    // The first hunk ends at line 14, the second starts at line 76.
    expect(gap?.hiddenCount).toBe(61);
    expect(diff.lines.filter((l) => l.type !== 'gap')).toHaveLength(10 + 9);
    expect(diff.lines.find((l) => l.type === 'deletion' && l.content === 'line 80')?.oldLineNum).toBe(80);
    expect(diff.lines.find((l) => l.type === 'context' && l.content === 'line 81')).toMatchObject({ oldLineNum: 81, newLineNum: 80 });
  });

  it('marks a last line that has no line end', () => {
    const diff = buildFileDiff({ kind: 'patch', patch: patchOf('a\nb', 'a\nc') });

    expect(numbers(diff.lines)).toEqual([
      ['context', 1, 1],
      ['deletion', 2, null],
      ['noNewline', null, null],
      ['addition', null, 2],
      ['noNewline', null, null],
    ]);
  });
});

describe('the lines without a patch', () => {
  it('numbers a new file from 1, which is where its lines are', () => {
    const diff = buildFileDiff({ kind: 'newFile', content: 'a\nb\n' });

    expect(numbers(diff.lines)).toEqual([['addition', null, 1], ['addition', null, 2]]);
    expect(diff.stats).toEqual({ added: 2, removed: 0 });
  });

  it('gives a requested change no numbers, since nothing says where it is in the file', () => {
    const diff = buildFileDiff({ kind: 'change', oldText: 'keep\nold\n', newText: 'keep\nnew\n' });

    expect(diff.numbered).toBe(false);
    expect(diff.lines.every((l) => l.oldLineNum === null && l.newLineNum === null)).toBe(true);
    expect(diff.lines.map((l) => [l.type, l.content])).toEqual([['context', 'keep'], ['deletion', 'old'], ['addition', 'new']]);
  });

  it('says why when no patch was recorded', () => {
    expect(buildFileDiff({ kind: 'omitted', reason: 'binary' })).toMatchObject({ lines: [], numbered: false, omitted: 'binary' });
  });

  it('says when there is nothing to show: a patch that changes nothing, or a file with no content', () => {
    expect(buildFileDiff({ kind: 'patch', patch: patchOf('a\n', 'a\n') })).toMatchObject({ lines: [], empty: 'noChanges' });
    expect(buildFileDiff({ kind: 'newFile', content: '' })).toMatchObject({ lines: [], empty: 'emptyFile' });
    expect(buildFileDiff({ kind: 'change', oldText: '', newText: '' })).toMatchObject({ lines: [], empty: 'emptyFile' });
    expect(buildFileDiff({ kind: 'newFile', content: 'a\n' })).not.toHaveProperty('empty');
  });
});

describe('which source a file change card renders', () => {
  const edit = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't1', name: 'Edit', input: { file_path: '/w/f.ts', old_string: 'a', new_string: 'b' }, status: 'completed', ...over,
  });
  const write = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't2', name: 'Write', input: { file_path: '/w/f.ts', content: 'x\n' }, status: 'completed', ...over,
  });

  it('the result\'s recorded patch, or why there is none', () => {
    expect(fileChangeSource(edit({ metadata: { patch: 'P' } }), undefined)).toEqual({ kind: 'patch', patch: 'P' });
    expect(fileChangeSource(write({ metadata: { patchOmitted: 'tooLarge' } }), undefined)).toEqual({ kind: 'omitted', reason: 'tooLarge' });
  });

  it('the approval\'s patch while the call awaits it, and a new file\'s own lines', () => {
    expect(fileChangeSource(edit({ status: 'awaiting_approval' }), { patch: 'A' })).toEqual({ kind: 'patch', patch: 'A' });
    expect(fileChangeSource(write({ status: 'awaiting_approval' }), {})).toEqual({ kind: 'newFile', content: 'x\n' });
  });

  it('a completed Write whose result records that it created its file', () => {
    expect(fileChangeSource(write({ metadata: { created: true } }), undefined)).toEqual({ kind: 'newFile', content: 'x\n' });
  });

  it('the requested content, without numbers, for a completed Write that recorded neither a patch nor a creation', () => {
    expect(fileChangeSource(write(), undefined)).toEqual({ kind: 'change', oldText: '', newText: 'x\n' });
  });

  describe('a patch jsdiff cannot parse, which counts as no patch', () => {
    const valid = patchOf('a\nb\n', 'a\nc\n');
    it.each([
      ['a stray line in a hunk', valid.replace(' a\n', ' a\nstray\n')],
      ['a hunk whose line count does not match its header', valid.replace('@@ -1,2 +1,2 @@', '@@ -1,3 +1,2 @@')],
      ['a header path split by a newline', patchOf('a\nb\n', 'a\nc\n').replaceAll('f.ts', 'f\nb.ts')],
    ])('%s', (_label, patch) => {
      expect(fileChangeSource(edit({ metadata: { patch } }), undefined)).toEqual({ kind: 'change', oldText: 'a', newText: 'b' });
      expect(fileChangeSource(write({ status: 'awaiting_approval' }), { patch })).toEqual({ kind: 'change', oldText: '', newText: 'x\n' });
      expect(() => buildFileDiff(fileChangeSource(edit({ status: 'awaiting_approval' }), { patch }))).not.toThrow();
    });
  });

  it.each([
    ['a denied edit', edit({ status: 'denied' })],
    ['a failed edit', edit({ status: 'failed' })],
    ['a running edit before its result', edit({ status: 'running' })],
    ['an edit no longer awaiting the approval it had', edit({ status: 'approved' })],
  ])('the requested change, without numbers, for %s', (_label, toolCall) => {
    expect(fileChangeSource(toolCall, { patch: 'stale' })).toEqual({ kind: 'change', oldText: 'a', newText: 'b' });
  });

  it('the requested content, without numbers, for a Write that wrote nothing', () => {
    expect(fileChangeSource(write({ status: 'denied' }), undefined)).toEqual({ kind: 'change', oldText: '', newText: 'x\n' });
  });
});
