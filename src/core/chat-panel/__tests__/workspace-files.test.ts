import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { installWalkHost, type WalkHost, type WalkSpec, type WalkStream } from '../../search-walk';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { HostInstance } from '../types';
import { folderKey } from '../../workspace-folders/folder-key';
import { installWorktreeProjectLookup } from '../../worktrees/personal-config';
import { resolveMention } from '../mention-resolver';
import { listWorkspaceFiles } from '../workspace-files';
import { WorkspaceManager } from '../workspace-manager';

let base: string;
let counter = 0;

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-at-list-')));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  // git's global config and excludes come from an empty home, never the developer's
  const home = path.join(base, `home-${++counter}`);
  fs.mkdirSync(home);
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A tree under base: a name ending in `/` is a folder, any other an empty file. */
function tree(names: readonly string[]): string {
  const root = path.join(base, `t-${++counter}`);
  fs.mkdirSync(root);
  for (const name of names) {
    const at = path.join(root, name);
    if (name.endsWith('/')) fs.mkdirSync(at, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, '');
    }
  }
  return root;
}

const host = (user: Record<string, unknown> = {}, trusted = true) => createFakePlatform({ settings: { user }, trusted });
const open = (): AbortSignal => new AbortController().signal;

/** The folders below root the walk listed, '/'-separated. */
function listedFolders(readdir: { mock: { calls: unknown[][] } }, root: string): string[] {
  return readdir.mock.calls.map(([folder]) => path.relative(root, String(folder)).replaceAll('\\', '/')).filter((rel) => !rel.startsWith('..'));
}

describe('listWorkspaceFiles', () => {
  it('lists the files and the folders holding them, shallow first, folders before files', async () => {
    const root = tree(['b.txt', 'a.txt', 'nested/c.txt', 'nested/deep/d.txt', 'empty/']);
    expect(await listWorkspaceFiles(host(), root, open())).toEqual([
      { relativePath: 'nested', isDirectory: true },
      { relativePath: 'a.txt', isDirectory: false },
      { relativePath: 'b.txt', isDirectory: false },
      { relativePath: 'nested/deep', isDirectory: true },
      { relativePath: 'nested/c.txt', isDirectory: false },
      { relativePath: 'nested/deep/d.txt', isDirectory: false },
    ]);
  });

  /** A tree with a junction j to a folder outside it and a dangling junction. */
  function linkedTree(): string {
    const root = tree(['a.txt', 'real/b.txt']);
    const outside = tree(['c.txt', 'inner/d.txt']);
    fs.symlinkSync(outside, path.join(root, 'j'), 'junction');
    fs.symlinkSync(path.join(base, 'nowhere'), path.join(root, 'dangling'), 'junction');
    return root;
  }

  it.each([
    ['an untrusted folder', {}, false],
    ['a trusted folder with search.followSymlinks off', { 'search.followSymlinks': false }, true],
  ])('lists no link and nothing below one, and enters none, in %s', async (_name, user, trusted) => {
    const root = linkedTree();
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const listed = (await listWorkspaceFiles(host(user, trusted), root, open())).map((file) => file.relativePath);
    expect(listed.sort()).toEqual(['a.txt', 'real', 'real/b.txt']);
    expect(listedFolders(readdir, root).filter((rel) => rel.startsWith('j') || rel.startsWith('dangling'))).toEqual([]);
  });

  it('lists the files through a link leading outside a trusted folder by the path through the link', async () => {
    const root = linkedTree();
    const listed = (await listWorkspaceFiles(host(), root, open())).map((file) => file.relativePath);
    expect(listed.sort()).toEqual(['a.txt', 'j', 'j/c.txt', 'j/inner', 'j/inner/d.txt', 'real', 'real/b.txt']);
  });

  // A real junction to a local folder whose readlink answers a share or WSL path, as in asset-walk.test.ts.
  it.runIf(process.platform === 'win32').each([['\\\\host\\share\\x'], ['\\\\wsl.localhost\\Ubuntu\\x']])('lists no link onto %s in a trusted folder and touches neither it nor its target', async (unc) => {
    const root = tree(['a.txt']);
    const link = path.join(root, 'nas');
    fs.symlinkSync(tree(['c.txt']), link, 'junction');
    const uncCalls: string[] = [];
    const throughLink: string[] = [];
    const under = (file: string): boolean => file.toLowerCase() === link.toLowerCase() || file.toLowerCase().startsWith(`${link.toLowerCase()}\\`);
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (String(file).toLowerCase() === link.toLowerCase() ? unc : readlink(file))) as never);
    for (const name of ['lstat', 'stat', 'realpath', 'open', 'readdir'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        const spelled = String(file);
        if (/^[\\/]{2}/.test(spelled)) {
          uncCalls.push(spelled);
          throw new Error(`reached ${spelled}`);
        }
        if (name !== 'lstat' && under(spelled)) throughLink.push(`${name} ${spelled}`);
        return original(file, ...rest);
      }) as never);
    }
    const listed = (await listWorkspaceFiles(host(), root, open())).map((file) => file.relativePath);
    expect(listed).toEqual(['a.txt']);
    expect(uncCalls).toEqual([]);
    expect(throughLink).toEqual([]);
  });

  it('stops the walk at damocles.maxIndexedFiles', async () => {
    const root = tree(Array.from({ length: 40 }, (_, index) => `f${String(index).padStart(2, '0')}/x.txt`));
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const files = (await listWorkspaceFiles(host({ 'damocles.maxIndexedFiles': 2 }), root, open())).filter((file) => !file.isDirectory);
    expect(files).toHaveLength(2);
    // the root, the folders read ahead and the two listed
    expect(listedFolders(readdir, root).length).toBeLessThan(15);
  });

  it('prunes dependency, build and git folders without entering them', async () => {
    const root = tree([
      'node_modules/p/x.js', 'sub/node_modules/y.js', '.git/HEAD', 'dist/a.js', 'build/b.js', 'out/c.js', '.next/d.js',
      'build.txt', 'src/out.txt', 'src/main.ts',
    ]);
    fs.writeFileSync(path.join(root, 'sub', 'build'), '');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const files = (await listWorkspaceFiles(host(), root, open())).filter((file) => !file.isDirectory).map((file) => file.relativePath);
    expect(files.sort()).toEqual(['build.txt', 'src/main.ts', 'src/out.txt', 'sub/build']);
    // .git is listed only to find its info/exclude, as rg reads it
    expect(listedFolders(readdir, root).filter((rel) => /(^|\/)(node_modules|\.git|dist|build|out|\.next)(\/|$)/.test(rel))).toEqual(['.git']);
  });

  it('gives the time of each file the rule names, below a followed link too, and none to any other file', async () => {
    const root = tree(['plans/a.md', 'b.ts']);
    const outside = tree(['rollout-plan.md', 'notes.md']);
    fs.symlinkSync(outside, path.join(root, 'j'), 'junction');
    fs.utimesSync(path.join(root, 'plans', 'a.md'), new Date(Date.UTC(2020, 0, 2)), new Date(Date.UTC(2020, 0, 2)));
    fs.utimesSync(path.join(outside, 'rollout-plan.md'), new Date(Date.UTC(2020, 0, 3)), new Date(Date.UTC(2020, 0, 3)));
    const files = await listWorkspaceFiles(host(), root, open(), { timed: { extension: '.md', folder: 'plans', word: 'plan' } });
    expect(files.filter((file) => !file.isDirectory).map((file) => [file.relativePath, file.modifiedAt]).sort()).toEqual([
      ['b.ts', undefined],
      ['j/notes.md', undefined],
      ['j/rollout-plan.md', Date.UTC(2020, 0, 3)],
      ['plans/a.md', Date.UTC(2020, 0, 2)],
    ]);
  });

  describe('in a worktree chat', () => {
    /** A chat worktree whose links lead into its project folder, out of it, and out again from inside it. */
    function worktreeChat(): { worktree: string; project: string; dispose(): void } {
      const project = tree(['src/a.ts']);
      const shared = tree(['s.txt']);
      fs.symlinkSync(shared, path.join(project, 'src', 'ext'), 'junction');
      const worktree = tree(['own.txt']);
      fs.symlinkSync(path.join(project, 'src'), path.join(worktree, 'lnk'), 'junction');
      fs.symlinkSync(tree(['pkg/i.js']), path.join(worktree, 'deps'), 'junction');
      const installed = installWorktreeProjectLookup({ projectOf: (folder) => (folderKey(folder) === folderKey(worktree) ? project : undefined), recordsOfProject: () => [], chatRecordFor: () => undefined, get: () => undefined });
      return { worktree, project, dispose: () => installed.dispose() };
    }

    it('lists only what a mention resolves: no file a link leads to in the project folder, every other through a link', async () => {
      const chat = worktreeChat();
      try {
        const platform = createFakePlatform();
        const listed = (await listWorkspaceFiles(platform, chat.worktree, open())).filter((file) => !file.isDirectory).map((file) => file.relativePath).sort();
        expect(listed).toEqual(['deps/pkg/i.js', 'lnk/ext/s.txt', 'own.txt']);
        const deps = { folders: { resolve: () => undefined }, confinement: platform.confinement, trust: platform.trust };
        for (const relativePath of listed) {
          expect(await resolveMention(deps, { path: path.join(chat.worktree, ...relativePath.split('/')) }, chat.worktree), relativePath).toMatchObject({ ok: true });
        }
        expect(await resolveMention(deps, { path: path.join(chat.worktree, 'lnk', 'a.ts') }, chat.worktree)).toEqual({ ok: false, reason: 'projectCopy' });
      } finally {
        chat.dispose();
      }
    });
  });

  it('applies ignore files as the search.use*IgnoreFiles settings ask', async () => {
    const root = tree(['.git/', 'a.log', 'b.txt']);
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n');
    const files = async (user: Record<string, unknown>): Promise<string[]> =>
      (await listWorkspaceFiles(host(user), root, open())).map((file) => file.relativePath).sort();
    expect(await files({})).toEqual(['.gitignore', 'b.txt']);
    expect(await files({ 'search.useIgnoreFiles': false })).toEqual(['.gitignore', 'a.log', 'b.txt']);
  });
});

describe("a panel's @ list", () => {
  const target = (fsPath: string): FolderTarget => ({ key: fsPath, fsPath, name: fsPath, label: fsPath, projectScope: true });

  /** Walks that list nothing and wait, as on a share that stopped answering, until their signal aborts. */
  function hungWalks(): { readonly walks: Array<{ readonly spec: WalkSpec; readonly signal: AbortSignal | undefined }>; restore(): void } {
    const walks: Array<{ spec: WalkSpec; signal: AbortSignal | undefined }> = [];
    const hung: WalkHost = {
      walk: (spec, signal): WalkStream => {
        walks.push({ spec, signal });
        const ended = new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('Operation aborted'));
          signal?.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true });
        });
        return { errors: [], modified: new Map(), [Symbol.asyncIterator]: () => ({ next: (): Promise<IteratorResult<readonly string[]>> => ended }) };
      },
      close: async () => undefined,
    };
    const previous = installWalkHost(hung);
    return { walks, restore: () => void installWalkHost(previous!) };
  }

  function panel(folder: FolderTarget, platform = createFakePlatform()) {
    const posted: ExtensionToWebviewMessage[] = [];
    const disposables: Array<{ dispose(): void }> = [];
    const instance = { host: {}, folder, disposables } as unknown as HostInstance;
    const panels = new Map([['p1', instance]]);
    const manager = new WorkspaceManager({ postMessage: (_host, message) => posted.push(message), getPanels: () => panels, platform });
    // as releasePanel: the panel leaves the map, then its disposables run
    const close = (): void => {
      panels.delete('p1');
      disposables.forEach((disposable) => disposable.dispose());
    };
    return { instance, manager, posted, close };
  }

  it('stops its walk when the panel closes, and posts nothing', async () => {
    const hung = hungWalks();
    try {
      const { manager, instance, posted, close } = panel(target(base));
      const sent = manager.sendWorkspaceFiles(instance);
      await vi.waitFor(() => expect(hung.walks).toHaveLength(1));
      expect(hung.walks[0]!.signal?.aborted).toBe(false);
      close();
      expect(hung.walks[0]!.signal?.aborted).toBe(true);
      await sent;
      expect(posted).toEqual([]);
      // a list asked for after the close is stopped before it starts, also for a panel that had listed nothing
      expect(await manager.workspaceFilesMessage(instance, instance.folder)).toBeUndefined();
      const unlisted = panel(target(base));
      unlisted.close();
      expect(await unlisted.manager.workspaceFilesMessage(unlisted.instance, unlisted.instance.folder)).toBeUndefined();
      expect(hung.walks.slice(1).map((walk) => walk.signal?.aborted)).toEqual([true, true]);
    } finally {
      hung.restore();
    }
  });

  it('posts no list of a folder the panel left while the list was walked', async () => {
    let finish = (): void => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    // a walk that lists its file once released, whatever its signal says
    const late: WalkHost = {
      walk: (): WalkStream => ({ errors: [], modified: new Map(), [Symbol.asyncIterator]: async function* () {
        await finished;
        yield ['x.ts'];
      } }),
      close: async () => undefined,
    };
    const previous = installWalkHost(late);
    try {
      const { manager, instance, posted } = panel(target(path.join(base, 'a')));
      const sent = manager.sendWorkspaceFiles(instance);
      instance.folder = target(path.join(base, 'b'));
      finish();
      await sent;
      expect(posted).toEqual([]);
    } finally {
      installWalkHost(previous!);
    }
  });

  it('stops the walk of the folder the panel left once it lists its new folder', async () => {
    const hung = hungWalks();
    try {
      const a = target(path.join(base, 'a'));
      const b = target(path.join(base, 'b'));
      const { manager, instance, posted } = panel(a);
      const first = manager.sendWorkspaceFiles(instance);
      // a request the webview sent while the panel was on a
      const request = manager.workspaceFilesMessage(instance, a);
      await vi.waitFor(() => expect(hung.walks).toHaveLength(2));
      instance.folder = b;
      const second = manager.sendWorkspaceFiles(instance);
      await vi.waitFor(() => expect(hung.walks).toHaveLength(3));
      expect(hung.walks.map((walk) => [walk.spec.root, walk.signal?.aborted])).toEqual([[a.fsPath, true], [a.fsPath, true], [b.fsPath, false]]);
      await first;
      expect(await request).toBeUndefined();
      // a list asked for the folder the panel left is stopped before it starts
      expect(await manager.workspaceFilesMessage(instance, a)).toBeUndefined();
      expect(hung.walks.slice(3).map((walk) => walk.signal?.aborted)).toEqual([true]);
      expect(posted).toEqual([]);
      void second;
    } finally {
      hung.restore();
    }
  });

  it('ends a listing a trust revoke stopped with a list that holds no link leading out', async () => {
    const root = tree(['a.txt']);
    const outside = tree(['c.txt']);
    fs.symlinkSync(outside, path.join(root, 'j'), 'junction');
    const platform = createFakePlatform();
    const { manager, instance, posted } = panel(target(root), platform);
    // the walk reads the linked folder at its realpath; it waits there until trust is taken back
    let reached = false;
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (folder: fs.PathLike, ...rest: unknown[]) => {
      if (String(folder) === outside) {
        reached = true;
        await released;
      }
      return readdir(folder, ...rest);
    }) as never);
    const first = manager.sendWorkspaceFiles(instance);
    await vi.waitFor(() => expect(reached).toBe(true));
    platform.trust.revokeTrust([root]);
    manager.relistWorkspaceFiles();
    release();
    await first;
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted).toEqual([{ type: 'workspaceFiles', files: [{ relativePath: 'a.txt', isDirectory: false }] }]);
  });

  it('posts no list whose walk ended just before a restart, only the fresh one', async () => {
    let finish = (): void => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const walks: Array<AbortSignal | undefined> = [];
    // the first walk lists its file once released, whatever its signal says; the fresh one lists at once
    const late: WalkHost = {
      walk: (_spec, signal): WalkStream => {
        walks.push(signal);
        const first = walks.length === 1;
        return { errors: [], modified: new Map(), [Symbol.asyncIterator]: async function* () {
          if (first) await finished;
          yield [first ? 'old.ts' : 'new.ts'];
        } };
      },
      close: async () => undefined,
    };
    const previous = installWalkHost(late);
    try {
      const { manager, instance, posted } = panel(target(path.join(base, 'a')));
      const first = manager.sendWorkspaceFiles(instance);
      await vi.waitFor(() => expect(walks).toHaveLength(1));
      manager.relistWorkspaceFiles();
      expect(walks.map((signal) => signal?.aborted)).toEqual([true, false]);
      finish();
      await first;
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(posted).toEqual([{ type: 'workspaceFiles', files: [{ relativePath: 'new.ts', isDirectory: false }] }]);
    } finally {
      installWalkHost(previous!);
    }
  });
});
