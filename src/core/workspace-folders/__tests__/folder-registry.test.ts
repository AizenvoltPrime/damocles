import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';

const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({ log: logMock }));

import * as path from 'path';
import { WorkspaceFolderRegistry, DEFAULT_WORKSPACE_FOLDER_STATE_KEY, defaultProjectPath, homeDirectory, type FolderChange } from '../folder-registry';
import { folderKey } from '../folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { OpenFolder } from '../../../platform/workspace-folders';

const ROOT = path.resolve(os.tmpdir(), 'reg-root');
const A = path.join(ROOT, 'alpha');
const B = path.join(ROOT, 'beta');
const C = path.join(ROOT, 'gamma');

function wsFolder(fsPath: string, name = path.basename(fsPath)): OpenFolder {
  return { fsPath, name };
}

/** Replace the open folders and fire the change event, as the host does on add, remove or rename. */
function setFolders(folders: readonly OpenFolder[]): void {
  fake.workspaceFolders.setFolders(folders);
}

class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

let state: MemoryState;
let fake: FakePlatform;
let registry: WorkspaceFolderRegistry | null = null;

function makeRegistry(): WorkspaceFolderRegistry {
  registry = new WorkspaceFolderRegistry(fake.workspaceFolders, state);
  return registry;
}

function record(reg: WorkspaceFolderRegistry): FolderChange[] {
  const changes: FolderChange[] = [];
  reg.onDidChange((c) => changes.push(c));
  return changes;
}

beforeEach(() => {
  state = new MemoryState();
  fake = createFakePlatform();
});

afterEach(() => {
  registry?.dispose();
  registry = null;
});

describe('WorkspaceFolderRegistry targets', () => {
  it('has exactly one home target with no project scope when no folder is open', () => {
    setFolders([]);
    const reg = makeRegistry();
    expect(reg.targets()).toHaveLength(1);
    const home = reg.targets()[0]!;
    expect(home.fsPath).toBe(process.env['HOME'] || process.env['USERPROFILE'] || os.homedir());
    expect(home.projectScope).toBe(false);
    expect(reg.defaultTarget()).toBe(home);
    expect(reg.isMultiRoot).toBe(false);
  });

  // A no-folder window's session dir and memory strings are already on disk under this exact path.
  describe('home path', () => {
    const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
    const restore = (name: 'HOME' | 'USERPROFILE') => {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    };
    afterEach(() => {
      restore('HOME');
      restore('USERPROFILE');
    });

    it('prefers HOME, then USERPROFILE', () => {
      process.env['HOME'] = path.join(ROOT, 'home-env');
      process.env['USERPROFILE'] = path.join(ROOT, 'profile-env');
      expect(homeDirectory()).toBe(path.join(ROOT, 'home-env'));
      setFolders([]);
      expect(makeRegistry().targets()[0]!.fsPath).toBe(path.join(ROOT, 'home-env'));

      delete process.env['HOME'];
      expect(homeDirectory()).toBe(path.join(ROOT, 'profile-env'));
    });
  });

  it('keeps the raw fsPath while the key is the normalized form', () => {
    const raw = path.join(ROOT, 'MixedCase');
    setFolders([wsFolder(raw)]);
    const target = makeRegistry().targets()[0]!;
    expect(target.fsPath).toBe(raw);
    expect(target.key).toBe(folderKey(raw));
  });

  it('is multi-root with two folders open', () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    expect(makeRegistry().isMultiRoot).toBe(true);
  });

  // The webview sends keys, so anything that is not an open folder must resolve to nothing.
  it('resolves only keys of open folders', () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    expect(reg.resolve(folderKey(B))?.fsPath).toBe(B);
    expect(reg.resolve(folderKey(C))).toBeUndefined();
    expect(reg.resolve(C)).toBeUndefined();
    expect(reg.resolve(folderKey(os.homedir()))).toBeUndefined();
  });
});

describe('WorkspaceFolderRegistry labels', () => {
  it("labels two folders named app by their parents, as 'app (client)' and 'app (server)'", () => {
    setFolders([wsFolder(path.join(ROOT, 'client', 'app')), wsFolder(path.join(ROOT, 'server', 'app')), wsFolder(A)]);
    const labels = makeRegistry().folderInfos().map((f) => f.label);
    expect(labels).toEqual(['app (client)', 'app (server)', 'alpha']);
  });

  it('takes as many parent segments as it needs to tell same-named folders apart', () => {
    setFolders([wsFolder(path.join(ROOT, 'one', 'x', 'app')), wsFolder(path.join(ROOT, 'two', 'x', 'app'))]);
    expect(makeRegistry().folderInfos().map((f) => f.label)).toEqual(['app (one/x)', 'app (two/x)']);
  });

  it('uses the workspace folder name, not the directory name', () => {
    setFolders([wsFolder(A, 'Frontend'), wsFolder(B)]);
    expect(makeRegistry().folderInfos()).toEqual([
      { key: folderKey(A), name: 'Frontend', label: 'Frontend', path: A },
      { key: folderKey(B), name: 'beta', label: 'beta', path: B },
    ]);
  });
});

describe('WorkspaceFolderRegistry default folder', () => {
  it('defaults to the first folder when nothing is stored', () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    expect(makeRegistry().defaultTarget().fsPath).toBe(A);
  });

  it('stores a chosen default in workspaceState and announces it', async () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    const changes = record(reg);
    expect(await reg.setDefault(folderKey(B))).toBe(true);
    expect(state.get('damocles.defaultWorkspaceFolder')).toBe(folderKey(B));
    expect(reg.defaultTarget().fsPath).toBe(B);
    expect(changes).toEqual([{ added: [], removed: [], relabelled: false, defaultChanged: true }]);
  });

  it('refuses a default that is not open and stores nothing', async () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    const changes = record(reg);
    expect(await reg.setDefault(folderKey(C))).toBe(false);
    expect(state.values.has(DEFAULT_WORKSPACE_FOLDER_STATE_KEY)).toBe(false);
    expect(changes).toEqual([]);
  });

  // Default B, B removed -> first folder, B added back -> B again.
  it('falls back to the first folder while the default is closed, and restores it when re-added', async () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    await reg.setDefault(folderKey(B));
    const changes = record(reg);

    setFolders([wsFolder(A)]);
    expect(reg.defaultTarget().fsPath).toBe(A);
    expect(state.get(DEFAULT_WORKSPACE_FOLDER_STATE_KEY)).toBe(folderKey(B));
    expect(changes.at(-1)?.defaultChanged).toBe(true);
    expect(changes.at(-1)?.removed.map((t) => t.fsPath)).toEqual([B]);

    setFolders([wsFolder(A), wsFolder(B)]);
    expect(reg.defaultTarget().fsPath).toBe(B);
    expect(changes.at(-1)?.defaultChanged).toBe(true);
    expect(changes.at(-1)?.added.map((t) => t.fsPath)).toEqual([B]);
  });

  it('keeps a stale stored default untouched from the start', () => {
    state.values.set(DEFAULT_WORKSPACE_FOLDER_STATE_KEY, folderKey(C));
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    expect(reg.defaultTarget().fsPath).toBe(A);
    expect(state.get(DEFAULT_WORKSPACE_FOLDER_STATE_KEY)).toBe(folderKey(C));
  });

  // The desktop settings store reads the project layer from defaultProjectPath, the panels from defaultTarget().
  it.each([
    ['no folder open', [], undefined],
    ['nothing stored', [A, B], undefined],
    ['a stored default that is open', [A, B], B],
    ['a stored default that is closed', [A, B], C],
    ['a stored default with no folder open', [], B],
  ] as const)('defaultProjectPath names the folder defaultTarget() does: %s', (_name, open, stored) => {
    setFolders(open.map((fsPath) => wsFolder(fsPath)));
    if (stored !== undefined) state.values.set(DEFAULT_WORKSPACE_FOLDER_STATE_KEY, folderKey(stored));
    const target = makeRegistry().defaultTarget();
    expect(defaultProjectPath(fake.workspaceFolders, state)).toBe(target.projectScope ? target.fsPath : undefined);
  });
});

describe('WorkspaceFolderRegistry change events', () => {
  it('diffs by key, so renaming a folder is neither a removal nor an addition', () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    const changes = record(reg);

    setFolders([wsFolder(A), wsFolder(B, 'Backend')]);

    expect(changes).toEqual([{ added: [], removed: [], relabelled: true, defaultChanged: false }]);
    expect(reg.resolve(folderKey(B))?.label).toBe('Backend');
  });

  it('reports a relabel when an added same-named folder changes an open folder\'s label', () => {
    const client = path.join(ROOT, 'client', 'app');
    setFolders([wsFolder(client)]);
    const reg = makeRegistry();
    const changes = record(reg);

    setFolders([wsFolder(client), wsFolder(path.join(ROOT, 'server', 'app'))]);

    expect(changes[0]).toMatchObject({ removed: [], relabelled: true });
    expect(reg.resolve(folderKey(client))?.label).toBe('app (client)');
  });

  it('reports added and removed folders', () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    const changes = record(reg);

    setFolders([wsFolder(A), wsFolder(C)]);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.added.map((t) => t.fsPath)).toEqual([C]);
    expect(changes[0]!.removed.map((t) => t.fsPath)).toEqual([B]);
    expect(changes[0]!.defaultChanged).toBe(false);
    expect(changes[0]!.relabelled).toBe(false);
    expect(reg.resolve(folderKey(B))).toBeUndefined();
  });

  it('still notifies every later listener when one throws, including through setDefault', async () => {
    setFolders([wsFolder(A), wsFolder(B)]);
    const reg = makeRegistry();
    reg.onDidChange(() => { throw new Error('listener failed'); });
    const changes = record(reg);

    setFolders([wsFolder(A), wsFolder(B), wsFolder(C)]);
    expect(await reg.setDefault(folderKey(B))).toBe(true);

    expect(changes.map((c) => c.added.length)).toEqual([1, 0]);
    expect(changes.at(-1)?.defaultChanged).toBe(true);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('listener failed'), expect.any(Error));
  });

  it('stops listening once disposed', () => {
    setFolders([wsFolder(A)]);
    const reg = makeRegistry();
    const changes = record(reg);
    reg.dispose();
    setFolders([wsFolder(A), wsFolder(B)]);
    expect(changes).toEqual([]);
  });
});
