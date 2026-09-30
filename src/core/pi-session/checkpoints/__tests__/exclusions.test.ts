import { describe, it, expect } from 'vitest';
import {
  buildSnapshotMessage,
  categoryPatternFor,
  excludeLineForPath,
  isSecurityExcluded,
  parseLfsPatterns,
  skipsFromCommitMessage,
  summarizeSkipped,
} from '../exclusions';

describe('exclusions', () => {
  it('drops a negative LFS pattern, which an exclude file would read as a re-include', () => {
    expect(parseLfsPatterns('*.bin filter=lfs\n!*.mp4 filter=lfs\n"!x.psd" filter=lfs\n')).toEqual(['*.bin']);
  });

  it('turns a line break in a path into a ? wildcard instead of throwing', () => {
    expect(excludeLineForPath('a\nb.bin')).toBe('/a?b.bin');
    expect(excludeLineForPath('x[1]*.bin')).toBe('/x\\[1\\]\\*.bin');
  });

  it('round-trips a skipped path holding a line break through the commit trailers', () => {
    const message = buildSnapshotMessage('subject', ['dir/odd\nname.bin', 'plain.bin'], ['*.psd']);
    expect(skipsFromCommitMessage(message)).toEqual({ paths: ['dir/odd\nname.bin', 'plain.bin'], patterns: ['*.psd'] });
  });

  it('throws on a path trailer that is not a JSON string', () => {
    expect(() => skipsFromCommitMessage('s\n\ndamocles-skip-path: raw/path.bin\n')).toThrow();
  });

  it('matches category patterns by extension and by directory component, with the folder repo case rule', () => {
    expect(categoryPatternFor('dist/clip.mp4', false)).toBe('*.mp4');
    expect(categoryPatternFor('dist/CLIP.MP4', false)).toBeNull();
    expect(categoryPatternFor('dist/CLIP.MP4', true)).toBe('*.mp4');
    expect(categoryPatternFor('a/.venv/lib/x.py', false)).toBe('.venv/');
    expect(categoryPatternFor('a/target', false)).toBeNull();
    expect(categoryPatternFor('src/app.ts', false)).toBeNull();
  });

  it('matches the security excludes: .git anywhere and the anchored .damocles settings files', () => {
    expect(isSecurityExcluded('.damocles/settings.json', false)).toBe(true);
    expect(isSecurityExcluded('.damocles/settings.local.json', false)).toBe(true);
    expect(isSecurityExcluded('sub/.damocles/settings.json', false)).toBe(false);
    expect(isSecurityExcluded('.DAMOCLES/Settings.json', true)).toBe(true);
    expect(isSecurityExcluded('vendor/.git/config', false)).toBe(true);
    expect(isSecurityExcluded('.damocles/skills/x/SKILL.md', false)).toBe(false);
  });

  it('summarises every skip once: totals, per reason, per pattern, and the full list with directories', () => {
    const { summary, files } = summarizeSkipped([
      { path: 'big.bin', bytes: 30, reason: 'size', pattern: null },
      { path: 'big.bin', bytes: 30, reason: 'category', pattern: '*.bin' },
      { path: 'a.mp4', bytes: 10, reason: 'category', pattern: '*.mp4' },
      { path: '.venv/', bytes: null, reason: 'category', pattern: '.venv/' },
      { path: 'dist/m.bin', bytes: 5, reason: 'lfs', pattern: null },
    ]);
    expect(summary).toEqual({
      totalCount: 4,
      totalBytes: 45,
      byReason: { size: { count: 1, bytes: 30 }, category: { count: 2, bytes: 10 }, lfs: { count: 1, bytes: 5 } },
      patterns: [
        { pattern: '*.mp4', reason: 'category', count: 1, bytes: 10 },
        { pattern: '.venv/', reason: 'category', count: 1, bytes: 0 },
      ],
    });
    expect(files).toEqual([
      { path: 'big.bin', bytes: 30, reason: 'size' },
      { path: 'a.mp4', bytes: 10, reason: 'category' },
      { path: '.venv/', bytes: null, reason: 'category' },
      { path: 'dist/m.bin', bytes: 5, reason: 'lfs' },
    ]);
  });
});
