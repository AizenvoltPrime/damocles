import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { folderKey } from '../folder-key';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('folderKey', () => {
  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('resolves relative and dotted paths to one absolute key', () => {
    const dir = path.join(process.cwd(), 'some', 'folder');
    expect(folderKey(path.join(dir, '..', 'folder'))).toBe(folderKey(dir));
    expect(folderKey('some/folder')).toBe(folderKey(dir));
  });

  it('case-folds on win32, where the filesystem ignores case', () => {
    setPlatform('win32');
    const dir = path.join(process.cwd(), 'Mixed', 'Case');
    expect(folderKey(dir)).toBe(folderKey(dir.toUpperCase()));
    expect(folderKey(dir)).toBe(path.resolve(dir).toLowerCase());
  });

  it('keeps case elsewhere', () => {
    setPlatform('linux');
    const dir = path.join(process.cwd(), 'Mixed', 'Case');
    expect(folderKey(dir)).toBe(path.resolve(dir));
  });
});
