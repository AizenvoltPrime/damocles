// The `simple` mode cases of Visual Studio Code's fileActions.test.ts ("Files - Increment file name simple"), MIT License.
import { describe, expect, it } from 'vitest';
import { incrementFileName } from '../increment-name';

describe('incrementFileName', () => {
  it.each([
    ['test.js', 'test copy.js'],
    ['test copy.js', 'test copy 2.js'],
    ['test copy 005.js', 'test copy 6.js'],
    ['test copy 9007199254740992.js', 'test copy 9007199254740992 copy.js'],
    ['copy.js', 'copy copy.js'],
    ['copy 2.js', 'copy 2 copy.js'],
    ['test', 'test copy'],
    ['test.', 'test copy.'],
    ['.test', '.test copy'],
    ['..test', '. copy.test'],
    ['test copy 5', 'test copy 6'],
  ])('a file %s becomes %s', (name, next) => {
    expect(incrementFileName(name, false)).toBe(next);
  });

  it.each([
    ['test', 'test copy'],
    ['test copy', 'test copy 2'],
    ['test copy 005', 'test copy 6'],
    ['test copy 9007199254740992', 'test copy 9007199254740992 copy'],
    ['copy', 'copy copy'],
    ['copy 2', 'copy 2 copy'],
    ['test.js', 'test.js copy'],
    ['test.js copy 5', 'test.js copy 6'],
    ['test copy 0', 'test copy'],
    ['test copy 1', 'test copy 2'],
  ])('a folder %s becomes %s', (name, next) => {
    expect(incrementFileName(name, true)).toBe(next);
  });
});
