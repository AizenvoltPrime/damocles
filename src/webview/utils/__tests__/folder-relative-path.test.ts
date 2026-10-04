import { describe, it, expect } from 'vitest';
import { folderRelativePath } from '../folder-relative-path';

describe('folderRelativePath', () => {
  it('strips a POSIX folder prefix', () => {
    expect(folderRelativePath('/home/a/proj/src/routes/auth.ts', '/home/a/proj')).toBe('src/routes/auth.ts');
    expect(folderRelativePath('/home/a/proj/src/x.ts', '/home/a/proj/')).toBe('src/x.ts');
  });

  it('strips a Windows folder prefix case-insensitively and with either separator, keeping the file part as written', () => {
    expect(folderRelativePath('C:\\Users\\A\\Proj\\src\\Auth.ts', 'c:\\users\\a\\proj')).toBe('src\\Auth.ts');
    expect(folderRelativePath('C:/Users/A/Proj/src/Auth.ts', 'C:\\Users\\A\\Proj')).toBe('src/Auth.ts');
  });

  it('keeps the whole relative part under a folder whose name lower-cases to a longer string', () => {
    // 'İ'.toLowerCase() is two code units, so offsets measured on lower-cased text cut one character too many.
    expect(folderRelativePath('C:\\Users\\İsmail\\proj\\src\\auth.ts', 'C:\\Users\\İsmail\\proj')).toBe('src\\auth.ts');
    expect(folderRelativePath('c:/users/İSMAIL/proj/src/auth.ts', 'C:\\Users\\İsmail\\proj\\')).toBe('src/auth.ts');
  });

  it('keeps a path outside the folder, a sibling sharing its prefix, and a path climbing out with ..', () => {
    expect(folderRelativePath('/home/a/other/x.ts', '/home/a/proj')).toBe('/home/a/other/x.ts');
    expect(folderRelativePath('/home/a/project2/x.ts', '/home/a/proj')).toBe('/home/a/project2/x.ts');
    expect(folderRelativePath('/home/a/proj/../secret/x.ts', '/home/a/proj')).toBe('/home/a/proj/../secret/x.ts');
  });

  it('keeps the path when there is no folder, and a POSIX path compares case-sensitively', () => {
    expect(folderRelativePath('/home/a/proj/x.ts', undefined)).toBe('/home/a/proj/x.ts');
    expect(folderRelativePath('/home/a/Proj/x.ts', '/home/a/proj')).toBe('/home/a/Proj/x.ts');
  });
});
