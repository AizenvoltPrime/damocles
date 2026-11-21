import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInsideRealRoot, linkRootOf } from '../real-root';

let root: string;
let folder: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-real-root-')));
  folder = path.join(root, 'proj');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'deep', 'g.txt'), 'x');
  fs.symlinkSync(outside, path.join(folder, 'out'), 'junction');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isInsideRealRoot', () => {
  it('holds the root itself and what lies under it, never a sibling that shares its prefix', () => {
    expect(isInsideRealRoot(folder, folder)).toBe(true);
    expect(isInsideRealRoot(folder, path.join(folder, 'src'))).toBe(true);
    expect(isInsideRealRoot(folder, `${folder}-other`)).toBe(false);
    expect(isInsideRealRoot(folder, root)).toBe(false);
  });
});

describe('linkRootOf', () => {
  it('answers the deepest link among the segments, by its folder path and realpath, when it holds the target', async () => {
    const real = path.join(outside, 'deep', 'g.txt');
    expect(await linkRootOf(folder, ['out', 'deep', 'g.txt'], real)).toEqual({ link: 'out', realRoot: outside });
    fs.symlinkSync(path.join(outside, 'deep'), path.join(outside, 'next'), 'junction');
    expect(await linkRootOf(folder, ['out', 'next', 'g.txt'], real)).toEqual({ link: 'out/next', realRoot: path.join(outside, 'deep') });
  });

  it('answers a file link with the file as its root', async () => {
    const file = path.join(outside, 'deep', 'g.txt');
    fs.symlinkSync(file, path.join(folder, 'f'), 'file');
    expect(await linkRootOf(folder, ['f'], file)).toEqual({ link: 'f', realRoot: file });
  });

  it('answers undefined with no link on the way, or when the deepest link does not hold the target', async () => {
    expect(await linkRootOf(folder, ['src'], path.join(folder, 'src'))).toBeUndefined();
    expect(await linkRootOf(folder, ['out', 'deep', 'g.txt'], path.join(root, 'elsewhere', 'g.txt'))).toBeUndefined();
  });
});
