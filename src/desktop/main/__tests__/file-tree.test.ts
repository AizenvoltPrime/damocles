import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { FileEntry, FilesChanged } from '../../preload/shell-channels';
import { DEFAULT_FILES_EXCLUDE } from '../desktop-configuration';
import type { Project } from '../documents/confine';
import { compareEntries, FileTree } from '../files/file-tree';
import { fileNameProblem, isValidFileName } from '../../preload/file-names';
import type { MessageQuestion } from '../message-dialog';

let root: string;
let projectDir: string;
let outside: string;
let project: Project;
let platform: FakePlatform;
let trashed: string[];
let revealed: string[];
let copied: string[];
let answer: number | undefined;
// answered first, in order, before answer
let answers: Array<number | undefined>;
let asked: MessageQuestion[];
let trashFailure: string | undefined;
let removed: string[];
let removeFailure: string | undefined;
let exclude: Record<string, unknown>;
let changed: FilesChanged[];
let tree: FileTree;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-files-')));
  projectDir = path.join(root, 'proj');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  platform = createFakePlatform();
  trashed = [];
  revealed = [];
  copied = [];
  answer = 0;
  answers = [];
  asked = [];
  trashFailure = undefined;
  removed = [];
  removeFailure = undefined;
  exclude = { ...DEFAULT_FILES_EXCLUDE };
  changed = [];
  tree = new FileTree({
    projects: () => [project],
    exclude: () => exclude,
    watchers: platform.fileWatchers,
    ask: async (question) => {
      asked.push(question);
      return answers.length > 0 ? answers.shift() : answer;
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    log: () => undefined,
    trash: async (target) => {
      if (trashFailure !== undefined) throw new Error(trashFailure);
      trashed.push(target);
      fs.rmSync(target, { recursive: true, force: true });
    },
    remove: async (target) => {
      if (removeFailure !== undefined) throw new Error(removeFailure);
      removed.push(target);
      fs.rmSync(target, { recursive: true });
    },
    reveal: async (target) => { revealed.push(target); },
    copy: async (text) => { copied.push(text); },
    changed: (change) => changed.push(change),
  });
});

afterEach(() => {
  tree.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(relativePath: string): void {
  const file = path.join(projectDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

describe('listing', () => {
  it('lists folders first, then files, in VS Code order, without files.exclude matches', async () => {
    for (const name of ['b.ts', 'a10.ts', 'a2.ts', 'Thumbs.db', '.gitignore']) touch(name);
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.mkdirSync(path.join(projectDir, 'docs'));
    const result = await tree.list(project.key, '');
    expect(result).toEqual({ ok: true, entries: [
      { name: 'docs', kind: 'dir' },
      { name: 'src', kind: 'dir' },
      { name: '.gitignore', kind: 'file' },
      { name: 'a2.ts', kind: 'file' },
      { name: 'a10.ts', kind: 'file' },
      { name: 'b.ts', kind: 'file' },
    ] });
  });

  it('shows a pattern turned off, and hides a new one, on the next listing', async () => {
    fs.mkdirSync(path.join(projectDir, '.git'));
    touch('src/gen.ts');
    exclude = { ...DEFAULT_FILES_EXCLUDE, '**/.git': false, '**/gen.ts': true };
    expect(await tree.list(project.key, '')).toMatchObject({ entries: expect.arrayContaining([{ name: '.git', kind: 'dir' }]) });
    expect(await tree.list(project.key, 'src')).toEqual({ ok: true, entries: [] });
  });

  it('lists a link by what it points to, and refuses to list a folder link that leads outside', async () => {
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    expect(await tree.list(project.key, '')).toMatchObject({ entries: expect.arrayContaining([{ name: 'out', kind: 'dir' }]) });
    expect(await tree.list(project.key, 'out')).toEqual({ ok: false, reason: 'outside' });
  });

  it.runIf(process.platform === 'win32')('lists a link to a UNC share as a file without following it', async () => {
    const link = path.join(projectDir, 'share');
    fs.symlinkSync(outside, link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (folderKey(String(file)) === folderKey(link) ? '\\\\server\\share' : readlink(file))) as typeof fs.promises.readlink);
    const lstatOf = fs.promises.lstat.bind(fs.promises);
    const remote: string[] = [];
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      if (String(file).startsWith('\\\\')) {
        remote.push(String(file));
        throw new Error('network');
      }
      return lstatOf(file, options);
    }) as typeof fs.promises.lstat);
    const stat = vi.spyOn(fs.promises, 'stat');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    try {
      expect(await tree.list(project.key, '')).toMatchObject({ entries: expect.arrayContaining([{ name: 'share', kind: 'file' }]) });
      expect(await tree.list(project.key, 'share')).toEqual({ ok: false, reason: 'outside' });
      expect(remote).toEqual([]);
      expect(stat).not.toHaveBeenCalled();
      expect(realpath.mock.calls.map(([file]) => String(file))).not.toContain(link);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([['..'], ['../outside'], ['src/../..'], ['/'], ['C:'], ['src\\x']])('refuses the directory %j', async (relativeDir) => {
    expect(await tree.list(project.key, relativeDir)).toEqual({ ok: false, reason: 'outside' });
  });

  it('refuses a project main does not list', async () => {
    expect(await tree.list(folderKey(outside), '')).toEqual({ ok: false, reason: 'outside' });
  });
});

describe('create and rename', () => {
  it('creates a file and a folder, never over an existing entry', async () => {
    expect(await tree.create(project.key, 'src', 'new.ts', 'file')).toEqual({ ok: true, relativePath: 'src/new.ts' });
    expect(await tree.create(project.key, '', 'lib', 'dir')).toEqual({ ok: true, relativePath: 'lib' });
    fs.writeFileSync(path.join(projectDir, 'src', 'new.ts'), 'kept');
    expect(await tree.create(project.key, 'src', 'new.ts', 'file')).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(path.join(projectDir, 'src', 'new.ts'), 'utf8')).toBe('kept');
  });

  it('refuses a rename onto an existing file, which fs.rename would replace on Windows, but allows a case-only rename', async () => {
    touch('a.ts');
    fs.writeFileSync(path.join(projectDir, 'b.ts'), 'other');
    expect(await tree.rename(project.key, 'a.ts', 'b.ts')).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(path.join(projectDir, 'b.ts'), 'utf8')).toBe('other');
    expect(await tree.rename(project.key, 'a.ts', 'A.ts')).toEqual({ ok: true, relativePath: 'A.ts' });
    expect(fs.readdirSync(projectDir)).toContain('A.ts');
  });

  it('renames a link itself, never what it points to', async () => {
    fs.writeFileSync(path.join(outside, 'target.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'target.txt'), path.join(projectDir, 'link.txt'), 'file');
    expect(await tree.rename(project.key, 'link.txt', 'renamed.txt')).toEqual({ ok: true, relativePath: 'renamed.txt' });
    expect(fs.existsSync(path.join(outside, 'target.txt'))).toBe(true);
    expect(fs.lstatSync(path.join(projectDir, 'renamed.txt')).isSymbolicLink()).toBe(true);
  });

  it.each([['a/b'], ['..'], ['.'], ['a\\b'], ['x\0'], ['a'.repeat(256)], [' lead']])('refuses the name %j', async (name) => {
    expect(await tree.create(project.key, '', name, 'file')).toEqual({ ok: false, reason: 'invalidName' });
  });

  it('refuses Windows device names, streams and trailing dots or spaces on win32 only', () => {
    for (const name of ['CON', 'nul.txt', 'COM1.log', 'lpt9', 'a:b', 'trail.', 'trail ']) expect(isValidFileName(name, 'win32'), name).toBe(false);
    expect(isValidFileName('CON', 'linux')).toBe(true);
    expect(isValidFileName('console.ts', 'win32')).toBe(true);
  });

  it('names what is wrong with a typed name: empty, invalid, or a sibling\'s, ignoring case on Windows and macOS only', () => {
    const siblings = ['README.md', 'src'];
    expect(fileNameProblem('', siblings, 'win32')).toBe('empty');
    expect(fileNameProblem('a/b', siblings, 'linux')).toBe('invalidName');
    expect(fileNameProblem('CON', siblings, 'win32')).toBe('invalidName');
    expect(fileNameProblem('src', siblings, 'linux')).toBe('exists');
    expect(fileNameProblem('readme.MD', siblings, 'win32')).toBe('exists');
    expect(fileNameProblem('readme.MD', siblings, 'darwin')).toBe('exists');
    expect(fileNameProblem('readme.MD', siblings, 'linux')).toBeUndefined();
    expect(fileNameProblem('notes.txt', siblings, 'win32')).toBeUndefined();
  });
});

describe('delete, reveal and copy', () => {
  it('asks first, then moves the entry to the trash', async () => {
    touch('src/old.ts');
    answer = undefined;
    expect(await tree.delete(project.key, 'src/old.ts')).toEqual({ ok: false, reason: 'cancelled' });
    expect(trashed).toEqual([]);
    answer = 0;
    expect(await tree.delete(project.key, 'src/old.ts')).toEqual({ ok: true });
    expect(trashed).toEqual([path.join(projectDir, 'src', 'old.ts')]);
  });

  it('trashes a junction itself, never the folder outside it points to', async () => {
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    expect(await tree.delete(project.key, 'out')).toEqual({ ok: true });
    expect(trashed).toEqual([path.join(projectDir, 'out')]);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('refuses to delete the project itself or anything outside it', async () => {
    expect(await tree.delete(project.key, '')).toEqual({ ok: false, reason: 'outside' });
    expect(await tree.delete(project.key, '../outside')).toEqual({ ok: false, reason: 'outside' });
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
    expect(await tree.delete(project.key, 'out/f.txt')).toEqual({ ok: false, reason: 'outside' });
    expect(trashed).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('refuses names Win32 resolves elsewhere, so a folder named ".. " never trashes its parent', async () => {
    for (const relativePath of ['src/.. ', 'src/...', 'src/a.', 'src/CON', 'src/a:b']) {
      expect(await tree.delete(project.key, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
      expect(await tree.rename(project.key, relativePath, 'x'), relativePath).toEqual({ ok: false, reason: 'outside' });
      expect(await tree.list(project.key, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
    }
    expect(trashed).toEqual([]);
  });

  it('offers Delete Permanently when the trash fails, deletes only after that confirmation, and reports a failure of either', async () => {
    touch('src/locked.ts');
    const file = path.join(projectDir, 'src', 'locked.ts');
    trashFailure = 'The Recycle Bin is not available';
    answers = [0, undefined];
    expect(await tree.delete(project.key, 'src/locked.ts')).toEqual({ ok: false, reason: 'cancelled' });
    expect(fs.existsSync(file)).toBe(true);
    expect(asked[1]).toMatchObject({ severity: 'danger', actions: ['Delete Permanently'], cancelLabel: 'Cancel' });
    expect(asked[1]!.message).toContain('locked.ts');
    expect(asked[1]!.detail).toContain('The Recycle Bin is not available');

    asked = [];
    answers = [0, 0];
    removeFailure = 'EBUSY: resource busy or locked';
    expect(await tree.delete(project.key, 'src/locked.ts')).toEqual({ ok: false, reason: 'failed', message: 'EBUSY: resource busy or locked' });
    expect(fs.existsSync(file)).toBe(true);

    answers = [0, 0];
    removeFailure = undefined;
    expect(await tree.delete(project.key, 'src/locked.ts')).toEqual({ ok: true });
    expect(removed).toEqual([file]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('deletes a junction itself permanently, never the folder outside it points to', async () => {
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    trashFailure = 'no trash';
    answers = [0, 0];
    expect(await tree.delete(project.key, 'out')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(projectDir, 'out'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('refuses to delete permanently an entry that another one replaced while it asked', async () => {
    touch('src/a.ts');
    const file = path.join(projectDir, 'src', 'a.ts');
    trashFailure = 'no trash';
    let calls = 0;
    tree = new FileTree({
      projects: () => [project], exclude: () => exclude, watchers: platform.fileWatchers, t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])), log: () => undefined,
      ask: async () => {
        if (++calls === 2) {
          fs.writeFileSync(`${file}.new`, 'someone else');
          fs.renameSync(`${file}.new`, file);
        }
        return 0;
      },
      trash: async () => { throw new Error('no trash'); },
      remove: async (target) => { removed.push(target); },
      reveal: async () => undefined, copy: async () => undefined, changed: () => undefined,
    });
    expect(await tree.delete(project.key, 'src/a.ts')).toMatchObject({ ok: false, reason: 'failed' });
    expect(removed).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
  });

  it('resolves a failed reveal or copy, and a reveal of an entry that is gone, as a failure instead of throwing', async () => {
    expect(await tree.reveal(project.key, 'src/gone.ts')).toEqual({ ok: false, reason: 'missing' });
    expect(await tree.copyPath('removed-project', 'src/a.ts', false)).toEqual({ ok: false, reason: 'missing' });
    touch('src/a.ts');
    tree = new FileTree({
      projects: () => [project], exclude: () => exclude, watchers: platform.fileWatchers, ask: async () => 0, t: (message) => message, log: () => undefined,
      trash: async () => undefined, remove: async () => undefined,
      reveal: async () => { throw new Error('no file manager'); },
      copy: async () => { throw new Error('clipboard busy'); },
      changed: () => undefined,
    });
    expect(await tree.reveal(project.key, 'src/a.ts')).toEqual({ ok: false, reason: 'failed', message: 'no file manager' });
    expect(await tree.copyPath(project.key, 'src/a.ts', true)).toEqual({ ok: false, reason: 'failed', message: 'clipboard busy' });
  });

  it('reveals and copies paths of the project', async () => {
    touch('src/a.ts');
    expect(await tree.reveal(project.key, 'src/a.ts')).toEqual({ ok: true });
    expect(await tree.copyPath(project.key, 'src/a.ts', false)).toEqual({ ok: true });
    expect(await tree.copyPath(project.key, 'src/a.ts', true)).toEqual({ ok: true });
    expect(revealed).toEqual([path.join(projectDir, 'src', 'a.ts')]);
    expect(copied).toEqual([path.join(projectDir, 'src', 'a.ts'), path.join('src', 'a.ts')]);
  });
});

describe('watching', () => {
  it('reports the parent folders of created and deleted entries once per burst, skipping excluded ones', async () => {
    await tree.list(project.key, '');
    let structural = 0;
    tree.onDidChangeStructure(() => structural++);
    const watcher = platform.fileWatchers.watcher(projectDir, '**');
    watcher.fireCreate(path.join(projectDir, 'src', 'x.ts'));
    watcher.fireDelete(path.join(projectDir, 'y.ts'));
    watcher.fireCreate(path.join(projectDir, '.git', 'index'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changed).toEqual([{ projectKey: project.key, relativeDirs: ['src', ''] }]);
    expect(structural).toBe(1);
  });

  it('asks every watched project to refetch when files.exclude changes', async () => {
    await tree.list(project.key, '');
    tree.excludeChanged();
    expect(changed).toEqual([{ projectKey: project.key, relativeDirs: [] }]);
  });

  it('orders folders before files and numbers numerically', () => {
    const entries: FileEntry[] = [{ name: 'b', kind: 'file' }, { name: 'z', kind: 'dir' }, { name: 'a10', kind: 'file' }, { name: 'a9', kind: 'file' }];
    expect(entries.sort(compareEntries).map((entry) => entry.name)).toEqual(['z', 'a9', 'a10', 'b']);
  });
});
