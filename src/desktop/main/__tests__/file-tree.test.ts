import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { FileEntry, FilesChanged } from '../../preload/shell-channels';
import { DEFAULT_FILES_EXCLUDE } from '../../local-services/desktop-configuration';
import type { Project } from '../../local-services/confine';
import { compareEntries, FileTree, type FileTreeDeps } from '../files/file-tree';
import { testRemote, testWorkspaces } from './test-workspaces';
import type { Workspaces } from '../workspace/workspaces';
import type { FolderListing } from '../../workspace/tree-listing';
import { projectKeyOf } from '../../../shared/project-location';
import { LocalizedError } from '../../../shared/localized-text';
import type { FileSystemDeps } from '../../workspace/file-system';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { fileNameProblem, isValidFileName } from '../../preload/file-names';
import type { MessageQuestion } from '../message-dialog';

let root: string;
let projectDir: string;
let outside: string;
let project: Project;
let platform: FakePlatform;
let trashed: string[];
let revealed: string[];
// what the next reveal rejects with, as a Reveal check that could not run does
let revealError: Error | undefined;
let copied: string[];
let answer: number | undefined;
let host: string | undefined;
let wslDistro: string | undefined;
// answered first, in order, before answer
let answers: Array<number | undefined>;
let asked: MessageQuestion[];
let trashFailure: string | undefined;
let removed: string[];
let removeFailure: string | undefined;
let exclude: Record<string, unknown>;
let changed: FilesChanged[];
let tree: FileTree;
// the workspaces of the last tree fileTree built
let workspaces: Workspaces;

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
  revealError = undefined;
  copied = [];
  answer = 0;
  host = undefined;
  wslDistro = undefined;
  answers = [];
  asked = [];
  trashFailure = undefined;
  removed = [];
  removeFailure = undefined;
  exclude = { ...DEFAULT_FILES_EXCLUDE };
  changed = [];
  tree = fileTree({
    projects: () => [project],
    exclude: () => exclude,
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
    reveal: async (target) => {
      if (revealError) throw revealError;
      revealed.push(target);
    },
    copy: async (text) => { copied.push(text); },
    changed: (change) => changed.push(change),
    ignored: async () => new Set(), target: () => ({ os: process.platform, ...(host !== undefined ? { host } : {}), ...(wslDistro !== undefined ? { wslDistro } : {}) }),
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


// The project's watch refetches every listing once it is ready; drained so a test sees only what follows.
async function untilWatchReady(): Promise<void> {
  await vi.waitFor(() => expect(changed).toContainEqual({ projectKey: project.key, relativeDirs: [] }));
  changed.length = 0;
}

// The fake watchers, each of whose ready settles only when the test opens its gate, in creation order.
function gatedWatchers(): { readonly watchers: FileWatcherFactory; readonly gates: Array<() => void> } {
  const gates: Array<() => void> = [];
  const fakes = platform.fileWatchers;
  return {
    gates,
    watchers: {
      watch: (base, glob) => {
        const inner = fakes.watch(base, glob);
        let open = (): void => undefined;
        const ready = new Promise<void>((resolve) => {
          open = resolve;
        });
        gates.push(open);
        return { ready, onDidCreate: (cb) => inner.onDidCreate(cb), onDidChange: (cb) => inner.onDidChange(cb), onDidDelete: (cb) => inner.onDidDelete(cb), dispose: () => inner.dispose() };
      },
      watchWorkspace: (glob) => fakes.watchWorkspace(glob),
      onDidRenameFiles: (cb) => fakes.onDidRenameFiles(cb),
    },
  };
}

const LIVE = `[files] the watch of`;

// FileTree over the test's watchers, with the trash and permanent delete its workspace's files use.
function fileTree(deps: Omit<FileTreeDeps, 'workspaces'> & { readonly trash: FileSystemDeps['trash']; readonly remove: NonNullable<FileSystemDeps['remove']> }): FileTree {
  const { trash, remove, ...rest } = deps;
  workspaces = testWorkspaces({ watchers: platform.fileWatchers, trash, remove, damoclesHome: path.join(root, 'home', '.damocles') });
  return new FileTree({ ...rest, workspaces });
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

  it('marks the entries git ignores in the listed folder, and lists them unmarked when the query fails', async () => {
    touch('src/a.ts');
    touch('src/b.log');
    fs.mkdirSync(path.join(projectDir, 'src', 'out'));
    const lines: string[] = [];
    const asked: Array<[string, string, string[]]> = [];
    let fail = false;
    const make = (): FileTree => fileTree({
      projects: () => [project], exclude: () => exclude, t: (message) => message, log: (line) => lines.push(line), ask: async () => 0,
      trash: async () => undefined, remove: async () => undefined, reveal: async () => undefined, copy: async () => undefined, changed: () => undefined, target: () => ({ os: process.platform }),
      ignored: async (projectKey, relativeDir, entries) => {
        asked.push([projectKey, relativeDir, entries.map((entry) => `${entry.name}:${entry.kind}`).sort()]);
        if (fail) throw new Error('git refused');
        return new Set(['b.log', 'out']);
      },
    });
    tree.dispose();
    tree = make();
    expect(await tree.list(project.key, 'src')).toEqual({ ok: true, entries: [{ name: 'out', kind: 'dir', ignored: true }, { name: 'a.ts', kind: 'file' }, { name: 'b.log', kind: 'file', ignored: true }] });
    expect(asked).toEqual([[project.key, 'src', ['a.ts:file', 'b.log:file', 'out:dir']]]);
    fail = true;
    expect(await tree.list(project.key, 'src')).toEqual({ ok: true, entries: [{ name: 'out', kind: 'dir' }, { name: 'a.ts', kind: 'file' }, { name: 'b.log', kind: 'file' }] });
    expect(lines.filter((line) => line.includes('failed'))).toEqual(['[files] the ignored-file query failed: git refused']);
  });

  it('shows a pattern turned off, and hides a new one, on the next listing', async () => {
    fs.mkdirSync(path.join(projectDir, '.git'));
    touch('src/gen.ts');
    exclude = { ...DEFAULT_FILES_EXCLUDE, '**/.git': false, '**/gen.ts': true };
    const listing = await tree.list(project.key, '');
    expect(listing.ok && listing.entries.find((entry) => entry.name === '.git')).toEqual({ name: '.git', kind: 'dir' });
    expect(await tree.list(project.key, 'src')).toEqual({ ok: true, entries: [] });
  });

  it('lists a link by what it points to, and a folder link that leads outside through the link', async () => {
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const listing = await tree.list(project.key, '');
    expect(listing.ok && listing.entries.find((entry) => entry.name === 'out')).toEqual({ name: 'out', kind: 'dir', link: { target: fs.readlinkSync(path.join(projectDir, 'out')) } });
    expect(await tree.list(project.key, 'out')).toEqual({ ok: true, entries: [{ name: 'secret.txt', kind: 'file' }] });
  });

  it('marks a link whose target is gone as a broken file link, and a plain entry as no link', async () => {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(projectDir, 'dangling'), 'junction');
    fs.rmSync(gone, { recursive: true });
    const listing = await tree.list(project.key, '');
    expect(listing.ok && listing.entries.find((entry) => entry.name === 'dangling')).toEqual({ name: 'dangling', kind: 'file', link: { target: fs.readlinkSync(path.join(projectDir, 'dangling')), broken: true } });
    expect(listing.ok && listing.entries.find((entry) => entry.name === 'src')).toEqual({ name: 'src', kind: 'dir' });
  });

  it('marks a file symlink whose target is gone, or whose target folder is gone, as a broken file link', async (ctx) => {
    try {
      fs.symlinkSync(path.join(outside, 'missing.ts'), path.join(projectDir, 'dangling.ts'), 'file');
      fs.symlinkSync(path.join(root, 'gone', 'missing.ts'), path.join(projectDir, 'orphan.ts'), 'file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    const listing = await tree.list(project.key, '');
    for (const name of ['dangling.ts', 'orphan.ts']) {
      expect(listing.ok && listing.entries.find((entry) => entry.name === name)).toEqual({ name, kind: 'file', link: { target: fs.readlinkSync(path.join(projectDir, name)), broken: true } });
    }
  });

  it.each(['EACCES', 'ELOOP'])('lists a link whose target fails with %s as a link, not a broken one', async (code) => {
    const link = path.join(projectDir, 'guarded');
    fs.symlinkSync(outside, link, 'junction');
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      if (folderKey(String(file)) === folderKey(link)) throw Object.assign(new Error(`${code}: refused, stat '${String(file)}'`), { code });
      return stat(file, options);
    }) as typeof fs.promises.stat);
    try {
      const listing = await tree.list(project.key, '');
      expect(listing.ok && listing.entries.find((entry) => entry.name === 'guarded')).toEqual({ name: 'guarded', kind: 'file', link: { target: fs.readlinkSync(link) } });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.runIf(process.platform === 'win32')('lists a link to a UNC share as a file without following it, and names the share in every refusal on its path', async () => {
    const link = path.join(projectDir, 'share');
    fs.symlinkSync(outside, link, 'junction');
    fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
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
      // the badge names the link's own text; the target is never stat'ed for it
      const listing = await tree.list(project.key, '');
      expect(listing.ok && listing.entries.find((entry) => entry.name === 'share')).toEqual({ name: 'share', kind: 'file', link: { target: '\\\\server\\share' } });
      const share = { ok: false, reason: 'outside', refusal: 'share' };
      expect(await tree.list(project.key, 'share')).toEqual(share);
      expect(await tree.list(project.key, 'share/deeper')).toEqual(share);
      expect(await tree.create(project.key, 'share', 'made.txt', 'file')).toEqual(share);
      expect(await tree.rename(project.key, 'share/x.txt', 'y.txt')).toEqual(share);
      expect(await tree.delete(project.key, 'share/x.txt')).toEqual(share);
      expect(await tree.reveal(project.key, 'share/x.txt')).toEqual(share);
      expect(asked).toEqual([]);
      expect(fs.readdirSync(outside)).toEqual(['x.txt']);
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
  it("passes a reveal's LocalizedError on for the toast to word in the user's language, and any other failure as its message", async () => {
    touch('src/a.ts');
    revealError = Object.assign(new LocalizedError({ message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] }), { code: 'ETIMEDOUT' });
    await expect(tree.reveal(project.key, 'src/a.ts')).rejects.toBe(revealError);
    revealError = new Error('no file manager');
    expect(await tree.reveal(project.key, 'src/a.ts')).toEqual({ ok: false, reason: 'failed', message: 'no file manager' });
  });

  it('asks first, then moves the entry to the trash', async () => {
    touch('src/old.ts');
    answer = undefined;
    expect(await tree.delete(project.key, 'src/old.ts')).toEqual({ ok: false, reason: 'cancelled' });
    expect(trashed).toEqual([]);
    answer = 0;
    expect(await tree.delete(project.key, 'src/old.ts')).toEqual({ ok: true });
    expect(trashed).toEqual([path.join(projectDir, 'src', 'old.ts')]);
  });

  it('deletes an entry on a remote host permanently, only after a confirmation that says so, and never reveals it', async () => {
    host = 'Local daemon';
    touch('src/old.ts');
    answer = undefined;
    expect(await tree.delete(project.key, 'src/old.ts')).toEqual({ ok: false, reason: 'cancelled' });
    expect(asked.at(-1)).toMatchObject({ severity: 'danger', actions: ['Delete Permanently'], detail: 'It is deleted permanently on Local daemon, which has no trash. This action is irreversible.' });
    answer = 0;
    expect(await tree.delete(project.key, 'src/old.ts')).toEqual({ ok: true });
    expect(trashed).toEqual([]);
    expect(removed).toEqual([path.join(projectDir, 'src', 'old.ts')]);
    expect(await tree.reveal(project.key, '')).toEqual({ ok: false, reason: 'failed', message: 'The folder is not on this computer.' });
    expect(revealed).toEqual([]);
  });

  it('reveals a WSL distro\'s project folder in File Explorer under \\\\wsl.localhost, and nothing it cannot name', async () => {
    host = 'Ubuntu-24.04';
    wslDistro = 'Ubuntu-24.04';
    project = { key: 'wsl+Ubuntu-24.04|/home/me/app', fsPath: '/home/me/app', name: 'app' };
    expect(await tree.reveal(project.key, '')).toEqual({ ok: true });
    expect(revealed).toEqual(['\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\app']);
    project = { key: 'wsl+Ubuntu-24.04|C:/odd', fsPath: 'C:\\odd', name: 'odd' };
    expect(await tree.reveal(project.key, '')).toEqual({ ok: false, reason: 'failed', message: 'The folder is not on this computer.' });
    expect(revealed).toHaveLength(1);
  });

  it('trashes a junction itself, never the folder outside it points to', async () => {
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    expect(await tree.delete(project.key, 'out')).toEqual({ ok: true });
    expect(trashed).toEqual([path.join(projectDir, 'out')]);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('refuses to delete the project itself or a path that names its way outside, and deletes in a linked folder\'s target', async () => {
    expect(await tree.delete(project.key, '')).toEqual({ ok: false, reason: 'outside' });
    expect(await tree.delete(project.key, '../outside')).toEqual({ ok: false, reason: 'outside' });
    expect(trashed).toEqual([]);
    fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
    fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
    expect(await tree.delete(project.key, 'out/f.txt')).toEqual({ ok: true });
    expect(trashed).toEqual([path.join(outside, 'f.txt')]);
    // the link row is the link itself
    expect(await tree.delete(project.key, 'out')).toEqual({ ok: true });
    expect(trashed).toEqual([path.join(outside, 'f.txt'), path.join(projectDir, 'out')]);
  });

  it.runIf(process.platform === 'win32')('refuses names Win32 resolves elsewhere, so a folder named ".. " never trashes its parent', async () => {
    for (const relativePath of ['src/.. ', 'src/...', 'src/a.', 'src/CON', 'src/a:b']) {
      expect(await tree.delete(project.key, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
      expect(await tree.rename(project.key, relativePath, 'x'), relativePath).toEqual({ ok: false, reason: 'outside' });
      expect(await tree.list(project.key, relativePath), relativePath).toEqual({ ok: false, reason: 'outside' });
    }
    expect(trashed).toEqual([]);
  });

  it('names an entry with control or bidi characters by their escapes in both delete questions', async () => {
    touch('src/a\u202Eb.ts');
    trashFailure = "EPERM: operation not permitted, 'a\u202Eb.ts'";
    answers = [0, undefined];
    await tree.delete(project.key, 'src/a\u202Eb.ts');
    expect(asked.map((question) => question.message)).toEqual([
      "Are you sure you want to delete 'a\\u{202E}b.ts'?",
      "'a\\u{202E}b.ts' could not be moved to the trash. Do you want to delete it permanently instead?",
    ]);
    expect(asked[1]!.detail).toContain("'a\\u{202E}b.ts'");
  });

  it('refuses an action that would reach chat session files before asking anything, and changes nothing', async () => {
    const sessions = path.join(root, 'home', '.damocles', 'pi', 'agent', 'sessions', '--work--');
    const chat = path.join(sessions, '2026-11-04T10-00-00-000Z_s1.jsonl');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(chat, 'chat\n');
    fs.symlinkSync(path.dirname(sessions), path.join(projectDir, 'store'), 'junction');
    const inStore = `store/--work--/${path.basename(chat)}`;
    answers = [0];
    expect(await tree.delete(project.key, inStore)).toEqual({ ok: false, reason: 'sessionFile' });
    host = 'Local daemon';
    answers = [0];
    expect(await tree.delete(project.key, 'store/--work--')).toEqual({ ok: false, reason: 'sessionFile' });
    host = undefined;
    expect(asked).toEqual([]);
    // the store reached only once the question was answered: the trash refuses, and no permanent delete is offered
    const { files } = workspaces.local;
    const entryOf = files.entry.bind(files);
    const unflagged = vi.spyOn(files, 'entry').mockImplementation(async (of, relativePath) => {
      const found = await entryOf(of, relativePath);
      return found.ok ? { ok: true, path: found.path, folder: found.folder, identity: found.identity } : found;
    });
    answers = [0];
    expect(await tree.delete(project.key, inStore)).toEqual({ ok: false, reason: 'sessionFile' });
    expect(asked).toHaveLength(1);
    unflagged.mockRestore();
    expect(await tree.rename(project.key, inStore, 'renamed.jsonl')).toEqual({ ok: false, reason: 'sessionFile' });
    expect(await tree.create(project.key, 'store/--work--', 'new.txt', 'file')).toEqual({ ok: false, reason: 'sessionFile' });
    expect([trashed, removed, fs.readdirSync(sessions), fs.readFileSync(chat, 'utf8')]).toEqual([[], [], [path.basename(chat)], 'chat\n']);
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
    tree = fileTree({
      projects: () => [project], exclude: () => exclude, t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])), log: () => undefined,
      ask: async () => {
        if (++calls === 2) {
          fs.writeFileSync(`${file}.new`, 'someone else');
          fs.renameSync(`${file}.new`, file);
        }
        return 0;
      },
      trash: async () => { throw new Error('no trash'); },
      remove: async (target) => { removed.push(target); },
      reveal: async () => undefined, copy: async () => undefined, changed: () => undefined, ignored: async () => new Set(), target: () => ({ os: process.platform }),
    });
    expect(await tree.delete(project.key, 'src/a.ts')).toMatchObject({ ok: false, reason: 'failed' });
    expect(removed).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
  });

  it('resolves a failed reveal or copy, and a reveal of an entry that is gone, as a failure instead of throwing', async () => {
    expect(await tree.reveal(project.key, 'src/gone.ts')).toEqual({ ok: false, reason: 'missing' });
    expect(await tree.copyPath('removed-project', 'src/a.ts', false)).toEqual({ ok: false, reason: 'missing' });
    touch('src/a.ts');
    tree = fileTree({
      projects: () => [project], exclude: () => exclude, ask: async () => 0, t: (message) => message, log: () => undefined,
      trash: async () => undefined, remove: async () => undefined,
      reveal: async () => { throw new Error('no file manager'); },
      copy: async () => { throw new Error('clipboard busy'); },
      changed: () => undefined, ignored: async () => new Set(), target: () => ({ os: process.platform }),
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
    await untilWatchReady();
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

  it('fails a listing of a project whose host is not connected or drops during the call, and watches it once it is back', async () => {
    touch('src/a.ts');
    let remote = testRemote({ watchers: platform.fileWatchers });
    remote.disconnect('network');
    const away: Project = { key: projectKeyOf({ kind: 'loopback' }, folderKey(projectDir)), fsPath: projectDir, name: 'proj' };
    const lines: string[] = [];
    const remoteTree = new FileTree({
      projects: () => [away], exclude: () => ({}), workspaces: testWorkspaces({ watchers: platform.fileWatchers, remote: () => remote.workspace() }),
      ask: async () => undefined, t: (message) => message, log: (line) => lines.push(line), reveal: async () => undefined, copy: async () => undefined,
      changed: () => undefined, ignored: async () => new Set(), target: () => ({ os: process.platform, host: 'Local daemon' }),
    });
    try {
      expect(await remoteTree.list(away.key, '')).toEqual({ ok: false, reason: 'failed' });
      expect(remoteTree.watch(away)).toBe(false);
      remote = testRemote({ watchers: platform.fileWatchers });
      const listing = remoteTree.list(away.key, 'src');
      // the request is on its way once the listing's first step ran
      await Promise.resolve();
      remote.disconnect('network');
      expect(await listing).toEqual({ ok: false, reason: 'failed' });
      remote = testRemote({ watchers: platform.fileWatchers });
      expect(await remoteTree.list(away.key, 'src')).toEqual({ ok: true, entries: [{ name: 'a.ts', kind: 'file' }] });
      expect(remoteTree.watch(away)).toBe(true);
      expect(lines.filter((line) => line.includes('failed'))).toHaveLength(2);
    } finally {
      remoteTree.dispose();
      remote.disconnect('the test ended');
    }
  });

  it('watches a remote project again over its host\'s next connection, and refetches what changed while the host was away', async () => {
    let remote = testRemote({ watchers: platform.fileWatchers });
    const away: Project = { key: projectKeyOf({ kind: 'loopback' }, folderKey(projectDir)), fsPath: projectDir, name: 'proj' };
    const remoteChanged: FilesChanged[] = [];
    const remoteTree = new FileTree({
      projects: () => [away], exclude: () => ({}), workspaces: testWorkspaces({ watchers: platform.fileWatchers, remote: () => remote.workspace() }),
      ask: async () => undefined, t: (message) => message, log: () => undefined, reveal: async () => undefined, copy: async () => undefined,
      changed: (change) => remoteChanged.push(change), ignored: async () => new Set(), target: () => ({ os: process.platform, host: 'Local daemon' }),
    });
    let structural = 0;
    remoteTree.onDidChangeStructure(() => structural++);
    const liveWatchers = (): number => platform.fileWatchers.watchers.filter((watcher) => !watcher.disposed && watcher.base === projectDir).length;
    try {
      expect((await remoteTree.list(away.key, '')).ok).toBe(true);
      await vi.waitFor(() => expect(liveWatchers()).toBe(1));
      await vi.waitFor(() => expect(remoteChanged).toEqual([{ projectKey: away.key, relativeDirs: [] }]));
      remote.disconnect('network');
      remoteTree.connectionsChanged();
      expect(remoteTree.watch(away)).toBe(false);
      remote = testRemote({ watchers: platform.fileWatchers });
      const before = platform.fileWatchers.watchers.length;
      remoteChanged.length = 0;
      structural = 0;
      remoteTree.connectionsChanged();
      await vi.waitFor(() => expect(remoteChanged).toEqual([{ projectKey: away.key, relativeDirs: [] }]));
      expect(structural).toBe(1);
      await vi.waitFor(() => expect(platform.fileWatchers.watchers.length).toBe(before + 1));
      platform.fileWatchers.watcher(projectDir, '**').fireCreate(path.join(projectDir, 'src', 'new.ts'));
      await vi.waitFor(() => expect(remoteChanged).toContainEqual({ projectKey: away.key, relativeDirs: ['src'] }));
    } finally {
      remoteTree.dispose();
      remote.disconnect('the test ended');
    }
  });

  it('refetches every listing and logs once the watch is ready, never before', async () => {
    const { watchers, gates } = gatedWatchers();
    const lines: string[] = [];
    const gated = new FileTree({
      projects: () => [project], exclude: () => ({}), workspaces: testWorkspaces({ watchers }),
      ask: async () => undefined, t: (message) => message, log: (line) => lines.push(line), reveal: async () => undefined, copy: async () => undefined,
      changed: (change) => changed.push(change), ignored: async () => new Set(), target: () => ({ os: process.platform }),
    });
    let structural = 0;
    gated.onDidChangeStructure(() => structural++);
    try {
      expect((await gated.list(project.key, '')).ok).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(changed).toEqual([]);
      expect(lines.filter((line) => line.startsWith(LIVE))).toEqual([]);
      gates[0]!();
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: project.key, relativeDirs: [] }]));
      expect(structural).toBe(1);
      expect(lines).toContain(`[files] the watch of ${projectDir} is live`);
    } finally {
      gated.dispose();
    }
  });

  it('neither refetches nor logs for a watch that was disposed or replaced before it was ready', async () => {
    const { watchers, gates } = gatedWatchers();
    const lines: string[] = [];
    const gated = new FileTree({
      projects: () => [project], exclude: () => ({}), workspaces: testWorkspaces({ watchers }),
      ask: async () => undefined, t: (message) => message, log: (line) => lines.push(line), reveal: async () => undefined, copy: async () => undefined,
      changed: (change) => changed.push(change), ignored: async () => new Set(), target: () => ({ os: process.platform }),
    });
    expect((await gated.list(project.key, '')).ok).toBe(true);
    gated.dispose();
    gates[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(changed).toEqual([]);
    expect(lines.filter((line) => line.startsWith(LIVE))).toEqual([]);

    let remote = testRemote({ watchers });
    const away: Project = { key: projectKeyOf({ kind: 'loopback' }, folderKey(projectDir)), fsPath: projectDir, name: 'proj' };
    const remoteTree = new FileTree({
      projects: () => [away], exclude: () => ({}), workspaces: testWorkspaces({ watchers, remote: () => remote.workspace() }),
      ask: async () => undefined, t: (message) => message, log: (line) => lines.push(line), reveal: async () => undefined, copy: async () => undefined,
      changed: (change) => changed.push(change), ignored: async () => new Set(), target: () => ({ os: process.platform, host: 'Local daemon' }),
    });
    try {
      expect((await remoteTree.list(away.key, '')).ok).toBe(true);
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      // the daemon answers the first watch only after the connection that carried it ended, and a later watch replaced it
      remote.disconnect('network');
      remote = testRemote({ watchers });
      remoteTree.connectionsChanged();
      await vi.waitFor(() => expect(gates).toHaveLength(3));
      gates[1]!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(changed).toEqual([]);
      expect(lines.filter((line) => line.startsWith(LIVE))).toEqual([]);
      gates[2]!();
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: away.key, relativeDirs: [] }]));
      expect(lines.filter((line) => line.startsWith(LIVE))).toEqual([`[files] the watch of ${projectDir} is live`]);
    } finally {
      remoteTree.dispose();
      remote.disconnect('the test ended');
    }
  });

  describe('a linked folder that leads outside the project', () => {
    // the live watches other than the project's, by base
    const linkRootWatches = (): string[] => platform.fileWatchers.watchers.filter((watcher) => !watcher.disposed && watcher.base !== projectDir).map((watcher) => `${watcher.base} ${watcher.glob}`);
    let target: string;

    beforeEach(async () => {
      fs.mkdirSync(path.join(outside, 'sub'));
      fs.symlinkSync(outside, path.join(projectDir, 'out'), 'junction');
      target = fs.realpathSync.native(outside);
      await tree.list(project.key, '');
      await untilWatchReady();
    });

    it('watches each expanded folder under the link, without recursion, and reports its changes through the link', async () => {
      expect(linkRootWatches()).toEqual([]);
      expect((await tree.list(project.key, 'out')).ok).toBe(true);
      expect(linkRootWatches()).toEqual([`${target} *`]);
      // the folder's watch is ready: what changed before it was is listed again
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: project.key, relativeDirs: ['out'] }]));
      expect((await tree.list(project.key, 'out/sub')).ok).toBe(true);
      expect(linkRootWatches()).toEqual([`${target} *`, `${target} sub/*`]);
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: project.key, relativeDirs: ['out'] }, { projectKey: project.key, relativeDirs: ['out/sub'] }]));
      changed.length = 0;
      let structural = 0;
      tree.onDidChangeStructure(() => structural++);
      platform.fileWatchers.watcher(target, '*').fireCreate(path.join(target, 'new.txt'));
      platform.fileWatchers.watcher(target, '*').fireCreate(path.join(target, '.git'));
      platform.fileWatchers.watcher(target, 'sub/*').fireDelete(path.join(target, 'sub', 'old.txt'));
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: project.key, relativeDirs: ['out', 'out/sub'] }]));
      expect(structural).toBe(1);
    });

    it('watches an expanded folder whose name holds glob syntax as that folder only', async () => {
      fs.mkdirSync(path.join(outside, 'New folder (2)'));
      await tree.list(project.key, 'out/New folder (2)');
      expect(linkRootWatches()).toEqual([`${target} New folder [(]2[)]/*`]);
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: project.key, relativeDirs: ['out/New folder (2)'] }]));
      changed.length = 0;
      platform.fileWatchers.watcher(target, 'New folder [(]2[)]/*').fireCreate(path.join(target, 'New folder (2)', 'a.txt'));
      await vi.waitFor(() => expect(changed).toEqual([{ projectKey: project.key, relativeDirs: ['out/New folder (2)'] }]));
    });

    it('ends the watch of a collapsed folder and of every folder under it, and only theirs', async () => {
      fs.mkdirSync(path.join(outside, 'sub', 'deep'));
      await tree.list(project.key, 'out');
      await tree.list(project.key, 'out/sub');
      await tree.list(project.key, 'out/sub/deep');
      await tree.list(project.key, 'src');
      tree.collapsed(project.key, 'src');
      expect(linkRootWatches()).toEqual([`${target} *`, `${target} sub/*`, `${target} sub/deep/*`]);
      tree.collapsed(project.key, 'out/sub/deep');
      expect(linkRootWatches()).toEqual([`${target} *`, `${target} sub/*`]);
      // the shell reports only the folder it collapses, not the expanded ones under it
      tree.collapsed(project.key, 'out');
      expect(linkRootWatches()).toEqual([]);
      // the project's own watch stays
      expect(() => platform.fileWatchers.watcher(projectDir, '**')).not.toThrow();
      // expanded again, it is watched again
      await tree.list(project.key, 'out');
      expect(linkRootWatches()).toEqual([`${target} *`]);
    });

    it('watches nothing for a listing answered after its folder, or a folder above it, collapsed', async () => {
      const listing = tree.list(project.key, 'out');
      tree.collapsed(project.key, 'out');
      expect((await listing).ok).toBe(true);
      expect(linkRootWatches()).toEqual([]);
      const below = tree.list(project.key, 'out/sub');
      tree.collapsed(project.key, 'out');
      expect((await below).ok).toBe(true);
      expect(linkRootWatches()).toEqual([]);
      await tree.list(project.key, 'out');
      expect(linkRootWatches()).toEqual([`${target} *`]);
    });

    it('keeps the watch the newest listing of a folder asked for when an older one answers after it', async () => {
      await tree.list(project.key, 'out');
      const trees = workspaces.forProject(project.key).tree;
      const list = trees.list.bind(trees);
      let answer!: () => void;
      const held = new Promise<void>((resolve) => (answer = resolve));
      let read = false;
      vi.spyOn(trees, 'list').mockImplementationOnce(async (...args): Promise<FolderListing> => {
        const listing = await list(...args);
        read = true;
        await held;
        return listing;
      });
      const older = tree.list(project.key, 'out');
      // the older listing has read the old target before the link moves
      await vi.waitFor(() => expect(read).toBe(true));
      const other = path.join(root, 'other');
      fs.mkdirSync(other);
      fs.unlinkSync(path.join(projectDir, 'out'));
      fs.symlinkSync(other, path.join(projectDir, 'out'), 'junction');
      await tree.list(project.key, 'out');
      const watchedBases = (): string[] => linkRootWatches().map((watch) => watch.slice(0, watch.lastIndexOf(' ')));
      expect(watchedBases()).toEqual([fs.realpathSync.native(other)]);
      answer();
      expect((await older).ok).toBe(true);
      expect(watchedBases()).toEqual([fs.realpathSync.native(other)]);
    });

    it('keeps a record of a folder only while a listing of it is in flight or a link watch covers it', async () => {
      const records = (): number => (tree as unknown as { watched: Map<string, { folders: Map<string, unknown> }> }).watched.get(project.key)!.folders.size;
      for (let index = 0; index < 50; index++) tree.collapsed(project.key, `gone${index}`);
      await tree.list(project.key, 'src');
      expect(records()).toBe(0);
      await tree.list(project.key, 'out');
      expect(records()).toBe(1);
      const listing = tree.list(project.key, 'out/sub');
      tree.collapsed(project.key, 'out');
      expect(records()).toBe(1);
      await listing;
      expect(records()).toBe(0);
    });

    it('drops the watch when the project leaves', async () => {
      await tree.list(project.key, 'out');
      expect(linkRootWatches()).toHaveLength(1);
      const kept = project;
      project = { key: folderKey(outside), fsPath: outside, name: 'outside' };
      tree.projectsChanged();
      project = kept;
      expect(linkRootWatches()).toEqual([]);
    });

    it('moves the watch to the new target when a re-pointed link is listed again', async () => {
      await tree.list(project.key, 'out');
      const other = path.join(root, 'other');
      fs.mkdirSync(other);
      fs.unlinkSync(path.join(projectDir, 'out'));
      fs.symlinkSync(other, path.join(projectDir, 'out'), 'junction');
      await tree.list(project.key, 'out');
      expect(linkRootWatches()).toEqual([`${fs.realpathSync.native(other)} *`]);
      // a folder that now lists inside the project needs no watch of its own
      fs.unlinkSync(path.join(projectDir, 'out'));
      fs.symlinkSync(path.join(projectDir, 'src'), path.join(projectDir, 'out'), 'junction');
      await tree.list(project.key, 'out');
      expect(linkRootWatches()).toEqual([]);
    });
  });

  it('asks every watched project to refetch when files.exclude changes', async () => {
    await tree.list(project.key, '');
    await untilWatchReady();
    tree.excludeChanged();
    expect(changed).toEqual([{ projectKey: project.key, relativeDirs: [] }]);
  });

  it('orders folders before files and numbers numerically', () => {
    const entries: FileEntry[] = [{ name: 'b', kind: 'file' }, { name: 'z', kind: 'dir' }, { name: 'a10', kind: 'file' }, { name: 'a9', kind: 'file' }];
    expect(entries.sort(compareEntries).map((entry) => entry.name)).toEqual(['z', 'a9', 'a10', 'b']);
  });

  // a typed folder's listing entries carry link and target beside kind and name, and sort by the same rule
  it('orders a bare kind and name as it orders a Files entry', () => {
    const entries = [{ kind: 'file' as const, name: 'b.txt', link: true }, { kind: 'dir' as const, name: 'src' }, { kind: 'file' as const, name: '.hidden' }];
    expect(entries.sort(compareEntries).map((entry) => entry.name)).toEqual(['src', '.hidden', 'b.txt']);
  });
});
