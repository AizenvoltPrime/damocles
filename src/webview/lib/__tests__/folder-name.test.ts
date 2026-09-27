import { describe, it, expect } from 'vitest';
import { folderName } from '../folder-name';

describe('folderName', () => {
  it.each([
    ['C:\\work\\alpha', 'alpha'],
    ['/home/me/beta/', 'beta'],
    ['c:/mixed\\gamma', 'gamma'],
  ])('takes the last segment of %s', (path, name) => {
    expect(folderName(path)).toBe(name);
  });

  it('returns a path with no segment unchanged', () => {
    expect(folderName('/')).toBe('/');
  });
});
