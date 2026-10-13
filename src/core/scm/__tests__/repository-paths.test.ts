import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isInside } from '../discovery';
import type { GitRunner } from '../git-runner';
import { gitignoreLine, PathRefusedError, Repository } from '../repository';

let root: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-scm-paths-')));
  fs.mkdirSync(path.join(root, 'real'), { recursive: true });
  fs.writeFileSync(path.join(root, 'real', 'a.txt'), 'a');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const noGit: GitRunner = {
  git: { path: 'git', version: { major: 2, minor: 45, patch: 0 } },
  envFor: () => ({}),
  run: () => Promise.reject(new Error('no git in this test')),
};

const repository = (): Repository => new Repository({ root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git'), kind: 'root', project: root }, noGit);

describe('repository paths', () => {
  it('counts a folder named ..x as inside its parent', () => {
    expect(isInside(root, path.join(root, '..x'))).toBe(true);
    expect(isInside(root, path.join(root, '..x', 'y'))).toBe(true);
    expect(isInside(path.join(root, 'real'), root)).toBe(false);
    expect(isInside(path.join(root, 'real'), path.join(root, 'other'))).toBe(false);
  });

  it('writes .gitignore lines with a trailing space, a leading # or ! and glob characters escaped, and refuses a control character', () => {
    expect(gitignoreLine('a ')).toBe('a\\ ');
    expect(gitignoreLine('!keep')).toBe('\\!keep');
    expect(gitignoreLine('#note')).toBe('\\#note');
    expect(gitignoreLine('dir/[x]*?.txt')).toBe('dir/\\[x\\]\\*\\?.txt');
    expect(gitignoreLine('back\\slash')).toBe('back\\\\slash');
    expect(() => gitignoreLine('new\nline')).toThrow(PathRefusedError);
  });

  it('confines an entry under a folder named ..x', async () => {
    fs.mkdirSync(path.join(root, '..cache'));
    fs.writeFileSync(path.join(root, '..cache', 'junk.txt'), '');
    expect(await repository().confinedEntry('..cache/junk.txt')).toBe(path.join(root, '..cache', 'junk.txt'));
  });
});

describe.runIf(process.platform === 'win32')('repository paths through links (win32)', () => {
  it('refuses an entry behind a link to a UNC share without following the link', async () => {
    // a real junction, so lstat sees a link, whose readlink answers a UNC share
    const link = path.join(root, 'share');
    fs.symlinkSync(path.join(root, 'real'), link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (path.resolve(String(file)) === link ? '\\\\server\\share' : readlink(file))) as typeof fs.promises.readlink);
    await expect(repository().confinedEntry('share/a.txt')).rejects.toBeInstanceOf(PathRefusedError);
    // the link itself is still an entry, acted on and never followed
    expect(await repository().confinedEntry('share')).toBe(link);
  });
});
