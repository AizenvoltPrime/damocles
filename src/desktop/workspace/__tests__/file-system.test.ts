import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { Project } from '../../local-services/confine';
import { createFileSystem, WriteRefusedError, type WorkspaceFileSystem } from '../file-system';

let root: string;
let project: Project;
let files: WorkspaceFileSystem;
const logged: string[] = [];

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-workspace-files-')));
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'old text');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  logged.length = 0;
  files = createFileSystem({ watchers: createFakePlatform().fileWatchers, trash: async () => undefined, damoclesHome: path.join(root, 'home', '.damocles'), log: (line) => logged.push(line) });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const located = (relativePath: string) => ({ path: path.join(project.fsPath, ...relativePath.split('/')), projectKey: project.key, relativePath });

describe('confinement through the workspace files', () => {
  it('refuses an absolute path, a parent escape, and on Windows a UNC path, a device name or a drive-relative path, before any file system call', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const lstat = vi.spyOn(fs.promises, 'lstat');
    const windowsOnly = process.platform === 'win32' ? ['\\\\server\\share\\a.ts', '//server/share/a.ts', 'src/CON', 'src/nul.txt', 'C:a.ts', 'src/a.ts:stream'] : [];
    for (const relativePath of [...windowsOnly, '../outside.txt', 'src/../../outside.txt', path.join(root, 'outside.txt')]) {
      expect(await files.confineExisting(project, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
      expect(await files.entry(project, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
    }
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('confines an existing file to its real path and a missing one under its deepest existing folder', async () => {
    expect(await files.confineExisting(project, 'src/a.ts')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'a.ts') });
    expect(await files.confineExisting(project, 'src/gone.ts')).toEqual({ ok: false, reason: 'missing' });
    expect(await files.confineMissing(project, 'src/new/b.ts')).toEqual({ ok: true, path: path.join(project.fsPath, 'src', 'new', 'b.ts') });
  });
});

describe('the in-place save', () => {
  it('writes the confined file in place, so a hardlink and the mode stay', async () => {
    const file = path.join(project.fsPath, 'src', 'a.ts');
    const link = path.join(root, 'hardlink.ts');
    fs.linkSync(file, link);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
    const before = fs.statSync(file, { bigint: true });
    await files.writeInPlace(project, located('src/a.ts'), Buffer.from('new'));
    const after = fs.statSync(file, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(link, 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect(after.mode & 0o777n).toBe(0o640n);
  });

  it('refuses a file another one replaced between the identity check and the open, and leaves the newcomer alone', async () => {
    const file = path.join(project.fsPath, 'src', 'a.ts');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') {
        fs.writeFileSync(`${file}.new`, 'someone else');
        fs.renameSync(`${file}.new`, file);
      }
      return open(target, flags);
    }) as typeof fs.promises.open);
    const write = files.writeInPlace(project, located('src/a.ts'), Buffer.from('mine'));
    await expect(write).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(write).rejects.toMatchObject({ refusal: 'replaced' });
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
  });

  it('refuses a path that no longer names the file the editor opened', async () => {
    fs.writeFileSync(path.join(project.fsPath, 'src', 'b.ts'), 'b');
    await expect(files.writeInPlace(project, { ...located('src/a.ts'), path: path.join(project.fsPath, 'src', 'b.ts') }, Buffer.from('x'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(path.join(project.fsPath, 'src', 'b.ts'), 'utf8')).toBe('b');
  });

  it('creates a missing file exclusively, with any folder deleted with it', async () => {
    await files.writeInPlace(project, located('gone/deeper/c.ts'), Buffer.from('back'));
    expect(fs.readFileSync(path.join(project.fsPath, 'gone', 'deeper', 'c.ts'), 'utf8')).toBe('back');
  });
});

describe('the host\'s own settings file', () => {
  let home: string;
  let settings: string;
  const text = (read: Awaited<ReturnType<WorkspaceFileSystem['readHostSettings']>>['read']): string | undefined => (read.kind === 'bytes' ? read.bytes.toString('utf8') : undefined);

  beforeEach(() => {
    home = path.join(root, 'home', '.damocles');
    settings = path.join(home, 'settings.json');
    fs.mkdirSync(home, { recursive: true });
  });

  it('reads ~/.damocles/settings.json and writes it in place, creating it when missing', async () => {
    expect(await files.readHostSettings()).toEqual({ path: settings, read: { kind: 'missing' } });
    await files.writeHostSettings(Buffer.from('{}'));
    const created = fs.statSync(settings, { bigint: true }).ino;
    await files.writeHostSettings(Buffer.from('{ "damocles.maxBudgetUsd": 3 }'));
    expect(fs.statSync(settings, { bigint: true }).ino).toBe(created);
    const read = await files.readHostSettings();
    expect(read.path).toBe(settings);
    expect(text(read.read)).toBe('{ "damocles.maxBudgetUsd": 3 }');
  });

  it('refuses a settings.json that links to any other file, outside ~/.damocles or beside it', async () => {
    const outsideFile = path.join(root, 'outside.txt');
    fs.symlinkSync(outsideFile, settings, 'file');
    expect((await files.readHostSettings()).read).toEqual({ kind: 'outside' });
    await expect(files.writeHostSettings(Buffer.from('{}'))).rejects.toMatchObject({ refusal: 'outsideProject' });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside');

    fs.rmSync(settings);
    const mcp = path.join(home, 'mcp.json');
    fs.writeFileSync(mcp, '{ "mcpServers": {} }');
    fs.symlinkSync(mcp, settings, 'file');
    expect((await files.readHostSettings()).read).toEqual({ kind: 'outside' });
    await expect(files.writeHostSettings(Buffer.from('{}'))).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(mcp, 'utf8')).toBe('{ "mcpServers": {} }');
  });

  it('names the file in the real ~/.damocles when that folder is itself a link', async () => {
    fs.rmSync(home, { recursive: true });
    const real = path.join(root, 'dotfiles', 'damocles');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, home, 'junction');
    await files.writeHostSettings(Buffer.from('{}'));
    expect(fs.readFileSync(path.join(real, 'settings.json'), 'utf8')).toBe('{}');
    expect((await files.readHostSettings()).path).toBe(path.join(real, 'settings.json'));
  });
});

describe('the folder browser', () => {
  it('offers a folder a link leads to, as a ~/work link would be, and neither a file nor a link that leads nowhere', async () => {
    fs.symlinkSync(project.fsPath, path.join(root, 'linked'), 'junction');
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(root, 'dangling'), 'junction');
    fs.rmSync(gone, { recursive: true });
    const listed = await files.browse(root);
    if (!listed.ok) throw new Error(listed.reason);
    expect([...listed.folders].sort()).toEqual(['linked', 'proj']);
  });
});
