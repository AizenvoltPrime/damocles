import { describe, expect, it } from 'vitest';
import { isReferencePath, MAX_LINKED_REFERENCES, MAX_REFERENCE_NUMBER, referenceLabel, scanReferences, type ForgeReference, type ReferenceKind, type ReferenceSegment } from '../references';

// The commit message reference scanner: what links and what stays text, and that hostile text costs linear time.

const links = (text: string, kind: ReferenceKind = 'gitlab'): ForgeReference[] => scanReferences(text, kind).flatMap((segment) => (segment.reference ? [segment.reference] : []));
const joined = (segments: readonly ReferenceSegment[]): string => segments.map((segment) => segment.text).join('');

describe('scanReferences', () => {
  it('splits a commit message into text and #123, !45 and owner/repo#12 links, and gives the text back', () => {
    const text = 'Add the account chip to Source Control (#123)\n\nFollow-up to !45 and owner/repo#12.';
    const segments = scanReferences(text, 'gitlab');
    expect(joined(segments)).toBe(text);
    expect(segments).toEqual([
      { text: 'Add the account chip to Source Control (' },
      { text: '#123', reference: { sigil: '#', number: 123 } },
      { text: ')\n\nFollow-up to ' },
      { text: '!45', reference: { sigil: '!', number: 45 } },
      { text: ' and ' },
      { text: 'owner/repo#12', reference: { sigil: '#', number: 12, path: 'owner/repo' } },
      { text: '.' },
    ]);
  });

  it('links ! only on GitLab, and a GitHub path only as owner/repo', () => {
    expect(links('Merged in !45', 'github')).toEqual([]);
    expect(links('see grp/sub/proj#7 and grp/sub/proj!8', 'gitlab')).toEqual([{ sigil: '#', number: 7, path: 'grp/sub/proj' }, { sigil: '!', number: 8, path: 'grp/sub/proj' }]);
    expect(links('see grp/sub/proj#7', 'github')).toEqual([]);
    expect(links('see owner/repo#7', 'github')).toEqual([{ sigil: '#', number: 7, path: 'owner/repo' }]);
  });

  it('takes a reference at the start, after whitespace, ( or [, and before the end, whitespace or . , ; : ) ] ! ?', () => {
    expect(links('#1')).toEqual([{ sigil: '#', number: 1 }]);
    expect(links('[#2] (!3)\t#4\n#5')).toHaveLength(4);
    for (const after of ['.', ',', ';', ':', ')', ']', '!', '?', ' ', '\n']) expect(links(`fixes #9${after}`)).toEqual([{ sigil: '#', number: 9 }]);
  });

  it('links nothing inside URLs, entities, words, code-like runs or with bad numbers', () => {
    for (const text of [
      'https://github.com/owner/repo#12',
      'https://gitlab.indigital.gr/grp/proj/-/issues/#12',
      'see example.com/#12',
      '&#123;',
      'abc#1',
      'repo#12',
      '##1',
      '#1a',
      '#1_000',
      '#0',
      '#012',
      `#${MAX_REFERENCE_NUMBER + 1}`,
      '#99999999999',
      'C#7',
      'a/b/#3',
      '/owner/repo#3',
      'owner//repo#3',
      './repo#3',
      '../x#3',
      'user@host#1',
      'x!45',
      '!45x',
      '#',
      '!',
    ]) {
      expect(links(text), text).toEqual([]);
      expect(joined(scanReferences(text, 'gitlab')), text).toBe(text);
    }
    expect(links(`#${MAX_REFERENCE_NUMBER}`)).toEqual([{ sigil: '#', number: MAX_REFERENCE_NUMBER }]);
  });

  it('labels a reference as it reads, and checks a cross-project path as the scanner does', () => {
    expect(referenceLabel({ sigil: '#', number: 123 })).toBe('#123');
    expect(referenceLabel({ sigil: '!', number: 45 })).toBe('!45');
    expect(referenceLabel({ sigil: '#', number: 12, path: 'owner/repo' })).toBe('owner/repo#12');
    expect(isReferencePath('owner/repo')).toBe(true);
    expect(isReferencePath('grp/sub/proj')).toBe(true);
    expect(isReferencePath('grp/sub/proj', 'github')).toBe(false);
    for (const path of ['repo', 'owner/', '/repo', 'owner/../x', 'owner/./x', 'owner/re po', 'owner/re%2fpo', `${'a/'.repeat(20)}b`]) expect(isReferencePath(path), path).toBe(false);
  });

  describe('hostile input', () => {
    // Each case is about 1 MiB; a quadratic scan would take minutes, a linear one well under the budget.
    const BUDGET_MS = 3000;
    const MIB = 1024 * 1024;
    const timed = (text: string, kind: ReferenceKind = 'gitlab'): { readonly segments: readonly ReferenceSegment[]; readonly ms: number } => {
      const started = performance.now();
      const segments = scanReferences(text, kind);
      return { segments, ms: performance.now() - started };
    };

    for (const [name, text] of [
      ['a run of #', '#'.repeat(MIB)],
      ['a run of !', '!'.repeat(MIB)],
      ['a run of /', '/'.repeat(MIB)],
      ['a run of digits after #', `#${'9'.repeat(MIB)}`],
      ['a run of path characters before #', `${'a'.repeat(MIB)}#1`],
      ['slashes and words before #', `${'a/'.repeat(MIB / 2)}#1`],
      ['openers', '('.repeat(MIB)],
      ['space and # pairs', ' #'.repeat(MIB / 2)],
      ['path, sigil and space repeated', 'a/b#x '.repeat(MIB / 6)],
    ] as const) {
      it(name, () => {
        const { segments, ms } = timed(text);
        expect(ms).toBeLessThan(BUDGET_MS);
        expect(joined(segments)).toBe(text);
      });
    }

    it('1 MiB of real references finishes, links the first 200 and keeps the rest as text', () => {
      const unit = 'Fixes #123, see !45 and owner/repo#12. ';
      const text = unit.repeat(Math.floor(MIB / unit.length));
      const { segments, ms } = timed(text);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(segments.filter((segment) => segment.reference)).toHaveLength(MAX_LINKED_REFERENCES);
      expect(joined(segments)).toBe(text);
      expect(segments.at(-1)?.reference).toBeUndefined();
    });

    it('a run of GH- prefixes on GitHub', () => {
      const text = 'GH-'.repeat(MIB / 3);
      const { segments, ms } = timed(text, 'github');
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(joined(segments)).toBe(text);
    });
  });
});

describe('GitHub\'s GH-123', () => {
  it('links GH-123 on GitHub as the repository\'s #123, keeping its text', () => {
    expect(scanReferences('Fixes GH-123.', 'github')).toEqual([{ text: 'Fixes ' }, { text: 'GH-123', reference: { sigil: '#', number: 123 } }, { text: '.' }]);
    expect(links('(GH-7) and GH-8', 'github')).toEqual([{ sigil: '#', number: 7 }, { sigil: '#', number: 8 }]);
  });

  it('links no GH- on GitLab, in lower case, inside a word, or with a bad number', () => {
    expect(links('Fixes GH-123', 'gitlab')).toEqual([]);
    for (const text of ['gh-123', 'xGH-1', 'GH-0', 'GH-01', 'GH-', 'GH-1a', 'GH--1', 'owner/repoGH-1']) expect(links(text, 'github'), text).toEqual([]);
  });

  it('caps the links of one text at 200, counting every kind', () => {
    const text = Array.from({ length: 150 }, (_, index) => `#${index + 1} GH-${index + 1}`).join(' ');
    const found = links(text, 'github');
    expect(found).toHaveLength(MAX_LINKED_REFERENCES);
    expect(found.at(-1)).toEqual({ sigil: '#', number: 100 });
  });
});
