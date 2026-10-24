import { describe, expect, it } from 'vitest';
import { pathCombine, posixBasename, posixDirname, psJoinPath, psSplitPath } from '../path-functions';

const drives = new Set(['C']);

// Expected values are what Windows PowerShell 5.1, pwsh 7 and Git Bash's coreutils print; undefined where they disagree,
// fail, print nothing, or the case is left unread.
describe.skipIf(process.platform !== 'win32')('path functions on Windows', () => {
  it.each([
    ['C:\\a\\b', 'C:\\a', 'b', 'C:'],
    ['C:/a/b', 'C:\\a', 'b', 'C:'],
    ['C:\\a b\\c', 'C:\\a b', 'c', 'C:'],
    ['a\\b', 'a', 'b', undefined],
    ['\\a\\b', '\\a', 'b', undefined],
    ['a', undefined, 'a', undefined],
    ['C:\\a', undefined, 'a', 'C:'],
    ['C:\\', undefined, undefined, 'C:'],
    ['C:\\a\\b\\', undefined, undefined, 'C:'],
    ['C:\\a\\\\b', undefined, undefined, 'C:'],
    ['C:\\a\\.', undefined, undefined, 'C:'],
    ['C:\\a\\..', undefined, undefined, 'C:'],
    ['C:foo', undefined, undefined, undefined],
    ['C:foo\\b', undefined, undefined, undefined],
    ['\\\\srv\\share\\a', undefined, undefined, undefined],
    ['//srv/share/a', undefined, undefined, undefined],
    ['D:\\a\\b', undefined, undefined, undefined],
    ['~', undefined, undefined, undefined],
    ['~\\a', '~', 'a', undefined],
    ['a\\~', 'a', '~', undefined],
    ['C:\\a*\\b', undefined, undefined, undefined],
  ])('Split-Path %j', (text, parent, leaf, qualifier) => {
    expect(psSplitPath(text, 'parent', drives)).toBe(parent);
    expect(psSplitPath(text, 'leaf', drives)).toBe(leaf);
    expect(psSplitPath(text, 'qualifier', drives)).toBe(qualifier);
  });

  it.each([
    ['C:\\a', 'b', 'C:\\a\\b'],
    ['C:\\a\\', 'b', 'C:\\a\\b'],
    ['C:\\a', '\\b', 'C:\\a\\b'],
    ['C:\\a\\', '\\b', 'C:\\a\\b'],
    ['C:', 'b', 'C:\\b'],
    ['a', 'b\\c', 'a\\b\\c'],
    ['C:/a', 'b/c', 'C:\\a\\b\\c'],
    ['C:\\a', '.', 'C:\\a\\.'],
    ['C:\\a', '..', 'C:\\a\\..'],
    ['~', 'a', '~\\a'],
    ['C:\\a', '\\\\b', undefined],
    ['C:\\a', 'D:\\b', undefined],
    ['HKLM:', 'x', undefined],
    ['', 'b', undefined],
  ])('Join-Path %j %j', (parent, child, joined) => {
    expect(psJoinPath(parent, child, drives)).toBe(joined);
  });

  it.each([
    [['C:\\a', 'b'], 'C:\\a\\b'],
    [['C:\\a\\', 'b'], 'C:\\a\\b'],
    [['C:\\a', '', 'b'], 'C:\\a\\b'],
    [['C:\\a', 'b', 'C:\\c', 'd'], 'C:\\c\\d'],
    [['C:\\a', '\\b'], '\\b'],
    [['a', 'b'], 'a\\b'],
    [['C:\\a', '..'], 'C:\\a\\..'],
    [['', ''], undefined],
    [['C:\\a', 'C:b'], undefined],
    [['C:', 'b'], undefined],
    [['foo:', 'bar'], undefined],
    [['C:\\a', '1:x'], undefined],
    [['x', '$:y'], undefined],
    [['C:\\a', 'b|c'], undefined],
    [['C:\\a', 'b\tc'], undefined],
  ])('[IO.Path]::Combine(%j)', (args, combined) => {
    expect(pathCombine(args)).toBe(combined);
  });

  it.each([
    ['a/b', 'a', 'b'],
    ['a/b/', 'a', 'b'],
    ['a//b', 'a', 'b'],
    ['/', '/', '/'],
    ['a', '.', 'a'],
    ['/a', '/', 'a'],
    ['a\\b', 'a', 'b'],
    ['\\a\\b', '\\a', 'b'],
    ['a\\', '.', 'a'],
    ['C:/a/b', 'C:/a', 'b'],
    ['C:\\a\\b', 'C:\\a', 'b'],
    ['C:/a', undefined, 'a'],
    ['C:/', undefined, undefined],
    ['x:y', undefined, undefined],
    ['a/x:y', 'a', undefined],
    ['//a', undefined, undefined],
    ['a/.', 'a', '.'],
    ['a/..', 'a', '..'],
    ['..', '.', '..'],
    ['', undefined, undefined],
  ])('dirname and basename %j', (text, dirname, basename) => {
    expect(posixDirname(text)).toBe(dirname);
    expect(posixBasename(text)).toBe(basename);
  });
});

describe.skipIf(process.platform === 'win32')('path functions off Windows', () => {
  it('reads `\\` as a name character and leaves a PowerShell path holding one unread', () => {
    expect(posixDirname('a\\b')).toBe('.');
    expect(posixBasename('a\\b')).toBe('a\\b');
    expect(psSplitPath('a\\b', 'leaf', drives)).toBeUndefined();
    expect(psJoinPath('/a', 'b\\c', drives)).toBeUndefined();
    expect(psJoinPath('/a', 'b', drives)).toBe('/a/b');
    expect(pathCombine(['/a', 'b', '/c'])).toBe('/c');
  });
});
