import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RelocationView } from '../../../core/project-relocation/types';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { rootKey } from '../../preload/folder-root';
import type { FileRef } from '../../preload/shell-channels';
import { ProjectList } from '../projects';
import { presentFiles, RelocatedProjects, type RelocateStateDeps } from '../relocate-project-state';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');

const OLD = path.resolve('/work/acme');
const NEW = path.resolve('/moved/acme');
// a chat worktree stays where it is: its folder is the same before and after the move
const WORKTREE = path.resolve('/home/.damocles/worktrees/acme-1a2b3c4d/aaaa1111');
const ANSWERS = new Map([['doc-1', 'discarded text']]);

const view = (extra: Partial<RelocationView> = {}): RelocationView => ({
  id: 'r1', seq: 1, requestedBy: 'desktop', mode: 'locate', from: OLD, to: NEW, state: 'coreDone', step: 'hostState', progress: { done: 2, total: 2 }, chats: 2, ...extra,
});

interface World {
  listed: Set<string>;
  absent: Set<string>;
  applied: Set<string>;
  trusted: Set<string>;
  open: boolean;
  closeAnswers: ReadonlyMap<string, string> | undefined;
  tabs: Map<string, FileRef[]>;
  // the step that throws once, as a crash cut short there would
  failOnce: string | undefined;
  trail: string[];
}

function setup(world: Partial<World> = {}) {
  const w: World = {
    listed: new Set([folderKey(OLD)]),
    absent: new Set([folderKey(OLD)]),
    applied: new Set(),
    trusted: new Set([OLD]),
    open: true,
    closeAnswers: new Map(),
    tabs: new Map([[folderKey(OLD), [{ projectKey: folderKey(OLD), relativePath: 'src/a.ts' }]]]),
    failOnce: undefined,
    trail: [],
    ...world,
  };
  const step = (name: string): void => {
    if (w.failOnce === name) {
      w.failOnce = undefined;
      throw new Error(`${name} failed`);
    }
    w.trail.push(name);
  };
  const deps: RelocateStateDeps = {
    keyOf: folderKey,
    listed: (key) => (w.listed.has(key) ? { name: 'acme' } : undefined),
    absent: (key) => w.absent.has(key),
    applied: (id) => w.applied.has(id),
    offerOpen: async (relocation, name) => {
      w.trail.push(`offer:${name}:${relocation.to}`);
      return w.open;
    },
    askClose: async () => {
      w.trail.push('askClose');
      return w.closeAnswers;
    },
    isTrusted: (fsPath) => w.trusted.has(fsPath),
    requestTrust: async (fsPath) => {
      w.trail.push(`trust:${fsPath}`);
      return false;
    },
    savedTabs: (key) => {
      w.trail.push('savedTabs');
      return w.tabs.get(key) ?? [];
    },
    relocateStores: async () => step('stores'),
    relocateWorktreeStores: (worktree, fromKey, toKey) => w.trail.push(`worktree:${worktree.worktreeId}:${fromKey}->${toKey}`),
    revokeTrust: async (fsPath) => {
      step('revoke');
      w.trusted.delete(fsPath);
    },
    applyHostState: async () => step('hostState'),
    relocateList: async (from, to, id) => {
      step('list');
      w.listed.delete(from.key);
      w.listed.add(to.key);
      w.applied.add(id);
    },
    relocateOrder: async () => step('order'),
    relocateRoot: (fromRootKey, toRootKey) => w.trail.push(`relocateRoot:${fromRootKey}->${toRootKey}`),
    reopenTabs: async (files) => {
      w.trail.push(`reopenTabs:${files.map((file) => `${file.projectKey}/${file.relativePath}`).join(',')}`);
    },
    closeOldRoot: (key, answers) => w.trail.push(key === folderKey(OLD) && answers.size === 0 ? 'closeOldRoot' : `closeOldRoot:${key}:${answers.size}`),
    reopenChats: () => w.trail.push('reopenChats'),
    select: async (key) => {
      w.trail.push(`select:${key}`);
    },
    announce: (message) => w.trail.push(`announce:${message}`),
    describe: (failure, project) => `[${failure.code} ${String(failure.params?.['reason'])} of ${project.name}]`,
    report: (action, err) => w.trail.push(`report:${action}:${(err as Error).message}`),
    t,
  };
  return { w, deps, projects: new RelocatedProjects(deps) };
}

const MOVED = `announce:Moved 2 chats of acme to ${NEW}.`;
const APPLIED = (): string[] => [
  'savedTabs', 'stores', 'revoke', 'hostState', 'list', 'order', `reopenTabs:${folderKey(NEW)}/src/a.ts`, 'closeOldRoot', 'reopenChats', `select:${folderKey(NEW)}`, MOVED,
];

describe('RelocatedProjects', () => {
  it('applies a relocation this app requested at once, the list before the order, the new folder\'s tabs before the old root closes', async () => {
    const { w, projects } = setup();
    await projects.reached(view(), 'thisApp');
    expect(w.trail).toEqual(APPLIED());
    expect(w.trusted.has(OLD)).toBe(false);
    expect(w.applied.has('r1')).toBe(true);
  });

  it('runs again whole after a part cut short, and does nothing once the list moved on', async () => {
    const { w, projects } = setup({ failOnce: 'hostState' });
    await expect(projects.reached(view(), 'thisApp')).rejects.toThrow('hostState failed');
    expect(w.trail).toEqual(['savedTabs', 'stores', 'revoke']);
    expect(w.listed.has(folderKey(OLD))).toBe(true);
    w.trail = [];
    await projects.reached(view(), 'thisApp');
    expect(w.trail).toEqual(APPLIED());
    w.trail = [];
    await projects.reached(view(), 'thisApp');
    expect(w.trail).toEqual([]);
  });

  it('runs the steps after the sidebar order when its write fails, and reports it', async () => {
    const { w, projects } = setup({ failOnce: 'order' });
    await projects.reached(view(), 'thisApp');
    expect(w.trail).toEqual(APPLIED().map((entry) => (entry === 'order' ? 'report:Moving the project in the sidebar order:order failed' : entry)));
  });

  it('applies one relocation once while it runs, however often the mirror reports it', async () => {
    const { w, projects } = setup();
    await Promise.all([projects.reached(view(), 'thisApp'), projects.reached(view(), 'thisApp')]);
    expect(w.trail).toEqual(APPLIED());
  });

  it('closes the old root with the answers Locate took in this run', async () => {
    const { w, projects } = setup();
    await projects.reached(view(), { answers: ANSWERS });
    expect(w.trail).toEqual(APPLIED().map((entry) => (entry === 'closeOldRoot' ? `closeOldRoot:${folderKey(OLD)}:1` : entry)));
  });

  it('offers a relocation another app requested with Open, which asks Locate\'s questions and trust before applying', async () => {
    const { w, projects } = setup();
    await projects.reached(view({ requestedBy: 'vscode' }), 'other');
    expect(w.trail).toEqual([`offer:acme:${NEW}`, 'askClose', `trust:${NEW}`, ...APPLIED()]);
  });

  it('leaves a relocation another app requested as it is when the notice is dismissed, and does not offer it again in this run', async () => {
    const { w, projects } = setup({ open: false });
    await projects.reached(view({ requestedBy: 'vscode' }), 'other');
    await projects.reached(view({ requestedBy: 'vscode' }), 'other');
    expect(w.trail).toEqual([`offer:acme:${NEW}`]);
    expect(w.listed.has(folderKey(OLD))).toBe(true);
  });

  it('applies nothing when Open\'s questions are cancelled', async () => {
    const { w, projects } = setup({ closeAnswers: undefined });
    await projects.reached(view({ requestedBy: 'vscode' }), 'other');
    expect(w.trail).toEqual([`offer:acme:${NEW}`, 'askClose']);
  });

  it('tells the user once, with the announcement, that the memories wait for a later start', async () => {
    const { w, projects } = setup();
    const waiting = view({ failure: { code: 'memoryReadOnly', params: { reason: 'readOnly' } } });
    await projects.reached(waiting, 'thisApp');
    await projects.reached(waiting, 'thisApp');
    expect(w.trail.filter((entry) => entry.startsWith('announce:'))).toEqual([`${MOVED} [memoryReadOnly readOnly of acme]`]);
  });

  it('announces the memories waiting beside a repair that waits on trust, which has a notice of its own', async () => {
    const { w, projects } = setup();
    const untrusted = { code: 'untrusted', params: { count: 1 } };
    await projects.reached(view({ step: 'repair', failure: untrusted, waiting: [untrusted, { code: 'memoryReadOnly', params: { reason: 'readOnly' } }] }), 'thisApp');
    expect(w.trail.at(-1)).toBe(`${MOVED} [memoryReadOnly readOnly of acme]`);
  });

  it("re-keys each chat worktree's stores after the project's and its live editor tabs after the list, and leaves a waiting repair to its own notice", async () => {
    const { w, projects } = setup();
    const worktrees = ['aaaa1111', 'bbbb2222'].map((worktreeId) => ({ worktreeId, from: path.join(path.dirname(WORKTREE), worktreeId), to: path.join(path.dirname(WORKTREE), worktreeId) }));
    await projects.reached(view({ step: 'repair', failure: { code: 'untrusted', params: { count: 1 } }, worktrees }), 'thisApp');
    const rekeyed = (worktreeId: string): string[] => [
      `worktree:${worktreeId}:${folderKey(OLD)}->${folderKey(NEW)}`,
      `relocateRoot:${rootKey({ projectKey: folderKey(OLD), worktreeId })}->${rootKey({ projectKey: folderKey(NEW), worktreeId })}`,
    ];
    const applied = APPLIED();
    // the editor's live tabs of a worktree root follow once the list names the new key, which their root resolves under
    expect(w.trail).toEqual([
      ...applied.slice(0, 2), rekeyed('aaaa1111')[0], rekeyed('bbbb2222')[0], ...applied.slice(2, 5), rekeyed('aaaa1111')[1], rekeyed('bbbb2222')[1], ...applied.slice(5),
    ]);
  });

  it('ignores a relocation that is not done or whose old folder is no longer listed', async () => {
    const { w, projects } = setup({ listed: new Set() });
    await projects.reached(view(), 'thisApp');
    const running = setup();
    await running.projects.reached(view({ state: 'running' }), 'thisApp');
    expect([...w.trail, ...running.w.trail]).toEqual([]);
  });

  it('applies a relocation the mirror reports only while its old folder is not there, unless this run\'s Locate asked for it', async () => {
    const { w, projects } = setup({ absent: new Set() });
    await projects.reached(view(), 'thisApp');
    await projects.reached(view({ requestedBy: 'vscode' }), 'other');
    expect(w.trail).toEqual([]);
    await projects.reached(view(), { answers: new Map() });
    expect(w.trail).toEqual(APPLIED());
  });

  it('never applies a relocation again once applied: after A to B and B to A, A to B reported again changes nothing', async () => {
    const { w, deps, projects } = setup();
    await projects.reached(view(), 'thisApp');
    w.absent = new Set([folderKey(NEW)]);
    await projects.reached(view({ id: 'r2', seq: 2, from: NEW, to: OLD }), 'thisApp');
    expect([...w.listed]).toEqual([folderKey(OLD)]);
    // the old folder is missing again: the moves the mirror still holds are no reason to move it
    w.absent = new Set([folderKey(OLD)]);
    w.trail = [];
    await projects.reached(view(), 'thisApp');
    await new RelocatedProjects(deps).reached(view(), 'other');
    expect(w.trail).toEqual([]);
    expect([...w.listed]).toEqual([folderKey(OLD)]);
  });
});

describe('RelocatedProjects with the project list', () => {
  let userData: string;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-relocated-'));
  });
  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const withList = (list: ProjectList) => {
    const { deps } = setup();
    return new RelocatedProjects({
      ...deps,
      listed: (key) => (list.folders().some((folder) => folderKey(folder.fsPath) === key) ? { name: 'acme' } : undefined),
      applied: (id) => list.relocated(id),
      relocateList: async (from, to, id) => { await list.relocate(from.fsPath, to.fsPath, id); },
    });
  };

  it('does not apply a relocation again after a relaunch, to a folder added again at its old path', async () => {
    const list = new ProjectList(userData, () => undefined);
    await list.add(OLD);
    await withList(list).reached(view(), 'thisApp');
    expect(list.folders().map((folder) => folder.fsPath)).toEqual([NEW]);
    await list.add(OLD);
    const relaunched = new ProjectList(userData, () => undefined);
    // the launch asks core for the moves from every listed folder that is not there: the re-added one went missing
    await withList(relaunched).reached(view(), 'thisApp');
    expect(new ProjectList(userData, () => undefined).folders().map((folder) => folder.fsPath)).toEqual([NEW, OLD]);
  });
});

describe('presentFiles', () => {
  it('keeps the files that are there, counts a failed check as absent, and logs every failure but a missing file', async () => {
    const failure = (code: string) => async (): Promise<boolean> => Promise.reject(Object.assign(new Error(code), { code }));
    const checks = new Map<string, () => Promise<boolean>>([
      ['a.ts', async () => true],
      ['folder', async () => false],
      ['gone.ts', failure('ENOENT')],
      ['denied.ts', failure('EACCES')],
      ['under-a-file.ts', failure('ENOTDIR')],
      ['b.ts', async () => true],
    ]);
    const logged: string[] = [];
    expect(await presentFiles([...checks.keys()], (file) => checks.get(file)!(), (file, err) => logged.push(`${file}: ${(err as Error).message}`))).toEqual(['a.ts', 'b.ts']);
    expect(logged).toEqual(['denied.ts: EACCES', 'under-a-file.ts: ENOTDIR']);
  });
});
