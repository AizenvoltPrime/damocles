import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { worktreeFolderFor } from '../../worktrees/records';
import { REGISTRY_FILE, WorktreeRegistry } from '../../worktrees/registry';
import { ProjectRelocations, type ProjectRelocationsDeps } from '../index';
import { parseJournal, RelocationStore } from '../store';
import { RELOCATION_STEPS, type RelocationRecord, type RelocationStepName, type RelocationStepState } from '../types';

let dir: string;
let journalFile: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relocation-trust-')));
  journalFile = path.join(dir, 'project-relocations.json');
});
afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A finished relocation whose repair waits on the new folder's trust, as a core that was refused trust left it.
async function waitingOnTrust(id: string, to: string): Promise<void> {
  const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
  const stepOf = (name: RelocationStepName): RelocationStepState => (name === 'repair' ? { state: 'waiting', failure: { code: 'untrusted', params: { count: 1 } } } : { state: 'done' });
  const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, stepOf(name)])) as Record<RelocationStepName, RelocationStepState>;
  await store.add((seq) => ({ id, seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: path.join(dir, 'old', id), to }], chats: 0, state: 'coreDone', steps, startedAt: 1, finishedAt: 2 }));
  store.dispose();
}

const allDone = (): Record<RelocationStepName, RelocationStepState> => Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'done' }])) as Record<RelocationStepName, RelocationStepState>;

const onDisk = (id: string): RelocationRecord => parseJournal(fs.readFileSync(journalFile, 'utf8'), () => undefined).records.find((record) => record.id === id)!;

describe('ProjectRelocations trust resume', () => {
  it('a trust grant runs the repair of the relocation whose new folder is trusted now, and leaves another waiting', async () => {
    const granted = path.join(dir, 'new', 'granted');
    const other = path.join(dir, 'new', 'other');
    await waitingOnTrust('granted', granted);
    await waitingOnTrust('other', other);
    const trusted = new Set<string>();
    const grantListeners = new Set<(folders: readonly string[]) => void>();
    const relocations = new ProjectRelocations({
      requestedBy: 'desktop',
      watcherFactory: createFakePlatform().fileWatchers,
      metaIndex: { move: async () => undefined, meta: async () => null },
      memory: { relocateWorkspace: async () => ({}) },
      hostState: { mcp: { relocateFolders: async () => undefined } },
      trust: {
        isTrusted: (folder) => trusted.has(folder),
        onDidGrantTrust: (cb) => {
          grantListeners.add(cb);
          return { dispose: () => grantListeners.delete(cb) };
        },
      },
      projectFolders: () => [],
      log: () => undefined,
      file: journalFile,
      identitiesFile: path.join(dir, 'folder-identities.json'),
      lockDir: path.join(dir, 'locks'),
    });
    opened.push(relocations);

    trusted.add(granted);
    for (const listener of grantListeners) listener([granted]);
    await relocations.whenIdle();

    expect(onDisk('granted').steps.repair).toEqual({ state: 'done' });
    expect(onDisk('other').steps.repair).toEqual({ state: 'waiting', failure: { code: 'untrusted', params: { count: 1 } } });
  });
});

// A→B left its memory step waiting (memory off) and its repair waiting on B's trust; B→C then finished. The steps A→B runs at the
// next start act on where the project is now, C, not on B, which no longer exists.
describe('ProjectRelocations waiting steps after a later relocation of the project', () => {
  it('re-keys the memory rows to C, finishes the superseded repair, and no longer lists the relocation', async () => {
    const A = path.join(dir, 'a');
    const B = path.join(dir, 'b');
    const C = path.join(dir, 'c');
    const ID = 'aaaa1111';
    const worktreesRoot = path.join(dir, 'worktrees');
    const W = worktreeFolderFor(worktreesRoot, A, ID);
    fs.mkdirSync(W, { recursive: true });
    fs.writeFileSync(path.join(W, '.git'), `gitdir: ${path.join(B, '.git', 'worktrees', ID)}\n`);
    fs.mkdirSync(C, { recursive: true });
    // the record as B→C's worktrees step left it
    const record = { id: ID, kind: 'chat', projectPath: C, namedFor: A, repositoryRoot: C, worktreeRoot: W, workingFolder: W, branch: 'damocles/a', index: 1, baseCommit: 'b'.repeat(40), createdAt: 1, usedAt: 2 };
    fs.mkdirSync(worktreesRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreesRoot, REGISTRY_FILE), `${JSON.stringify({ version: 1, records: [record] }, null, 2)}\n`);

    const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
    const waiting = { ...allDone(), repair: { state: 'waiting', failure: { code: 'untrusted', params: { count: 1 } } }, memory: { state: 'waiting', failure: { code: 'memoryReadOnly', params: { reason: 'disabled' } } } } as Record<RelocationStepName, RelocationStepState>;
    await store.add((seq) => ({ id: 'ab', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: A, to: B }, { kind: 'worktree', from: W, to: W, worktreeId: ID }], repository: B, chats: 0, state: 'coreDone', steps: waiting, startedAt: 1_000, finishedAt: 1_001 }));
    await store.add((seq) => ({ id: 'bc', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: B, to: C }, { kind: 'worktree', from: W, to: W, worktreeId: ID }], repository: C, chats: 0, state: 'coreDone', steps: allDone(), startedAt: 2_000, finishedAt: 2_001 }));
    store.dispose();

    const rows = new Map<string, number>([[A, 3]]);
    const registry = new WorktreeRegistry({ rootDir: worktreesRoot, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
    opened.push(registry);
    const deps: ProjectRelocationsDeps = {
      requestedBy: 'desktop',
      watcherFactory: createFakePlatform().fileWatchers,
      metaIndex: { move: async () => undefined, meta: async () => null },
      memory: {
        relocateWorkspace: async (from, to) => {
          rows.set(to, (rows.get(to) ?? 0) + (rows.get(from) ?? 0));
          rows.delete(from);
          return {};
        },
      },
      hostState: { mcp: { relocateFolders: async () => undefined } },
      worktrees: registry,
      trust: { isTrusted: () => false, onDidGrantTrust: () => ({ dispose: () => undefined }) },
      projectFolders: () => [],
      log: () => undefined,
      file: journalFile,
      identitiesFile: path.join(dir, 'folder-identities.json'),
      lockDir: path.join(dir, 'locks'),
    };
    const relocations = new ProjectRelocations(deps);
    opened.push(relocations);
    await relocations.resumeAtStart();
    await relocations.whenIdle();

    expect([...rows]).toEqual([[C, 3]]);
    expect(onDisk('ab').steps).toEqual(allDone());
    expect(relocations.views().find((view) => view.id === 'ab')).toMatchObject({ state: 'coreDone', step: 'hostState' });
    expect(relocations.views().find((view) => view.id === 'ab')?.failure).toBeUndefined();
    const next = new ProjectRelocations(deps);
    opened.push(next);
    expect(next.views()).toEqual([]);
  });

  // A→B of project P, then C→A of project Q into a re-created A, both with memory off: re-keyed in the order they moved.
  it('runs the waiting memory steps of a reused folder\'s relocations in seq order', async () => {
    const A = path.join(dir, 'a');
    const B = path.join(dir, 'b');
    const C = path.join(dir, 'c');
    const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
    const waiting = { ...allDone(), memory: { state: 'waiting', failure: { code: 'memoryReadOnly', params: { reason: 'disabled' } } } } as Record<RelocationStepName, RelocationStepState>;
    await store.add((seq) => ({ id: 'ab', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: A, to: B }], chats: 0, state: 'coreDone', steps: waiting, startedAt: 1_000, finishedAt: 1_001 }));
    await store.add((seq) => ({ id: 'ca', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: C, to: A }], chats: 0, state: 'coreDone', steps: waiting, startedAt: 2_000, finishedAt: 2_001 }));
    store.dispose();

    const rows = new Map<string, string[]>([[A, ['p']], [C, ['q']]]);
    const relocations = new ProjectRelocations({
      requestedBy: 'desktop',
      watcherFactory: createFakePlatform().fileWatchers,
      metaIndex: { move: async () => undefined, meta: async () => null },
      memory: {
        relocateWorkspace: async (from, to) => {
          // the earlier relocation's store write is the slower one
          if (from === A) await new Promise((resolve) => setTimeout(resolve, 50));
          rows.set(to, [...(rows.get(to) ?? []), ...(rows.get(from) ?? [])]);
          rows.delete(from);
          return {};
        },
      },
      hostState: { mcp: { relocateFolders: async () => undefined } },
      trust: { isTrusted: () => false, onDidGrantTrust: () => ({ dispose: () => undefined }) },
      projectFolders: () => [],
      log: () => undefined,
      file: journalFile,
      identitiesFile: path.join(dir, 'folder-identities.json'),
      lockDir: path.join(dir, 'locks'),
    });
    opened.push(relocations);
    await relocations.resumeAtStart();
    await relocations.whenIdle();

    expect(Object.fromEntries(rows)).toEqual({ [B]: ['p'], [A]: ['q'] });
  });

  // VS Code re-keys A→B's memories while the desktop resumes C→A: the desktop's waits for it, then runs on the journal's change.
  it('a memory step waits while an earlier relocation sharing a folder path, which another process runs, has not moved its memories', async () => {
    const A = path.join(dir, 'a');
    const B = path.join(dir, 'b');
    const C = path.join(dir, 'c');
    const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
    const waiting = { ...allDone(), memory: { state: 'waiting', failure: { code: 'memoryReadOnly', params: { reason: 'disabled' } } } } as Record<RelocationStepName, RelocationStepState>;
    await store.add((seq) => ({ id: 'ab', seq, requestedBy: 'vscode', mode: 'locate', folders: [{ kind: 'project', from: A, to: B }], chats: 0, state: 'coreDone', steps: waiting, startedAt: 1_000, finishedAt: 1_001 }));
    await store.add((seq) => ({ id: 'ca', seq, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: C, to: A }], chats: 0, state: 'coreDone', steps: waiting, startedAt: 2_000, finishedAt: 2_001 }));
    store.dispose();

    // one memory database both processes write
    const rows = new Map<string, string[]>([[A, ['p']], [C, ['q']]]);
    const order: string[] = [];
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = (requestedBy: 'vscode' | 'desktop', watcherFactory: ReturnType<typeof createFakePlatform>['fileWatchers'], slow: boolean): ProjectRelocations => {
      const relocations = new ProjectRelocations({
        requestedBy,
        watcherFactory,
        metaIndex: { move: async () => undefined, meta: async () => null },
        memory: {
          relocateWorkspace: async (from, to) => {
            if (slow) {
              entered();
              await gate;
            }
            order.push(`${path.basename(from)}→${path.basename(to)}`);
            rows.set(to, [...(rows.get(to) ?? []), ...(rows.get(from) ?? [])]);
            rows.delete(from);
            return {};
          },
        },
        hostState: { mcp: { relocateFolders: async () => undefined } },
        trust: { isTrusted: () => false, onDidGrantTrust: () => ({ dispose: () => undefined }) },
        projectFolders: () => [],
        log: () => undefined,
        file: journalFile,
        identitiesFile: path.join(dir, `${requestedBy}-identities.json`),
        lockDir: path.join(dir, 'locks'),
      });
      opened.push(relocations);
      return relocations;
    };
    const vscode = open('vscode', createFakePlatform().fileWatchers, true);
    const desktopWatchers = createFakePlatform().fileWatchers;
    const desktop = open('desktop', desktopWatchers, false);

    const vscodeRun = vscode.retry('ab');
    await inside;
    await desktop.resumeAtStart();
    expect(onDisk('ca').steps.memory).toEqual({ state: 'waiting', failure: { code: 'earlierMove', params: { path: A } } });
    expect(desktop.views().find((view) => view.id === 'ca')?.waiting).toEqual([{ code: 'earlierMove', params: { path: A } }]);
    expect(order).toEqual([]);

    release();
    await vscodeRun;
    await vscode.whenIdle();
    desktopWatchers.watcher(dir, path.basename(journalFile)).fireChange(journalFile);
    await vi.waitFor(() => expect(onDisk('ca').steps.memory).toEqual({ state: 'done' }));
    await desktop.whenIdle();
    expect(order).toEqual(['a→b', 'c→a']);
    expect(Object.fromEntries(rows)).toEqual({ [B]: ['p'], [A]: ['q'] });
  });
});
