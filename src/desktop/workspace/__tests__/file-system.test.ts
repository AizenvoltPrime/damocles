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

describe('files outside every project', () => {
  let plans: string;
  let plan: string;
  const PLANS = { within: 'plans' } as const;

  beforeEach(() => {
    plans = path.join(root, 'home', '.damocles', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    plan = path.join(plans, 'fix-it-0123abcd.md');
    fs.writeFileSync(plan, '# Plan\n');
  });

  it('resolves a file or a folder to its realpath and answers missing for neither', async () => {
    expect(await files.resolveOutside(path.join(root, 'outside.txt'), {})).toEqual({ kind: 'file', path: path.join(root, 'outside.txt') });
    expect(await files.resolveOutside(path.join(root, 'proj'), {})).toEqual({ kind: 'folder', path: path.join(root, 'proj') });
    expect(await files.resolveOutside(path.join(root, 'gone.txt'), {})).toEqual({ kind: 'missing' });
    expect(await files.resolveOutside(path.join(root, 'outside.txt', 'below'), {})).toEqual({ kind: 'missing' });
    fs.symlinkSync(path.join(root, 'proj'), path.join(root, 'linked'), 'junction');
    expect(await files.resolveOutside(path.join(root, 'linked', 'src', 'a.ts'), {})).toEqual({ kind: 'file', path: path.join(project.fsPath, 'src', 'a.ts') });
  });

  it('refuses a relative path, NUL, a dot segment, and on Windows a UNC, device, drive-relative or root-relative path, a stream or a device name, before any file system call', async () => {
    const calls = (['realpath', 'lstat', 'stat', 'open', 'readlink'] as const).map((name) => vi.spyOn(fs.promises, name));
    const windowsOnly = process.platform === 'win32'
      ? ['\\\\server\\share\\a.md', '//server/share/a.md', '\\\\?\\C:\\a.md', '\\\\.\\pipe\\a.md', 'C:a.md', '\\a.md', '/a.md', `${plans}\\CON.md`, `${plan}:stream.md`, `${plans}\\x.md.`]
      : [];
    const dotted = [`${plans}${path.sep}.${path.sep}a.md`, `${plans}${path.sep}..${path.sep}plans${path.sep}${path.basename(plan)}`];
    for (const target of [...windowsOnly, ...dotted, 'a.md', 'plans/a.md', `${plan}\0`]) {
      expect(await files.resolveOutside(target, PLANS), target).toEqual({ kind: 'outside' });
      expect(await files.resolveOutside(target, {}), target).toEqual({ kind: 'outside' });
      expect(await files.readOutside(target, {}), target).toEqual({ kind: 'outside' });
      await expect(files.writeOutside(target, Buffer.from('x'), {}), target).rejects.toMatchObject({ refusal: 'outsideFile' });
    }
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(fs.readFileSync(plan, 'utf8')).toBe('# Plan\n');
  });

  it('accepts a .md file below the plans folder, and refuses a .txt there, the folder itself, a link out of it and a hard link', async () => {
    expect(await files.resolveOutside(plan, PLANS)).toEqual({ kind: 'file', path: plan });
    fs.writeFileSync(path.join(plans, 'notes.txt'), 'x');
    expect(await files.resolveOutside(path.join(plans, 'notes.txt'), PLANS)).toEqual({ kind: 'outside' });
    expect(await files.resolveOutside(plans, PLANS)).toEqual({ kind: 'outside' });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'evil.md'), 'evil');
    fs.symlinkSync(elsewhere, path.join(plans, 'out'), 'junction');
    expect(await files.resolveOutside(path.join(plans, 'out', 'evil.md'), PLANS)).toEqual({ kind: 'outside' });
    expect(await files.readOutside(path.join(elsewhere, 'evil.md'), PLANS)).toEqual({ kind: 'outside' });
    fs.symlinkSync(path.join(elsewhere, 'evil.md'), path.join(plans, 'linked.md'), 'file');
    expect(await files.resolveOutside(path.join(plans, 'linked.md'), PLANS)).toEqual({ kind: 'outside' });
    fs.linkSync(path.join(elsewhere, 'evil.md'), path.join(plans, 'hard.md'));
    expect(await files.resolveOutside(path.join(plans, 'hard.md'), PLANS)).toEqual({ kind: 'outside' });
    expect(await files.readOutside(path.join(plans, 'hard.md'), PLANS)).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(path.join(plans, 'hard.md'), Buffer.from('x'), PLANS)).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(path.join(elsewhere, 'evil.md'), 'utf8')).toBe('evil');
    // without the rule the same file outside every project resolves
    expect(await files.resolveOutside(path.join(plans, 'out', 'evil.md'), {})).toEqual({ kind: 'file', path: path.join(elsewhere, 'evil.md') });
  });

  it('reads and writes a file only while its path is still its realpath', async () => {
    const read = await files.readOutside(plan, PLANS);
    expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('# Plan\n');
    const other = path.join(plans, 'other.md');
    fs.writeFileSync(other, 'other');
    fs.rmSync(plan);
    fs.symlinkSync(other, plan, 'file');
    expect(await files.readOutside(plan, PLANS)).toEqual({ kind: 'outside' });
    expect(await files.readOutside(plan, {})).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(plan, Buffer.from('mine'), PLANS)).rejects.toMatchObject({ refusal: 'outsideFile' });
    await expect(files.writeOutside(plan, Buffer.from('mine'), {})).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(other, 'utf8')).toBe('other');
  });

  it('writes in place, keeping the inode and the mode, with the plans rule or without it', async () => {
    if (process.platform !== 'win32') fs.chmodSync(plan, 0o640);
    const before = fs.statSync(plan, { bigint: true });
    expect(typeof (await files.writeOutside(plan, Buffer.from('# Edited\n'), PLANS))).toBe('number');
    const after = fs.statSync(plan, { bigint: true });
    expect(after.ino).toBe(before.ino);
    if (process.platform !== 'win32') expect(after.mode & 0o777n).toBe(0o640n);
    expect(fs.readFileSync(plan, 'utf8')).toBe('# Edited\n');
    await files.writeOutside(path.join(root, 'outside.txt'), Buffer.from('changed'), {});
    expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('changed');
    await expect(files.writeOutside(path.join(root, 'outside.txt'), Buffer.from('x'), PLANS)).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('changed');
  });

  it('writes a file outside the plans folder in place without the plans rule, keeping its inode, its hard link and its mode', async () => {
    const folder = path.join(root, 'docs');
    fs.mkdirSync(folder);
    const file = path.join(folder, 'notes.txt');
    fs.writeFileSync(file, 'notes');
    const hard = path.join(root, 'hard.txt');
    fs.linkSync(file, hard);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
    const before = fs.statSync(file, { bigint: true });
    expect(await files.resolveOutside(file, {})).toEqual({ kind: 'file', path: file });
    expect(typeof (await files.writeOutside(file, Buffer.from('mine'), {}))).toBe('number');
    const after = fs.statSync(file, { bigint: true });
    expect(after.ino).toBe(before.ino);
    if (process.platform !== 'win32') expect(after.mode & 0o777n).toBe(0o640n);
    expect(fs.readFileSync(hard, 'utf8')).toBe('mine');
    const read = await files.readOutside(file, {});
    expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('mine');
  });

  it.each([['a junction', 'junction' as const], ['a directory link', 'dir' as const]])('refuses a file once a folder on its path became %s, writing nothing where it leads', async (_name, type) => {
    const folder = path.join(root, 'docs');
    fs.mkdirSync(folder);
    const file = path.join(folder, 'notes.txt');
    fs.writeFileSync(file, 'notes');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'notes.txt'), 'elsewhere');
    fs.renameSync(folder, path.join(root, 'docs-moved'));
    fs.symlinkSync(elsewhere, folder, type);
    expect(await files.readOutside(file, {})).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(file, Buffer.from('mine'), {})).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(path.join(elsewhere, 'notes.txt'), 'utf8')).toBe('elsewhere');
    // a file gone from behind the link is never created there either
    fs.rmSync(path.join(elsewhere, 'notes.txt'));
    await expect(files.writeOutside(file, Buffer.from('mine'), {})).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'docs-moved', 'notes.txt'), 'utf8')).toBe('notes');
  });

  it('refuses a file another one replaced between the identity check and the open, and leaves the newcomer alone', async () => {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') {
        fs.writeFileSync(`${plan}.new`, 'someone else');
        fs.renameSync(`${plan}.new`, plan);
      }
      return open(target, flags);
    }) as typeof fs.promises.open);
    await expect(files.writeOutside(plan, Buffer.from('mine'), PLANS)).rejects.toMatchObject({ refusal: 'replaced' });
    expect(fs.readFileSync(plan, 'utf8')).toBe('someone else');
  });

  it('refuses a plan that gained a hard link between the check and the open', async () => {
    const open = fs.promises.open.bind(fs.promises);
    const shared = path.join(root, 'shared.md');
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') fs.linkSync(plan, shared);
      return open(target, flags);
    }) as typeof fs.promises.open);
    await expect(files.writeOutside(plan, Buffer.from('mine'), PLANS)).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readFileSync(shared, 'utf8')).toBe('# Plan\n');
  });

  it('refuses a plan replaced by a link that leads nowhere, creating nothing where it leads', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(plan);
    fs.symlinkSync(path.join(elsewhere, 'missing.md'), plan, 'file');
    const open = vi.spyOn(fs.promises, 'open');
    await expect(files.writeOutside(plan, Buffer.from('mine'), PLANS)).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a write whose path was swapped to a link, back, and to the link again around its checks', async () => {
    const elsewhere = path.join(root, 'elsewhere.md');
    fs.writeFileSync(elsewhere, 'elsewhere');
    const toLink = (): void => {
      fs.rmSync(plan);
      fs.symlinkSync(elsewhere, plan, 'file');
    };
    const stat = fs.promises.stat.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (swapped || String(target) !== plan || options?.bigint !== true) return stat(target, options);
      swapped = true;
      // the identity is the link's target, and the path is a plain plan again for the realpath and the plans rule
      toLink();
      const linked = await stat(target, options);
      fs.rmSync(plan);
      fs.writeFileSync(plan, '# Plan\n');
      return linked;
    }) as typeof fs.promises.stat);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
      if (flags === 'r+') toLink();
      return open(target, flags);
    }) as typeof fs.promises.open);
    await expect(files.writeOutside(plan, Buffer.from('mine'), PLANS)).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(swapped).toBe(true);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('elsewhere');
  });

  it('answers missing for a plan deleted before its identity stat, and a write refuses one deleted before the plans rule\'s stat as replaced', async () => {
    const stat = fs.promises.stat.bind(fs.promises);
    let deleteAt: 'bigint' | 'number' = 'bigint';
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (String(target) === plan && (options?.bigint === true ? 'bigint' : 'number') === deleteAt) fs.rmSync(plan, { force: true });
      return stat(target, options);
    }) as typeof fs.promises.stat);
    expect(await files.readOutside(plan, PLANS)).toEqual({ kind: 'missing' });
    fs.writeFileSync(plan, '# Plan\n');
    deleteAt = 'number';
    await expect(files.writeOutside(plan, Buffer.from('mine'), PLANS)).rejects.toMatchObject({ refusal: 'replaced' });
  });

  describe('a read from the one handle its checks lead to', () => {
    // every handle an open returned, and whether it was closed
    let handles: Array<{ closed: boolean }>;
    // runs once, right before the read's open of plan
    let beforeOpen: (() => void) | undefined;

    beforeEach(() => {
      handles = [];
      beforeOpen = undefined;
      const open = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number) => {
        if (String(target) === plan && flags === 'r' && beforeOpen) {
          const swap = beforeOpen;
          beforeOpen = undefined;
          swap();
        }
        const handle = await open(target, flags);
        const record = { closed: false };
        handles.push(record);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          record.closed = true;
          await close();
        };
        return handle;
      }) as typeof fs.promises.open);
    });

    const allClosed = (): boolean => handles.every((handle) => handle.closed);

    it('reads the file through the handle it checked, closing it', async () => {
      const read = await files.readOutside(plan, PLANS);
      expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('# Plan\n');
      expect(handles).toHaveLength(1);
      expect(allClosed()).toBe(true);
    });

    it.each([['with the plans rule', { within: 'plans' } as const], ['without it', {} as const]])('refuses a file another one replaced between its checks and the open %s, returning none of the newcomer\'s text', async (_name, rule) => {
      beforeOpen = () => {
        fs.writeFileSync(`${plan}.new`, 'someone else');
        fs.renameSync(`${plan}.new`, plan);
      };
      expect(await files.readOutside(plan, rule)).toEqual({ kind: 'outside' });
      expect(handles).toHaveLength(1);
      expect(allClosed()).toBe(true);
    });

    it('refuses a plan that gained a hard link between its checks and the open, and reads the same file without the plans rule', async () => {
      const shared = path.join(root, 'shared.md');
      beforeOpen = () => fs.linkSync(plan, shared);
      expect(await files.readOutside(plan, PLANS)).toEqual({ kind: 'outside' });
      expect(allClosed()).toBe(true);
      const read = await files.readOutside(plan, {});
      expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('# Plan\n');
      expect(allClosed()).toBe(true);
    });

    it('refuses a path swapped to a link around its identity stat, back for the realpath, and to the link again for the open', async () => {
      const elsewhere = path.join(root, 'elsewhere.md');
      fs.writeFileSync(elsewhere, 'elsewhere');
      const toLink = (): void => {
        fs.rmSync(plan);
        fs.symlinkSync(elsewhere, plan, 'file');
      };
      const stat = fs.promises.stat.bind(fs.promises);
      let swapped = false;
      vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
        if (swapped || String(target) !== plan || options?.bigint !== true) return stat(target, options);
        swapped = true;
        toLink();
        const linked = await stat(target, options);
        fs.rmSync(plan);
        fs.writeFileSync(plan, '# Plan\n');
        return linked;
      }) as typeof fs.promises.stat);
      beforeOpen = toLink;
      expect(await files.readOutside(plan, {})).toEqual({ kind: 'outside' });
      expect(swapped).toBe(true);
      expect(allClosed()).toBe(true);
    });

    it('opens no FIFO, folder or device: a path that is no regular file answers before any open', async () => {
      expect(await files.readOutside(plans, {})).toEqual({ kind: 'notAFile', folder: true });
      expect(handles).toEqual([]);
    });
  });

  it('creates a missing file exclusively, only in a folder that resolves to itself, and never a folder', async () => {
    fs.rmSync(plan);
    await files.writeOutside(plan, Buffer.from('# Back\n'), PLANS);
    expect(fs.readFileSync(plan, 'utf8')).toBe('# Back\n');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(plans, 'sub'), 'junction');
    await expect(files.writeOutside(path.join(plans, 'sub', 'new.md'), Buffer.from('x'), {})).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    await expect(files.writeOutside(path.join(plans, 'gone', 'new.md'), Buffer.from('x'), PLANS)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(path.join(plans, 'gone'))).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('files outside every project behind links to UNC and device paths (win32)', () => {
  // folderKey of a link -> what readlink answers for it; a realpath or stat at or under such a link, or of a UNC or device
  // path, is recorded and throws instead of reaching the network
  let fakeTargets: Map<string, string>;
  let followed: string[];

  beforeEach(() => {
    fakeTargets = new Map();
    followed = [];
    const follows = (file: string): boolean => /^[\\/]{2}/.test(file) || [...fakeTargets.keys()].some((link) => folderKey(file).startsWith(link));
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(folderKey(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (file: fs.PathLike) => {
      if (follows(String(file))) {
        followed.push(String(file));
        throw new Error(`followed ${String(file)}`);
      }
      return realpath(file);
    }) as typeof fs.promises.realpath);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      if (follows(String(file))) {
        followed.push(String(file));
        throw new Error(`followed ${String(file)}`);
      }
      return stat(file, options);
    }) as typeof fs.promises.stat);
  });

  it.each([['\\\\server\\share'], ['\\\\?\\UNC\\server\\share'], ['\\\\.\\pipe\\x'], ['\\??\\UNC\\server\\share'], ['D:x']])('refuses a link in the plans folder to %j without following it', async (target) => {
    const plans = path.join(root, 'home', '.damocles', 'plans');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.mkdirSync(plans, { recursive: true });
    // a real junction, which lstat sees as a link and which needs no privilege, whose readlink answers target
    const link = path.join(plans, 'share');
    fs.symlinkSync(path.join(root, 'real'), link, 'junction');
    fakeTargets.set(folderKey(link), target);
    const named = path.join(link, 'a.md');
    expect(await files.resolveOutside(named, { within: 'plans' })).toEqual({ kind: 'outside' });
    expect(await files.resolveOutside(named, {})).toEqual({ kind: 'outside' });
    expect(await files.readOutside(named, { within: 'plans' })).toEqual({ kind: 'outside' });
    await expect(files.writeOutside(named, Buffer.from('x'), { within: 'plans' })).rejects.toMatchObject({ refusal: 'outsideFile' });
    expect(followed).toEqual([]);
  });

  it('refuses a plans folder that is itself a link to a share, without following it', async () => {
    const home = path.join(root, 'home', '.damocles');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const plans = path.join(home, 'plans');
    fs.symlinkSync(path.join(root, 'real'), plans, 'junction');
    fs.writeFileSync(path.join(root, 'outside.md'), 'x');
    fakeTargets.set(folderKey(plans), '\\\\server\\share');
    expect(await files.resolveOutside(path.join(root, 'outside.md'), { within: 'plans' })).toEqual({ kind: 'outside' });
    expect(followed).toEqual([]);
  });
});
