import { describe, expect, it } from 'vitest';
import { conflictReplacement, containsConflict, parseConflicts, resolveAll } from '../editor/merge/conflict-parser';
import { alignConflicts, handleMergeRequest, MERGE_ALIGN_MAX_LINES, matchRegions, mergeProgress, mergeWithMarkers } from '../editor/merge/merge-model';

const FILE = [
  'before',
  '<<<<<<< HEAD',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> feature',
  'middle',
  '<<<<<<< HEAD',
  'a1',
  '||||||| base',
  'a0',
  '=======',
  'b1',
  'b2',
  '>>>>>>> feature',
  'after',
  '',
].join('\n');

describe('the conflict parser (mergeConflictParser.ts)', () => {
  it('finds each conflict with its blocks, names and common ancestors', () => {
    const conflicts = parseConflicts(FILE);
    expect(conflicts).toHaveLength(2);
    const [first, second] = conflicts;
    expect(first).toMatchObject({ startLine: 2, endLine: 6, splitterLine: 4 });
    expect(first!.current).toMatchObject({ headerLine: 2, firstLine: 3, lineCount: 1, name: 'HEAD' });
    expect(first!.incoming).toMatchObject({ headerLine: 6, firstLine: 5, lineCount: 1, name: 'feature' });
    expect(FILE.slice(first!.start, first!.end)).toBe('<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\n');
    expect(second!.commonAncestors).toHaveLength(1);
    expect(second!.commonAncestors[0]).toMatchObject({ headerLine: 10, lineCount: 1, name: 'base' });
    expect(second!.current.lineCount).toBe(1);
    expect(second!.incoming.lineCount).toBe(2);
  });

  it('takes a side, both, or nothing for a side that is only a line break', () => {
    const [first, second] = parseConflicts(FILE);
    expect(conflictReplacement(FILE, first!, 'current')).toBe('mine\n');
    expect(conflictReplacement(FILE, first!, 'incoming')).toBe('theirs\n');
    expect(conflictReplacement(FILE, first!, 'both')).toBe('mine\ntheirs\n');
    // the current block of a diff3 conflict stops at its ancestors marker
    expect(conflictReplacement(FILE, second!, 'current')).toBe('a1\n');
    const empty = '<<<<<<< HEAD\n\n=======\nx\n>>>>>>> b\n';
    expect(conflictReplacement(empty, parseConflicts(empty)[0]!, 'current')).toBe('');
  });

  it('resolves every conflict at once, keeping CRLF line breaks', () => {
    expect(resolveAll(FILE, 'incoming')).toBe('before\ntheirs\nmiddle\nb1\nb2\nafter\n');
    const crlf = FILE.replace(/\n/g, '\r\n');
    expect(resolveAll(crlf, 'current')).toBe('before\r\nmine\r\nmiddle\r\na1\r\nafter\r\n');
  });

  it('stops at a second start before an end, skips a conflict with no splitter, and ignores marker-like text without both markers', () => {
    expect(parseConflicts('<<<<<<< a\nx\n<<<<<<< b\ny\n=======\nz\n>>>>>>> c\n')).toEqual([]);
    expect(parseConflicts('<<<<<<< a\nx\n>>>>>>> c\n')).toEqual([]);
    expect(containsConflict('<<<<<<< only a start')).toBe(false);
    // a splitter with trailing text is no splitter, as in VS Code
    expect(parseConflicts('<<<<<<< a\nx\n======= \ny\n>>>>>>> b\n')).toEqual([]);
  });

  it('reads markers of a longer conflict-marker-size, every marker of a conflict as long as its start', () => {
    const long = 'intro\n<<<<<<<<< HEAD\nTitle\n=======\n|||||||||| not a marker\n=========\nOther\n=======\n>>>>>>>>> side\n';
    const [conflict] = parseConflicts(long);
    expect(conflict).toMatchObject({ startLine: 2, splitterLine: 6, endLine: 9, current: { name: 'HEAD', lineCount: 3 }, incoming: { name: 'side', lineCount: 2 } });
    expect(conflict!.commonAncestors).toEqual([]);
    expect(resolveAll(long, 'incoming')).toBe('intro\nOther\n=======\n');
    expect(parseConflicts('<<<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n')).toEqual([]);
  });
});

describe('the merge model off the main thread', () => {
  it('aligns the same regions after trimming the lines all three sides share at either end', () => {
    const shared = Array.from({ length: 50 }, (_value, index) => `line ${index}`);
    const base = [...shared, 'b', ...shared, ''].join('\n');
    const current = [...shared, 'c', ...shared, ''].join('\n');
    const incoming = [...shared, 'i', ...shared, ''].join('\n');
    expect(alignConflicts(base, current, incoming)).toEqual([{ current: { start: 51, lines: 1 }, incoming: { start: 51, lines: 1 }, base: { start: 51, lines: 1 }, currentText: ['c'], incomingText: ['i'] }]);
    expect(mergeWithMarkers(base, current, incoming, { current: 'main', incoming: 'side', base: 'Base' }, '\n')).toBe([...shared, '<<<<<<< main', 'c', '=======', 'i', '>>>>>>> side', ...shared, ''].join('\n'));
  });

  it('aligns nothing past the line cap, where the Result still counts its conflicts from its markers', () => {
    const many = (tag: string): string => Array.from({ length: MERGE_ALIGN_MAX_LINES + 1 }, (_value, index) => `${tag} ${index}`).join('\n');
    expect(alignConflicts(many('b'), many('c'), many('i'))).toBeNull();
    expect(mergeWithMarkers(many('b'), many('c'), many('i'), { current: 'c', incoming: 'i', base: 'b' }, '\n')).toBeNull();
  });

  it('answers the worker\'s requests by id', () => {
    const base = 'top\nshared\nend\n';
    expect(handleMergeRequest({ id: 7, kind: 'align', base, current: 'top\nours\nend\n', incoming: 'top\ntheirs\nend\n' })).toEqual({ id: 7, kind: 'align', regions: alignConflicts(base, 'top\nours\nend\n', 'top\ntheirs\nend\n') });
    expect(handleMergeRequest({ id: 8, kind: 'markers', base, current: 'top\nours\nend\n', incoming: base, labels: { current: 'c', incoming: 'i', base: 'b' }, eol: '\n' })).toEqual({ id: 8, kind: 'markers', text: 'top\nours\nend\n' });
  });
});

describe('the merge model (node-diff3 diff3Merge)', () => {
  const base = 'top\nshared\nmid\nend\n';
  const current = 'top\nours\nmid\nend\n';
  const incoming = 'top\ntheirs\nmid\nend-x\n';

  it('aligns each conflict to its lines on both sides and leaves one-sided changes merged', () => {
    const regions = alignConflicts(base, current, incoming)!;
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ current: { start: 2, lines: 1 }, incoming: { start: 2, lines: 1 }, base: { start: 2, lines: 1 }, currentText: ['ours'], incomingText: ['theirs'] });
  });

  it('rebuilds the Result with markers in the document line break, and the diff3 base block', () => {
    const labels = { current: 'main', incoming: 'feature', base: 'base' };
    expect(mergeWithMarkers(base, current, incoming, labels, '\r\n')).toBe('top\r\n<<<<<<< main\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\nmid\r\nend-x\r\n');
    expect(mergeWithMarkers(base, current, incoming, labels, '\n', true)).toContain('||||||| base\nshared\n=======');
  });

  it('matches the Result conflicts to the regions by their lines, and counts what is left', () => {
    const labels = { current: 'main', incoming: 'feature', base: 'base' };
    const regions = alignConflicts(base, current, incoming)!;
    const result = mergeWithMarkers(base, current, incoming, labels, '\n')!;
    expect(matchRegions(result, parseConflicts(result), regions)).toEqual([regions[0]]);
    expect(mergeProgress(result, 1)).toEqual({ left: 1, total: 1 });
    const resolved = resolveAll(result, 'current');
    expect(matchRegions(resolved, parseConflicts(resolved), regions)).toEqual([]);
    expect(mergeProgress(resolved, 1)).toEqual({ left: 0, total: 1 });
    // a conflict typed by hand raises the total rather than going negative
    expect(mergeProgress(`${result}${result}`, 1)).toEqual({ left: 2, total: 2 });
  });
});
