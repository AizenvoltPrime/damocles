import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDesignFile, readServedDesignFile } from '../design-file-read';

const MAX = 1024;
let root: string;
let folder: string;

function write(relPath: string, content: string | Buffer, base = folder): string {
  const file = path.join(base, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Makes a link, or answers false where the OS refuses (a symlink on Windows without the privilege). */
function tryLink(make: () => void): boolean {
  try {
    make();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-read-'));
  folder = path.join(root, 'contacts-1a2b3c4d');
  fs.mkdirSync(folder);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readDesignFile', () => {
  it('reads a regular file below the folder', async () => {
    write('screens/S1-contacts.html', '<h1>Contacts</h1>');
    const read = await readDesignFile(folder, 'screens/S1-contacts.html', MAX);
    expect(read).toEqual({ kind: 'file', bytes: Buffer.from('<h1>Contacts</h1>') });
  });

  it('answers missing for a missing file or folder, a directory, and a file used as a directory', async () => {
    write('screens/S1.html', 'x');
    expect(await readDesignFile(folder, 'screens/S2.html', MAX)).toEqual({ kind: 'missing' });
    expect(await readDesignFile(path.join(root, 'gone'), 'screens/S1.html', MAX)).toEqual({ kind: 'missing' });
    expect(await readDesignFile(folder, 'screens', MAX)).toEqual({ kind: 'missing' });
    expect(await readDesignFile(folder, 'screens/S1.html/x.css', MAX)).toEqual({ kind: 'missing' });
  });

  it('refuses a path that is not a relative file path, or names what Windows resolves elsewhere, as outside', async () => {
    write('a.html', 'x');
    write('../outside.html', 'secret');
    for (const relPath of ['../outside.html', 'screens/../a.html', './a.html', '', 'a//b.html', '/a.html', 'C:/a.html', 'a\\b.html', '\\\\?\\C:\\a.html', 'a.html\0', 'a.html:stream', 'a.html.', 'a.html ', 'nul.html', 'con', 'com1.css']) {
      expect(await readDesignFile(folder, relPath, MAX), JSON.stringify(relPath)).toEqual({ kind: 'outside' });
    }
  });

  it('refuses a file over the cap as tooLarge and reads one at the cap', async () => {
    write('at-cap.txt', Buffer.alloc(MAX, 1));
    write('over-cap.txt', Buffer.alloc(MAX + 1, 1));
    expect(await readDesignFile(folder, 'at-cap.txt', MAX)).toEqual({ kind: 'file', bytes: Buffer.alloc(MAX, 1) });
    expect(await readDesignFile(folder, 'over-cap.txt', MAX)).toEqual({ kind: 'tooLarge' });
  });

  it('refuses a file with a second hard link, wherever the other name is', async () => {
    const inside = write('a.html', 'x');
    fs.linkSync(inside, path.join(root, 'elsewhere.html'));
    expect(await readDesignFile(folder, 'a.html', MAX)).toEqual({ kind: 'outside' });
  });

  it('refuses a symbolic link to a file, even one inside the folder', async (ctx) => {
    write('a.html', 'x');
    const outside = write('secret.txt', 'secret', root);
    if (!tryLink(() => fs.symlinkSync(outside, path.join(folder, 'out.txt'), 'file'))) ctx.skip();
    fs.symlinkSync(path.join(folder, 'a.html'), path.join(folder, 'in.html'), 'file');
    expect(await readDesignFile(folder, 'out.txt', MAX)).toEqual({ kind: 'outside' });
    expect(await readDesignFile(folder, 'in.html', MAX)).toEqual({ kind: 'outside' });
  });

  it('refuses a path through a symbolic link to a directory', async (ctx) => {
    write('secret.txt', 'secret', path.join(root, 'other'));
    if (!tryLink(() => fs.symlinkSync(path.join(root, 'other'), path.join(folder, 'assets'), 'dir'))) ctx.skip();
    expect(await readDesignFile(folder, 'assets/secret.txt', MAX)).toEqual({ kind: 'outside' });
  });

  it.runIf(process.platform === 'win32')('refuses a path through a junction', async () => {
    write('secret.txt', 'secret', path.join(root, 'other'));
    fs.symlinkSync(path.join(root, 'other'), path.join(folder, 'assets'), 'junction');
    expect(await readDesignFile(folder, 'assets/secret.txt', MAX)).toEqual({ kind: 'outside' });
  });

  it('reads through a folder that is itself reached through a link, since only the segments below it are checked', async (ctx) => {
    write('a.html', 'x');
    const alias = path.join(root, 'alias');
    if (!tryLink(() => fs.symlinkSync(folder, alias, process.platform === 'win32' ? 'junction' : 'dir'))) ctx.skip();
    expect(await readDesignFile(alias, 'a.html', MAX)).toEqual({ kind: 'file', bytes: Buffer.from('x') });
  });

  it('reads a file named in another case where the file system folds case, and finds none where it does not', async () => {
    write('screens/S1.html', 'x');
    const folds = fs.existsSync(path.join(folder, 'SCREENS', 's1.HTML'));
    expect(await readDesignFile(folder, 'SCREENS/s1.HTML', MAX)).toEqual(folds ? { kind: 'file', bytes: Buffer.from('x') } : { kind: 'missing' });
  });

  it.runIf(process.platform === 'win32')('reads through a \\\\?\\ folder path and an 8.3 short name below the folder', async (ctx) => {
    write('longdirectoryname/a.html', 'x');
    expect(await readDesignFile(`\\\\?\\${folder}`, 'longdirectoryname/a.html', MAX)).toEqual({ kind: 'file', bytes: Buffer.from('x') });
    // A volume can have short names turned off.
    if (!fs.existsSync(path.join(folder, 'LONGDI~1'))) ctx.skip();
    expect(await readDesignFile(folder, 'LONGDI~1/a.html', MAX)).toEqual({ kind: 'file', bytes: Buffer.from('x') });
  });
});

describe('readDesignFile and 8.3 file aliases', () => {
  it.runIf(process.platform === 'win32')('finds no file through an 8.3 alias whose extension differs from the real name\'s, and reads one whose extension is the same', async (ctx) => {
    write('variants/longfilename.svgz', '<svg/>');
    write('variants/longpagename.html', 'x');
    write('variants/longstylesheet.css', ':root{}');
    // A volume can have short names turned off.
    if (!fs.existsSync(path.join(folder, 'variants', 'LONGFI~1.SVG'))) ctx.skip();
    expect(await readDesignFile(folder, 'variants/LONGFI~1.SVG', MAX)).toEqual({ kind: 'missing' });
    expect(await readDesignFile(folder, 'variants/LONGPA~1.HTM', MAX)).toEqual({ kind: 'missing' });
    expect(await readDesignFile(folder, 'variants/LONGST~1.CSS', MAX)).toEqual({ kind: 'file', bytes: Buffer.from(':root{}') });
    expect(await readDesignFile(folder, 'variants/longfilename.svgz', MAX)).toEqual({ kind: 'file', bytes: Buffer.from('<svg/>') });
  });
});

describe('readServedDesignFile', () => {
  const manifest = (fidelity: unknown): string => JSON.stringify({ schemaVersion: 1, designId: 'contacts-1a2b3c4d', plan: null, fidelity, status: 'draft', version: null, screens: [], updatedAt: '2026-01-01T00:00:00.000Z' });

  it('serves the manifest\'s fidelity, read at each request', async () => {
    write('screens/S1.html', '<script>x()</script>');
    write('manifest.json', manifest('interactive'));
    expect(await readServedDesignFile(folder, 'contacts-1a2b3c4d', 'screens/S1.html')).toMatchObject({ kind: 'file', fidelity: 'interactive' });
    write('manifest.json', manifest('static'));
    expect(await readServedDesignFile(folder, 'contacts-1a2b3c4d', 'screens/S1.html')).toMatchObject({ kind: 'file', fidelity: 'static' });
  });

  it('serves a design with no manifest, or one that does not parse, with no fidelity, which is static', async () => {
    write('screens/S1.html', 'x');
    expect(await readServedDesignFile(folder, 'contacts-1a2b3c4d', 'screens/S1.html')).toMatchObject({ kind: 'file', fidelity: null });
    write('manifest.json', '{');
    expect(await readServedDesignFile(folder, 'contacts-1a2b3c4d', 'screens/S1.html')).toMatchObject({ kind: 'file', fidelity: null });
  });

  it('passes a refusal through', async () => {
    expect(await readServedDesignFile(folder, 'contacts-1a2b3c4d', '../x.html')).toEqual({ kind: 'outside' });
  });
});
