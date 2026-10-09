import { describe, expect, it } from 'vitest';
import { hasUnsafeWindowsSegment, isRelativeFilePath, isUnsafeWindowsName } from '../relative-path';

describe('relative paths a renderer may name', () => {
  it('takes relative paths with no empty, . or .. segment', () => {
    expect(isRelativeFilePath('a/b.c')).toBe(true);
    for (const value of ['', 'a//b', './a', 'a/..', 'a\0', 'a'.repeat(4097), 7]) expect(isRelativeFilePath(value)).toBe(false);
  });

  it('finds names Win32 path normalization would resolve elsewhere, VS Code\'s reserved names included', () => {
    for (const name of ['.. ', '...', 'a.', 'a ', 'nul', 'COM1.txt', 'a:b', 'a\u0001b', 'a?b', 'clock$', 'CLOCK$.txt', 'com0', 'lpt0.log', 'com¹']) expect(isUnsafeWindowsName(name), name).toBe(true);
    for (const name of ['.gitignore', 'console.ts', 'a.b', 'clock', 'com10', 'lpt']) expect(isUnsafeWindowsName(name), name).toBe(false);
    expect(hasUnsafeWindowsSegment('src/.. /x')).toBe(true);
    expect(hasUnsafeWindowsSegment('src/a.ts')).toBe(false);
  });
});
