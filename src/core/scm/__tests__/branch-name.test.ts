import { describe, expect, it } from 'vitest';
import { sanitizeBranchName } from '../branches';

// Expected values are what VS Code's sanitizeBranchName (extensions/git/src/commands.ts) returns for each input.
describe('sanitizeBranchName (VS Code port)', () => {
  it('turns whitespace into the whitespace character after trimming the ends', () => {
    expect(sanitizeBranchName('fix login', '-')).toBe('fix-login');
    expect(sanitizeBranchName('  fix login  ', '-')).toBe('fix-login');
    expect(sanitizeBranchName('a\tb', '-')).toBe('a-b');
    expect(sanitizeBranchName('a b', '_')).toBe('a_b');
  });

  it('drops leading dashes', () => {
    expect(sanitizeBranchName('--fix', '-')).toBe('fix');
    expect(sanitizeBranchName('-a-b', '-')).toBe('a-b');
  });

  it('replaces "..", "~", "^", ":", "*", "[", "\\" and a trailing "]"', () => {
    expect(sanitizeBranchName('a..b', '-')).toBe('a-b');
    expect(sanitizeBranchName('a~b^c:d*e[f', '-')).toBe('a-b-c-d-e-f');
    expect(sanitizeBranchName('a\\b', '-')).toBe('a-b');
    expect(sanitizeBranchName('a]', '-')).toBe('a-');
    expect(sanitizeBranchName(']a', '-')).toBe(']a');
  });

  it('replaces a leading or path-part-leading ".", a trailing "/" or ".", and ".lock" at an end or before "/"', () => {
    expect(sanitizeBranchName('.hidden', '-')).toBe('-hidden');
    expect(sanitizeBranchName('a/.b', '-')).toBe('a-b');
    expect(sanitizeBranchName('feature/', '-')).toBe('feature-');
    expect(sanitizeBranchName('end.', '-')).toBe('end-');
    expect(sanitizeBranchName('x.lock', '-')).toBe('x-');
    expect(sanitizeBranchName('x.lock/y', '-')).toBe('x-y');
  });

  it('keeps a valid name, and answers empty for empty and the whitespace character for blank', () => {
    expect(sanitizeBranchName('feat/login', '-')).toBe('feat/login');
    expect(sanitizeBranchName('', '-')).toBe('');
    expect(sanitizeBranchName('   ', '-')).toBe('-');
  });
});
