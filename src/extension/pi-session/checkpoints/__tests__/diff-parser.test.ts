import { describe, it, expect } from 'vitest';
import { parseDiffStats } from '../diff-parser';

describe('parseDiffStats', () => {
  it('parses added/removed counts per file', () => {
    const out = '3\t1\tsrc/a.ts\n0\t12\tsrc/b.ts\n';
    expect(parseDiffStats(out)).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'src/b.ts', added: 0, removed: 12 },
    ]);
  });

  it('maps binary files (-\\t-) to zero counts', () => {
    const out = '-\t-\tassets/logo.png\n5\t0\treadme.md\n';
    expect(parseDiffStats(out)).toEqual([
      { path: 'assets/logo.png', added: 0, removed: 0 },
      { path: 'readme.md', added: 5, removed: 0 },
    ]);
  });

  it('ignores blank lines and trailing whitespace', () => {
    expect(parseDiffStats('\n\n2\t2\tfile.ts\n\n')).toEqual([{ path: 'file.ts', added: 2, removed: 2 }]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseDiffStats('')).toEqual([]);
    expect(parseDiffStats('   \n  ')).toEqual([]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseDiffStats('1\t0\tonly.ts\r\n')).toEqual([{ path: 'only.ts', added: 1, removed: 0 }]);
  });

  it('preserves paths that themselves contain tabs', () => {
    expect(parseDiffStats('1\t1\tweird\tname.ts')).toEqual([{ path: 'weird\tname.ts', added: 1, removed: 1 }]);
  });

  it('skips malformed lines lacking a path column', () => {
    expect(parseDiffStats('1\t2\n3\t4\tgood.ts')).toEqual([{ path: 'good.ts', added: 3, removed: 4 }]);
  });
});
