import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ trail: [] as string[], folderState: 'worktree' as 'worktree' | 'leftover' | 'gone', removeError: undefined as Error | undefined, applyOutcome: undefined as unknown, uncommitted: [] as Array<{ path: string; letter: string }>, unmerged: [] as Array<{ hash: string; subject: string }>, contained: false }));
vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {}, dialog: { showMessageBox: vi.fn() } }));
vi.mock('../../../core/worktrees/integrate', () => ({
  aheadBehind: vi.fn(async () => ({ behind: 0 })),
  lineChangesSinceBase: vi.fn(async () => ({ added: 0, removed: 0 })),
  branchContained: vi.fn(async () => H.contained),
  apply: vi.fn(async () => {
    H.trail.push('apply');
    return H.applyOutcome;
  }),
  isRewritten: vi.fn(async () => false),
  mergeInto: vi.fn(async () => ({ kind: 'ok' })),
  rebaseOnto: vi.fn(async () => ({ kind: 'ok' })),
  updateFrom: vi.fn(async () => ({ kind: 'ok' })),
  targetBranch: vi.fn(async () => 'main'),
  uncommittedFiles: vi.fn(async () => H.uncommitted),
  unmergedCommits: vi.fn(async () => H.unmerged),
  // a folder that is not there is gone; one that is reads as the test sets it
  worktreeFolderState: vi.fn(async (folder: string) => ((await import('node:fs')).existsSync(folder) ? H.folderState : 'gone')),
  removeWorktree: vi.fn(async (_record: unknown, _git: unknown, _registry: unknown, options: { deleteBranch: boolean; force: boolean }) => {
    H.trail.push(`remove:${options.deleteBranch}:${options.force}`);
    if (H.removeError) throw H.removeError;
  }),
}));

import type { ChatWorktreeRecord, WorktreeRegistry } from '../../../core/worktrees/registry';
import type { GitRunner } from '../../../core/scm/git-runner';
import { lineChangesSinceBase, mergeInto, targetBranch, updateFrom } from '../../../core/worktrees/integrate';
import { rootKey } from '../../preload/folder-root';
import { WorktreeRoots } from '../worktrees/roots';
import { mostRecentlyUsed, WorktreeController, type WorktreeControllerDeps } from '../worktrees/worktree-controller';
import { finishHold, worktreeEngine } from '../worktrees/engine';
import type { WorktreeRecordReader } from '../worktrees/records';
import { createFinishHolds, worktreeCalls, type FinishHolds } from '../../core-host/worktrees';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type WorktreeCall } from '../../core-protocol';
import { CoreClient } from '../core-client';
import type { AskWorktreeDialog } from '../worktrees/worktree-dialogs';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { DocumentService, type TextDocument } from '../documents/document-service';
import { EditorPane } from '../editor-pane';
import { closeWorktreeRoot, type CloseWorktreeDeps } from '../worktrees/close-worktree';

const PROJECT = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha';
const KEY = process.platform === 'win32' ? PROJECT.toLowerCase() : PROJECT;
// the worktree's folder exists, as a live one's does
const WT = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-wt-'));
afterAll(() => fs.rmSync(WT, { recursive: true, force: true }));

let record: ChatWorktreeRecord;
let roots: WorktreeRoots;
let dialogs: unknown[];
let dialogAnswers: unknown[];
let notices: Array<{ severity: string; message: string; actions: string[] }>;
let busy: boolean;
let leased: boolean;
let closeAnswer: boolean;
// a chat of the worktree started working while the last question was open
let busyAtHold: boolean;
let tasks: Array<Parameters<WorktreeControllerDeps['runTask']>[0]>;
// what the worktree's `git submodule status` and porcelain v2 status print
let gitOutput: Record<string, string>;
const fakeGit = { git: { path: 'git', version: { major: 2, minor: 45, patch: 0 } }, run: async (call: { args: readonly string[] }) => ({ stdout: Buffer.from(gitOutput[call.args[0]!] ?? ''), stderr: '', exitCode: 0 }) } as unknown as GitRunner;

// worktrees.call as core serves it over its own registry and finish holds
function coreCalls(registry: WorktreeRegistry, holds: FinishHolds): (method: WorktreeCall, args: readonly unknown[]) => Promise<unknown> {
  const calls = worktreeCalls({ registry, git: () => fakeGit, isTrusted: () => true, holds, log: () => undefined });
  return (method, args) => (calls[method] as (...callArgs: readonly unknown[]) => Promise<unknown>)(...args);
}

const recordRegistry = (): WorktreeRegistry => ({
  get: (id: string) => (id === record.id ? record : undefined),
  liveChatRecords: () => (record.deletedAt === undefined ? [record] : []),
  records: () => [record],
} as unknown as WorktreeRegistry);

// The registry as core holds it and main reads it; the git and registry work goes through core's worktree calls.
function controller(overrides: Partial<WorktreeControllerDeps> & { readonly registry?: WorktreeRegistry } = {}): WorktreeController {
  const { registry: overriddenRegistry, ...rest } = overrides;
  const registry = overriddenRegistry ?? recordRegistry();
  const holds = createFinishHolds();
  const call = coreCalls(registry, holds);
  const engine = worktreeEngine(call);
  roots = new WorktreeRoots({ projects: () => [{ key: KEY, fsPath: PROJECT, name: 'alpha' }], registry: () => registry });
  const askDialog = (async (dialog: unknown) => {
    dialogs.push(dialog);
    H.trail.push(`dialog:${(dialog as { dialog: string }).dialog}`);
    return dialogAnswers.shift();
  }) as AskWorktreeDialog;
  const notice = (severity: string) => async (message: string, ...actions: string[]): Promise<string | undefined> => {
    notices.push({ severity, message, actions });
    return undefined;
  };
  return new WorktreeController({
    records: registry as unknown as WorktreeRecordReader,
    engine,
    roots,
    gitFound: true,
    branchPrefix: () => '',
    isTrusted: () => true,
    askDialog,
    ask: async () => 0,
    notify: { info: notice('info'), warn: notice('warn'), error: notice('error') },
    t: (message, ...args) => message.replace(/\{(\d)\}/g, (_, index: string) => String(args[Number(index)])),
    log: () => undefined,
    setupShell: () => undefined,
    runTask: (request) => tasks.push(request),
    retrySetup: async () => undefined,
    worktreeEnv: () => ({}),
    chatsUsing: () => [{ panelId: 'p1', busy }],
    sessionsUsing: async () => ['s1', 's2'],
    leasedElsewhere: async (sessionId) => leased && sessionId === 's2',
    closeWorktree: async (worktreeId, key, stop) => {
      H.trail.push(`close:${worktreeId}:${key === rootKey({ projectKey: KEY, worktreeId })}`);
      H.trail.push(`root while asking:${roots.resolve(key) === undefined ? 'refused' : 'open'}`);
      if (!closeAnswer) return 'cancelled';
      if (!(await stop())) return 'refused';
      H.trail.push(`root once stopping:${roots.resolve(key) === undefined ? 'refused' : 'open'}`);
      return 'closed';
    },
    afterClose: (_id, removed) => H.trail.push(`afterClose:${removed}`),
    showProjectFolder: () => H.trail.push('showProjectFolder'),
    beginFinish: async (worktreeId, action) => {
      if (busyAtHold) return undefined;
      H.trail.push(`hold:${worktreeId}:${action}`);
      const hold = holds.add(worktreeId, { dispose: () => H.trail.push('release') });
      return finishHold({ call, stopped: () => false, worktreeId, hold, release: () => holds.release(hold) });
    },
    showTask: () => true,
    stopTask: (key) => H.trail.push(`stopTask:${key}`),
    projectRepositoryWhenReady: async () => PROJECT,
    worktreeChats: async () => new Map(),
    openConflicts: async (folder, files, branch) => {
      H.trail.push(`conflicts:${folder === PROJECT}:${files.join(',')}:${branch ?? ''}`);
    },
    publish: async () => undefined,
    targetFacts: () => ({ hasRemote: true, detached: false }),
    generateMessage: async () => 'generated',
    changed: () => undefined,
    reveal: async () => undefined,
    ...rest,
  });
}

beforeEach(() => {
  record = { id: 'abcd1234', kind: 'chat', projectPath: PROJECT, repositoryRoot: PROJECT, worktreeRoot: WT, workingFolder: WT, branch: 'damocles/fix', index: 1, baseCommit: 'a'.repeat(40), createdAt: 1 };
  H.trail.length = 0;
  H.folderState = 'worktree';
  H.removeError = undefined;
  H.applyOutcome = { kind: 'ok', files: ['a.ts', 'b.ts'] };
  H.uncommitted = [{ path: 'a.ts', letter: 'M' }];
  H.unmerged = [{ hash: 'b'.repeat(40), subject: 'Fix' }];
  H.contained = false;
  dialogs = [];
  dialogAnswers = [];
  notices = [];
  busy = false;
  leased = false;
  closeAnswer = true;
  busyAtHold = false;
  tasks = [];
  gitOutput = {};
});

describe('WorktreeController', () => {
  it('deletes a chat worktree in rule 14\'s order: confirm, close what runs there, then remove, then show the project folder', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
    await controller().finish(record.id, 'delete');
    expect(dialogs[0]).toEqual({ dialog: 'delete', path: WT, branch: 'damocles/fix', uncommitted: [{ path: 'a.ts', letter: 'M' }], submoduleChanges: [], unmergedCommits: H.unmerged, deleteBranchDefault: false, deleteBranchLocked: false });
    expect(H.trail).toEqual(['dialog:delete', 'close:abcd1234:true', 'root while asking:open', 'hold:abcd1234:delete', 'root once stopping:refused', 'remove:false:true', 'release', 'afterClose:true', 'showProjectFolder']);
  });

  it('pre-ticks Also delete branch only when no commit is unmerged and the branch tip is in the project folder\'s branch', async () => {
    H.unmerged = [];
    for (const [contained, ticked] of [[false, false], [true, true]] as const) {
      H.contained = contained;
      dialogs = [];
      dialogAnswers = [{ dialog: 'delete', choice: 'cancel', deleteBranch: false }];
      await controller().finish(record.id, 'delete');
      expect((dialogs[0] as { deleteBranchDefault: boolean }).deleteBranchDefault).toBe(ticked);
    }
  });

  it('names submodules with uncommitted work, and forces the remove only for what the confirmation listed', async () => {
    gitOutput = {
      submodule: ' 1234567 libs/a (heads/main)\n-89abcde libs/b',
      status: ['1 .M S.M. 160000 160000 160000 aaa aaa libs/a', '1 .M N... 100644 100644 100644 bbb bbb src/x.ts', '2 R. S..U 160000 160000 160000 ccc ccc R100 libs/c', 'libs/old', '? notes.txt', ''].join('\0'),
    };
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
    await controller().finish(record.id, 'delete');
    expect(dialogs[0]).toMatchObject({ submoduleChanges: [{ path: 'libs/a', letter: 'S' }, { path: 'libs/c', letter: 'S' }] });
    // a clean worktree with no submodule is removed without --force, so work appearing after the question makes git refuse
    H.trail.length = 0;
    H.uncommitted = [];
    gitOutput = {};
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: true }];
    await controller().finish(record.id, 'delete');
    expect(H.trail).toContain('remove:true:false');
  });

  it('keeps the worktree registered and its root open when git cannot remove it, names the path, and offers Retry', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: true }];
    H.removeError = new Error(`Could not remove the worktree ${WT}: Permission denied`);
    const worktrees = controller();
    await worktrees.finish(record.id, 'delete');
    expect(H.trail).toEqual(['dialog:delete', 'close:abcd1234:true', 'root while asking:open', 'hold:abcd1234:delete', 'root once stopping:refused', 'remove:true:true', 'release', 'afterClose:false']);
    expect(notices.at(-1)).toEqual({ severity: 'error', message: `Could not delete the worktree "${WT}": Could not remove the worktree ${WT}: Permission denied`, actions: ['Retry'] });
    expect(worktrees.busy(record.id)).toBe(false);
  });

  it('finishes the remove on Retry once git left the folder without its .git link, asking nothing again and keeping the branch choice', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: true }];
    H.removeError = new Error(`Could not remove the worktree ${WT}: Permission denied`);
    let clickRetry: (choice: string) => void = () => undefined;
    const worktrees = controller({
      notify: {
        info: async (message) => { notices.push({ severity: 'info', message, actions: [] }); return undefined; },
        warn: async () => undefined,
        error: (message, ...actions) => {
          notices.push({ severity: 'error', message, actions });
          return new Promise((resolve) => { clickRetry = resolve; });
        },
      },
    });
    await worktrees.finish(record.id, 'delete');
    // the held file's process ended; git had deleted the folder's contents and its .git link
    H.removeError = undefined;
    H.folderState = 'leftover';
    clickRetry('Retry');
    await vi.waitFor(() => expect(H.trail.filter((step) => step.startsWith('remove:'))).toEqual(['remove:true:true', 'remove:true:false']));
    expect(H.trail.filter((step) => step === 'dialog:delete')).toHaveLength(1);
    await vi.waitFor(() => expect(H.trail.at(-1)).toBe('showProjectFolder'));
    expect(notices).toHaveLength(1);
  });

  it('asks before a first Delete removes a folder git left without its .git link, and Cancel removes nothing', async () => {
    H.folderState = 'leftover';
    const asked: Array<{ severity: string; message: string; actions: readonly string[] }> = [];
    const reply: { choice: number | undefined } = { choice: undefined };
    const worktrees = controller({ ask: async (question) => { asked.push(question); return reply.choice; } });
    await worktrees.finish(record.id, 'delete');
    expect(asked).toEqual([expect.objectContaining({ severity: 'danger', message: `The folder of the worktree "${WT}" is no longer a git worktree. Delete it and everything in it?`, actions: ['Delete worktree'] })]);
    expect(dialogs).toEqual([]);
    expect(H.trail).toEqual([]);
    reply.choice = 0;
    await worktrees.finish(record.id, 'delete');
    expect(H.trail).toEqual(['close:abcd1234:true', 'root while asking:open', 'hold:abcd1234:delete', 'root once stopping:refused', 'remove:false:false', 'release', 'afterClose:true', 'showProjectFolder']);
  });

  it('stops before removing anything when the user cancels a question while closing', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
    closeAnswer = false;
    await controller().finish(record.id, 'delete');
    expect(H.trail).toEqual(['dialog:delete', 'close:abcd1234:true', 'root while asking:open', 'afterClose:false']);
  });

  it('refuses every finish action but Push while a chat using the worktree works, and Delete while another process holds one of its chats', async () => {
    busy = true;
    const worktrees = controller({ publish: async () => { H.trail.push('publish'); } });
    expect(worktrees.finishState(record)).toEqual({ busy: true, hasRemote: true, detachedTarget: false });
    await worktrees.finish(record.id, 'apply');
    expect(H.trail).toEqual([]);
    expect(notices.at(-1)?.message).toBe('A chat using this worktree is working. Try again once it is idle.');
    // Push branch writes nothing in the worktree (D33)
    await worktrees.finish(record.id, 'push');
    expect(H.trail).toEqual(['publish']);
    H.trail.length = 0;
    busy = false;
    leased = true;
    await worktrees.finish(record.id, 'delete');
    expect(H.trail).toEqual([]);
    expect(notices.at(-1)?.message).toBe('Another Damocles window has a chat of this worktree open, so the worktree was not deleted.');
  });

  it('says another action runs on the worktree, not that a chat works, while a finish action holds it', async () => {
    let answer!: (value: unknown) => void;
    const worktrees = controller({ askDialog: (() => new Promise<unknown>((resolve) => { answer = resolve; })) as AskWorktreeDialog });
    const deleting = worktrees.finish(record.id, 'delete');
    await vi.waitFor(() => expect(answer).toBeDefined());
    await worktrees.finish(record.id, 'apply');
    expect(notices.at(-1)?.message).toBe('Another action is running on this worktree. Try again once it ends.');
    answer({ dialog: 'delete', choice: 'cancel', deleteBranch: false });
    await deleting;
  });

  it('tells the user a Retry found the worktree gone, and never leaves its failure unhandled', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
    H.removeError = new Error('Permission denied');
    const worktrees = controller({
      notify: {
        info: async (message) => { notices.push({ severity: 'info', message, actions: [] }); return undefined; },
        warn: async () => undefined,
        error: async () => {
          record = { ...record, deletedAt: 5 };
          return 'Retry';
        },
      },
    });
    await worktrees.finish(record.id, 'delete');
    await vi.waitFor(() => expect(notices.at(-1)?.message).toBe('This worktree no longer exists.'));
  });

  it('refuses to run setup again in a project that is no longer trusted', async () => {
    const host = controller({ isTrusted: () => false, setupShell: () => ({ file: '/bin/bash', kind: 'posix' }) }).ui();
    expect(await host.runSetup({ worktreeId: record.id, cwd: record.workingFolder, commands: ['npm ci'], env: {} }, () => undefined)).toEqual({ exitCode: 1 });
    expect(tasks).toEqual([]);
    expect(notices.at(-1)).toMatchObject({ severity: 'error', message: 'Trust this folder to use worktrees' });
  });

  it('lists the other worktrees in Continue in a worktree when git fails for one of them', async () => {
    const other: ChatWorktreeRecord = { ...record, id: 'efgh5678', branch: 'damocles/other' };
    vi.mocked(lineChangesSinceBase).mockImplementationOnce(async () => {
      throw new Error('fatal: bad object');
    });
    const worktrees = controller({
      registry: { get: () => undefined, liveChatRecords: () => [record, other], records: () => [record, other] } as unknown as WorktreeRegistry,
    });
    expect((await worktrees.continueWorktrees({ fsPath: PROJECT })).map((row) => row.worktreeId)).toEqual(['efgh5678']);
  });

  it('generates for the merge dialog still open after an earlier one closed', async () => {
    const other: ChatWorktreeRecord = { ...record, id: 'efgh5678', branch: 'damocles/other' };
    const answers = new Map<string, (value: unknown) => void>();
    const generatedFor: string[] = [];
    const worktrees = controller({
      registry: {
        get: (id: string) => [record, other].find((candidate) => candidate.id === id),
        liveChatRecords: () => [record, other],
        records: () => [record, other],
      } as unknown as WorktreeRegistry,
      askDialog: ((dialog: { branch: string }) => new Promise<unknown>((resolve) => answers.set(dialog.branch, resolve))) as AskWorktreeDialog,
      generateMessage: async (target) => {
        generatedFor.push(target.branch);
        return 'generated';
      },
    });
    const first = worktrees.finish(record.id, 'merge');
    await vi.waitFor(() => expect(answers.has('damocles/fix')).toBe(true));
    const second = worktrees.finish(other.id, 'merge');
    await vi.waitFor(() => expect(answers.has('damocles/other')).toBe(true));
    answers.get('damocles/fix')!({ dialog: 'mergeMessage', choice: 'cancel', message: '' });
    await first;
    expect(await worktrees.generateForOpenDialog()).toEqual({ message: 'generated' });
    expect(generatedFor).toEqual(['damocles/other']);
    answers.get('damocles/other')!({ dialog: 'mergeMessage', choice: 'cancel', message: '' });
    await second;
    expect(await worktrees.generateForOpenDialog()).toBeNull();
  });

  it('applies into the project folder and shows it, names refused files, and opens Apply\'s conflicts with the worktree branch', async () => {
    await controller().finish(record.id, 'apply');
    expect(H.trail).toEqual(['hold:abcd1234:apply', 'apply', 'release', 'showProjectFolder']);
    expect(notices.at(-1)?.message).toBe('Applied 2 files to the project folder.');
    H.trail.length = 0;
    H.applyOutcome = { kind: 'refused', files: [{ path: 'a.ts', letter: 'M' }] };
    dialogAnswers = [{ dialog: 'refusal', choice: 'ok' }];
    await controller().finish(record.id, 'apply');
    expect(dialogs.at(-1)).toEqual({ dialog: 'refusal', action: 'apply', files: [{ path: 'a.ts', letter: 'M' }] });
    expect(H.trail).toEqual(['hold:abcd1234:apply', 'apply', 'release', 'dialog:refusal']);
    H.trail.length = 0;
    H.applyOutcome = { kind: 'conflicts', files: ['a.ts'] };
    await controller().finish(record.id, 'apply');
    expect(H.trail).toEqual(['hold:abcd1234:apply', 'apply', 'release', 'showProjectFolder', 'conflicts:true:a.ts:damocles/fix']);
  });

  it('asks for a commit message before merging uncommitted worktree files, and Generate fills it from the open dialog\'s worktree', async () => {
    let generated: unknown;
    const worktrees = controller();
    dialogAnswers = [{ dialog: 'mergeMessage', choice: 'cancel', message: '' }];
    const asking = controller({
      askDialog: (async (dialog: { dialog: string }) => {
        dialogs.push(dialog);
        generated = await asking.generateForOpenDialog();
        return { dialog: 'mergeMessage', choice: 'commit', message: 'Fix the login' };
      }) as AskWorktreeDialog,
    });
    await asking.finish(record.id, 'merge');
    expect(dialogs.at(-1)).toEqual({ dialog: 'mergeMessage', branch: 'damocles/fix', target: 'main', files: [{ path: 'a.ts', letter: 'M' }] });
    expect(H.trail).toEqual(['hold:abcd1234:merge', 'release', 'showProjectFolder']);
    expect(generated).toEqual({ message: 'generated' });
    expect(await worktrees.generateForOpenDialog()).toBeNull();
    expect(notices.at(-1)?.message).toBe('Merged damocles/fix into main.');
  });

  it('deletes a worktree removed outside Damocles without questions, keeping its branch, so Delete never fails on it', async () => {
    record = { ...record, worktreeRoot: path.join(WT, 'gone'), workingFolder: path.join(WT, 'gone') };
    await controller().finish(record.id, 'delete');
    expect(dialogs).toEqual([]);
    expect(H.trail).toEqual(['close:abcd1234:true', 'root while asking:open', 'hold:abcd1234:delete', 'root once stopping:refused', 'remove:false:false', 'release', 'afterClose:true', 'showProjectFolder']);
  });

  it('re-checks busy after the last question: a turn that started meanwhile refuses Delete before anything stops', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
    busyAtHold = true;
    await controller().finish(record.id, 'delete');
    expect(H.trail).toEqual(['dialog:delete', 'close:abcd1234:true', 'root while asking:open', 'afterClose:false']);
    expect(notices.at(-1)?.message).toBe('A chat using this worktree is working. Try again once it is idle.');
  });

  it('takes the hold after the merge question, so a turn started while it was open refuses the merge', async () => {
    dialogAnswers = [{ dialog: 'mergeMessage', choice: 'commit', message: 'Fix' }];
    busyAtHold = true;
    await controller().finish(record.id, 'merge');
    expect(H.trail).toEqual(['dialog:mergeMessage']);
    expect(notices.at(-1)?.message).toBe('A chat using this worktree is working. Try again once it is idle.');
  });

  it.each([
    ['Apply', 'apply' as const, []],
    ['Delete', 'delete' as const, [{ dialog: 'delete', choice: 'delete', deleteBranch: false }]],
  ])('fails %s visibly when the core holding the worktree stops before the action, and the next core refuses that hold', async (_name, action, answers) => {
    dialogAnswers = [...answers];
    // a core over the loopback, as main reaches it; its channel closes as a crash or reload closes it
    const holds = createFinishHolds();
    const { main, core } = createLoopback();
    const mainEndpoint = createMainEndpoint(main, () => undefined);
    const client = new CoreClient(mainEndpoint, (_view, attach) => attach());
    const endpoint = createCoreEndpoint(core, () => undefined);
    const call = coreCalls(recordRegistry(), holds);
    let given: string | undefined;
    endpoint.serve('worktree.beginFinish', ({ worktreeId }) => (given = holds.add(worktreeId, { dispose: () => H.trail.push('release') })));
    endpoint.serve('worktree.endFinish', ({ hold }) => holds.release(hold));
    endpoint.serve('worktrees.call', ({ method, args }) => call(method, args));
    let stopped = false;
    await controller({
      beginFinish: async (worktreeId, finishAction) => {
        const held = await client.beginWorktreeFinish(worktreeId, finishAction, () => stopped);
        H.trail.push(`hold:${worktreeId}:${finishAction}`);
        stopped = true;
        mainEndpoint.close('Damocles Core stopped');
        return held;
      },
    }).finish(record.id, action);
    expect(H.trail.some((step) => step === 'apply' || step.startsWith('remove:'))).toBe(false);
    expect(notices.at(-1)).toMatchObject({ severity: 'error', message: 'The Damocles engine stopped during the worktree action, so it may not have finished. Check the worktree and the project folder, then try again.' });
    const next = coreCalls(recordRegistry(), createFinishHolds());
    await expect(next(action === 'apply' ? 'apply' : 'removeWorktree', [record.id, given, { deleteBranch: false, force: false }])).rejects.toThrow('no longer holds the worktree');
    expect(H.trail.some((step) => step === 'apply' || step.startsWith('remove:'))).toBe(false);
  });

  it('runs no finish action in core without a hold core gave out for that worktree', async () => {
    const holds = createFinishHolds();
    const call = coreCalls(recordRegistry(), holds);
    const other = holds.add('zzzz9999', { dispose: () => undefined });
    await expect(call('apply', [record.id, other])).rejects.toThrow('no longer holds the worktree');
    const hold = holds.add(record.id, { dispose: () => undefined });
    holds.release(hold);
    await expect(call('updateFrom', [record.id, hold])).rejects.toThrow('no longer holds the worktree');
    expect(H.trail).toEqual([]);
  });

  it('tells the user when a buffer edited while the hold was taken stops the delete, and stops nothing', async () => {
    dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
    await controller({
      closeWorktree: async (_worktreeId, _key, stop) => ((await stop()) ? 'edited' : 'refused'),
    }).finish(record.id, 'delete');
    expect(H.trail).toEqual(['dialog:delete', 'hold:abcd1234:delete', 'release', 'afterClose:false']);
    expect(notices.at(-1)).toEqual({ severity: 'warn', message: 'A file of the worktree was edited while Damocles was deleting it, so the worktree was not deleted. Try again.', actions: [] });
  });

  it('offers no worktree without a repository source control opened for the project (D9, D30)', async () => {
    expect(await controller({ projectRepositoryWhenReady: async () => undefined }).options({ fsPath: PROJECT, name: 'alpha' })).toEqual({ available: false, reason: 'notGit' });
  });

  it('reports each setup command as it starts, from the Setup tab\'s command marks', async () => {
    const steps: unknown[] = [];
    const host = controller({ setupShell: () => ({ file: '/bin/bash', kind: 'posix' }) }).ui();
    const running = host.runSetup({ worktreeId: record.id, cwd: record.workingFolder, commands: ['npm ci', 'npm run build'], env: {} }, (step) => steps.push(step));
    const task = tasks[0]!;
    task.onCommandStart?.();
    task.onCommandStart?.();
    task.onExit(0);
    expect(await running).toEqual({ exitCode: 0 });
    expect(steps).toEqual([{ index: 1, total: 2, command: 'npm ci' }, { index: 2, total: 2, command: 'npm run build' }]);
  });

  it('stops the Setup tab of the worktree it runs in, and tells a hand-off\'s conflicts as Apply tells them', async () => {
    const host = controller({ setupShell: () => ({ file: '/bin/bash', kind: 'posix' }) }).ui();
    void host.runSetup({ worktreeId: record.id, cwd: record.workingFolder, commands: ['npm ci'], env: {} }, () => undefined);
    host.stopSetup(record.id);
    expect(H.trail).toEqual([`stopTask:${tasks[0]!.key}`]);
    H.trail.length = 0;
    await host.showApplyConflicts(record.id, ['a.ts']);
    expect(H.trail).toEqual(['conflicts:true:a.ts:damocles/fix']);
    expect(notices.at(-1)).toMatchObject({ severity: 'warn', message: 'There are merge conflicts. Please resolve them before committing your changes.' });
  });

  it.each([
    ['a failed action', async () => {
      vi.mocked(targetBranch).mockRejectedValueOnce(new Error('fatal: bad ref fe\u202Eat'));
      await controller().finish(record.id, 'merge');
    }],
    ['a refused merge', async () => {
      H.uncommitted = [];
      vi.mocked(mergeInto).mockResolvedValueOnce({ kind: 'refused', message: `${PROJECT}\u202E has an unfinished merge` });
      await controller().finish(record.id, 'merge');
    }],
    ['a refused update', async () => {
      vi.mocked(updateFrom).mockResolvedValueOnce({ kind: 'refused', message: 'error: fe\u202Eat cannot be updated' });
      await controller().finish(record.id, 'update');
    }],
    ['a failed delete', async () => {
      dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
      H.removeError = new Error('fatal: cannot remove fe\u202Eat');
      await controller().finish(record.id, 'delete');
    }],
  ])('shows the bidi controls in the error notice of %s as escapes', async (_name, act) => {
    await act();
    expect(notices.at(-1)?.severity).toBe('error');
    expect(notices.at(-1)?.message).toContain('\\u{202E}');
    expect(notices.at(-1)?.message).not.toContain('\u202E');
  });
});

describe('closing a worktree root', () => {
  function closer(answers: { tabs?: boolean; terminals?: boolean; terminalsOpened?: string[] | undefined; openedWhileStopping?: string; lateTerminal?: boolean; editedWhileStopping?: boolean }) {
    const trail: string[] = [];
    let terminals = ['t1'];
    let formatterExited!: () => void;
    const deps: CloseWorktreeDeps = {
      editor: {
        confirmCloseRoot: async (_key, answered) => {
          trail.push(answered ? 'tabs again' : 'tabs');
          return answers.tabs === false ? undefined : new Map([['d1', 'unsaved']]);
        },
        closeRoot: () => {
          trail.push(answers.editedWhileStopping ? 'tabs refused' : 'close tabs');
          return !answers.editedWhileStopping;
        },
      },
      terminals: {
        idsIn: () => terminals,
        confirmKill: async (ids) => {
          trail.push(`terminals:${ids.join(',')}`);
          if (answers.terminalsOpened) {
            terminals = [...terminals, ...answers.terminalsOpened];
            answers.terminalsOpened = undefined;
          }
          return ids.includes(answers.openedWhileStopping ?? '') ? answers.lateTerminal !== false : answers.terminals !== false;
        },
        kill: (id) => trail.push(`kill:${id}`),
      },
      closeChats: () => trail.push('close chats'),
      rootsChanged: () => trail.push('roots changed'),
      releaseFormatter: () => new Promise((resolve) => (formatterExited = () => resolve())),
      whenFolderReleased: async () => {
        trail.push('folder released');
      },
    };
    const stop = async (): Promise<boolean> => {
      trail.push('stop');
      if (answers.openedWhileStopping !== undefined) terminals = [...terminals, answers.openedWhileStopping];
      return true;
    };
    return { trail, deps, stop, formatterExited: () => formatterExited() };
  }

  it('asks every question before anything stops, so a Cancel at the terminal question leaves everything running', async () => {
    const cancelled = closer({ terminals: false });
    expect(await closeWorktreeRoot(cancelled.deps, 'k', cancelled.stop)).toBe('cancelled');
    expect(cancelled.trail).toEqual(['tabs', 'terminals:t1']);
    const tabs = closer({ tabs: false });
    expect(await closeWorktreeRoot(tabs.deps, 'k', tabs.stop)).toBe('cancelled');
    expect(tabs.trail).toEqual(['tabs']);
  });

  it('stops what runs there once every answer is in, and settles only after the formatter host exited', async () => {
    const run = closer({ terminalsOpened: ['t2'] });
    let done: string | undefined;
    const closing = closeWorktreeRoot(run.deps, 'k', run.stop).then((closed) => (done = closed));
    await vi.waitFor(() => expect(run.trail).toContain('folder released'));
    // a terminal opened while the question was open is asked about too
    expect(run.trail).toEqual(['tabs', 'terminals:t1', 'tabs again', 'terminals:t2', 'tabs again', 'stop', 'close tabs', 'close chats', 'kill:t1', 'kill:t2', 'roots changed', 'folder released']);
    expect(done).toBeUndefined();
    run.formatterExited();
    await closing;
    expect(done).toBe('closed');
  });

  it('asks about a terminal opened while the hold was taken before it kills it, and a Cancel there stops nothing', async () => {
    const kept = closer({ openedWhileStopping: 't3', lateTerminal: false });
    expect(await closeWorktreeRoot(kept.deps, 'k', kept.stop)).toBe('cancelled');
    expect(kept.trail).toEqual(['tabs', 'terminals:t1', 'tabs again', 'stop', 'terminals:t3']);
    const killed = closer({ openedWhileStopping: 't3' });
    const closing = closeWorktreeRoot(killed.deps, 'k', killed.stop);
    await vi.waitFor(() => expect(killed.trail).toContain('folder released'));
    killed.formatterExited();
    expect(await closing).toBe('closed');
    expect(killed.trail).toEqual(['tabs', 'terminals:t1', 'tabs again', 'stop', 'terminals:t3', 'close tabs', 'close chats', 'kill:t1', 'kill:t3', 'roots changed', 'folder released']);
  });

  it('reports a buffer edited while the hold was taken, and stops nothing', async () => {
    const edited = closer({ editedWhileStopping: true });
    expect(await closeWorktreeRoot(edited.deps, 'k', edited.stop)).toBe('edited');
    expect(edited.trail).toEqual(['tabs', 'terminals:t1', 'tabs again', 'stop', 'tabs refused']);
  });
});

describe('Delete with a dirty editor tab of the worktree', () => {
  it('saves the tab the user answers Save for, while the worktree is still a root, then removes the worktree', async () => {
    const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-wt-save-')));
    const platform = createFakePlatform();
    const paneAnswers: Array<number | undefined> = [];
    const ask = async (): Promise<number | undefined> => paneAnswers.shift();
    const t = (message: string, ...args: Array<string | number>): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
    record = { ...record, worktreeRoot: folder, workingFolder: folder };
    fs.writeFileSync(path.join(folder, 'b.ts'), 'disk');
    let worktrees!: WorktreeController;
    const documents = new DocumentService({
      projects: () => roots.all(),
      watchers: platform.fileWatchers,
      ask,
      t,
      log: () => undefined,
      pickSavePath: async () => undefined,
      backups: { changed: () => undefined, writeNow: async () => undefined, remove: () => undefined },
      settings: { locate: () => undefined, save: async () => ({ ok: false, error: 'unused', conflict: false }) },
    });
    const pane: EditorPane = new EditorPane({
      documents,
      settings: platform.settings,
      ask,
      t,
      log: () => undefined,
      restoreLayout: () => true,
      persist: () => undefined,
      flushBackups: async () => undefined,
      logsDir: path.join(folder, '..', 'logs'),
      sendState: () => undefined,
      sendDocument: () => undefined,
      sendCommand: () => undefined,
      sendFlush: (requestId) => {
        setImmediate(() => pane.flushed(requestId));
        return true;
      },
      focusTab: () => undefined,
      revealLine: () => undefined,
      showPane: () => undefined,
      hidePane: () => undefined,
      showPaneBeside: () => undefined,
      projects: () => roots.all(),
      copy: async () => undefined,
      reveal: async () => undefined,
      mention: async () => undefined,
      browser: () => undefined,
      warn: () => undefined,
      searchEditorClosed: () => undefined,
      reviewClosed: () => undefined,
      openChanges: async () => undefined,
      gitOf: () => undefined,
      worktreeBranch: () => undefined,
    });
    try {
      worktrees = controller({
        closeWorktree: (_worktreeId, key, stop) => closeWorktreeRoot({
          editor: pane,
          terminals: { idsIn: () => [], confirmKill: async () => true, kill: () => undefined },
          closeChats: () => undefined,
          rootsChanged: () => undefined,
          releaseFormatter: async () => undefined,
          whenFolderReleased: async () => undefined,
        }, key, stop),
      });
      const key = rootKey({ projectKey: KEY, worktreeId: record.id });
      const opened = await pane.openFromUser(key, 'b.ts');
      if (!opened.ok) throw new Error('not opened');
      const tab = pane.state().tabs.find((candidate) => candidate.id === opened.tabId)!;
      const document = documents.get(tab.documentId!) as TextDocument;
      pane.edit(document.id, { version: document.version, seq: 1, text: 'unsaved', overReload: false });
      dialogAnswers = [{ dialog: 'delete', choice: 'delete', deleteBranch: false }];
      paneAnswers.push(0);
      await worktrees.finish(record.id, 'delete');
      expect(fs.readFileSync(path.join(folder, 'b.ts'), 'utf8')).toBe('unsaved');
      expect(H.trail).toContain('remove:false:true');
      expect(pane.state().tabs).toEqual([]);
    } finally {
      pane.dispose();
      documents.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('mostRecentlyUsed', () => {
  it('orders worktrees by their chats\' latest activity, then the newer worktree', () => {
    const rows = [
      { worktreeId: 'old', lastActivity: 100, createdAt: 1 },
      { worktreeId: 'busy', lastActivity: 900, createdAt: 2 },
      { worktreeId: 'newer-idle', lastActivity: 100, createdAt: 5 },
      { worktreeId: 'recent', lastActivity: 500, createdAt: 3 },
    ];
    expect(mostRecentlyUsed(rows).map((row) => row.worktreeId)).toEqual(['busy', 'recent', 'newer-idle', 'old']);
  });
});
