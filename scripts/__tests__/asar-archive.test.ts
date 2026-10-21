import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { asarFiles, readAsarFile, readAsarHeader, writeAsar } from '../asar-archive.mjs';

// Text, an empty file, a non-ASCII name (header byte length differs from its string length) and raw bytes.
const TEXT = { 'package.json': '{"name":"x"}', 'dist/main.js': 'console.log(1);\n', 'dist/deep/ä.txt': 'ä', 'dist/empty.txt': '' };
const RAW = Buffer.from([0, 1, 2]);

describe('writeAsar', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function archiveOf(files: Record<string, string | Buffer>): string {
    dir ??= mkdtempSync(join(tmpdir(), 'asar-archive-'));
    const archive = join(dir, 'app.asar');
    writeAsar(archive, files);
    return archive;
  }

  it('writes an archive that Electron\'s own asar library lists and extracts byte for byte', () => {
    const archive = archiveOf({ ...TEXT, 'dist/raw.bin': RAW });
    const native = (file: string): string => file.split('/').join(sep);
    expect(listPackage(archive, { isPack: false }).sort()).toEqual(
      ['dist', 'dist/deep', 'dist/deep/ä.txt', 'dist/empty.txt', 'dist/main.js', 'dist/raw.bin', 'package.json'].map((file) => `${sep}${native(file)}`).sort(),
    );
    for (const [file, text] of Object.entries(TEXT)) expect(extractFile(archive, native(file)).toString('utf8')).toBe(text);
    expect(extractFile(archive, native('dist/raw.bin')).equals(RAW)).toBe(true);
  });

  it('reads back through readAsarHeader and readAsarFile', () => {
    const archive = archiveOf(TEXT);
    const { header, dataOffset } = readAsarHeader(archive);
    const entries = asarFiles(header) as Array<{ path: string; entry: { size: number; offset: string } }>;
    expect(entries.map((file) => file.path).sort()).toEqual(Object.keys(TEXT).sort());
    for (const [path, text] of Object.entries(TEXT)) expect(readAsarFile(archive, dataOffset, entries.find((file) => file.path === path)!.entry)).toBe(text);
  });

  it.each([
    [{ a: 'x', 'a/b': 'y' }, 'asar path a/b goes through a file'],
    [{ 'a/b': 'y', a: 'x' }, 'asar path a is already in the archive'],
    [{ '/a': 'x' }, 'asar path /a has an empty, . or .. segment'],
    [{ 'd//x': 'x' }, 'asar path d//x has an empty, . or .. segment'],
    [{ 'd/../x': 'x' }, 'asar path d/../x has an empty, . or .. segment'],
  ])('refuses %j, which no archive can hold', (files, message) => {
    expect(() => archiveOf(files)).toThrow(message);
  });
});
