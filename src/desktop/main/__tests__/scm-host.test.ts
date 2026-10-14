import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StructuredCompletionRequest } from '../../../core/pi-session/structured-completion';
import { RemoteCancelledError, StashKeptError, SyncBranchChangedError, type CommitHooks, type ProjectView, type ScmEvent, type ScmService } from '../../../core/scm/scm-service';
import type { Change, Repository, RepositoryStatus } from '../../../core/scm/repository';
import { SCM_SETTING_KEYS } from '../../../core/scm/settings-keys';
import type { Artifacts, CommitPairDiff } from '../../../core/scm/artifacts';
import { MAX_OVERLAY_LABEL_LENGTH, MAX_QUICK_PICK_ITEMS } from '../../preload/overlay-channels';
import type { ScmArtifactsChanged, ScmChangesTab, ScmSetInput, ScmShellCommand, ScmView } from '../../preload/scm-channels';
import type { AskInputRequest } from '../overlay';
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
  upstream: { remote: 'origin', branch: 'main', ahead: 1, behind: 2 },
  remotes: ['origin'],
};
const PLAIN = { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false } as const;
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const PAIR: CommitPairDiff = { left: HASH_A, entries: [{ change: { path: 'src/a.ts', status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false }, right: HASH_B }] };

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
    isValidBranchName: async (name: string) => !name.includes('~'),
    info: { root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git'), kind: 'root', project: root },
    gitVersion: { major: 2, minor: 45, patch: 0 },
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
  // the OS folder picker's answer
  folder?: string;
  // the folder core remembers the repository's last worktree in
  worktreeFolder?: string;
  // the overlay quick pick's answers, by call
  picks?: Array<string | { readonly id: string; readonly query: string } | undefined>;
  clone?: ScmService['clone'];
  remotes?: Array<{ name: string; fetchUrl?: string; pushUrl?: string }>;
  // the artifacts core reads, by group
  artifacts?: Partial<{ [G in Artifacts['group']]: Extract<Artifacts, { group: G }>['rows'] }>;
  gitVersion?: { major: number; minor: number; patch: number } | undefined;
  // what core's checkout, branch delete and worktree removal answer, in call order
  checkouts?: Array<'ok' | 'dirty'>;
  deletes?: Array<'ok' | 'unmerged'>;
  removals?: Array<'ok' | 'dirty'>;
  // what removing a project answers (a deleted worktree's)
  removeProject?: { ok: true } | { ok: false; reason: string };
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
  const checkouts = [...(overrides.checkouts ?? [])];
  const deletes = [...(overrides.deletes ?? [])];
  const removals = [...(overrides.removals ?? [])];
  const artifactsChanged: ScmArtifactsChanged[] = [];
  const settingListeners: Array<() => void> = [];
  const service = {
    onDidChange: (listener: (event: ScmEvent) => void) => {
      coreListeners.push(listener);
      return { dispose: () => undefined };
    },
    projectRealPath: () => overrides.real,
    projectKeys: () => ['p'],
    view: (key: string) => (key === 'p' ? view : undefined),
    snapshot: (repoId: string) => (repos.has(repoId) ? { repoId, projectKey: 'p', status, busy: false, running: null, lastRemote: null } : undefined),
    cloneState: () => ({ running: null, last: null }),
    setAutofetchProject: vi.fn(),
    remotes: async () => overrides.remotes ?? [{ name: 'origin', fetchUrl: 'https://user:token@example.com/a.git', pushUrl: 'https://user:token@example.com/a.git' }],
    remoteBranches: async () => ['main', 'dev'],
    fetch: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    push: vi.fn(async () => true),
    sync: vi.fn(async () => true),
    addRemote: vi.fn(async () => undefined),
    removeRemote: vi.fn(async () => undefined),
    clone: vi.fn(overrides.clone ?? (async (_url: string, parent: string) => path.join(parent, 'a'))),
    cancel: vi.fn(),
    cancelClone: vi.fn(),
    repository: (repoId: string) => (repos.has(repoId) ? { repo: repos.get(repoId)!, projectKey: 'p', projectPath, kind: 'root' } : undefined),
    decorations: () => ({}),
    commit: vi.fn(overrides.commit ?? (async () => ({ ok: true }))),
    currentStatus: async () => overrides.current ?? status,
    commitInput: overrides.commitInput ?? (async () => ({ template: 'template text', history: ['older'], headMessage: 'first' })),
    undoLastCommit: async () => overrides.undo ?? { kind: 'undone', message: 'Undone subject\n\nbody' },
    move: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    gitVersion: () => ('gitVersion' in overrides ? overrides.gitVersion : { major: 2, minor: 45, patch: 0 }),
    artifacts: vi.fn(async (_repoId: string, group: Artifacts['group']) => ({ group, rows: overrides.artifacts?.[group] ?? [] })),
    checkout: vi.fn(async () => checkouts.shift() ?? 'ok'),
    fastForward: vi.fn(async () => 'ok'),
    createBranch: vi.fn(async () => undefined),
    renameBranch: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => deletes.shift() ?? 'ok'),
    deleteRemoteRef: vi.fn(async () => undefined),
    remoteTags: vi.fn(async () => [{ name: 'v1', commit: HASH_A }]),
    integrate: vi.fn(async () => 'ok'),
    stash: vi.fn(async () => 'ok'),
    stashApply: vi.fn(async () => 'ok'),
    stashDrop: vi.fn(async () => 'ok'),
    stashClear: vi.fn(async () => undefined),
    diffStash: vi.fn(async () => PAIR),
    diffRefs: vi.fn(async () => PAIR),
    entryPatch: vi.fn(async () => ({ kind: 'patch', patch: 'pair patch' })),
    createTag: vi.fn(async () => undefined),
    deleteTag: vi.fn(async () => undefined),
    pushTags: vi.fn(async () => undefined),
    addWorktree: vi.fn(async () => undefined),
    worktreeFolder: () => overrides.worktreeFolder,
    removeWorktree: vi.fn(async () => removals.shift() ?? 'ok'),
    discardAll: vi.fn(async () => true),
    autofetchNow: vi.fn(),
  } as unknown as ScmService;
  const sent = { views: [] as ScmView[], settings: 0, states: 0 };
  let menuChanges = 0;
  const settingValues = new Map(Object.entries(overrides.settings ?? {}));
  let settingReads = 0;
  const questions: MessageQuestion[] = [];
  const answers = [...(overrides.answers ?? [])];
  const inputRequests: AskInputRequest[] = [];
  const inputs = [...(overrides.inputs ?? [])];
  const setInputs: ScmSetInput[] = [];
  const commands: ScmShellCommand[] = [];
  const gitLog: string[] = [];
  const saved = new Map<string, string>();
  const notices: Array<{ severity: string; message: string; actions: string[] }> = [];
  const copied: string[] = [];
  const folderRequests: Array<{ defaultPath: string; title?: string; buttonLabel?: string }> = [];
  const added: string[] = [];
  const selectedProjects: string[] = [];
  const removedProjects: string[] = [];
  const picks = [...(overrides.picks ?? [])];
  const pickRequests: Array<{ placeholder: string; items: readonly { id: string; label: string; description?: string }[] }> = [];
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
    closeChangesTabs: vi.fn(async () => undefined),
  } as unknown as EditorPane;
  const notify = (severity: string) => async (message: string, ...actions: string[]) => {
    notices.push({ severity, message, actions });
    return undefined;
  };
  const host = new ScmHost({
    service,
    settings: {
      get: (key: string) => {
        settingReads++;
        return settingValues.get(key);
      },
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
    pickFolder: async (defaultPath, title, buttonLabel) => {
      folderRequests.push({ defaultPath, ...(title !== undefined ? { title } : {}), ...(buttonLabel !== undefined ? { buttonLabel } : {}) });
      return overrides.folder;
    },
    addProject: async (folder) => void added.push(folder),
    selectProject: async (projectKey) => void selectedProjects.push(projectKey),
    removeProject: async (projectKey) => {
      removedProjects.push(projectKey);
      return overrides.removeProject ?? { ok: true };
    },
    gitFound: true,
    quickPick: async (placeholder, items) => {
      pickRequests.push({ placeholder, items });
      const pick = picks.shift();
      return typeof pick === 'string' ? { id: pick, query: '' } : pick;
    },
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
      clone: () => undefined,
      artifactsChanged: (changed) => void artifactsChanged.push(changed),
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
  return { host, saved, notices, copied, editorPane, service, questions, inputRequests, setInputs, commands, gitLog, repos, sent, emit, settingsChanged, menuChanges: () => menuChanges, folderRequests, added, selectedProjects, removedProjects, pickRequests, artifactsChanged, settingReads: () => settingReads };
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

  it('copies only a path of the repository\'s status, composed by main, and tells the user when it refuses one', async () => {
    const { host, copied, notices } = setup();
    await host.copy({ repoId: 'repo-1', kind: 'path', value: 'src/a.ts' });
    await host.copy({ repoId: 'repo-1', kind: 'relativePath', value: 'src/a.ts' });
    expect(copied).toEqual([path.join(projectPath, 'src', 'a.ts'), ['src', 'a.ts'].join(path.sep)]);
    // a change committed after the shell listed it: the page cannot show a rejection, so main tells it as a failed run
    await expect(host.copy({ repoId: 'repo-1', kind: 'path', value: 'other.ts' })).resolves.toBeUndefined();
    expect(notices).toEqual([{ severity: 'error', message: 'Copy names a path that is not a change of the repository', actions: ['Show Git Output'] }]);
    await expect(host.copy({ repoId: 'repo-1', kind: 'path', value: 'src/a.ts\ncurl x' })).rejects.toThrow('Malformed');
    expect(copied).toHaveLength(2);
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

  it('puts the template in the box after a commit, then runs postCommitCommand push to the upstream', async () => {
    const { host, setInputs, service } = setup({ settings: { [SCM_SETTING_KEYS.postCommitCommand]: 'push' } });
    const commitInput = { template: 'template text', history: ['older'], headMessage: 'first' };
    expect(await host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN })).toEqual({ ok: true, message: 'template text', commitInput });
    // the commit's reply carries the box's text, which no separate message could race
    expect(setInputs).toEqual([]);
    await vi.waitFor(() => expect(vi.mocked(service.push)).toHaveBeenCalledWith('repo-1', { remote: 'origin', branch: 'main', toBranch: 'main', setUpstream: false, followTags: false, force: false }));
    expect(vi.mocked(service.sync)).not.toHaveBeenCalled();
  });

  it('runs Commit & Sync\'s sync in place of the setting, and nothing after a commit with neither', async () => {
    const overridden = setup({ settings: { [SCM_SETTING_KEYS.postCommitCommand]: 'push' } });
    await overridden.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN, postCommit: 'sync' });
    await vi.waitFor(() => expect(vi.mocked(overridden.service.sync)).toHaveBeenCalledWith('repo-1', false));
    expect(vi.mocked(overridden.service.push)).not.toHaveBeenCalled();
    const none = setup();
    await none.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    await new Promise((resolve) => setImmediate(resolve));
    expect(vi.mocked(none.service.push)).not.toHaveBeenCalled();
    expect(vi.mocked(none.service.sync)).not.toHaveBeenCalled();
    await expect(none.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN, postCommit: 'pull' })).rejects.toThrow();
  });

  it('refuses a force push while allowForcePush is off, before core or any question', async () => {
    const off = setup();
    expect(await off.host.run({ op: 'push', repoId: 'repo-1', to: false, force: true, followTags: false })).toEqual({ ok: false, reason: 'failed' });
    expect(vi.mocked(off.service.push)).not.toHaveBeenCalled();
    expect(off.notices).toEqual([{ severity: 'error', message: 'Force push is not allowed, please enable it with the "Allow force push" setting.', actions: [] }]);
    const on = setup({ settings: { [SCM_SETTING_KEYS.allowForcePush]: true } });
    expect(await on.host.run({ op: 'push', repoId: 'repo-1', to: false, force: true, followTags: false })).toEqual({ ok: true });
    expect(vi.mocked(on.service.push)).toHaveBeenCalledWith('repo-1', { remote: 'origin', branch: 'main', toBranch: 'main', setUpstream: false, followTags: false, force: true });
  });

  it('answers a cancelled remote operation cancelled with no notice, and shows any other failure with Show Git Output', async () => {
    const { host, service, notices } = setup();
    vi.mocked(service.pull).mockRejectedValueOnce(new RemoteCancelledError());
    expect(await host.run({ op: 'pull', repoId: 'repo-1', rebase: true })).toEqual({ ok: false, reason: 'cancelled' });
    expect(vi.mocked(service.pull)).toHaveBeenCalledWith('repo-1', { rebase: true });
    expect(notices).toEqual([]);
    vi.mocked(service.pull).mockRejectedValueOnce(new Error('error: Your local changes to the following files would be overwritten by merge:'));
    expect(await host.run({ op: 'pull', repoId: 'repo-1', rebase: false })).toEqual({ ok: false, reason: 'failed' });
    expect(notices).toEqual([{ severity: 'error', message: 'error: Your local changes to the following files would be overwritten by merge:', actions: ['Show Git Output'] }]);
  });

  it('picks a remote for Push to..., showing its URL without userinfo, and publishes with -u to the one remote', async () => {
    const remotes = [{ name: 'origin', pushUrl: 'https://user:token@example.com/a.git' }, { name: 'backup', pushUrl: 'https://example.com/b.git' }];
    // ids are indices, so a remote's name never travels as one
    const { host, service, pickRequests } = setup({ remotes, picks: ['1'] });
    expect(await host.run({ op: 'push', repoId: 'repo-1', to: true, force: false, followTags: false })).toEqual({ ok: true });
    expect(pickRequests[0]!.items.map((item) => item.description)).toEqual(['https://example.com/a.git', 'https://example.com/b.git', undefined]);
    expect(vi.mocked(service.push)).toHaveBeenCalledWith('repo-1', { remote: 'backup', branch: 'main', setUpstream: false, followTags: false, force: false });
    const one = setup();
    expect(await one.host.run({ op: 'publish', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(vi.mocked(one.service.push)).toHaveBeenCalledWith('repo-1', { remote: 'origin', branch: 'main', setUpstream: true, followTags: false, force: false });
  });

  it('adds a remote from a URL and a validated name, then fetches it; a name that is an option never reaches core', async () => {
    const { host, service, inputRequests } = setup({ inputs: [' https://example.com/x.git ', 'upstream'] });
    expect(await host.run({ op: 'addRemote', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(inputRequests[1]).toMatchObject({ validation: 'remoteName' });
    expect(vi.mocked(service.addRemote)).toHaveBeenCalledWith('repo-1', 'upstream', 'https://example.com/x.git');
    expect(vi.mocked(service.fetch)).toHaveBeenCalledWith('repo-1', { remote: 'upstream' });
    for (const [url, name] of [['https://example.com/x.git', '-x'], ['--upload-pack=touch x', 'ok'], ['ext::sh -c touch% x', 'ok']] as const) {
      const refused = setup({ inputs: [url, name] });
      // the user was told why, which a failed result means
      expect(await refused.host.run({ op: 'addRemote', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'failed' });
      expect(refused.notices).toHaveLength(1);
      expect(vi.mocked(refused.service.addRemote)).not.toHaveBeenCalled();
    }
  });

  it('clones into the picked folder, asks before adding the project at prompt, and adds it at always', async () => {
    const folder = path.resolve('/work/clones');
    const prompt = setup({ inputs: ['git clone https://example.com/acme-api.git'], folder, answers: [0] });
    expect(await prompt.host.run({ op: 'clone', recursive: true })).toEqual({ ok: true });
    expect(vi.mocked(prompt.service.clone)).toHaveBeenCalledWith('https://example.com/acme-api.git', folder, true);
    expect(prompt.folderRequests[0]).toEqual({ defaultPath: os.homedir(), title: 'Choose a folder to clone https://example.com/acme-api.git into', buttonLabel: 'Select as Repository Destination' });
    expect(prompt.questions[0]).toMatchObject({ message: 'Would you like to open the cloned repository?', actions: ['Add Project'] });
    expect(prompt.added).toEqual([path.join(folder, 'a')]);
    const declined = setup({ inputs: ['https://example.com/acme-api.git'], folder, answers: [undefined] });
    expect(await declined.host.run({ op: 'clone', recursive: false })).toEqual({ ok: true });
    expect(declined.added).toEqual([]);
    const always = setup({ inputs: ['https://example.com/acme-api.git'], folder, settings: { [SCM_SETTING_KEYS.openAfterClone]: 'always' } });
    expect(await always.host.run({ op: 'clone', recursive: false })).toEqual({ ok: true });
    expect(always.questions).toEqual([]);
    expect(always.added).toEqual([path.join(folder, 'a')]);
  });

  it('opens the folder picker at defaultCloneDirectory, ~ expanded, and answers a cancelled clone or picker cancelled', async () => {
    const parent = path.resolve('/work/default');
    const picked = path.resolve('/work/picked');
    const { host, service, folderRequests, notices, added } = setup({ inputs: ['https://example.com/a.git'], folder: picked, settings: { [SCM_SETTING_KEYS.defaultCloneDirectory]: parent }, clone: async () => Promise.reject(new RemoteCancelledError()) });
    expect(await host.run({ op: 'clone', recursive: false })).toEqual({ ok: false, reason: 'cancelled' });
    expect(folderRequests).toEqual([{ defaultPath: parent, title: 'Choose a folder to clone https://example.com/a.git into', buttonLabel: 'Select as Repository Destination' }]);
    expect(vi.mocked(service.clone)).toHaveBeenCalledWith('https://example.com/a.git', picked, false);
    expect(notices).toEqual([]);
    expect(added).toEqual([]);
    const home = setup({ inputs: ['https://example.com/a.git'], settings: { [SCM_SETTING_KEYS.defaultCloneDirectory]: '~/src' } });
    expect(await home.host.run({ op: 'clone', recursive: false })).toEqual({ ok: false, reason: 'cancelled' });
    expect(home.folderRequests[0]!.defaultPath).toBe(`${os.homedir()}/src`);
    expect(vi.mocked(home.service.clone)).not.toHaveBeenCalled();
  });

  it('cancels a repository\'s remote operation and the window\'s clone', async () => {
    const { host, service } = setup();
    expect(await host.run({ op: 'cancel', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(vi.mocked(service.cancel)).toHaveBeenCalledWith('repo-1');
    expect(await host.run({ op: 'cancelClone' })).toEqual({ ok: true });
    expect(vi.mocked(service.cancelClone)).toHaveBeenCalled();
    expect(await host.run({ op: 'cancel', repoId: 'repo-9' })).toEqual({ ok: false, reason: 'unknown' });
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

describe('source control host: branches, stash, tags and worktrees', () => {
  const commit = (hash: string, subject: string) => ({ hash, subject, author: 'Ada', date: 1_700_000_000_000 });
  const branches = [
    { ref: 'refs/heads/main', name: 'main', commit: commit(HASH_A, 'main subject'), current: true, upstream: { remote: 'origin', branch: 'main', ahead: 1, behind: 2 } },
    { ref: 'refs/heads/feat', name: 'feat', commit: commit(HASH_B, 'feat subject'), current: false, upstream: null },
  ];
  const remoteBranches = [
    { ref: 'refs/remotes/origin/main', name: 'origin/main', remote: 'origin', commit: commit(HASH_A, 'main subject') },
    { ref: 'refs/remotes/origin/topic', name: 'origin/topic', remote: 'origin', commit: commit(HASH_B, 'topic subject') },
  ];
  const tags = [{ ref: 'refs/tags/v1', name: 'v1', commit: commit(HASH_A, 'main subject'), annotated: true, current: false }];
  const stashes = [
    { index: 0, hash: HASH_B, description: 'newest', branch: 'main', date: 1 },
    { index: 1, hash: HASH_A, description: 'oldest', branch: null, date: 1 },
  ];
  const artifacts = { branches, remoteBranches, tags, stashes };

  it('offers the branch picker with its commands, then local, remote and tag groups in core\'s newest-first order, and checks out a remote branch as a new tracking branch', async () => {
    const { host, service, pickRequests } = setup({ artifacts, picks: ['3'] });
    expect(await host.run({ op: 'checkout', repoId: 'repo-1', detached: false })).toEqual({ ok: true });
    const items = pickRequests[0]!.items as ReadonlyArray<Record<string, unknown>>;
    expect(pickRequests[0]!.placeholder).toBe('Select a branch or tag to checkout');
    expect(items.map((item) => [item['label'], item['icon'], item['group'], item['hint'], item['current']])).toEqual([
      ['Create new branch...', 'add', undefined, undefined, undefined],
      ['Create new branch from...', 'add', undefined, undefined, undefined],
      ['Checkout detached...', 'detached', undefined, undefined, undefined],
      ['main', 'branch', 'branches', '2\u2193 1\u2191', true],
      ['feat', 'branch', 'branches', 'local', undefined],
      ['origin/main', 'remoteBranch', 'remote branches', undefined, undefined],
      ['origin/topic', 'remoteBranch', 'remote branches', undefined, undefined],
      ['v1', 'tag', 'tags', undefined, undefined],
    ]);
    expect(items[4]!['description']).toBe(`${HASH_B.slice(0, 7)} \u2022 feat subject`);
    expect(items.every((item, index) => item['id'] === `${index}`)).toBe(true);
    // '3' is main, the current branch
    expect(service.checkout).toHaveBeenCalledWith('repo-1', { kind: 'branch', name: 'main' });
    const remote = setup({ artifacts, picks: ['6'] });
    await remote.host.run({ op: 'checkout', repoId: 'repo-1', detached: false });
    expect(remote.service.checkout).toHaveBeenCalledWith('repo-1', { kind: 'track', ref: 'refs/remotes/origin/topic' });
  });

  it('checks out the local branch already tracking a remote branch, and a tag detached', async () => {
    const tracking = [...branches, { ref: 'refs/heads/mine', name: 'mine', commit: commit(HASH_B, 's'), current: false, upstream: { remote: 'origin', branch: 'topic', ahead: 0, behind: 0 } }];
    const { host, service } = setup({ artifacts: { ...artifacts, branches: tracking } });
    await host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/remotes/origin/topic' });
    expect(service.checkout).toHaveBeenLastCalledWith('repo-1', { kind: 'branch', name: 'mine' });
    await host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/tags/v1' });
    expect(service.checkout).toHaveBeenLastCalledWith('repo-1', { kind: 'detached', revision: HASH_A });
  });

  it('lists no commands and no tags in the detached picker, and detaches at the picked branch\'s commit', async () => {
    const { host, service, pickRequests } = setup({ artifacts, picks: ['0'] });
    await host.run({ op: 'checkout', repoId: 'repo-1', detached: true });
    expect(pickRequests[0]!.placeholder).toBe('Select a branch to checkout in detached mode');
    expect(pickRequests[0]!.items.map((item) => item.label)).toEqual(['main', 'feat', 'origin/main', 'origin/topic']);
    expect(service.checkout).toHaveBeenCalledWith('repo-1', { kind: 'detached', revision: HASH_A });
  });

  it('refuses a ref that is not in main\'s fresh list before git sees it', async () => {
    const { host, service, notices } = setup({ artifacts });
    expect(await host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/gone' })).toEqual({ ok: false, reason: 'failed' });
    expect(service.checkout).not.toHaveBeenCalled();
    expect(notices[0]!.message).toBe('"refs/heads/gone" is no longer in this repository.');
  });

  it('fast-forwards a branch with an upstream before checking it out while pullBeforeCheckout is on', async () => {
    const behind = [branches[0]!, { ...branches[1]!, upstream: { remote: 'origin', branch: 'feat', ahead: 0, behind: 3 } }];
    const on = setup({ artifacts: { ...artifacts, branches: behind }, settings: { [SCM_SETTING_KEYS.pullBeforeCheckout]: true } });
    const order: string[] = [];
    vi.mocked(on.service.fastForward).mockImplementation(async () => {
      order.push('fastForward');
      return 'ok';
    });
    vi.mocked(on.service.checkout).mockImplementation(async () => {
      order.push('checkout');
      return 'ok';
    });
    await on.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' });
    expect(on.service.fastForward).toHaveBeenCalledWith('repo-1', 'feat', { remote: 'origin', branch: 'feat', ahead: 0, behind: 3 });
    expect(order).toEqual(['fastForward', 'checkout']);
    // a refused fast-forward (outgoing commits) leaves the branch and the checkout goes on, as VS Code's does
    vi.mocked(on.service.fastForward).mockRejectedValueOnce(new Error('rejected non-fast-forward'));
    expect(await on.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' })).toEqual({ ok: true });
    expect(on.gitLog.at(-1)).toContain('was not fast-forwarded');
    vi.mocked(on.service.fastForward).mockRejectedValueOnce(new RemoteCancelledError());
    expect(await on.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' })).toEqual({ ok: false, reason: 'cancelled' });
    const off = setup({ artifacts: { ...artifacts, branches: behind } });
    await off.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' });
    expect(off.service.fastForward).not.toHaveBeenCalled();
    // a branch with outgoing commits is not fast-forwarded (VS Code's setting: "does not have outgoing commits")
    const outgoing = [branches[0]!, { ...branches[1]!, upstream: { remote: 'origin', branch: 'feat', ahead: 1, behind: 3 } }];
    const ahead = setup({ artifacts: { ...artifacts, branches: outgoing }, settings: { [SCM_SETTING_KEYS.pullBeforeCheckout]: true } });
    await ahead.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' });
    expect(ahead.service.fastForward).not.toHaveBeenCalled();
    expect(ahead.service.checkout).toHaveBeenCalledWith('repo-1', { kind: 'branch', name: 'feat' });
  });

  it('asks VS Code\'s question when a checkout would overwrite changes, and Force Checkout discards first', async () => {
    const { host, service, questions } = setup({ artifacts, checkouts: ['dirty', 'ok'], answers: [2] });
    expect(await host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' })).toEqual({ ok: true });
    expect(questions[0]).toMatchObject({ severity: 'warning', message: 'Your local changes would be overwritten by checkout.', actions: ['Stash & Checkout', 'Migrate Changes', 'Force Checkout'] });
    expect(service.discardAll).toHaveBeenCalledWith('repo-1', 'all');
    expect(service.checkout).toHaveBeenCalledTimes(2);
  });

  it('creates a branch with the prefix in the box, refuses a name a branch has, and creates from a picked ref', async () => {
    const { host, service, inputRequests, notices, pickRequests } = setup({ artifacts, settings: { [SCM_SETTING_KEYS.branchPrefix]: 'me/' }, inputs: ['feat', 'me/new', 'me/from'], picks: ['3'] });
    expect(await host.run({ op: 'createBranch', repoId: 'repo-1', from: false })).toEqual({ ok: false, reason: 'cancelled' });
    expect(notices[0]!.message).toBe('A branch named "feat" already exists');
    expect(inputRequests[0]).toMatchObject({ prompt: 'Please provide a new branch name', placeholder: 'Branch name', value: 'me/', valueSelection: [3, 3], validation: 'branchName' });
    await host.run({ op: 'createBranch', repoId: 'repo-1', from: false });
    expect(service.createBranch).toHaveBeenLastCalledWith('repo-1', 'me/new', 'HEAD');
    await host.run({ op: 'createBranch', repoId: 'repo-1', from: true });
    expect(pickRequests[0]!.items[0]).toMatchObject({ label: 'HEAD', description: 'abc' });
    // '3' is origin/main, after HEAD, main and feat
    expect(service.createBranch).toHaveBeenLastCalledWith('repo-1', 'me/from', 'refs/remotes/origin/main');
  });

  it('starts the name box with the text typed in Checkout to..., cleaned and behind branchPrefix, and creates the branch from it', async () => {
    const cases: Array<{ prefix: string; typed: string; value: string; selection: readonly [number, number] }> = [
      { prefix: '', typed: ' fix login ', value: 'fix-login', selection: [0, 9] },
      { prefix: 'me/', typed: 'fix login', value: 'me/fix-login', selection: [3, 12] },
      { prefix: 'me/', typed: 'me/fix', value: 'me/fix', selection: [3, 6] },
      // nothing left after cleaning: the box starts with the prefix alone, as with nothing typed
      { prefix: 'me/', typed: '   ', value: 'me/', selection: [3, 3] },
    ];
    for (const { prefix, typed, value, selection } of cases) {
      const { host, service, inputRequests, pickRequests } = setup({ artifacts, settings: { [SCM_SETTING_KEYS.branchPrefix]: prefix }, picks: [{ id: '0', query: typed }], inputs: [value === prefix ? undefined : value] });
      await host.run({ op: 'checkout', repoId: 'repo-1', detached: false });
      expect(pickRequests[0]!.items.slice(0, 2)).toEqual([
        expect.objectContaining({ label: 'Create new branch...', alwaysShow: true, echoQuery: true }),
        expect.objectContaining({ label: 'Create new branch from...', alwaysShow: true, echoQuery: true }),
      ]);
      expect(inputRequests[0], typed).toMatchObject({ value, valueSelection: selection, validation: 'branchName' });
      if (value !== prefix) expect(service.createBranch).toHaveBeenCalledWith('repo-1', value, 'HEAD');
    }
  });

  it('names a branch created from a picked ref after the first picker\'s text, never the ref picker\'s', async () => {
    const { host, service, inputRequests } = setup({ artifacts, picks: [{ id: '1', query: 'feature~x' }, { id: '0', query: 'HE' }], inputs: ['feature-x'] });
    await host.run({ op: 'checkout', repoId: 'repo-1', detached: false });
    expect(inputRequests[0]).toMatchObject({ value: 'feature-x' });
    expect(service.createBranch).toHaveBeenCalledWith('repo-1', 'feature-x', 'HEAD');
  });

  it('keeps the current name in Rename Branch\'s box, unsanitized', async () => {
    const renamed: RepositoryStatus = { ...status, head: { type: 'branch', name: 'odd..name' } };
    const { host, inputRequests } = setup({ artifacts, status: renamed, settings: { [SCM_SETTING_KEYS.branchPrefix]: 'me/' } });
    await host.run({ op: 'renameBranch', repoId: 'repo-1' });
    expect(inputRequests[0]).toMatchObject({ value: 'odd..name' });
  });

  it('deletes a merged branch at once, and an unmerged one only after the danger question, then with force', async () => {
    const merged = setup({ artifacts, picks: ['0'] });
    await merged.host.run({ op: 'deleteBranch', repoId: 'repo-1' });
    expect(merged.pickRequests[0]!.items.map((item) => item.label)).toEqual(['feat']);
    expect(merged.service.deleteBranch).toHaveBeenCalledWith('repo-1', 'feat', false);
    expect(merged.questions).toEqual([]);
    const unmerged = setup({ artifacts, picks: ['0', '0'], deletes: ['unmerged', 'unmerged'], answers: [undefined, 0] });
    expect(await unmerged.host.run({ op: 'deleteBranch', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(unmerged.questions[0]).toMatchObject({ severity: 'danger', message: 'The branch "feat" is not fully merged. Delete anyway?', actions: ['Delete Branch'], cancelLabel: 'Cancel' });
    expect(unmerged.questions[0]!.defaultAction).toBeUndefined();
    expect(vi.mocked(unmerged.service.deleteBranch).mock.calls).toEqual([['repo-1', 'feat', false]]);
    await unmerged.host.run({ op: 'deleteBranch', repoId: 'repo-1' });
    expect(vi.mocked(unmerged.service.deleteBranch).mock.calls.slice(1)).toEqual([['repo-1', 'feat', false], ['repo-1', 'feat', true]]);
  });

  it('asks before deleting a branch a row names, and refuses the checked-out one', async () => {
    const { host, service, questions, notices } = setup({ artifacts, answers: [0] });
    await host.run({ op: 'deleteBranch', repoId: 'repo-1', ref: 'refs/heads/feat' });
    expect(questions[0]!.message).toBe('Are you sure you want to delete branch "feat"? This action will permanently remove the branch reference from the repository.');
    expect(service.deleteBranch).toHaveBeenCalledWith('repo-1', 'feat', false);
    await host.run({ op: 'deleteBranch', repoId: 'repo-1', ref: 'refs/heads/main' });
    expect(notices.at(-1)!.message).toBe('The active branch cannot be deleted.');
  });

  it('deletes a remote branch but HEAD\'s upstream, merges from a picked ref and rebases onto the upstream listed first', async () => {
    const { host, service, pickRequests } = setup({ artifacts, picks: ['0', '0', '0'] });
    await host.run({ op: 'deleteRemoteBranch', repoId: 'repo-1' });
    expect(pickRequests[0]!.items.map((item) => item.label)).toEqual(['origin/topic']);
    expect(service.deleteRemoteRef).toHaveBeenCalledWith('repo-1', 'origin', 'refs/heads/topic');
    await host.run({ op: 'merge', repoId: 'repo-1' });
    expect(pickRequests[1]!.items.map((item) => item.label)).toEqual(['feat', 'origin/topic', 'v1']);
    // the full refname, which a tag of the same name cannot shadow
    expect(service.integrate).toHaveBeenLastCalledWith('repo-1', 'merge', 'refs/heads/feat');
    await host.run({ op: 'rebase', repoId: 'repo-1' });
    expect(pickRequests[2]!.items[0]).toMatchObject({ label: 'origin/main', description: '(upstream)' });
    expect(service.integrate).toHaveBeenLastCalledWith('repo-1', 'rebase', 'refs/remotes/origin/main');
  });

  it('asks to save a changed file\'s dirty tab before a stash, then the message, then stashes', async () => {
    const dirty = path.join(projectPath, 'src', 'a.ts');
    const { host, service, questions, inputRequests, editorPane } = setup({ dirty: [dirty], answers: [0], inputs: ['my message'] });
    expect(await host.run({ op: 'stash', repoId: 'repo-1', scope: 'default' })).toEqual({ ok: true });
    expect(questions[0]).toMatchObject({
      message: 'The following file has unsaved changes which won\'t be included in the stash if you proceed: a.ts.',
      detail: 'Would you like to save it before stashing?',
      actions: ['Save All & Stash', 'Stash Anyway'],
    });
    expect(editorPane.saveDocuments).toHaveBeenCalledWith(['doc-0']);
    expect(inputRequests[0]).toMatchObject({ prompt: 'Optionally provide a stash message', placeholder: 'Stash message' });
    expect(service.stash).toHaveBeenCalledWith('repo-1', 'default', 'my message', []);
    const never = setup({ dirty: [dirty], inputs: [''], settings: { [SCM_SETTING_KEYS.promptToSaveFilesBeforeStash]: 'never' } });
    await never.host.run({ op: 'stash', repoId: 'repo-1', scope: 'includeUntracked' });
    expect(never.questions).toEqual([]);
    const cancelled = setup({ dirty: [dirty], answers: [undefined] });
    expect(await cancelled.host.run({ op: 'stash', repoId: 'repo-1', scope: 'default' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(cancelled.service.stash).not.toHaveBeenCalled();
  });

  it('refuses Stash Staged below git 2.35 and with nothing staged, and hides it from the palette there', async () => {
    const old = setup({ gitVersion: { major: 2, minor: 34, patch: 9 } });
    old.repos.set('repo-1', { ...old.repos.get('repo-1')!, gitVersion: { major: 2, minor: 34, patch: 9 } } as never);
    expect(old.host.menuState().stashStaged).toBe(false);
    expect(old.host.state().capabilities).toEqual({ stashStaged: false });
    expect(await old.host.run({ op: 'stash', repoId: 'repo-1', scope: 'staged' })).toEqual({ ok: false, reason: 'failed' });
    expect(old.service.stash).not.toHaveBeenCalled();
    const current = setup();
    expect(current.host.menuState().stashStaged).toBe(true);
    expect(await current.host.run({ op: 'stash', repoId: 'repo-1', scope: 'staged' })).toEqual({ ok: false, reason: 'failed' });
    expect(current.notices[0]!.message).toBe('There are no staged changes to stash.');
  });

  it('applies the latest stash, pops a picked one by its commit, and drops a row\'s stash after the question, closing its tab', async () => {
    const { host, service, pickRequests, questions, editorPane } = setup({ artifacts, picks: ['1'], answers: [0] });
    await host.run({ op: 'stashApply', repoId: 'repo-1', pop: false, target: 'latest' });
    expect(service.stashApply).toHaveBeenLastCalledWith('repo-1', { index: 0, hash: HASH_B }, false);
    await host.run({ op: 'stashApply', repoId: 'repo-1', pop: true, target: 'pick' });
    expect(pickRequests[0]).toMatchObject({ placeholder: 'Pick a stash to pop' });
    expect(pickRequests[0]!.items.map((item) => item.label)).toEqual(['#0: newest', '#1: oldest']);
    expect(service.stashApply).toHaveBeenLastCalledWith('repo-1', { index: 1, hash: HASH_A }, true);
    // the row says index 0, but the stash's commit now sits at 1
    await host.run({ op: 'stashDrop', repoId: 'repo-1', target: { index: 0, hash: HASH_A } });
    expect(questions[0]).toMatchObject({ severity: 'danger', message: 'Are you sure you want to drop the stash: oldest?', actions: ['Yes'], cancelLabel: 'Cancel' });
    expect(questions[0]!.defaultAction).toBeUndefined();
    expect(service.stashDrop).toHaveBeenCalledWith('repo-1', { index: 1, hash: HASH_A });
    expect(editorPane.closeChangesTabs).toHaveBeenCalled();
  });

  it('drops all stashes only after the danger question, and says so when there are none', async () => {
    const { host, service, questions } = setup({ artifacts, answers: [undefined] });
    expect(await host.run({ op: 'stashDropAll', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(questions[0]).toMatchObject({ severity: 'danger', message: 'Are you sure you want to drop ALL stashes? There are 2 stashes that will be subject to pruning, and MAY BE IMPOSSIBLE TO RECOVER.' });
    expect(service.stashClear).not.toHaveBeenCalled();
    const none = setup();
    await none.host.run({ op: 'stashDropAll', repoId: 'repo-1' });
    expect(none.notices[0]!.message).toBe('There are no stashes in the repository.');
  });

  it('opens View Stash as a changes tab pinned to the stash\'s commit, and answers a file of it only while that tab is open', async () => {
    const { host, editorPane } = setup({ artifacts });
    await host.run({ op: 'viewStash', repoId: 'repo-1', target: { index: 1, hash: HASH_A } });
    const source = { kind: 'stash', index: 1, hash: HASH_A } as const;
    expect(editorPane.showChanges).toHaveBeenCalledWith({ title: 'Git Stash #1: oldest', changes: { repoId: 'repo-1', source, entries: [PAIR.entries[0]!.change] } }, { focus: true });
    expect(await host.fileDiff({ repoId: 'repo-1', source, path: 'src/a.ts' })).toEqual({ kind: 'missing' });
    const open = setup({ artifacts, changesTabs: [{ tabId: 't', state: { title: 'x', changes: { repoId: 'repo-1', source, entries: [] } } }] });
    expect(await open.host.fileDiff({ repoId: 'repo-1', source, path: 'src/a.ts' })).toEqual({ kind: 'patch', patch: 'pair patch' });
    expect(open.service.entryPatch).toHaveBeenCalledWith('repo-1', HASH_A, PAIR.entries[0]);
    expect(await open.host.fileDiff({ repoId: 'repo-1', source, path: 'src/other.ts' })).toEqual({ kind: 'missing' });
  });

  it('opens a commit pair as one changes tab titled left ↔ right', async () => {
    const { host, editorPane, service } = setup();
    await host.openRefsChanges('repo-1', { hash: HASH_A, label: 'main' }, { hash: HASH_B, label: 'feat' });
    expect(service.diffRefs).toHaveBeenCalledWith('repo-1', HASH_A, HASH_B);
    expect(editorPane.showChanges).toHaveBeenCalledWith({ title: 'main \u2194 feat', changes: { repoId: 'repo-1', source: { kind: 'refs', left: HASH_A, right: HASH_B }, entries: [PAIR.entries[0]!.change] } }, { focus: true });
    vi.mocked(service.diffRefs).mockResolvedValueOnce({ left: HASH_A, entries: [] });
    await host.openRefsChanges('repo-1', { hash: HASH_A, label: 'main' }, { hash: HASH_A, label: 'v1' });
    expect(vi.mocked(editorPane.showChanges)).toHaveBeenCalledTimes(1);
  });

  it('answers the artifacts request from core, unknown for an id main never issued, failed when git fails', async () => {
    const { host, service } = setup({ artifacts });
    expect(await host.artifacts({ repoId: 'repo-1', group: 'tags' })).toEqual({ ok: true, artifacts: { group: 'tags', rows: tags } });
    expect(await host.artifacts({ repoId: 'repo-9', group: 'tags' })).toEqual({ ok: false, reason: 'unknown' });
    vi.mocked(service.artifacts).mockRejectedValueOnce(new Error('git failed'));
    expect(await host.artifacts({ repoId: 'repo-1', group: 'tags' })).toEqual({ ok: false, reason: 'failed' });
    await expect(host.artifacts({ repoId: 'repo-1', group: 'notes' })).rejects.toThrow();
  });

  it('forwards artifacts-changed coalesced per repository', async () => {
    const { emit, artifactsChanged } = setup();
    emit({ kind: 'artifacts', repoId: 'repo-1', groups: ['tags'] });
    emit({ kind: 'artifacts', repoId: 'repo-1', groups: ['branches', 'tags'] });
    emit({ kind: 'artifacts', repoId: 'repo-9', groups: ['tags'] });
    await tick();
    expect(artifactsChanged).toEqual([{ repoId: 'repo-1', groups: ['tags', 'branches'] }]);
  });

  it('copies a stash row\'s description and branch from main\'s own list, refusing one with no branch', async () => {
    const { host, copied, notices } = setup({ artifacts });
    await host.copy({ repoId: 'repo-1', kind: 'stashName', value: HASH_B });
    await host.copy({ repoId: 'repo-1', kind: 'branchName', value: HASH_B });
    expect(copied).toEqual(['newest', 'main']);
    await expect(host.copy({ repoId: 'repo-1', kind: 'branchName', value: HASH_A })).resolves.toBeUndefined();
    expect(notices.at(-1)).toMatchObject({ severity: 'error', message: 'Copy names a stash made on no branch' });
    // a stash dropped meanwhile is answered with a notice, not an error
    await host.copy({ repoId: 'repo-1', kind: 'stashName', value: 'c'.repeat(40) });
    expect(notices.at(-1)!.message).toBe('The stash is no longer in this repository.');
    expect(copied).toHaveLength(2);
  });

  it('copies a branch, tag and worktree row\'s name, commit hash and path from main\'s own lists', async () => {
    const worktrees = [
      { path: projectPath, name: 'project', branch: 'main', commit: commit(HASH_A, 's'), main: true, current: true, locked: false, prunable: false },
      { path: path.join(path.dirname(projectPath), 'wt'), name: 'wt', branch: null, commit: commit(HASH_B, 's'), main: false, current: false, locked: false, prunable: false },
    ];
    const { host, copied, notices } = setup({ artifacts: { ...artifacts, worktrees } });
    await host.copy({ repoId: 'repo-1', kind: 'branchName', value: 'refs/heads/feat' });
    await host.copy({ repoId: 'repo-1', kind: 'commitHash', value: 'refs/heads/feat' });
    await host.copy({ repoId: 'repo-1', kind: 'tagName', value: 'refs/tags/v1' });
    await host.copy({ repoId: 'repo-1', kind: 'commitHash', value: 'refs/tags/v1' });
    await host.copy({ repoId: 'repo-1', kind: 'branchName', value: projectPath });
    await host.copy({ repoId: 'repo-1', kind: 'commitHash', value: worktrees[1]!.path });
    await host.copy({ repoId: 'repo-1', kind: 'worktreePath', value: worktrees[1]!.path });
    expect(copied).toEqual(['feat', HASH_B, 'v1', HASH_A, 'main', HASH_B, worktrees[1]!.path]);
    // a detached worktree has no branch to copy, and the menu offers none; one detached after the shell listed it is told
    await expect(host.copy({ repoId: 'repo-1', kind: 'branchName', value: worktrees[1]!.path })).resolves.toBeUndefined();
    expect(notices.at(-1)).toMatchObject({ severity: 'error', message: 'Copy names a worktree with no branch' });
    // a ref deleted meanwhile is answered with a notice
    await host.copy({ repoId: 'repo-1', kind: 'branchName', value: 'refs/heads/gone' });
    expect(notices.at(-1)!.message).toBe('"refs/heads/gone" is no longer in this repository.');
    // each kind names only its row forms: a tag name for a branch ref, a path for a tag, a hash for a worktree path
    await expect(host.copy({ repoId: 'repo-1', kind: 'tagName', value: 'refs/heads/feat' })).rejects.toThrow('Malformed');
    await expect(host.copy({ repoId: 'repo-1', kind: 'tagName', value: projectPath })).rejects.toThrow('Malformed');
    await expect(host.copy({ repoId: 'repo-1', kind: 'worktreePath', value: HASH_A })).rejects.toThrow('Malformed');
    expect(copied).toHaveLength(7);
  });

  it('compares a row\'s ref with a picked other ref as one changes tab, the picked one on the left', async () => {
    const { host, editorPane, service, pickRequests } = setup({ artifacts, picks: ['1'] });
    await host.run({ op: 'compareRef', repoId: 'repo-1', ref: 'refs/heads/feat' });
    expect(pickRequests[0]!.placeholder).toBe('Select a reference to compare with');
    // the row's own ref is not offered; local branches, remote branches and tags each a group, in core's order
    expect(pickRequests[0]!.items.map((item) => item.label)).toEqual(['main', 'origin/main', 'origin/topic', 'v1']);
    expect(service.diffRefs).toHaveBeenCalledWith('repo-1', HASH_A, HASH_B);
    expect(editorPane.showChanges).toHaveBeenCalledWith(expect.objectContaining({ title: 'origin/main \u2194 feat' }), { focus: true });
    // a ref no longer listed is refused before any picker
    expect(await host.run({ op: 'compareRef', repoId: 'repo-1', ref: 'refs/heads/gone' })).toEqual({ ok: false, reason: 'failed' });
    await expect(host.run({ op: 'compareRef', repoId: 'repo-1', ref: 'refs/remotes/origin/main' })).rejects.toThrow('Malformed');
    expect(pickRequests).toHaveLength(1);
  });

  it('opens the worktree holding the project folder by selecting the project, and adds any other as a project', async () => {
    const other = path.join(path.dirname(projectPath), 'other-wt');
    const worktrees = [
      { path: projectPath, name: 'project', branch: 'main', commit: commit(HASH_A, 's'), main: true, current: true, locked: false, prunable: false },
      { path: other, name: 'other-wt', branch: 'wt', commit: commit(HASH_B, 's'), main: false, current: false, locked: false, prunable: false },
    ];
    const { host, added, selectedProjects, notices } = setup({ artifacts: { ...artifacts, worktrees } });
    const listed = await host.artifacts({ repoId: 'repo-1', group: 'worktrees' });
    expect(listed.ok && listed.artifacts.group === 'worktrees' ? listed.artifacts.rows.map((row) => row.opens) : []).toEqual(['project', 'addProject']);
    await host.run({ op: 'openWorktree', repoId: 'repo-1', path: projectPath });
    expect(selectedProjects).toEqual(['p']);
    await host.run({ op: 'openWorktree', repoId: 'repo-1', path: other });
    expect(added).toEqual([other]);
    // a worktree removed meanwhile is told, never added
    expect(await host.run({ op: 'openWorktree', repoId: 'repo-1', path: path.join(path.dirname(projectPath), 'gone') })).toEqual({ ok: false, reason: 'failed' });
    expect(notices.at(-1)!.message).toContain('is no longer in this repository.');
    expect(added).toHaveLength(1);
  });

  it('creates an annotated tag with a message, a lightweight one when the message is dismissed, and deletes a remote tag', async () => {
    const { host, service, inputRequests, pickRequests } = setup({ inputs: ['v2', 'Release two', 'light', undefined], picks: ['0'] });
    await host.run({ op: 'createTag', repoId: 'repo-1' });
    expect(inputRequests[0]).toMatchObject({ prompt: 'Please provide a tag name', placeholder: 'Tag name', validation: 'tagName' });
    expect(inputRequests[1]).toMatchObject({ prompt: 'Please provide a message to annotate the tag', placeholder: 'Message' });
    expect(service.createTag).toHaveBeenLastCalledWith('repo-1', 'v2', 'Release two');
    await host.run({ op: 'createTag', repoId: 'repo-1' });
    expect(service.createTag).toHaveBeenLastCalledWith('repo-1', 'light', '');
    // one remote with a push URL: no remote picker
    await host.run({ op: 'deleteRemoteTag', repoId: 'repo-1' });
    expect(pickRequests).toHaveLength(1);
    expect(pickRequests[0]).toMatchObject({ placeholder: 'Select a remote tag to delete' });
    expect(service.deleteRemoteRef).toHaveBeenCalledWith('repo-1', 'origin', 'refs/tags/v1');
    const noRemote = setup({ remotes: [] });
    expect(await noRemote.host.run({ op: 'pushTags', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'failed' });
    expect(noRemote.notices[0]!.message).toBe('Your repository has no remotes configured to push to.');
  });

  it('creates a worktree on a new branch at the default path, and deletes a dirty one only after the force question', async () => {
    const worktrees = [
      { path: projectPath, name: 'project', branch: 'main', commit: commit(HASH_A, 's'), main: true, current: true, locked: false, prunable: false },
      { path: path.join(path.dirname(projectPath), 'project.worktrees', 'wt'), name: 'wt', branch: 'wt', commit: commit(HASH_B, 's'), main: false, current: false, locked: false, prunable: false },
    ];
    const created = setup({ artifacts: { ...artifacts, worktrees }, picks: ['0'], inputs: ['new-branch', path.join(path.dirname(projectPath), 'project.worktrees', 'new-branch')] });
    await created.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(created.inputRequests[1]).toMatchObject({ prompt: 'Please provide a worktree path', value: path.join(path.dirname(projectPath), 'project.worktrees', 'new-branch') });
    expect(created.service.addWorktree).toHaveBeenCalledWith('repo-1', path.join(path.dirname(projectPath), 'project.worktrees', 'new-branch'), 'HEAD', 'new-branch');
    const relative = setup({ artifacts: { ...artifacts, worktrees }, picks: ['0'], inputs: ['x', 'relative/wt'] });
    expect(await relative.host.run({ op: 'createWorktree', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'failed' });
    expect(relative.service.addWorktree).not.toHaveBeenCalled();
    const dirty = setup({ artifacts: { ...artifacts, worktrees }, removals: ['dirty', 'ok'], answers: [0, 0] });
    await dirty.host.run({ op: 'deleteWorktree', repoId: 'repo-1', path: worktrees[1]!.path });
    expect(dirty.questions[1]).toMatchObject({ severity: 'danger', message: 'The worktree contains modified or untracked files. Do you want to force delete?', detail: `Worktree: ${worktrees[1]!.path}`, actions: ['Force Delete'] });
    expect(vi.mocked(dirty.service.removeWorktree).mock.calls).toEqual([['repo-1', worktrees[1]!.path, false], ['repo-1', worktrees[1]!.path, true]]);
    // the main worktree is never deleted
    expect(await dirty.host.run({ op: 'deleteWorktree', repoId: 'repo-1', path: projectPath })).toEqual({ ok: false, reason: 'failed' });
  });

  it('offers a folder button on the worktree path that picks a folder and keeps the name selected, and defaults to the remembered folder', async () => {
    const picked = path.join(path.dirname(projectPath), 'picked');
    const created = setup({ artifacts, picks: [{ id: '0', query: 'wt one' }], inputs: ['wt-one', undefined], folder: picked });
    await created.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(created.pickRequests[0]!.items[0]).toMatchObject({ label: 'Create new branch...', echoQuery: true });
    expect(created.inputRequests[0]).toMatchObject({ value: 'wt-one' });
    const box = created.inputRequests[1]!;
    expect(box.browse?.tooltip).toBe('Select Worktree Destination');
    expect(await box.browse!.pick(box.value ?? '')).toEqual({ value: path.join(picked, 'wt-one'), valueSelection: [path.join(picked, 'wt-one').length - 6, path.join(picked, 'wt-one').length] });
    expect(created.folderRequests).toEqual([{ defaultPath: path.dirname(projectPath), title: 'Select Worktree Destination', buttonLabel: 'Select as Worktree Destination' }]);
    // a cancelled folder picker leaves the box as it is
    const cancelled = setup({ artifacts, picks: ['0'], inputs: ['x', undefined] });
    await cancelled.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(await cancelled.inputRequests[1]!.browse!.pick('')).toBeUndefined();
    // a remembered folder is the suggested path's folder and where the picker opens
    const remembered = path.join(path.dirname(projectPath), 'trees');
    const again = setup({ artifacts, picks: ['0'], inputs: ['next', path.join(remembered, 'next')], worktreeFolder: remembered, folder: remembered });
    await again.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(again.inputRequests[1]).toMatchObject({ value: path.join(remembered, 'next'), valueSelection: [path.join(remembered, 'next').length - 4, path.join(remembered, 'next').length] });
    await again.inputRequests[1]!.browse!.pick('');
    expect(again.folderRequests[0]!.defaultPath).toBe(remembered);
    expect(again.service.addWorktree).toHaveBeenCalledWith('repo-1', path.join(remembered, 'next'), 'HEAD', 'next');
  });
});

describe('source control host: flows after a write, refusals and kept stashes', () => {
  const commit = (hash: string, subject: string, date = 1_700_000_000_000) => ({ hash, subject, author: 'Ada', date });
  const HASH_C = 'c'.repeat(40);
  const branches = [
    { ref: 'refs/heads/main', name: 'main', commit: commit(HASH_A, 'main subject'), current: true, upstream: { remote: 'origin', branch: 'main', ahead: 0, behind: 0 } },
    { ref: 'refs/heads/feat', name: 'feat', commit: commit(HASH_B, 'feat subject'), current: false, upstream: null },
  ];
  const tags = [{ ref: 'refs/tags/v1', name: 'v1', commit: commit(HASH_C, 'tagged subject'), annotated: true, current: false }];
  const stashes = [{ index: 0, hash: HASH_B, description: 'On main: wip', branch: 'main', date: 1 }];
  const worktree = (name: string, extra: Partial<{ main: boolean; current: boolean }> = {}) => ({ path: path.join(path.dirname(projectPath), name), name, branch: name, commit: commit(HASH_B, 's'), main: false, current: false, locked: false, prunable: false, ...extra });
  const mainWorktree = { ...worktree('project', { main: true, current: true }), path: projectPath };

  it('pushes the branch a commit to a new branch made, offering Publish for it, and the branch Continue Rebase lands on', async () => {
    // core resolves a commit only once its status refresh landed, which the fake does by changing the status first
    const landOn: RepositoryStatus = { ...status, head: { type: 'branch', name: 'topic' }, upstream: null };
    const h = setup({
      settings: { [SCM_SETTING_KEYS.postCommitCommand]: 'push' },
      answers: [0],
      commit: async () => {
        Object.assign(h.repos.get('repo-1')!, { lastStatus: landOn });
        return { ok: true };
      },
    });
    await h.host.commit({ repoId: 'repo-1', message: 'x', variant: PLAIN });
    await vi.waitFor(() => expect(vi.mocked(h.service.push)).toHaveBeenCalled());
    expect(h.questions[0]).toMatchObject({ severity: 'warning', message: 'The branch "topic" has no remote branch. Would you like to publish this branch?' });
    expect(vi.mocked(h.service.push)).toHaveBeenCalledWith('repo-1', { remote: 'origin', branch: 'topic', setUpstream: true, followTags: false, force: false });

    const rebasing: RepositoryStatus = { ...status, head: { type: 'detached', commit: HASH_A } as never, operation: { kind: 'rebase' } as never };
    const r = setup({
      status: rebasing,
      settings: { [SCM_SETTING_KEYS.postCommitCommand]: 'push' },
      commit: async () => {
        Object.assign(r.repos.get('repo-1')!, { lastStatus: status });
        return { ok: true };
      },
    });
    await r.host.commit({ repoId: 'repo-1', message: '', variant: PLAIN });
    await vi.waitFor(() => expect(vi.mocked(r.service.push)).toHaveBeenCalledWith('repo-1', { remote: 'origin', branch: 'main', toBranch: 'main', setUpstream: false, followTags: false, force: false }));
    expect(r.notices).toEqual([]);
  });

  it('lists every ref while they fit, and past the overlay\'s bounds keeps every local branch, the newest remote branches and tags, and a row naming the rest', async () => {
    const many = MAX_QUICK_PICK_ITEMS + 5_000;
    // core lists them newest first; every tenth is a tag
    const remoteBranches = Array.from({ length: many }, (_, index) => ({ ref: `refs/remotes/origin/pr/${index}`, name: `origin/pr/${index}`, remote: 'origin', commit: commit(HASH_A, 'pr', 2_000_000_000_000 - index * 2) }));
    const oldTags = [{ ref: 'refs/tags/ancient', name: 'ancient', commit: commit(HASH_C, 'old', 1) }, { ref: 'refs/tags/fresh', name: 'fresh', commit: commit(HASH_C, 'new', 2_000_000_000_001) }].map((tag) => ({ ...tag, annotated: false, current: false }));
    const h = setup({ artifacts: { branches, remoteBranches, tags: [oldTags[1]!, oldTags[0]!] }, picks: ['3'] });
    expect(await h.host.run({ op: 'checkout', repoId: 'repo-1', detached: false })).toEqual({ ok: true });
    const items = h.pickRequests[0]!.items as ReadonlyArray<Record<string, unknown>>;
    expect(items.length).toBeLessThanOrEqual(MAX_QUICK_PICK_ITEMS);
    const labels = items.map((item) => item['label']);
    expect(labels.slice(0, 5)).toEqual(['Create new branch...', 'Create new branch from...', 'Checkout detached...', 'main', 'feat']);
    expect(labels).toContain('fresh');
    expect(labels).not.toContain('ancient');
    expect(labels).toContain('origin/pr/0');
    expect(labels).not.toContain(`origin/pr/${many - 1}`);
    const shown = items.length - 3 - 1;
    expect(items.at(-1)).toMatchObject({ label: `${many + 2 + 2 - shown} more refs not shown`, alwaysShow: true, info: true });
    expect(h.service.checkout).toHaveBeenCalledWith('repo-1', { kind: 'branch', name: 'main' });
    // the info row answers nothing
    const more = setup({ artifacts: { branches, remoteBranches } });
    Object.assign(more.host.deps, { quickPick: async (_placeholder: string, offered: ReadonlyArray<{ id: string }>) => ({ id: offered.at(-1)!.id, query: '' }) });
    expect(await more.host.run({ op: 'checkout', repoId: 'repo-1', detached: true })).toEqual({ ok: false, reason: 'cancelled' });
    expect(more.service.checkout).not.toHaveBeenCalled();
  });

  it('always asks before deleting a worktree, naming the project it holds, which closes afterwards; Cancel deletes nothing', async () => {
    const linked = worktree('review');
    const other = worktree('plain');
    const projects = [{ key: 'p', fsPath: projectPath, name: 'project' }, { key: 'w', fsPath: linked.path, name: 'Review' }];
    const run = (answers: Array<number | undefined>, removals: Array<'ok' | 'dirty'> = ['ok'], removeProject?: { ok: false; reason: string }) => {
      const h = setup({ artifacts: { worktrees: [mainWorktree, linked, other] }, answers, removals, ...(removeProject ? { removeProject } : {}) });
      Object.assign(h.host.deps, { projects: () => projects });
      return h;
    };
    const cancelled = run([undefined]);
    expect(await cancelled.host.run({ op: 'deleteWorktree', repoId: 'repo-1', path: linked.path })).toEqual({ ok: false, reason: 'cancelled' });
    expect(cancelled.questions[0]).toEqual({
      severity: 'danger',
      message: `Are you sure you want to delete the worktree "${linked.path}"? The project "Review" is in it and will be closed, and its chats will no longer be listed.`,
      detail: 'Its ignored files, such as .env and node_modules, are deleted too.',
      actions: ['Delete Worktree'],
      cancelLabel: 'Cancel',
    });
    expect(cancelled.service.removeWorktree).not.toHaveBeenCalled();
    expect(cancelled.removedProjects).toEqual([]);

    const deleted = run([0]);
    expect(await deleted.host.run({ op: 'deleteWorktree', repoId: 'repo-1', path: linked.path })).toEqual({ ok: true });
    expect(vi.mocked(deleted.service.removeWorktree).mock.calls).toEqual([['repo-1', linked.path, false]]);
    expect(deleted.removedProjects).toEqual(['w']);

    // the palette's picker asks the same, and a clean worktree holding no project closes nothing
    const plain = setup({ artifacts: { worktrees: [mainWorktree, linked, other] }, answers: [0], picks: ['1'] });
    expect(await plain.host.run({ op: 'deleteWorktree', repoId: 'repo-1' })).toEqual({ ok: true });
    expect(plain.questions[0]).toMatchObject({ severity: 'danger', message: `Are you sure you want to delete the worktree "${other.path}"?` });
    expect(plain.service.removeWorktree).toHaveBeenCalledWith('repo-1', other.path, false);
    expect(plain.removedProjects).toEqual([]);

    // dirty: Force Delete as VS Code asks it, and a project that cannot close says why
    const dirty = run([0, 0], ['dirty', 'ok'], { ok: false, reason: 'A conversation is running in Review.' });
    expect(await dirty.host.run({ op: 'deleteWorktree', repoId: 'repo-1', path: linked.path })).toEqual({ ok: false, reason: 'failed' });
    expect(dirty.questions[1]).toMatchObject({ severity: 'danger', actions: ['Force Delete'] });
    expect(vi.mocked(dirty.service.removeWorktree).mock.calls.at(-1)).toEqual(['repo-1', linked.path, true]);
    expect(dirty.notices.at(-1)!.message).toBe('The worktree was deleted, but its project "Review" could not be closed: A conversation is running in Review.');
  });

  it('stashes with untracked files before a checkout, and Migrate Changes pops the latest stash after it', async () => {
    const changed: RepositoryStatus = { ...status, groups: { ...status.groups, untracked: [{ path: 'new.ts', status: 'UNTRACKED', letter: 'U', tone: 'untracked', strike: false }] } };
    const stashAndCheckout = setup({ artifacts: { branches, stashes }, checkouts: ['dirty', 'ok'], answers: [0], inputs: [''], current: changed });
    expect(await stashAndCheckout.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' })).toEqual({ ok: true });
    expect(stashAndCheckout.service.stash).toHaveBeenCalledWith('repo-1', 'includeUntracked', '', []);
    expect(stashAndCheckout.service.checkout).toHaveBeenCalledTimes(2);
    expect(stashAndCheckout.service.stashApply).not.toHaveBeenCalled();
    const migrate = setup({ artifacts: { branches, stashes }, checkouts: ['dirty', 'ok'], answers: [1], inputs: [''], current: changed });
    expect(await migrate.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' })).toEqual({ ok: true });
    expect(migrate.service.stashApply).toHaveBeenCalledWith('repo-1', { index: 0, hash: HASH_B }, true);
    // a dismissed stash message checks nothing out
    const dismissed = setup({ artifacts: { branches, stashes }, checkouts: ['dirty'], answers: [0], inputs: [undefined], current: changed });
    expect(await dismissed.host.run({ op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/feat' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(dismissed.service.checkout).toHaveBeenCalledTimes(1);
  });

  it('stashes only the changes it was given that the fresh status lists, with untracked files when one is untracked', async () => {
    const changed: RepositoryStatus = { ...status, groups: { ...status.groups, untracked: [{ path: 'new.ts', status: 'UNTRACKED', letter: 'U', tone: 'untracked', strike: false }] } };
    const h = setup({ current: changed, inputs: ['', ''] });
    await h.host.run({ op: 'stashChanges', repoId: 'repo-1', paths: ['src/a.ts', 'gone.ts'] });
    expect(h.service.stash).toHaveBeenLastCalledWith('repo-1', 'default', '', ['src/a.ts']);
    await h.host.run({ op: 'stashChanges', repoId: 'repo-1', paths: ['src/a.ts', 'new.ts'] });
    expect(h.service.stash).toHaveBeenLastCalledWith('repo-1', 'includeUntracked', '', ['src/a.ts', 'new.ts']);
    expect(await h.host.run({ op: 'stashChanges', repoId: 'repo-1', paths: ['gone.ts'] })).toEqual({ ok: false, reason: 'failed' });
    expect(h.notices.at(-1)!.message).toBe('There are no changes to stash.');
  });

  it('makes a taken worktree path unique, and refuses a UNC, root-relative or control-character path', async () => {
    const taken = worktree('wt');
    const first = setup({ artifacts: { worktrees: [mainWorktree, taken, { ...worktree('wt-1'), path: `${taken.path}-1` }] }, picks: ['0'], inputs: ['next', taken.path] });
    await first.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(first.service.addWorktree).toHaveBeenCalledWith('repo-1', `${taken.path}-2`, 'HEAD', 'next');
    const refused: Array<[NodeJS.Platform, string]> = [['win32', '\\\\server\\share\\wt'], ['win32', '\\wt'], ['win32', '/wt'], ['linux', '/work/w\u0007t'], ['linux', 'relative/wt']];
    for (const [platform, typed] of refused) {
      const h = setup({ platform, picks: ['0'], inputs: ['next', typed] });
      expect(await h.host.run({ op: 'createWorktree', repoId: 'repo-1' }), typed).toEqual({ ok: false, reason: 'failed' });
      expect(h.service.addWorktree, typed).not.toHaveBeenCalled();
      expect(h.notices.at(-1)!.message, typed).toBe(`"${typed}" is not an absolute folder path on this computer.`);
    }
    const drive = setup({ platform: 'win32', picks: ['0'], inputs: ['next', 'D:\\trees\\next'] });
    expect(await drive.host.run({ op: 'createWorktree', repoId: 'repo-1' })).toEqual({ ok: true });
  });

  it('creates a worktree from a tag detached at its commit and from a remote branch by its full refname, named after the ref', async () => {
    const remoteBranches = [{ ref: 'refs/remotes/origin/topic', name: 'origin/topic', remote: 'origin', commit: commit(HASH_A, 's') }];
    const tag = setup({ artifacts: { branches, remoteBranches, tags }, picks: ['4'], inputs: [path.resolve('/trees/v1')] });
    await tag.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(tag.inputRequests[0]!.value).toBe(path.join(path.dirname(projectPath), 'project.worktrees', 'v1'));
    expect(tag.service.addWorktree).toHaveBeenCalledWith('repo-1', path.resolve('/trees/v1'), HASH_C, undefined);
    const remote = setup({ artifacts: { branches, remoteBranches, tags }, picks: ['3'], inputs: [path.resolve('/trees/topic')] });
    await remote.host.run({ op: 'createWorktree', repoId: 'repo-1' });
    expect(remote.inputRequests[0]!.value).toBe(path.join(path.dirname(projectPath), 'project.worktrees', 'origin-topic'));
    expect(remote.service.addWorktree).toHaveBeenCalledWith('repo-1', path.resolve('/trees/topic'), 'refs/remotes/origin/topic', undefined);
  });

  it('closes the View Stash tab of a stash dropped outside the app when the stash list changes', async () => {
    const source = { kind: 'stash', index: 3, hash: HASH_C } as const;
    const kept = { kind: 'stash', index: 0, hash: HASH_B } as const;
    const h = setup({ artifacts: { stashes }, changesTabs: [{ tabId: 'a', state: { title: 'x', changes: { repoId: 'repo-1', source, entries: [] } } }, { tabId: 'b', state: { title: 'y', changes: { repoId: 'repo-1', source: kept, entries: [] } } }] });
    h.emit({ kind: 'artifacts', repoId: 'repo-1', groups: ['stashes'] });
    await vi.waitFor(() => expect(h.editorPane.closeChangesTabs).toHaveBeenCalledTimes(1));
    const close = vi.mocked(h.editorPane.closeChangesTabs).mock.calls[0]![0];
    expect(close({ repoId: 'repo-1', source, entries: [] })).toBe(true);
    expect(close({ repoId: 'repo-1', source: kept, entries: [] })).toBe(false);
  });

  it('asks before deleting a tag a row names', async () => {
    const declined = setup({ artifacts: { tags }, answers: [undefined] });
    expect(await declined.host.run({ op: 'deleteTag', repoId: 'repo-1', ref: 'refs/tags/v1' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(declined.questions[0]).toMatchObject({ message: 'Are you sure you want to delete tag "v1"? This action will permanently remove the tag reference from the repository.', actions: ['Delete Tag'] });
    expect(declined.service.deleteTag).not.toHaveBeenCalled();
    const accepted = setup({ artifacts: { tags }, answers: [0] });
    await accepted.host.run({ op: 'deleteTag', repoId: 'repo-1', ref: 'refs/tags/v1' });
    expect(accepted.service.deleteTag).toHaveBeenCalledWith('repo-1', 'v1');
  });

  it('syncs a branch with no upstream by offering Publish, and warns on a detached HEAD instead of ending silently', async () => {
    const unpublished = setup({ status: { ...status, upstream: null }, answers: [0] });
    expect(await unpublished.host.run({ op: 'sync', repoId: 'repo-1', rebase: false })).toEqual({ ok: true });
    expect(unpublished.service.sync).not.toHaveBeenCalled();
    expect(unpublished.service.push).toHaveBeenCalledWith('repo-1', { remote: 'origin', branch: 'main', setUpstream: true, followTags: false, force: false });
    const detached = setup({ status: { ...status, head: { type: 'detached', commit: HASH_A } as never } });
    expect(await detached.host.run({ op: 'sync', repoId: 'repo-1', rebase: false })).toEqual({ ok: false, reason: 'failed' });
    expect(detached.notices).toEqual([{ severity: 'warn', message: 'Please check out a branch to push to a remote.', actions: [] }]);
    expect(detached.service.sync).not.toHaveBeenCalled();
  });

  it('fetches from a picked remote, the upstream\'s first, or from all; pulls a picked branch of a picked remote; removes a picked remote', async () => {
    const remotes = [{ name: 'backup', fetchUrl: 'https://example.com/b.git' }, { name: 'origin', fetchUrl: 'https://example.com/a.git' }];
    const h = setup({ remotes, picks: ['0', '2', '0', '1', '1'] });
    await h.host.run({ op: 'fetch', repoId: 'repo-1', scope: 'default' });
    expect(h.pickRequests[0]!.items.map((item) => item.label)).toEqual(['origin', 'backup', 'Fetch From All Remotes']);
    expect(h.service.fetch).toHaveBeenLastCalledWith('repo-1', { remote: 'origin' });
    await h.host.run({ op: 'fetch', repoId: 'repo-1', scope: 'default' });
    expect(h.service.fetch).toHaveBeenLastCalledWith('repo-1', { all: true });
    await h.host.run({ op: 'pullFrom', repoId: 'repo-1' });
    expect(h.pickRequests[3]!.items.map((item) => item.label)).toEqual(['backup/main', 'backup/dev']);
    expect(h.service.pull).toHaveBeenCalledWith('repo-1', { rebase: false, remote: 'backup', branch: 'dev' });
    await h.host.run({ op: 'removeRemote', repoId: 'repo-1' });
    expect(h.service.removeRemote).toHaveBeenCalledWith('repo-1', 'origin');
    expect(h.pickRequests.every((request) => request.items.every((item, index) => item.id === `${index}`))).toBe(true);
  });

  it('answers a flow whose repository closed while it waited on a picker as unknown, with no notice', async () => {
    const h = setup({ artifacts: { branches } });
    // core's lookup of a closed repository
    vi.mocked(h.service.checkout).mockRejectedValueOnce(new Error('Unknown repository'));
    Object.assign(h.host.deps, {
      quickPick: async () => {
        h.repos.delete('repo-1');
        return { id: '3', query: '' };
      },
    });
    expect(await h.host.run({ op: 'checkout', repoId: 'repo-1', detached: false })).toEqual({ ok: false, reason: 'unknown' });
    expect(h.notices).toEqual([]);
  });

  it('keeps a picker\'s ids and placeholder within the overlay\'s bounds whatever the names, and says when the detached picker has nothing', async () => {
    const long = `feature/${'x'.repeat(300)}`;
    const h = setup({ status: { ...status, head: { type: 'branch', name: long }, upstream: null }, remotes: [{ name: 'origin', pushUrl: 'https://example.com/a.git' }, { name: 'backup', pushUrl: 'https://example.com/b.git' }], answers: [0] });
    await h.host.run({ op: 'push', repoId: 'repo-1', to: true, force: false, followTags: false });
    const placeholder = h.pickRequests[0]!.placeholder;
    expect(placeholder.length).toBeLessThanOrEqual(MAX_OVERLAY_LABEL_LENGTH);
    expect(placeholder).toMatch(/^Pick a remote to publish the branch "\u2026x+" to:$/);
    const empty = setup();
    expect(await empty.host.run({ op: 'checkout', repoId: 'repo-1', detached: true })).toEqual({ ok: false, reason: 'failed' });
    expect(empty.pickRequests).toEqual([]);
    expect(empty.notices).toEqual([{ severity: 'info', message: 'This repository has no other branches.', actions: [] }]);
  });

  it('warns that a remote branch\'s remote name cannot be used, rather than ending silently', async () => {
    const remoteBranches = [{ ref: 'refs/remotes/-x/topic', name: '-x/topic', remote: '-x', commit: commit(HASH_A, 's') }];
    const h = setup({ artifacts: { branches, remoteBranches }, picks: ['0'] });
    expect(await h.host.run({ op: 'deleteRemoteBranch', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'failed' });
    expect(h.service.deleteRemoteRef).not.toHaveBeenCalled();
    expect(h.notices).toEqual([{ severity: 'warn', message: 'Remote name format invalid', actions: [] }]);
  });

  it('renames nothing when Rename Branch keeps the current name', async () => {
    const h = setup({ artifacts: { branches }, inputs: ['main'] });
    expect(await h.host.run({ op: 'renameBranch', repoId: 'repo-1' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(h.service.renameBranch).not.toHaveBeenCalled();
    expect(h.notices).toEqual([]);
  });

  it('drops a cached commit pair once no open tab holds it', async () => {
    const tabs: Array<{ tabId: string; state: { title: string; changes: ScmChangesTab } }> = [];
    const h = setup({ artifacts: { stashes }, changesTabs: tabs });
    await h.host.run({ op: 'viewStash', repoId: 'repo-1', target: { index: 0, hash: HASH_B } });
    // that tab closed, then a Compare tab opened
    await h.host.openRefsChanges('repo-1', { hash: HASH_A, label: 'main' }, { hash: HASH_B, label: 'feat' });
    tabs.push({ tabId: 's', state: { title: 'x', changes: { repoId: 'repo-1', source: { kind: 'stash', index: 0, hash: HASH_B }, entries: [] } } });
    await h.host.fileDiff({ repoId: 'repo-1', source: { kind: 'stash', index: 0, hash: HASH_B }, path: 'src/a.ts' });
    expect(h.service.diffStash).toHaveBeenCalledTimes(2);
  });

  it('tells where a stash the engine kept is, beside the operation\'s own failure or conflict, and offers View Stash', async () => {
    const failed = setup({ artifacts: { stashes } });
    vi.mocked(failed.service.pull).mockRejectedValueOnce(new StashKeptError('kept', 'failed', HASH_B, new Error('fatal: unable to access the remote')));
    expect(await failed.host.run({ op: 'pull', repoId: 'repo-1', rebase: false })).toEqual({ ok: false, reason: 'failed' });
    await vi.waitFor(() => expect(failed.notices).toHaveLength(2));
    expect(failed.notices).toEqual([
      { severity: 'error', message: 'fatal: unable to access the remote', actions: ['Show Git Output'] },
      { severity: 'warn', message: 'Your changes were stashed for this operation and could not be applied back, so they are kept in the stash list as stash #0: On main: wip.', actions: ['View Stash'] },
    ]);
    const cancelled = setup({ artifacts: { stashes } });
    vi.mocked(cancelled.service.pull).mockRejectedValueOnce(new StashKeptError('kept', 'cancelled', HASH_B));
    await cancelled.host.run({ op: 'pull', repoId: 'repo-1', rebase: false });
    await vi.waitFor(() => expect(cancelled.notices).toHaveLength(1));
    expect(cancelled.notices[0]!.actions).toEqual(['View Stash']);
    const conflict = setup({ artifacts: { branches, stashes }, picks: ['0'] });
    vi.mocked(conflict.service.integrate).mockRejectedValueOnce(new StashKeptError('kept', 'conflict', HASH_B));
    await conflict.host.run({ op: 'merge', repoId: 'repo-1' });
    await vi.waitFor(() => expect(conflict.notices).toHaveLength(2));
    expect(conflict.notices[0]!.message).toBe('There are merge conflicts. Please resolve them before committing your changes.');
    // a stash no longer listed is named by the engine's own words
    const gone = setup();
    vi.mocked(gone.service.sync).mockRejectedValueOnce(new StashKeptError('Your changes are kept in the stash list.', 'ok', 'd'.repeat(40)));
    await gone.host.run({ op: 'sync', repoId: 'repo-1', rebase: false });
    await vi.waitFor(() => expect(gone.notices).toEqual([{ severity: 'warn', message: 'Your changes are kept in the stash list.', actions: [] }]));
  });

  it('opens View Stash on the kept stash when its action is taken', async () => {
    const h = setup({ artifacts: { stashes } });
    Object.assign(h.host.deps.notify, { warn: async (_message: string, ...actions: string[]) => actions[0] });
    vi.mocked(h.service.pull).mockRejectedValueOnce(new StashKeptError('kept', 'ok', HASH_B));
    await h.host.run({ op: 'pull', repoId: 'repo-1', rebase: false });
    await vi.waitFor(() => expect(h.service.diffStash).toHaveBeenCalledWith('repo-1', HASH_B));
  });

  it('names the confirmed and the current branch when a sync stops because HEAD moved', async () => {
    const h = setup();
    const confirmed = { branch: 'main', remote: 'origin', upstreamBranch: 'main' };
    vi.mocked(h.service.sync).mockRejectedValueOnce(new SyncBranchChangedError('changed', 'pull', confirmed, { branch: 'feat', remote: 'origin', upstreamBranch: 'feat' }));
    expect(await h.host.run({ op: 'sync', repoId: 'repo-1', rebase: false })).toEqual({ ok: false, reason: 'failed' });
    vi.mocked(h.service.sync).mockRejectedValueOnce(new SyncBranchChangedError('changed', 'push', confirmed, null));
    await h.host.run({ op: 'sync', repoId: 'repo-1', rebase: false });
    expect(h.notices).toEqual([
      { severity: 'warn', message: 'The sync was confirmed for "main" tracking "origin/main", but the repository is now on "feat" tracking "origin/feat", so nothing was pulled or pushed.', actions: [] },
      { severity: 'warn', message: 'The sync was confirmed for "main" tracking "origin/main", but after the pull the repository is on no branch with an upstream, so nothing was pushed.', actions: [] },
    ]);
  });

  it('reads the git settings once per menu state, and runs an autofetch round for the e2e hook', () => {
    const h = setup();
    const before = h.settingReads();
    h.host.menuState();
    expect(h.settingReads() - before).toBe(6);
    h.host.autofetchNow();
    expect(h.service.autofetchNow).toHaveBeenCalledTimes(1);
  });
});
