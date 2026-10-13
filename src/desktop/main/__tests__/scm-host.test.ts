import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StructuredCompletionRequest } from '../../../core/pi-session/structured-completion';
import type { CommitHooks, ProjectView, ScmEvent, ScmService } from '../../../core/scm/scm-service';
import type { Change, Repository, RepositoryStatus } from '../../../core/scm/repository';
import { SCM_SETTING_KEYS } from '../../../core/scm/settings-keys';
import type { ScmChangesTab, ScmSetInput, ScmShellCommand, ScmView } from '../../preload/scm-channels';
import type { InputRequest } from '../../preload/overlay-channels';
import type { EditorPane } from '../editor-pane';
import type { MessageQuestion } from '../message-dialog';
import { backgroundCompletion, ScmHost, type ScmHostDeps, type SubCallRuntime } from '../scm/scm-host';

const projectPath = path.resolve('/work/project');
const nestedRoot = path.join(projectPath, 'nested');

const modified: Change = { path: 'src/a.ts', status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false };
const stagedChange: Change = { path: 'src/staged.ts', status: 'INDEX_MODIFIED', letter: 'M', tone: 'modified', strike: false };
const status: RepositoryStatus = {
  head: { type: 'branch', name: 'main' },
  commit: { hash: 'abc', subject: 'first' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [modified], untracked: [] },
  tooManyChanges: false,
  submodules: [],
};
const PLAIN = { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false } as const;

// confinedEntry fails as fs.realpath does for a path whose folder is gone
function fakeRepo(root: string, repoStatus: RepositoryStatus = status, show: Repository['show'] = async () => Buffer.from('index text'), gone: readonly string[] = []): Repository {
  return {
    root,
    lastStatus: repoStatus,
    confinedEntry: async (relative: string) => {
      if (gone.some((folder) => relative.startsWith(`${folder}/`))) throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${relative}'`), { code: 'ENOENT' });
      return path.join(root, ...relative.split('/'));
    },
    show,
    diff: async () => ({ kind: 'patch', patch: '' }),
    commitTemplate: async () => 'template text',
  } as unknown as Repository;
}

interface SetupOptions {
  commit?: ScmService['commit'];
  commitInput?: ScmService['commitInput'];
  complete?: ScmHostDeps['complete'];
  settings?: Record<string, unknown>;
  // the document service's unsaved files, by absolute path
  dirty?: readonly string[];
  // the status core reads before the save prompt
  current?: RepositoryStatus;
  answers?: Array<number | undefined>;
  inputs?: Array<string | undefined>;
  activeFile?: string;
  undo?: Awaited<ReturnType<ScmService['undoLastCommit']>>;
  // the project folder as registered, and the realpath core resolved for it
  projectFolder?: string;
  real?: string;
  status?: RepositoryStatus;
  show?: Repository['show'];
  // folders of repo-1 that no longer exist
  gone?: readonly string[];
  platform?: NodeJS.Platform;
  changesTabs?: Array<{ tabId: string; state: { title: string; changes: ScmChangesTab } }>;
}

function setup(overrides: SetupOptions = {}) {
  const view: ProjectView = {
    projectKey: 'p',
    state: 'ready',
    repos: [{ repoId: 'repo-2', root: nestedRoot, kind: 'nested' }, { repoId: 'repo-1', root: projectPath, kind: 'root' }],
    closedRoots: [],
    unsafe: [],
    parents: [],
  };
  const repos = new Map([['repo-1', fakeRepo(projectPath, overrides.status, overrides.show, overrides.gone)], ['repo-2', fakeRepo(nestedRoot)]]);
  const coreListeners: Array<(event: ScmEvent) => void> = [];
  const settingListeners: Array<() => void> = [];
  const service = {
    onDidChange: (listener: (event: ScmEvent) => void) => {
      coreListeners.push(listener);
      return { dispose: () => undefined };
    },
    projectRealPath: () => overrides.real,
    projectKeys: () => ['p'],
    view: (key: string) => (key === 'p' ? view : undefined),
    snapshot: (repoId: string) => (repos.has(repoId) ? { repoId, projectKey: 'p', status, busy: false } : undefined),
    repository: (repoId: string) => (repos.has(repoId) ? { repo: repos.get(repoId)!, projectKey: 'p', projectPath, kind: 'root' } : undefined),
    decorations: () => ({}),
    commit: vi.fn(overrides.commit ?? (async () => ({ ok: true }))),
    currentStatus: async () => overrides.current ?? status,
    commitInput: overrides.commitInput ?? (async () => ({ template: 'template text', history: ['older'], headMessage: 'first' })),
    undoLastCommit: async () => overrides.undo ?? { kind: 'undone', message: 'Undone subject\n\nbody' },
    move: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } as unknown as ScmService;
  const sent = { views: [] as ScmView[], settings: 0, states: 0 };
  let menuChanges = 0;
  const settingValues = new Map(Object.entries(overrides.settings ?? {}));
  const questions: MessageQuestion[] = [];
  const answers = [...(overrides.answers ?? [])];
  const inputRequests: InputRequest[] = [];
  const inputs = [...(overrides.inputs ?? [])];
  const setInputs: ScmSetInput[] = [];
  const commands: ScmShellCommand[] = [];
  const gitLog: string[] = [];
  const saved = new Map<string, string>();
  const notices: Array<{ severity: string; message: string; actions: string[] }> = [];
  const copied: string[] = [];
  const editorPane = {
    onDidChangeActiveContext: () => ({ dispose: () => undefined }),
    activeContext: () => (overrides.activeFile !== undefined ? { filePath: overrides.activeFile, selection: undefined } : undefined),
    showDiff: vi.fn(async () => ({ close: () => undefined })),
    changesTabs: () => overrides.changesTabs ?? [],
    updateChanges: vi.fn(),
    closeChanges: vi.fn(async () => undefined),
    showChanges: vi.fn(),
    openInBackground: vi.fn(async () => undefined),
    openReadOnly: vi.fn(),
    openPlaceholder: vi.fn(),
    openFromUser: vi.fn(async () => ({ ok: true })),
    openPath: vi.fn(async () => undefined),
    closeScmDiffs: vi.fn(async () => undefined),
    closeUnmodified: vi.fn(async () => undefined),
    dirtyFiles: async () => (overrides.dirty ?? []).map((file, index) => ({ documentId: `doc-${index}`, path: file })),
    saveDocuments: vi.fn(async () => true),
    fileRenamed: vi.fn(async (_projectKey: string, _from: string, renameOnDisk: () => Promise<unknown>) => renameOnDisk()),
    closeActive: vi.fn(async () => undefined),
  } as unknown as EditorPane;
  const notify = (severity: string) => async (message: string, ...actions: string[]) => {
    notices.push({ severity, message, actions });
    return undefined;
  };
  const host = new ScmHost({
    service,
    settings: {
      get: (key: string) => settingValues.get(key),
      onDidChange: (_section: string, listener: () => void) => {
        settingListeners.push(listener);
        return { dispose: () => undefined };
      },
    } as never,
    projects: () => [{ key: 'p', fsPath: overrides.projectFolder ?? projectPath }] as never,
    selectedProjectKey: () => 'p',
    editorPane,
    selection: { get: (key) => saved.get(key), set: (key, root) => void saved.set(key, root) },
    notify: { info: notify('info'), warn: notify('warn'), error: notify('error') },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    showGitLog: () => undefined,
    copy: async (text) => void copied.push(text),
    reveal: async () => undefined,
    openExternal: async () => undefined,
    pickFolder: async () => undefined,
    quickPick: async () => undefined,
    ask: async (question) => {
      questions.push(question);
      return answers.shift();
    },
    askInput: async (request) => {
      inputRequests.push(request);
      return inputs.shift();
    },
    mention: async () => undefined,
    complete: overrides.complete ?? (async () => ({ kind: 'unreachable' })),
    send: {
      view: (view) => void sent.views.push(view),
      state: () => void sent.states++,
      decorations: () => undefined,
      settings: () => void sent.settings++,
      command: (command) => void commands.push(command),
      setInput: (input) => void setInputs.push(input),
      filesChanged: () => undefined,
    },
    menuChanged: () => void menuChanges++,
    log: () => undefined,
    gitLog: (line) => void gitLog.push(line),
    platform: overrides.platform ?? process.platform,
  });
  const emit = (event: ScmEvent): void => {
    for (const listener of coreListeners) listener(event);
  };
  const settingsChanged = (): void => {
    for (const listener of settingListeners) listener();
  };
  return { host, saved, notices, copied, editorPane, service, questions, inputRequests, setInputs, commands, gitLog, repos, sent, emit, settingsChanged, menuChanges: () => menuChanges };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('source control host', () => {
  it('selects the repository holding the project folder by default, and a selection persists by root path', () => {
    const { host, saved } = setup();
    expect(host.state().views[0]!.selectedRepoId).toBe('repo-1');
    host.select({ projectKey: 'p', repoId: 'repo-2' });
    expect(saved.get('p')).toBe(nestedRoot);
    expect(host.state().views[0]!.selectedRepoId).toBe('repo-2');
    expect(() => host.select({ projectKey: 'p', repoId: 'repo-1', extra: 1 })).toThrow();
  });

  it('refuses a malformed request before anything runs and answers unknown for an id main never issued', async () => {
    const { host } = setup();
    await expect(host.run({ op: 'stage', repoId: 'repo-1', paths: ['../outside'] })).rejects.toThrow();
    await expect(host.run({ op: 'stage', repoId: 'repo-1', paths: ['/abs'] })).rejects.toThrow();
    await expect(host.run({ op: 'nope' })).rejects.toThrow();
    expect(await host.run({ op: 'refresh', repoId: 'repo-9' })).toEqual({ ok: false, reason: 'unknown' });
  });

  it('refuses a path segment Windows would resolve to another entry, on Windows only, before anything runs', async () => {
    const platform = process.platform;
    const onPlatform = (value: NodeJS.Platform): void => void Object.defineProperty(process, 'platform', { value, configurable: true });
    const { host } = setup();
    try {
      for (const unsafe of ['con', 'src/a.ts:stream', 'src/trailing.', 'nul.txt']) {
        onPlatform('win32');
        await expect(host.run({ op: 'stage', repoId: 'repo-1', paths: [unsafe] }), unsafe).rejects.toThrow();
        await expect(host.fileDiff({ repoId: 'repo-1', source: { kind: 'workingTree' }, path: unsafe }), unsafe).rejects.toThrow();
        onPlatform('linux');
        await expect(host.fileDiff({ repoId: 'repo-1', source: { kind: 'workingTree' }, path: unsafe }), unsafe).resolves.toEqual({ kind: 'patch', patch: '' });
      }
    } finally {
      onPlatform(platform);
    }
  });

  it('copies only a path of the repository\'s status, composed by main', async () => {
    const { host, copied } = setup();
    await host.copy({ repoId: 'repo-1', kind: 'path', value: 'src/a.ts' });
    await host.copy({ repoId: 'repo-1', kind: 'relativePath', value: 'src/a.ts' });
    expect(copied).toEqual([path.join(projectPath, 'src', 'a.ts'), ['src', 'a.ts'].join(path.sep)]);
    await expect(host.copy({ repoId: 'repo-1', kind: 'path', value: 'other.ts' })).rejects.toThrow();
    await expect(host.copy({ repoId: 'repo-1', kind: 'path', value: 'src/a.ts\ncurl x' })).rejects.toThrow();
  });

  it('posts a notice with Show Git Output for a failed commit only; the shell shows the other reasons inline', async () => {
    const nothing = setup({ commit: async () => ({ ok: false, reason: 'nothingToCommit' }) });
    expect(await nothing.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toEqual({ ok: false, reason: 'nothingToCommit' });
    expect(nothing.notices).toEqual([]);
    expect(nothing.setInputs).toEqual([]);
    const failed = setup({ commit: async () => ({ ok: false, reason: 'failed', error: new Error('hook said no') }) });
    expect(await failed.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toEqual({ ok: false, reason: 'failed' });
    expect(failed.notices).toEqual([{ severity: 'error', message: 'hook said no', actions: ['Show Git Output'] }]);
  });

  it('refuses a commit without a well-formed variant before anything runs', async () => {
    const { host, service } = setup();
    await expect(host.commit({ repoId: 'repo-1', message: 'x' })).rejects.toThrow();
    await expect(host.commit({ repoId: 'repo-1', message: 'x', variant: { ...PLAIN, scope: 'everything' } })).rejects.toThrow();
    await expect(host.commit({ repoId: 'repo-1', message: 'x', variant: { ...PLAIN, amend: 'yes' } })).rejects.toThrow();
    await expect(host.commit({ repoId: 'repo-1', message: 'x', variant: { ...PLAIN, extra: true } })).rejects.toThrow();
    expect(vi.mocked(service.commit)).not.toHaveBeenCalled();
  });

  it('puts the template in the box after a commit, and notes once per run that push and sync act as none', async () => {
    const { host, setInputs, gitLog } = setup({ settings: { [SCM_SETTING_KEYS.postCommitCommand]: 'push' } });
    const commitInput = { template: 'template text', history: ['older'], headMessage: 'first' };
    expect(await host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toEqual({ ok: true, message: 'template text', commitInput });
    expect(await host.commit({ repoId: 'repo-1', message: 'y', variant: PLAIN })).toEqual({ ok: true, message: 'template text', commitInput });
    // the commit's reply carries the box's text, which no separate message could race
    expect(setInputs).toEqual([]);
    expect(gitLog).toHaveLength(1);
    expect(gitLog[0]).toContain('"push"');
    expect(setup().gitLog).toEqual([]);
  });

  it('asks to save an unsaved changed file first: Commit Changes commits as it is, Save All saves and passes the saved paths, Cancel commits nothing', async () => {
    const file = path.join(projectPath, 'src', 'a.ts');
    const plain = setup({ dirty: [file, path.resolve('/elsewhere/b.ts')], answers: [1] });
    expect(await plain.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toMatchObject({ ok: true });
    expect(plain.questions).toEqual([{
      severity: 'warning',
      message: 'The following file has unsaved changes which won\'t be included in the commit if you proceed: a.ts.',
      detail: 'Would you like to save it before committing?',
      actions: ['Save All & Commit Changes', 'Commit Changes'],
      cancelLabel: 'Cancel',
      defaultAction: 0,
    }]);
    expect(vi.mocked(plain.service.commit).mock.calls[0]![3]).toMatchObject({ saved: [] });
    expect(vi.mocked(plain.editorPane.saveDocuments)).not.toHaveBeenCalled();

    const save = setup({ dirty: [file], answers: [0] });
    await save.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    expect(vi.mocked(save.editorPane.saveDocuments)).toHaveBeenCalledWith(['doc-0']);
    expect(vi.mocked(save.service.commit).mock.calls[0]![3]).toMatchObject({ saved: [file] });

    const cancel = setup({ dirty: [file], answers: [undefined] });
    expect(await cancel.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toEqual({ ok: false, reason: 'cancelled' });
    expect(vi.mocked(cancel.service.commit)).not.toHaveBeenCalled();
  });

  it('asks about staged files only at staged or when something is staged, and never at never or for Commit Empty', async () => {
    const changed = path.join(projectPath, 'src', 'a.ts');
    const staged = path.join(projectPath, 'src', 'staged.ts');
    const withIndex: RepositoryStatus = { ...status, groups: { ...status.groups, index: [stagedChange] } };
    const indexed = setup({ dirty: [changed, staged], current: withIndex, answers: [1] });
    await indexed.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    expect(indexed.questions[0]!.message).toContain(': staged.ts.');

    const stagedMode = setup({ dirty: [changed], settings: { [SCM_SETTING_KEYS.promptToSaveFilesBeforeCommit]: 'staged' } });
    await stagedMode.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    expect(stagedMode.questions).toEqual([]);

    const many = setup({ dirty: [changed, path.join(projectPath, 'b.ts')], answers: [1] });
    await many.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    expect(many.questions[0]).toMatchObject({ message: 'There are 2 unsaved files.', detail: 'Would you like to save them before committing?' });

    const never = setup({ dirty: [changed], settings: { [SCM_SETTING_KEYS.promptToSaveFilesBeforeCommit]: 'never' } });
    await never.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    const empty = setup({ dirty: [changed] });
    await empty.host.commit({ repoId: 'repo-1', message: 'x', variant: { ...PLAIN, empty: true } });
    expect([...never.questions, ...empty.questions]).toEqual([]);
  });

  it('asks for a new branch\'s name with branchPrefix filled in and the caret after it', async () => {
    let hooks: CommitHooks | undefined;
    const { host, inputRequests } = setup({
      settings: { [SCM_SETTING_KEYS.branchPrefix]: 'me/' },
      inputs: ['me/topic'],
      commit: async (_repoId, _message, _variant, given) => {
        hooks = given;
        return { ok: true };
      },
    });
    await host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    expect(await hooks!.branchName!()).toBe('me/topic');
    expect(inputRequests).toEqual([{ title: 'Commit to a New Branch', prompt: 'Please provide a new branch name', placeholder: 'Branch name', value: 'me/', valueSelection: [3, 3], validation: 'branchName' }]);
  });

  it('puts the undone commit\'s message and the template back in the box, and warns when HEAD has no commit', async () => {
    const { host, setInputs } = setup();
    expect(await host.run({ op: 'undoLastCommit', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(await host.run({ op: 'restoreCommitTemplate', repoId: 'repo-1' })).toEqual({ ok: true });
    const commitInput = { template: 'template text', history: ['older'], headMessage: 'first' };
    expect(setInputs).toEqual([{ repoId: 'repo-1', message: 'Undone subject\n\nbody', cause: 'undo', commitInput }, { repoId: 'repo-1', message: 'template text', cause: 'template' }]);
    const none = setup({ undo: { kind: 'noCommit' } });
    expect(await none.host.run({ op: 'undoLastCommit', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(none.notices).toEqual([{ severity: 'warn', message: 'Can\'t undo because HEAD doesn\'t point to any commit.', actions: [] }]);
    expect(none.setInputs).toEqual([]);
    await expect(host.run({ op: 'undoLastCommit', repoId: 'repo-1', extra: 1 })).rejects.toThrow();
  });

  it('reports a commit that landed although the commit input could not be read afterwards, leaving that read to the shell', async () => {
    const { host, setInputs } = setup({ commitInput: () => Promise.reject(new Error('HEAD unreadable')) });
    expect(await host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toEqual({ ok: true, message: '' });
    expect(setInputs).toEqual([]);
  });

  it('answers the commit box inputs for a known repository, and nothing for one main no longer knows', async () => {
    const { host } = setup();
    expect(await host.commitInput({ repoId: 'repo-1' })).toEqual({ template: 'template text', history: ['older'], headMessage: 'first' });
    expect(await host.commitInput({ repoId: 'repo-9' })).toEqual({ template: null, history: [], headMessage: null });
    await expect(host.commitInput({ repoId: 1 })).rejects.toThrow();
  });

  it('sends a palette commit with its variant to the shell, and shows allowNoVerifyCommit to the shell and the palette', () => {
    const { host, commands } = setup({ settings: { [SCM_SETTING_KEYS.allowNoVerifyCommit]: true } });
    host.paletteCommit({ ...PLAIN, scope: 'all', noVerify: true });
    expect(commands).toEqual([{ command: 'commit', repoId: 'repo-1', variant: { ...PLAIN, scope: 'all', noVerify: true } }]);
    expect(host.state().settings.allowNoVerifyCommit).toBe(true);
    expect(host.menuState().allowNoVerifyCommit).toBe(true);
    expect(setup().host.menuState().allowNoVerifyCommit).toBe(false);
  });

  it('renames the active file through git mv after asking for the new path, its tabs following the file', async () => {
    const { host, inputRequests, service, editorPane } = setup({ activeFile: path.join(projectPath, 'src', 'a.ts'), inputs: [' src/b.ts '] });
    host.activeFile('rename');
    await vi.waitFor(() => expect(vi.mocked(service.move)).toHaveBeenCalled());
    expect(inputRequests[0]).toMatchObject({ value: 'src/a.ts', valueSelection: [4, 8], validation: 'path' });
    expect(vi.mocked(service.move)).toHaveBeenCalledWith('repo-1', 'src/a.ts', 'src/b.ts');
    expect(vi.mocked(editorPane.fileRenamed).mock.calls[0]!.slice(0, 2)).toEqual(['p', 'src/a.ts']);
  });

  it('refuses Delete on a file with uncommitted changes, and otherwise runs git rm and closes its clean tab', async () => {
    const changed = setup({ activeFile: path.join(projectPath, 'src', 'a.ts') });
    changed.host.activeFile('delete');
    await vi.waitFor(() => expect(changed.notices).toHaveLength(1));
    expect(changed.notices[0]).toEqual({ severity: 'info', message: 'Git: Delete can only be performed on committed files without uncommitted changes.', actions: [] });
    expect(vi.mocked(changed.service.remove)).not.toHaveBeenCalled();

    const clean = setup({ activeFile: path.join(projectPath, 'src', 'clean.ts') });
    clean.host.activeFile('delete');
    await vi.waitFor(() => expect(vi.mocked(clean.editorPane.closeActive)).toHaveBeenCalledWith({ cleanOnly: true }));
    expect(vi.mocked(clean.service.remove)).toHaveBeenCalledWith('repo-1', ['src/clean.ts']);
  });

  it('opens a working tree change as a diff of its index side and the file', async () => {
    const { host, editorPane } = setup();
    expect(await host.run({ op: 'openChanges', repoId: 'repo-1', path: 'src/a.ts', group: 'workingTree' })).toEqual({ ok: true });
    const [title, file, left, right] = vi.mocked(editorPane.showDiff).mock.calls[0]!;
    expect(title('a.ts')).toBe('a.ts (Working Tree)');
    expect(title('renamed.ts')).toBe('renamed.ts (Working Tree)');
    expect(file).toBe(path.join(projectPath, 'src', 'a.ts'));
    expect(left).toEqual({ name: 'a.ts', content: 'index text' });
    expect(right).toEqual({ path: path.join(projectPath, 'src', 'a.ts') });
    expect(vi.mocked(editorPane.showDiff).mock.calls[0]![4]).toEqual({ focus: true, scm: { root: projectPath, repoId: 'repo-1' } });
  });
});

describe('source control host: deleted, gone and linked', () => {
  const deleted: Change = { path: 'gone/x.ts', status: 'DELETED', letter: 'D', tone: 'deleted', strike: true };
  const withDeleted: RepositoryStatus = { ...status, groups: { ...status.groups, workingTree: [modified, deleted] } };

  it('opens a deleted change whose folder is gone as its HEAD side, and copies its path', async () => {
    const { host, editorPane, notices, copied } = setup({ status: withDeleted, gone: ['gone'] });
    expect(await host.run({ op: 'openChanges', repoId: 'repo-1', path: 'gone/x.ts', group: 'workingTree' })).toEqual({ ok: true });
    expect(vi.mocked(editorPane.openReadOnly)).toHaveBeenCalledWith('x.ts (Deleted)', 'index text', 'x.ts');
    await host.copy({ repoId: 'repo-1', kind: 'path', value: 'gone/x.ts' });
    await host.copy({ repoId: 'repo-1', kind: 'relativePath', value: 'gone/x.ts' });
    expect(copied).toEqual([path.join(projectPath, 'gone', 'x.ts'), ['gone', 'x.ts'].join(path.sep)]);
    expect(notices).toEqual([]);
  });

  it('answers a repository it no longer has without rejecting: no diff, no copy, no selection', async () => {
    const { host, copied, saved } = setup();
    expect(await host.fileDiff({ repoId: 'repo-9', source: { kind: 'workingTree' }, path: 'src/a.ts' })).toEqual({ kind: 'missing' });
    await expect(host.copy({ repoId: 'repo-9', kind: 'path', value: 'src/a.ts' })).resolves.toBeUndefined();
    expect(() => host.select({ projectKey: 'p', repoId: 'repo-9' })).not.toThrow();
    expect(() => host.select({ projectKey: 'q', repoId: 'repo-1' })).not.toThrow();
    expect(copied).toEqual([]);
    expect(saved.size).toBe(0);
    expect(await host.fileDiff({ repoId: 'repo-1', source: { kind: 'workingTree' }, path: 'src/a.ts' })).toEqual({ kind: 'patch', patch: '' });
  });

  it('closes the changes tabs of a repository core disposed, and keeps the others current', async () => {
    const entries = { repoId: 'repo-1', source: { kind: 'workingTree' as const }, entries: [] };
    const { emit, editorPane } = setup({ changesTabs: [{ tabId: 't-1', state: { title: 'project: Changes', changes: entries } }, { tabId: 't-9', state: { title: 'old: Changes', changes: { ...entries, repoId: 'repo-9' } } }] });
    emit({ kind: 'repository', repoId: 'repo-9' });
    emit({ kind: 'repository', repoId: 'repo-1' });
    await tick();
    expect(vi.mocked(editorPane.closeChanges).mock.calls).toEqual([['repo-9']]);
    expect(vi.mocked(editorPane.updateChanges).mock.calls).toEqual([['t-1', { title: 'project: Changes', changes: { ...entries, entries: [{ path: 'src/a.ts', status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false }] } }]]);
  });

  it('works through a project folder that is a link to the repository root', async () => {
    const link = path.resolve('/links/project');
    const { host, editorPane, service, copied } = setup({ projectFolder: link, real: projectPath, activeFile: path.join(projectPath, 'src', 'a.ts'), inputs: ['src/b.ts'] });
    const view = host.state().views[0]!;
    expect(view.repos.map((repo) => repo.displayPath)).toEqual(['nested', '']);
    expect(view.selectedRepoId).toBe('repo-1');
    await host.copy({ repoId: 'repo-1', kind: 'relativePath', value: 'src/a.ts' });
    expect(copied).toEqual([['src', 'a.ts'].join(path.sep)]);
    host.activeFile('rename');
    await vi.waitFor(() => expect(vi.mocked(service.move)).toHaveBeenCalledWith('repo-1', 'src/a.ts', 'src/b.ts'));
    expect(vi.mocked(editorPane.fileRenamed).mock.calls[0]!.slice(0, 2)).toEqual(['p', 'src/a.ts']);
    expect(vi.mocked(editorPane.closeActive)).not.toHaveBeenCalled();
  });
});

describe('source control host: sides, palette and pushes', () => {
  it('opens a missing, over-size or binary git side as a placeholder that carries no bytes, beside the other side, and decodes a text side', async () => {
    const staged: Change = { path: 'src/staged.ts', status: 'INDEX_ADDED', letter: 'A', tone: 'added', strike: false };
    const indexed: RepositoryStatus = { ...status, groups: { ...status.groups, index: [staged] } };
    const file = { path: path.join(projectPath, 'src', 'a.ts') };
    const cases: Array<readonly [Awaited<ReturnType<Repository['show']>>, object]> = [
      [undefined, { name: 'a.ts', notDisplayed: 'missing' }],
      ['tooLarge', { name: 'a.ts', notDisplayed: 'tooLarge' }],
      [Buffer.from([0x89, 0x50, 0x00, 0x01]), { name: 'a.ts', notDisplayed: 'binary', bytes: 4 }],
    ];
    for (const [shown, side] of cases) {
      const { host, editorPane, notices } = setup({ status: indexed, show: async () => shown });
      expect(await host.run({ op: 'openChanges', repoId: 'repo-1', path: 'src/a.ts', group: 'workingTree' })).toEqual({ ok: true });
      expect(vi.mocked(editorPane.showDiff).mock.calls[0]!.slice(2, 4)).toEqual([side, file]);
      await host.run({ op: 'openFileHead', repoId: 'repo-1', path: 'src/a.ts' });
      await host.run({ op: 'openChanges', repoId: 'repo-1', path: 'src/staged.ts', group: 'index' });
      expect(vi.mocked(editorPane.openPlaceholder).mock.calls).toEqual([['a.ts (HEAD)', side], ['staged.ts (Index)', { ...side, name: 'staged.ts' }]]);
      expect(vi.mocked(editorPane.openReadOnly)).not.toHaveBeenCalled();
      expect(notices).toEqual([]);
    }

    const bom = setup({ status: indexed, show: async () => Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]) });
    await bom.host.run({ op: 'openChanges', repoId: 'repo-1', path: 'src/staged.ts', group: 'index' });
    expect(vi.mocked(bom.editorPane.openReadOnly)).toHaveBeenCalledWith('staged.ts (Index)', 'hi', 'staged.ts');
  });

  it('opens every working tree change but deleted ones and submodules in one background open', async () => {
    const untracked: Change = { path: 'new.ts', status: 'UNTRACKED', letter: 'U', tone: 'untracked', strike: false };
    const removed: Change = { path: 'old.ts', status: 'DELETED', letter: 'D', tone: 'deleted', strike: true };
    const submodule: Change = { path: 'lib', status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false, submodule: true };
    const { host, editorPane } = setup({ status: { ...status, groups: { ...status.groups, workingTree: [modified, removed, submodule], untracked: [untracked] } } });
    host.paletteRun({ op: 'openAllChanges' });
    await vi.waitFor(() => expect(vi.mocked(editorPane.openInBackground)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(editorPane.openInBackground)).toHaveBeenCalledWith([path.join(projectPath, 'src', 'a.ts'), path.join(projectPath, 'new.ts')]);
  });

  it('runs the palette\'s editor commands on the selected repository and says when no repository is open', async () => {
    const { host, editorPane, notices, service } = setup();
    host.paletteRun({ op: 'closeAllDiffEditors' });
    host.paletteRun({ op: 'closeAllUnmodifiedEditors' });
    await vi.waitFor(() => expect(vi.mocked(editorPane.closeUnmodified)).toHaveBeenCalled());
    expect(vi.mocked(editorPane.closeScmDiffs)).toHaveBeenCalledWith(projectPath);
    const changed = vi.mocked(editorPane.closeUnmodified).mock.calls[0]![0];
    expect(changed(path.join(projectPath, 'src', 'a.ts'))).toBe(true);
    expect(changed(path.join(projectPath, 'src', 'clean.ts'))).toBe(false);

    (service.view('p')!.repos as unknown[]).splice(0);
    host.paletteRun({ op: 'openGroupChanges', group: 'workingTree' });
    expect(notices).toEqual([{ severity: 'error', message: 'There are no available repositories', actions: [] }]);
  });

  it('opens a group\'s changes tab, and says when the group is empty', async () => {
    const { host, editorPane, notices } = setup();
    expect(await host.run({ op: 'openGroupChanges', repoId: 'repo-1', group: 'workingTree' })).toEqual({ ok: true });
    expect(vi.mocked(editorPane.showChanges)).toHaveBeenCalledWith(
      { title: `${path.basename(projectPath)}: Changes`, changes: { repoId: 'repo-1', source: { kind: 'workingTree' }, entries: [{ path: 'src/a.ts', status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false }] } },
      { focus: true },
    );
    expect(await host.run({ op: 'openGroupChanges', repoId: 'repo-1', group: 'index' })).toEqual({ ok: true });
    expect(notices).toEqual([{ severity: 'info', message: 'The repository does not have any staged changes.', actions: [] }]);
  });

  it('names the reason a commit message could not be generated, and fills nothing', async () => {
    const { host, notices, repos } = setup({ complete: async () => ({ kind: 'unreachable' }) });
    Object.assign(repos.get('repo-1')!, { diffForMessage: async () => ({ diff: 'diff --git a/x b/x', truncated: false }), subjects: async () => [] });
    expect(await host.generateMessage({ repoId: 'repo-1' })).toEqual({ ok: false });
    expect(notices).toEqual([{ severity: 'warn', message: 'Couldn\'t generate a commit message. No model could be reached. Check the Background model in Settings.', actions: [] }]);
  });

  it('refuses a renamed path that is invalid once trimmed or unsafe on Windows, and says so', async () => {
    const trimmed = setup({ activeFile: path.join(projectPath, 'src', 'a.ts'), inputs: ['src/ '] });
    trimmed.host.activeFile('rename');
    await vi.waitFor(() => expect(trimmed.notices).toHaveLength(1));
    expect(trimmed.notices[0]!.message).toBe('src/ is not a valid file or folder name.');
    const windows = setup({ activeFile: path.join(projectPath, 'src', 'a.ts'), inputs: ['src/con.ts'], platform: 'win32' });
    windows.host.activeFile('rename');
    await vi.waitFor(() => expect(windows.notices).toHaveLength(1));
    expect(windows.notices[0]!.message).toBe('src/con.ts is not a valid file or folder name.');
    expect(vi.mocked(trimmed.service.move)).not.toHaveBeenCalled();
    expect(vi.mocked(windows.service.move)).not.toHaveBeenCalled();
  });

  it('keeps the shell\'s amend report for the selected repository as menu context, refusing a malformed one and dropping an unknown repository', () => {
    const { host, menuChanges } = setup();
    for (const raw of [undefined, null, 'repo-1', {}, { repoId: 'repo-1' }, { repoId: 'repo-1', amending: 'yes' }, { repoId: '', amending: true }, { repoId: 'r'.repeat(201), amending: true }, { repoId: 'repo-1', amending: true, extra: 1 }, ['repo-1', true]]) {
      expect(() => host.amend(raw), JSON.stringify(raw)).toThrow('Malformed');
    }
    host.amend({ repoId: 'repo-9', amending: true });
    expect(host.menuState().amending).toBe(false);
    expect(menuChanges()).toBe(0);

    host.amend({ repoId: 'repo-1', amending: true });
    expect(host.menuState().amending).toBe(true);
    expect(menuChanges()).toBe(1);
    host.amend({ repoId: 'repo-1', amending: true });
    expect(menuChanges()).toBe(1);
    host.amend({ repoId: 'repo-1', amending: false });
    expect(host.menuState().amending).toBe(false);
    expect(menuChanges()).toBe(2);
    // a report for a repository that is not the selected one titles nothing
    host.amend({ repoId: 'repo-2', amending: true });
    expect(host.menuState().amending).toBe(false);
  });

  it('leaves amend mode when the selection moves, after a commit or an undo, and when the repository is gone', async () => {
    const selected = setup();
    selected.host.amend({ repoId: 'repo-1', amending: true });
    selected.host.select({ projectKey: 'p', repoId: 'repo-2' });
    selected.host.select({ projectKey: 'p', repoId: 'repo-1' });
    expect(selected.host.menuState().amending).toBe(false);

    const committed = setup();
    committed.host.amend({ repoId: 'repo-1', amending: true });
    expect(await committed.host.commit({ repoId: 'repo-1', message: '', variant: { ...PLAIN, amend: true } })).toMatchObject({ ok: true });
    expect(committed.host.menuState().amending).toBe(false);
    expect(committed.menuChanges()).toBe(2);

    const undone = setup();
    undone.host.amend({ repoId: 'repo-1', amending: true });
    expect(await undone.host.run({ op: 'undoLastCommit', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(undone.host.menuState().amending).toBe(false);

    const gone = setup();
    gone.host.amend({ repoId: 'repo-1', amending: true });
    gone.repos.delete('repo-1');
    expect(gone.host.menuState().amending).toBe(false);
    gone.emit({ kind: 'repository', repoId: 'repo-1' });
    await tick();
    gone.repos.set('repo-1', gone.repos.get('repo-2')!);
    expect(gone.host.menuState().amending).toBe(false);
    expect(gone.menuChanges()).toBe(2);
  });

  it('refreshes the menu when a git setting changes, as the No Verify commands depend on one', () => {
    const { settingsChanged, sent, menuChanges } = setup();
    settingsChanged();
    expect(sent.settings).toBe(1);
    expect(menuChanges()).toBe(1);
  });

  it('publishes nothing once disposed, for a change queued before', async () => {
    const live = setup();
    live.emit({ kind: 'view', projectKey: 'p' });
    await tick();
    expect(live.sent.views).toHaveLength(1);
    const disposed = setup();
    disposed.emit({ kind: 'view', projectKey: 'p' });
    disposed.emit({ kind: 'repository', repoId: 'repo-1' });
    disposed.host.dispose();
    await tick();
    expect(disposed.sent.views).toEqual([]);
    expect(disposed.sent.states).toBe(0);
    expect(disposed.menuChanges()).toBe(0);
  });
});

describe('the Background model sub-call', () => {
  const request: StructuredCompletionRequest = { systemPrompt: 's', userMessage: 'u', outputToolName: 'o', outputToolDescription: 'd', schema: {}, purpose: 'commit-message', attribution: { cwd: projectPath } };

  function fakeRuntime(order: string[], folder: () => Promise<unknown> = async () => undefined): SubCallRuntime {
    return {
      folder: async (cwd) => {
        order.push(`folder:${cwd}`);
        return folder();
      },
      syncCustomProviders: async () => void order.push('sync'),
      runStructuredCompletion: async () => {
        order.push('run');
        return { kind: 'answered', value: { message: 'Subject' } } as never;
      },
    };
  }

  it('creates the runtime and the project\'s folder runtime before any chat has, then runs', async () => {
    const order: string[] = [];
    let created = 0;
    const complete = backgroundCompletion(() => {
      created++;
      return fakeRuntime(order);
    }, async () => undefined, () => undefined);
    expect(await complete(request)).toEqual({ kind: 'answered', value: { message: 'Subject' } });
    expect(created).toBe(1);
    expect(order).toEqual([`folder:${projectPath}`, 'sync', 'run']);
  });

  it('answers unreachable once the runtime is retired, or when it cannot start', async () => {
    expect(await backgroundCompletion(() => null, async () => undefined, () => undefined)(request)).toEqual({ kind: 'unreachable' });
    const lines: string[] = [];
    const order: string[] = [];
    const failing = backgroundCompletion(() => fakeRuntime(order, async () => { throw new Error('pi failed to load'); }), async () => undefined, (line) => lines.push(line));
    expect(await failing(request)).toEqual({ kind: 'unreachable' });
    expect(order).toEqual([`folder:${projectPath}`]);
    expect(lines).toEqual(['[scm] the model runtime could not start: pi failed to load']);
  });
});
