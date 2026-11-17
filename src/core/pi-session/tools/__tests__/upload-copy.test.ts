import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyFolderForUpload } from '../upload-copy';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-upload-copy-')));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
let counter = 0;

/** A folder named `name` under a fresh folder of base, holding `files` (path below it, with `/`, to content). */
function folderWith(name: string, files: Record<string, string>): string {
  const root = path.join(base, `t-${++counter}`, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const freshFolder = (): string => fs.mkdtempSync(path.join(base, 'into-'));

/** Every entry below folder, `/`-separated, a folder's ending in `/`, each regular file with its content. */
function contents(folder: string, below = ''): string[] {
  return fs.readdirSync(path.join(folder, below), { withFileTypes: true }).flatMap((entry) => {
    const rel = below === '' ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) return [`${rel}/`, ...contents(folder, rel)];
    return [entry.isFile() ? `${rel}=${fs.readFileSync(path.join(folder, rel), 'utf8')}` : `${rel} (not a file)`];
  }).sort();
}

describe('copyFolderForUpload', () => {
  it('copies every regular file the walk lists, hidden and .git ones included, under the folder\'s own name, with its modification time', async () => {
    const folder = folderWith('photos', { 'a.txt': 'A', 'sub/s.txt': 'S', '.hidden': 'H', '.git/HEAD': 'ref', 'sub/deeper/d.txt': 'D' });
    fs.mkdirSync(path.join(folder, 'empty'));
    const modified = new Date('2024-02-03T04:05:06Z');
    fs.utimesSync(path.join(folder, 'a.txt'), modified, modified);
    const into = freshFolder();
    const copied = await copyFolderForUpload(folder, into, undefined);
    expect(copied).toEqual({ copy: path.join(into, 'photos'), files: 5, leftOut: [] });
    expect(fs.readdirSync(into)).toEqual(['photos']);
    expect(contents(copied.copy)).toEqual(['.git/', '.git/HEAD=ref', '.hidden=H', 'a.txt=A', 'empty/', 'sub/', 'sub/deeper/', 'sub/deeper/d.txt=D', 'sub/s.txt=S']);
    expect(fs.statSync(path.join(copied.copy, 'a.txt')).mtime.getTime()).toBe(modified.getTime());
  });

  it('copies nothing and leaves nothing behind when its signal is already aborted', async () => {
    const folder = folderWith('docs', { 'a.txt': 'A' });
    const into = freshFolder();
    const controller = new AbortController();
    controller.abort();
    await expect(copyFolderForUpload(folder, into, controller.signal)).rejects.toThrow();
    expect(fs.readdirSync(into)).toEqual([]);
  });

  it('removes what it copied when its signal aborts part-way', async () => {
    const files = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}.txt`, 'x'.repeat(4096)]));
    const folder = folderWith('many', files);
    const into = freshFolder();
    const controller = new AbortController();
    const copying = copyFolderForUpload(folder, into, controller.signal);
    // the copy has started once its folder exists
    while (!fs.existsSync(path.join(into, 'many'))) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(copying).rejects.toThrow();
    expect(fs.readdirSync(into)).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('copyFolderForUpload: links (win32)', () => {
  it('leaves out a link to a named pipe, a file link and a junction, and opens none of them', async () => {
    const pipe = `\\\\.\\pipe\\dam-upload-copy-${process.pid}-${++counter}`;
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const folder = folderWith('shared', { 'a.txt': 'A', 'sub/s.txt': 'S' });
      const outside = folderWith('outside', { 'o.txt': 'O' });
      fs.symlinkSync(pipe, path.join(outside, 'pipe-again'), 'file');
      fs.symlinkSync(pipe, path.join(folder, 'pipe'), 'file');
      fs.symlinkSync(path.join(outside, 'o.txt'), path.join(folder, 'sub', 'file-link'), 'file');
      fs.symlinkSync(outside, path.join(folder, 'junction'), 'junction');
      const into = freshFolder();
      const copied = await copyFolderForUpload(folder, into, undefined);
      // a pipe connects as it opens, so one the copy made has reached the server by now
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connections).toBe(0);
      expect(copied.files).toBe(2);
      expect([...copied.leftOut].sort()).toEqual(['junction', 'pipe', path.join('sub', 'file-link')]);
      expect(contents(copied.copy)).toEqual(['a.txt=A', 'sub/', 'sub/s.txt=S']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
