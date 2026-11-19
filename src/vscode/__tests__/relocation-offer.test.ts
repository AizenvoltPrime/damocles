import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as vscode from 'vscode';
import { __trustEmitter } from 'vscode';
import { RELOCATION_NOTICE_CODES, RELOCATION_PAUSE_CODES, RELOCATION_REFUSAL_CODES, RELOCATION_WAIT_CODES, type MovedFromCandidate, type PreflightAnswer, type RelocationView } from '../../core/project-relocation/types';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { DECLINED_KEY, failureText, registerRelocationOffer, RelocationOffer } from '../relocation-offer';

type MockFolder = { uri: { fsPath: string; scheme: string }; name: string; index: number };

const OLD = path.resolve('/work/acme');
const TO = path.resolve('/clones/acme');
const folder = (fsPath: string, scheme = 'file'): MockFolder => ({ uri: { fsPath, scheme }, name: path.basename(fsPath), index: 0 });

function setWorkspaceFolders(folders: readonly MockFolder[]): void {
  (vscode.workspace as unknown as { workspaceFolders: readonly MockFolder[] }).workspaceFolders = folders;
}

function memento(): vscode.Memento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback) as T,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  } as vscode.Memento & { values: Map<string, unknown> };
}

const view = (state: RelocationView['state'], extra: Partial<RelocationView> = {}): RelocationView => ({
  id: 'r1', seq: 1, requestedBy: 'vscode', mode: 'merge', from: OLD, to: TO, state, step: 'hostState', progress: { done: 3, total: 3 }, chats: 3, ...extra,
});

// A ProjectRelocations whose relocation r1 runs to `outcomes[n]` on its n-th run (the relocate, then each retry).
function relocations(candidates: MovedFromCandidate[], outcomes: RelocationView[] = [view('coreDone')]) {
  const listeners = new Set<() => void>();
  let views: RelocationView[] = [];
  let runs = 0;
  const finishRun = (): void => {
    views = [view('running', { progress: { done: 0, total: 3 } })];
    setTimeout(() => {
      views = [outcomes[Math.min(runs++, outcomes.length - 1)]!];
      for (const listener of [...listeners]) listener();
    }, 0);
  };
  return {
    movedFrom: vi.fn(async (to: string) => (folderKey(to) === folderKey(TO) ? candidates : [])),
    preflight: vi.fn(async (): Promise<PreflightAnswer> => ({ ok: true, mode: 'merge', chats: 3, worktrees: 0, notices: [{ code: 'merge', params: { projectPath: TO } }] })),
    relocate: vi.fn(async () => {
      finishRun();
      return { id: 'r1' } as const;
    }),
    retry: vi.fn(async () => { finishRun(); }),
    abandon: vi.fn(async (): Promise<{ readonly code: string } | undefined> => {
      views = [];
      return undefined;
    }),
    views: () => views,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
}

// the mock's message functions answer undefined; a test answers with a button's label
type MessageSpy = MockInstance<(...args: unknown[]) => Promise<string | undefined>>;
let info: MessageSpy;
let error: MessageSpy;
let warning: MessageSpy;

beforeEach(() => {
  setWorkspaceFolders([folder(TO)]);
  info = vi.spyOn(vscode.window, 'showInformationMessage') as unknown as MessageSpy;
  error = vi.spyOn(vscode.window, 'showErrorMessage') as unknown as MessageSpy;
  warning = vi.spyOn(vscode.window, 'showWarningMessage') as unknown as MessageSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
  setWorkspaceFolders([]);
});

const answer = (spy: MessageSpy, ...answers: Array<string | undefined>): void => {
  for (const value of answers) spy.mockImplementationOnce(async () => value);
};
const messages = (spy: MessageSpy): unknown[] => spy.mock.calls.map((call) => call[0]);

describe('RelocationOffer', () => {
  it('asks once at activation for an opened folder of a missing folder\'s repository, and Move Chats merges its chats here', async () => {
    const fake = relocations([{ from: OLD, chats: 3 }]);
    const registered: Array<(...args: unknown[]) => unknown> = [];
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((_id, handler) => {
      registered.push(handler);
      return { dispose: () => undefined };
    });
    answer(info, 'Move Chats');
    registerRelocationOffer({ subscriptions: [], globalState: memento() } as unknown as vscode.ExtensionContext, fake);
    await vi.waitFor(() => expect(messages(info)).toContain(`Moved 3 chats of ${OLD} here.`));
    expect(info.mock.calls[0]).toEqual([`Move the chats of ${OLD} here?`, 'Move Chats', 'Not Now']);
    expect(fake.relocate).toHaveBeenCalledWith({ from: OLD, to: TO, listed: [TO] });
    expect(info).toHaveBeenCalledTimes(2);
    expect(registered).toHaveLength(1);
  });

  // core reads the opened folder's root commits only once the workspace is trusted, so a grant can find a match
  it('looks again when the workspace is trusted and offers what it finds, but never a pair the user declined', async () => {
    __trustEmitter.clear();
    const fake = relocations([]);
    const state = memento();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(() => ({ dispose: () => undefined }));
    // the activation's lookup, made while the folder was untrusted, is still running when the grant comes
    let untrustedLookup!: (found: MovedFromCandidate[]) => void;
    fake.movedFrom.mockImplementationOnce(() => new Promise((resolve) => { untrustedLookup = resolve; }));
    const context = { subscriptions: [] as vscode.Disposable[], globalState: state };
    registerRelocationOffer(context as unknown as vscode.ExtensionContext, fake);
    await vi.waitFor(() => expect(fake.movedFrom).toHaveBeenCalledTimes(1));

    fake.movedFrom.mockImplementation(async () => [{ from: OLD, chats: 3 }]);
    answer(info, 'Not Now');
    __trustEmitter.fire();
    await vi.waitFor(() => expect(state.values.get(DECLINED_KEY)).toEqual([`${folderKey(OLD)}\n${folderKey(TO)}`]));
    expect(info.mock.calls[0]).toEqual([`Move the chats of ${OLD} here?`, 'Move Chats', 'Not Now']);
    untrustedLookup([]);

    __trustEmitter.fire();
    await vi.waitFor(() => expect(fake.movedFrom).toHaveBeenCalledTimes(3));
    expect(info).toHaveBeenCalledTimes(1);
    for (const subscription of context.subscriptions) subscription.dispose();
    expect(__trustEmitter.cbs).toEqual([]);
  });

  it('remembers Not Now for the pair: a later check does not ask, the command asks again', async () => {
    const fake = relocations([{ from: OLD, chats: 3 }]);
    const state = memento();
    const offer = new RelocationOffer(fake, state);
    answer(info, 'Not Now');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(state.values.get(DECLINED_KEY)).toEqual([`${folderKey(OLD)}\n${folderKey(TO)}`]);
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(info).toHaveBeenCalledTimes(1);
    answer(info, undefined);
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], true);
    expect(info).toHaveBeenCalledTimes(2);
    expect(fake.relocate).not.toHaveBeenCalled();
  });

  it('asks nothing for a folder of another repository or a non-file folder, and the command says it found none', async () => {
    const fake = relocations([{ from: OLD, chats: 3 }]);
    const offer = new RelocationOffer(fake, memento());
    await offer.check([folder(path.resolve('/elsewhere')), folder(TO, 'vscode-remote')] as unknown as vscode.WorkspaceFolder[], false);
    expect(info).not.toHaveBeenCalled();
    expect(fake.movedFrom).toHaveBeenCalledTimes(1);
    await offer.check([folder(path.resolve('/elsewhere'))] as unknown as vscode.WorkspaceFolder[], true);
    expect(messages(info)).toEqual(['Damocles found no chats of a missing folder of this repository.']);
  });

  it('offers Retry when the move pauses, and Retry resumes the same relocation', async () => {
    const fake = relocations([{ from: OLD, chats: 3 }], [view('paused', { step: 'sessions', failure: { code: 'conflict', params: { path: 'x.jsonl' } } }), view('coreDone')]);
    const offer = new RelocationOffer(fake, memento());
    answer(info, 'Move Chats');
    answer(error, 'Retry');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(messages(error)).toEqual([`Damocles could not move the chats of ${OLD}: The move paused: x.jsonl is in the new place already with other content. Keep one copy, then retry.`]);
    expect(fake.relocate).toHaveBeenCalledTimes(1);
    expect(fake.retry).toHaveBeenCalledWith('r1');
    expect(messages(info)).toContain(`Moved 3 chats of ${OLD} here.`);
  });

  it('shows a refusal with Retry, which preflights again', async () => {
    const fake = relocations([{ from: OLD, chats: 1 }]);
    fake.relocate.mockImplementationOnce(async () => ({ refusal: { code: 'chatHeld', params: { sessionId: 's1', title: 'Fix it', holder: 'otherProcess' } } }) as never);
    const offer = new RelocationOffer(fake, memento());
    answer(info, 'Move Chats');
    answer(error, 'Retry');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(messages(error)[0]).toBe(`Damocles could not move the chats of ${OLD}: The chat "Fix it" is open in the Damocles app or another VS Code window. Close it there, then try again.`);
    expect(fake.relocate).toHaveBeenCalledTimes(2);
    expect(fake.retry).not.toHaveBeenCalled();
  });

  it('offers Stop Moving when the move pauses, which abandons it only once its warning is confirmed, and shows a refusal', async () => {
    const paused = view('paused', { step: 'sessions', failure: { code: 'conflict', params: { path: 'x.jsonl' } } });
    const fake = relocations([{ from: OLD, chats: 3 }], [paused]);
    const offer = new RelocationOffer(fake, memento());
    answer(info, 'Move Chats');
    answer(error, 'Stop Moving');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(error.mock.calls[0]!.slice(1)).toEqual(['Retry', 'Stop Moving']);
    expect(warning.mock.calls[0]).toEqual([`Stop moving the chats of ${OLD}?`, { modal: true, detail: `The chats already moved here stay here. The rest stay with ${OLD}, as do the memories and settings not moved yet, and Damocles: Move Chats Here can move them later. Nothing moves back.` }, 'Stop Moving']);
    expect(fake.abandon).not.toHaveBeenCalled();

    answer(info, 'Move Chats');
    answer(error, 'Stop Moving');
    answer(warning, 'Stop Moving');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(fake.abandon).toHaveBeenCalledWith('r1');
    expect(fake.retry).not.toHaveBeenCalled();

    fake.abandon.mockImplementationOnce(async () => ({ code: 'notPaused' }));
    answer(info, 'Move Chats');
    answer(error, 'Stop Moving');
    answer(warning, 'Stop Moving');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(messages(error).at(-1)).toBe(`The move of ${OLD} is no longer paused, so it was not stopped.`);
  });

  it('tells a finished move every step that waits: memories beside a repair waiting on trust', async () => {
    const untrusted = { code: 'untrusted', params: { count: 1 } };
    const fake = relocations([{ from: OLD, chats: 1 }], [view('coreDone', { chats: 1, step: 'repair', failure: untrusted, waiting: [untrusted, { code: 'memoryReadOnly', params: { reason: 'readOnly' } }] })]);
    const offer = new RelocationOffer(fake, memento());
    answer(info, 'Move Chats');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(messages(info)).toContain(`Moved 1 chat of ${OLD} here. Trust this folder to re-link its chat worktrees. The project's memories could not move yet: the memory database is read-only. Damocles tries again at its next start.`);
  });

  it('shows the notices of preflight in the offer, and a refusal instead of asking', async () => {
    const fake = relocations([{ from: OLD, chats: 3 }]);
    const notices = [{ code: 'merge', params: { projectPath: TO } }, { code: 'worktreesNotRelinkable', params: { count: 1, branches: 'damocles/a' } }];
    fake.preflight.mockImplementationOnce(async () => ({ ok: true, mode: 'merge', chats: 3, worktrees: 1, notices }));
    const offer = new RelocationOffer(fake, memento());
    answer(info, undefined);
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(info.mock.calls[0]).toEqual([`Move the chats of ${OLD} here? The new folder's repository does not know these chat worktrees, so they can't be linked to it: damocles/a. You can delete them after the move.`, 'Move Chats', 'Not Now']);

    fake.preflight.mockImplementationOnce(async () => ({ ok: false, refusal: { code: 'fromExists' } }));
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(info).toHaveBeenCalledOnce();
    expect(messages(error)).toEqual([`Damocles could not move the chats of ${OLD}: ${OLD} exists again, so its chats stay with it.`]);

    fake.preflight.mockImplementationOnce(async () => { throw new Error('registry read failed'); });
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(messages(error).at(-1)).toBe(`Damocles could not move the chats of ${OLD}: registry read failed`);
    expect(info).toHaveBeenCalledOnce();
    expect(fake.relocate).not.toHaveBeenCalled();
  });

  it('never shows a second offer for a pair whose offer is unanswered, and the command counts it as found', async () => {
    const fake = relocations([{ from: OLD, chats: 3 }]);
    const offer = new RelocationOffer(fake, memento());
    info.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    void offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    await vi.waitFor(() => expect(info).toHaveBeenCalledOnce());
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], true);
    expect(info).toHaveBeenCalledOnce();
    expect(fake.movedFrom).toHaveBeenCalledTimes(2);
  });

  it('renders every refusal, pause, waiting and notice code in words of its own', () => {
    const unknown = (code: string): string => failureText({ code: 'someLaterCode' }, OLD).replace('someLaterCode', code);
    const params = { path: 'x', errno: 'EIO', count: 2, branch: 'b', branches: 'b', title: 't', holder: 'otherProcess', reason: 'readOnly', root: 'r', projectPath: 'p' };
    for (const code of [...RELOCATION_REFUSAL_CODES, ...RELOCATION_PAUSE_CODES, ...RELOCATION_WAIT_CODES, ...RELOCATION_NOTICE_CODES]) {
      const text = failureText({ code, params }, OLD);
      expect(text, code).not.toBe(unknown(code));
    }
    expect(failureText({ code: 'agentRunHeld', params: { title: 'Plan', holder: 'thisProcess' } }, OLD)).toBe('A subagent or team of the chat "Plan" is still running in this window. Wait for it to finish, then try again.');
    expect(failureText({ code: 'agentRunning', params: { sessionId: 's1' } }, OLD)).toBe(`The move paused: a subagent or team of a chat of ${OLD} is still running. Wait for it to finish, then retry.`);
  });

  it('tells a finished move whose worktree repair waits on trust', async () => {
    const fake = relocations([{ from: OLD, chats: 1 }], [view('coreDone', { chats: 1, step: 'repair', failure: { code: 'untrusted', params: { count: 1 } } })]);
    const offer = new RelocationOffer(fake, memento());
    answer(info, 'Move Chats');
    await offer.check([folder(TO)] as unknown as vscode.WorkspaceFolder[], false);
    expect(messages(info)).toContain(`Moved 1 chat of ${OLD} here. Trust this folder to re-link its chat worktrees.`);
  });
});
