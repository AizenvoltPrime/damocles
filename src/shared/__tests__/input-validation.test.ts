import { describe, expect, it } from 'vitest';
import { inputProblem, MAX_INPUT_VALUE_LENGTH } from '../input-validation';
import { isRelativeFilePath } from '../relative-path';

const POSIX = { windows: false };
const code = (kind: Parameters<typeof inputProblem>[0], value: string): string | undefined => inputProblem(kind, value, POSIX)?.code;

describe('inputProblem', () => {
  it('accepts names git check-ref-format --branch accepts', () => {
    for (const name of ['main', 'feat/login', 'damocles/fix-login', 'v1.2', 'a-b_c', 'ü/ä', 'x@y', 'release/2024.1', 'a.b/c']) {
      expect(inputProblem('branchName', name, POSIX), name).toBeUndefined();
    }
  });

  it('names the ref-name rule a branch name breaks', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['a..b', 'doubleDot'],
      ['a\u0001b', 'control'],
      ['a\u007fb', 'control'],
      ['a\tb', 'control'],
      ['a b', 'space'],
      ['a~b', 'char'],
      ['a^b', 'char'],
      ['a:b', 'char'],
      ['a?b', 'char'],
      ['a*b', 'char'],
      ['a[b', 'char'],
      ['a\\b', 'char'],
      ['/a', 'slashEdge'],
      ['a/', 'slashEdge'],
      ['a//b', 'doubleSlash'],
      ['.a', 'dotPart'],
      ['a/.b', 'dotPart'],
      ['a.lock', 'lockPart'],
      ['a.lock/b', 'lockPart'],
      ['a.', 'trailingDot'],
      ['a@{b', 'atBrace'],
      ['@', 'at'],
      ['-a', 'leadingDash'],
    ];
    for (const [name, expected] of cases) expect(code('branchName', name), name).toBe(expected);
    expect(inputProblem('branchName', 'a[b', POSIX)).toEqual({ code: 'char', char: '[' });
  });

  it('refuses HEAD as a branch name', () => {
    expect(code('branchName', 'HEAD')).toBe('head');
    expect(inputProblem('branchName', 'HEADS', POSIX)).toBeUndefined();
  });

  it('takes a relative, normalized path inside the repository', () => {
    for (const path of ['a.ts', 'src/a.ts', 'src/.env', 'a b/c d.txt', '..a/b..']) {
      expect(inputProblem('path', path, POSIX), path).toBeUndefined();
      expect(isRelativeFilePath(path), path).toBe(true);
    }
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['/etc/passwd', 'absolute'],
      ['C:/x', 'absolute'],
      ['c:x', 'absolute'],
      ['src\\a.ts', 'backslash'],
      ['../a.ts', 'outside'],
      ['src/../../a.ts', 'outside'],
      ['src/./a.ts', 'notNormalized'],
      ['src//a.ts', 'notNormalized'],
      ['src/', 'notNormalized'],
      ['a\u0000b', 'control'],
      ['a\nb', 'control'],
    ];
    for (const [path, expected] of cases) {
      expect(code('path', path), path).toBe(expected);
      expect(isRelativeFilePath(path) && expected !== 'control', path).toBe(false);
    }
  });

  it('flags a name Windows would resolve elsewhere only on Windows', () => {
    for (const path of ['src/con.ts', 'a/b.', 'a /b', 'src/a:b', 'NUL']) {
      expect(inputProblem('path', path, { windows: true }), path).toEqual({ code: 'windowsName' });
      expect(inputProblem('path', path, POSIX), path).toBeUndefined();
    }
    expect(inputProblem('path', 'src/console.ts', { windows: true })).toBeUndefined();
  });

  it('bounds every kind', () => {
    expect(code('path', 'a'.repeat(MAX_INPUT_VALUE_LENGTH + 1))).toBe('tooLong');
    expect(code('branchName', 'a'.repeat(MAX_INPUT_VALUE_LENGTH + 1))).toBe('tooLong');
    expect(inputProblem('path', 'a'.repeat(MAX_INPUT_VALUE_LENGTH), POSIX)).toBeUndefined();
  });
});
