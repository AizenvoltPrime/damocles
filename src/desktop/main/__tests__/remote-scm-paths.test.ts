import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Artifacts } from '../../../core/scm/artifacts';
import type { Change, RepositoryStatus } from '../../../core/scm/repository';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { rootKey } from '../../preload/folder-root';
import type { Document, DocumentService } from '../documents/document-service';
import type { EditorPane } from '../editor-pane';
import { remoteFileRef } from '../remote/remote-files';
import type { RemoteProject } from '../remote/authorities';
import type { ScmServiceClient } from '../scm/scm-client';
import { ScmHost } from '../scm/scm-host';
import { englishText, type LocalizedText } from '../../../shared/localized-text';
import { createDesktopLocalizationService } from '../../local-services/localization-service';

// Every source control action on a remote repository names its files only through remoteFileRef, inside that host's projects
// and live chat worktrees; nothing resolves against this computer's files or matches its editors by path.

const HOST = 'ssh+h1';
const APP = `${HOST}|/srv/app`;
const WORKTREE = rootKey({ projectKey: APP, worktreeId: 'wt1a2b3c' });
// what index.ts's remoteFileRoots gives each authority: its live chat worktrees first, then its projects
const ROOTS: readonly RemoteProject[] = [
  { key: WORKTREE, fsPath: '/srv/worktrees/app-wt1', name: 'app', authorityKey: HOST, folderKey: '/srv/app', os: 'linux' },
  { key: APP, fsPath: '/srv/app', name: 'app', authorityKey: HOST, folderKey: '/srv/app', os: 'linux' },
  { key: 'ssh+h2|/srv/h2app', fsPath: '/srv/h2app', name: 'h2app', authorityKey: 'ssh+h2', folderKey: '/srv/h2app', os: 'linux' },
];
// the same projects on a Windows host, whose paths compare without case
const WIN_ROOTS: readonly RemoteProject[] = [
  { key: WORKTREE, fsPath: 'C:\\Srv\\Worktrees\\app-wt1', name: 'app', authorityKey: HOST, folderKey: 'c:\\srv\\app', os: 'win32' },
  { key: APP, fsPath: 'C:\\Srv\\App', name: 'app', authorityKey: HOST, folderKey: 'c:\\srv\\app', os: 'win32' },
  { key: 'ssh+h2|c:\\srv\\h2app', fsPath: 'C:\\Srv\\H2App', name: 'h2app', authorityKey: 'ssh+h2', folderKey: 'c:\\srv\\h2app', os: 'win32' },
];
const localProject = path.resolve('/work/app');
const HASH = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

const change = (file: string, status: Change['status']): Change => ({ path: file, status, letter: 'M', tone: 'modified', strike: false });
const STATUS: RepositoryStatus = {
  head: { type: 'branch', name: 'main' },
  commit: { hash: HASH, subject: 's' },
  operation: null,
  groups: { merge: [change('src/a.ts', 'BOTH_MODIFIED')], index: [change('src/a.ts', 'INDEX_MODIFIED')], workingTree: [change('src/a.ts', 'MODIFIED')], untracked: [] },
  tooManyChanges: false,
  submodules: [],
  upstream: null,
  remotes: [],
};

const textDocument = (id: string, location: { path: string; projectKey?: string; relativePath?: string }, text: string): Document =>
  ({ id, kind: 'text', location, name: 'a.ts', languageId: 'typescript', encoding: 'utf8', bom: false, eol: '\n', text, diskText: text, readOnlyReason: undefined, untitled: false, settingsScope: undefined, searchEditor: undefined }) as unknown as Document;

// the target's buffer of /srv/app/src/a.ts, a local editor of a file with the same relative path, and another host's buffer
// at the same target path
const REMOTE_DOC = textDocument('remote', { path: '/srv/app/src/a.ts', projectKey: APP, relativePath: 'src/a.ts' }, 'remote buffer\n');
const LOCAL_DOC = textDocument('local', { path: path.join(localProject, 'src', 'a.ts'), projectKey: folderKey(localProject), relativePath: 'src/a.ts' }, 'local buffer\n');
const OTHER_HOST_DOC = textDocument('other', { path: '/srv/app/src/a.ts', projectKey: 'ssh+h2|/srv/app', relativePath: 'src/a.ts' }, 'other host buffer\n');

// root: the repository root the remote core reports, which main never trusts to lie inside the host's roots
// realPath: APP's realpath on the target as its core published it, when the project was registered through a link
// os: the host's; a Windows host's projects are WIN_ROOTS
function setup(root: string, opts: { worktrees?: Artifacts['rows']; picks?: string[]; inputs?: Array<string | undefined>; answers?: Array<number | undefined>; realPath?: string; os?: 'win32'; render?: (text: LocalizedText) => string } = {}) {
  const flavor = opts.os === 'win32' ? path.win32 : path.posix;
  const hostRoots = opts.os === 'win32' ? WIN_ROOTS : ROOTS;
  const appPath = hostRoots.find((project) => project.key === APP)!.fsPath;
  const join = (relative: string): string => flavor.join(root, ...relative.split('/'));
  const repo = {
    repoId: 'repo-r',
    authority: HOST,
    root,
    kind: 'root',
    info: { gitDir: flavor.join(root, '.git'), commonDir: flavor.join(root, '.git') },
    gitVersion: { major: 2, minor: 45, patch: 0 },
    lastStatus: STATUS,
    // the target confines a path under its root as it likes; main must not take its answer on trust
    confinedEntry: async (relative: string) => join(relative),
    commitTemplate: async () => null,
    isValidBranchName: async () => true,
    diff: vi.fn(async () => ({ kind: 'patch', patch: 'remote patch' })),
    commitObject: async () => ({ parents: [PARENT], message: 'subject' }),
    show: async () => Buffer.from('git side\n'),
  };
  const service = {
    onDidChange: () => ({ dispose: () => undefined }),
    projectKeys: () => [APP],
    view: (key: string) => (key === APP ? { projectKey: APP, state: 'ready', repos: [{ repoId: 'repo-r', root, kind: 'root' }], closedRoots: [], unsafe: [], parents: [] } : undefined),
    snapshot: () => undefined,
    repository: (repoId: string) => (repoId === 'repo-r' ? { repo, projectKey: APP, projectPath: appPath, kind: 'root' } : undefined),
    projectRealPath: (key: string) => (key === APP ? opts.realPath : undefined),
    gitVersion: () => ({ major: 2, minor: 45, patch: 0 }),
    setAutofetchProject: vi.fn(),
    quickDiffBase: vi.fn(async () => ({ ok: true, indexText: 'i', indexOid: 'o', headText: 'h', headOid: 'ho', hasStaged: false })),
    stageRanges: vi.fn(async () => ({ ok: true })),
    isCommit: vi.fn(async () => true),
    emptyTree: vi.fn(async () => 'f'.repeat(40)),
    diffRefs: vi.fn(async () => ({ left: PARENT, entries: [{ change: change('src/a.ts', 'MODIFIED'), right: HASH }] })),
    diffStash: vi.fn(async () => ({ left: PARENT, entries: [{ change: change('src/a.ts', 'MODIFIED'), right: HASH }] })),
    entryPatch: vi.fn(async () => ({ kind: 'patch', patch: 'pair patch' })),
    commitBlob: vi.fn(async () => Buffer.from('blob\n')),
    artifacts: vi.fn(async (_repoId: string, group: Artifacts['group']) => {
      if (group === 'worktrees') return { group, rows: opts.worktrees ?? [] };
      if (group === 'branches') return { group, rows: [{ ref: 'refs/heads/main', name: 'main', commit: null, current: true, upstream: null }, { ref: 'refs/heads/topic', name: 'topic', commit: null, current: false, upstream: null }] };
      if (group === 'stashes') return { group, rows: [{ index: 0, hash: HASH, description: 'WIP', branch: 'main', commit: null }] };
      return { group, rows: [] };
    }),
    worktreeFolder: async () => undefined,
    addWorktree: vi.fn(async () => undefined),
    removeWorktree: vi.fn(async () => 'ok'),
    worktreeDirty: vi.fn(async () => false),
    completeMerge: vi.fn(async () => undefined),
    // a stash apply's labels, as core's mergeLabels names them
    mergeInputs: vi.fn(async () => ({
      ok: true,
      base: 'b',
      current: 'c',
      incoming: 'i',
      labels: { current: { title: { message: 'Current' }, marker: 'main', description: 'abc1234', detail: 'main' }, incoming: { title: { message: 'Stashed Changes' }, marker: 'Stashed Changes' }, base: { title: { message: 'Base' }, marker: 'Base' } },
      operation: 'stash',
    })),
    mergeFile: vi.fn(async () => ({ ok: true, text: 'merged' })),
    move: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } as unknown as ScmServiceClient;
  const documents = [REMOTE_DOC, LOCAL_DOC, OTHER_HOST_DOC];
  const editorPane = {
    onDidChangeActiveContext: () => ({ dispose: () => undefined }),
    activeContext: () => undefined,
    activeLocation: () => undefined,
    showDiff: vi.fn(async () => ({ close: () => undefined })),
    showRemoteDiff: vi.fn(async () => ({ close: () => undefined })),
    openFromUser: vi.fn(async () => ({ ok: true, tabId: 't' })),
    openPath: vi.fn(async () => undefined),
    openInBackground: vi.fn(async () => undefined),
    openReadOnly: vi.fn(),
    openPlaceholder: vi.fn(),
    showTimeline: vi.fn(),
    showChanges: vi.fn(),
    showMerge: vi.fn(),
    changesTabs: () => [{ tabId: 'c', state: { title: 't', changes: { repoId: 'repo-r', source: { kind: 'refs', left: PARENT, right: HASH }, entries: [] } } }],
    scmDiffTabs: () => [],
    saveDocuments: vi.fn(async () => true),
    closeMerge: vi.fn(async () => undefined),
    fileRenamed: vi.fn(async (_projectKey: string, _from: string, renameOnDisk: () => Promise<unknown>) => renameOnDisk()),
    closeActive: vi.fn(async () => undefined),
    gitChanged: vi.fn(),
  } as unknown as EditorPane;
  const resolved: string[] = [];
  const picks = [...(opts.picks ?? [])];
  const inputs = [...(opts.inputs ?? [])];
  const answers = [...(opts.answers ?? [])];
  const inputRequests: unknown[] = [];
  const notices: string[] = [];
  const added: Array<[string, string]> = [];
  const worktreeCalls: unknown[][] = [];
  const host = new ScmHost({
    render: opts.render ?? englishText,
    service,
    // index.ts's wiring: the authority's own roots, resolved by remote-files.ts
    remoteFileRef: (authority, targetPath) => {
      resolved.push(targetPath);
      const roots = hostRoots.map((project) => (project.key === APP && opts.realPath !== undefined ? { ...project, realPath: opts.realPath } : project));
      return remoteFileRef(roots.filter((project) => project.authorityKey === authority), targetPath);
    },
    hostName: () => 'prod-1',
    authorityOs: () => opts.os ?? 'linux',
    settings: { get: () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
    documents: {
      get: (id: string) => documents.find((document) => document.id === id),
      all: () => documents,
      openProjectFile: vi.fn(async (projectKey: string, relativePath: string) => ({ ok: true, document: documents.find((document) => document.location?.projectKey === projectKey && document.location.relativePath === relativePath) })),
    } as unknown as DocumentService,
    projects: () => [{ key: folderKey(localProject), fsPath: localProject, name: 'app' }, { key: APP, fsPath: appPath, name: 'app' }],
    selectedProjectKey: () => APP,
    editorPane,
    selection: { get: () => undefined, set: () => undefined },
    notify: {
      info: async (message: string) => void notices.push(message),
      warn: async (message: string) => void notices.push(message),
      error: async (message: string) => void notices.push(message),
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    showGitLog: () => undefined,
    agentForwarding: () => undefined,
    copy: async () => undefined,
    reveal: async () => undefined,
    openExternal: async () => undefined,
    pickFolder: vi.fn(async () => undefined),
    addProject: async (authority, folder) => void added.push([authority, folder]),
    selectProject: async () => undefined,
    worktrees: {
      deleteChatWorktreeAt: async (...args: unknown[]) => {
        worktreeCalls.push(['deleteChatWorktreeAt', ...args]);
        return false;
      },
      adopt: vi.fn(async () => undefined),
      adoptCreated: vi.fn(async () => undefined),
      markRemoved: vi.fn(async () => undefined),
      closeProject: vi.fn(async () => 'closed' as const),
      chatOf: (...args: unknown[]) => void worktreeCalls.push(['chatOf', ...args]),
      newChatTargetAt: () => undefined,
      selectChat: async () => undefined,
      showProjectFolder: () => undefined,
      projectCopyOf: () => undefined,
    },
    gitFound: true,
    quickPick: async (_placeholder, items) => {
      const label = picks.shift();
      const item = items.find((candidate) => candidate.label === label);
      return item ? { id: item.id, query: '' } : undefined;
    },
    ask: async () => answers.shift(),
    askInput: async (request) => {
      inputRequests.push(request);
      return inputs.shift();
    },
    mention: async () => undefined,
    addToChat: async () => undefined,
    send: { view: () => undefined, state: () => undefined, decorations: () => undefined, settings: () => undefined, command: () => undefined, setInput: () => undefined, clone: () => undefined, artifactsChanged: () => undefined, filesChanged: () => undefined },
    menuChanged: () => undefined,
    log: () => undefined,
    platform: process.platform,
  });
  return { host, service, editorPane, resolved, inputRequests, notices, added, worktreeCalls };
}

type Setup = ReturnType<typeof setup>;
const SRC = { projectKey: APP, relativePath: 'src/a.ts' };
const RANGES = [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }];

// Every carried-over action that names a file of the repository, run as the shell or the palette runs it.
const FILE_ACTIONS: ReadonlyArray<readonly [string, (h: Setup) => Promise<unknown>]> = [
  ['Open Changes (working tree)', (h) => h.host.runRequest({ op: 'openChanges', repoId: 'repo-r', path: 'src/a.ts', group: 'workingTree' }).then(told)],
  ['Open Changes (staged)', (h) => h.host.runRequest({ op: 'openChanges', repoId: 'repo-r', path: 'src/a.ts', group: 'index' }).then(told)],
  ['Open Changes (merge row)', (h) => h.host.runRequest({ op: 'openChanges', repoId: 'repo-r', path: 'src/a.ts', group: 'merge' }).then(told)],
  ['Open All Changes', (h) => h.host.openAllChanges('repo-r')],
  ['quick diff base', (h) => h.host.quickDiffBase({ repoId: 'repo-r', path: 'src/a.ts' })],
  ['Stage Selected Ranges', (h) => h.host.stageRanges({ op: 'stageRanges', repoId: 'repo-r', path: 'src/a.ts', documentId: 'remote', ranges: RANGES, indexOid: 'o' })],
  ['Unstage Selected Ranges', (h) => h.host.stageRanges({ op: 'unstageRanges', repoId: 'repo-r', path: 'src/a.ts', documentId: 'remote', ranges: RANGES, indexOid: 'o', headOid: 'ho' })],
  ['timeline and commit diff of a file', (h) => h.host.runRequest({ op: 'openCommit', repoId: 'repo-r', commit: HASH, path: 'src/a.ts' }).then(told)],
  ['Compare with Selected', (h) => h.host.compareCommits('repo-r', { commit: PARENT, path: 'src/a.ts' }, { commit: HASH, path: 'src/a.ts' })],
];

// runRequest answers a thrown refusal with a notice and TOLD, so a refusal reads the same from every action here
async function told(result: unknown): Promise<unknown> {
  if ((result as { ok?: boolean }).ok !== true) throw new Error('refused');
  return result;
}

const opened = (h: Setup): unknown[] => [
  ...vi.mocked(h.editorPane.showRemoteDiff).mock.calls,
  ...vi.mocked(h.editorPane.showDiff).mock.calls,
  ...vi.mocked(h.editorPane.openFromUser).mock.calls,
  ...vi.mocked(h.editorPane.openPath).mock.calls,
  ...vi.mocked(h.editorPane.openInBackground).mock.calls,
  ...vi.mocked(h.service.stageRanges).mock.calls,
  ...vi.mocked(h.service.quickDiffBase).mock.calls,
];

describe('remote source control: every path resolves through remoteFileRef', () => {
  it.each(FILE_ACTIONS)('%s names the target file as its host project\'s file', async (_name, action) => {
    const h = setup('/srv/app');
    await action(h);
    expect(h.resolved.length).toBeGreaterThan(0);
    expect(h.resolved.every((target) => target.startsWith('/srv/app/'))).toBe(true);
    expect(h.editorPane.showDiff).not.toHaveBeenCalled();
    expect(h.editorPane.openPath).not.toHaveBeenCalled();
    const files = [
      ...vi.mocked(h.editorPane.showRemoteDiff).mock.calls.map((call) => call[1]),
      ...vi.mocked(h.editorPane.openFromUser).mock.calls.map((call) => ({ projectKey: call[0], relativePath: call[1] })),
      ...vi.mocked(h.editorPane.openInBackground).mock.calls.flatMap((call) => call[0].map((entry) => ('file' in entry ? entry.file : entry))),
    ];
    for (const file of files) expect(file).toEqual(SRC);
  });

  // the root the target reports: another root, a '..' escape, a UNC path, a drive path, another authority's project, and
  // this computer's folder where a local editor holds the same relative path open
  const HOSTILE = [['another root', '/srv/other'], ['..', '/srv/app/../../etc'], ['UNC', '\\\\attacker\\share\\app'], ['drive', 'C:\\Users\\me\\app'], ['another authority\'s project', '/srv/h2app'], ['a local editor\'s folder', localProject]] as const;

  for (const [rootName, root] of HOSTILE) {
    it.each(FILE_ACTIONS)(`%s refuses a repository at ${rootName}`, async (_name, action) => {
      const h = setup(root);
      await expect(action(h)).rejects.toThrow();
      expect(opened(h)).toEqual([]);
    });
  }

  it('lists a remote file in an open repository only when its own path resolves to the project file the document is', () => {
    const h = setup('/srv/app');
    expect(h.host.gitOf({ path: '/srv/app/src/a.ts', projectKey: APP, relativePath: 'src/a.ts' })).toEqual({ repoId: 'repo-r', path: 'src/a.ts' });
    // a location whose path names another file than its project place, another host's file at the same path, a local file
    expect(h.host.gitOf({ path: '/srv/app/src/a.ts', projectKey: APP, relativePath: 'src/b.ts' })).toBeUndefined();
    expect(h.host.gitOf({ path: '/srv/app/src/a.ts', projectKey: 'ssh+h2|/srv/app', relativePath: 'src/a.ts' })).toBeUndefined();
    expect(h.host.gitOf({ path: path.join(localProject, 'src', 'a.ts'), projectKey: folderKey(localProject), relativePath: 'src/a.ts' })).toBeUndefined();
    for (const [, root] of HOSTILE) expect(setup(root).host.gitOf({ path: '/srv/app/src/a.ts', projectKey: APP, relativePath: 'src/a.ts' })).toBeUndefined();
  });
});

describe('remote source control: range stages send the target buffer', () => {
  it('stages the remote document\'s buffer, never a local editor\'s or another host\'s with the same path', async () => {
    const h = setup('/srv/app');
    await h.host.stageRanges({ op: 'stageRanges', repoId: 'repo-r', path: 'src/a.ts', documentId: 'remote', ranges: RANGES, indexOid: 'o' });
    expect(vi.mocked(h.service.stageRanges).mock.calls[0]![1]).toMatchObject({ path: 'src/a.ts', buffer: 'remote buffer\n' });
    for (const documentId of ['local', 'other']) {
      await expect(h.host.stageRanges({ op: 'stageRanges', repoId: 'repo-r', path: 'src/a.ts', documentId, ranges: RANGES, indexOid: 'o' })).rejects.toThrow('not the file');
    }
    expect(h.service.stageRanges).toHaveBeenCalledTimes(1);
  });

  it('names the refused action when the target refuses a range unstage as stale', async () => {
    const h = setup('/srv/app');
    vi.mocked(h.service.stageRanges).mockResolvedValueOnce({ ok: false, reason: 'changed' });
    await h.host.stageRanges({ op: 'unstageRanges', repoId: 'repo-r', path: 'src/a.ts', documentId: 'remote', ranges: RANGES, indexOid: 'o', headOid: 'ho' });
    expect(h.notices).toEqual(['The staged version of this file changed since the changes were shown, so nothing was unstaged. Try again.']);
  });

  it('on a project registered through a link, matches the editor\'s file to the repository its core roots at the realpath', async () => {
    const h = setup('/srv/real-app', { realPath: '/srv/real-app' });
    expect(h.host.gitOf({ path: '/srv/app/src/a.ts', projectKey: APP, relativePath: 'src/a.ts' })).toEqual({ repoId: 'repo-r', path: 'src/a.ts' });
    await h.host.stageRanges({ op: 'stageRanges', repoId: 'repo-r', path: 'src/a.ts', documentId: 'remote', ranges: RANGES, indexOid: 'o' });
    expect(vi.mocked(h.service.stageRanges).mock.calls[0]![1]).toMatchObject({ path: 'src/a.ts', buffer: 'remote buffer\n' });
    // a realpath its core did not give the project names nothing
    expect(setup('/srv/real-app').host.gitOf({ path: '/srv/app/src/a.ts', projectKey: APP, relativePath: 'src/a.ts' })).toBeUndefined();
  });

  it('reads the quick diff base in the remote document\'s encoding, found by its project place, not a local editor\'s', async () => {
    const h = setup('/srv/app');
    const documents = h.host.deps.documents;
    const remote = { ...(REMOTE_DOC as object), encoding: 'utf16le', bom: true } as unknown as Document;
    const local = { ...(LOCAL_DOC as object), encoding: 'utf8', bom: false } as unknown as Document;
    Object.assign(documents, { all: () => [local, remote], get: (id: string) => [local, remote].find((document) => document.id === id) });
    await h.host.quickDiffBase({ repoId: 'repo-r', path: 'src/a.ts' });
    expect(vi.mocked(h.service.quickDiffBase).mock.calls[0]![2]).toEqual({ encoding: 'utf16le', bom: true });
  });
});

describe('remote source control: diffs, the timeline and worktrees', () => {
  it('opens the working tree diff with the target file as its editable side and a git side that refreshes', async () => {
    const h = setup('/srv/app');
    await h.host.openChanges('repo-r', 'src/a.ts', 'workingTree');
    const [, file, left, right, opts] = vi.mocked(h.editorPane.showRemoteDiff).mock.calls[0]!;
    expect(file).toEqual(SRC);
    expect(left).toEqual({ name: 'a.ts', content: 'git side\n' });
    expect(right).toEqual({ file: SRC });
    expect(opts).toEqual({ focus: true, scm: { repoId: 'repo-r', git: { path: 'src/a.ts', group: 'workingTree' } } });
  });

  it('opens the timeline, a stash, a compare and their file patches, none of which names a local path', async () => {
    const h = setup('/srv/app');
    expect(await h.host.runRequest({ op: 'openTimeline', repoId: 'repo-r', path: 'src/a.ts' })).toEqual({ ok: true });
    expect(h.editorPane.showTimeline).toHaveBeenCalled();
    expect(await h.host.runRequest({ op: 'viewStash', repoId: 'repo-r', target: { index: 0, hash: HASH } })).toEqual({ ok: true });
    expect(await h.host.runRequest({ op: 'openGroupChanges', repoId: 'repo-r', group: 'workingTree' })).toEqual({ ok: true });
    expect(await h.host.runRequest({ op: 'openCommit', repoId: 'repo-r', commit: HASH })).toEqual({ ok: true });
    expect(h.editorPane.showChanges).toHaveBeenCalledTimes(3);
    expect(await h.host.fileDiff({ repoId: 'repo-r', path: 'src/a.ts', source: { kind: 'refs', left: PARENT, right: HASH } })).toEqual({ kind: 'patch', patch: 'pair patch' });
    expect(await h.host.fileDiff({ repoId: 'repo-r', path: 'src/a.ts', source: { kind: 'workingTree' } })).toEqual({ kind: 'patch', patch: 'remote patch' });
  });

  it('compares a chat worktree\'s file with the same file of its project, both through the host\'s roots', async () => {
    const h = setup('/srv/worktrees/app-wt1');
    expect(await h.host.runRequest({ op: 'compareWithWorkspace', repoId: 'repo-r', path: 'src/a.ts' })).toEqual({ ok: true });
    const [, file, left, right] = vi.mocked(h.editorPane.showRemoteDiff).mock.calls[0]!;
    expect(file).toEqual({ projectKey: WORKTREE, relativePath: 'src/a.ts' });
    expect(left).toEqual({ file: SRC });
    expect(right).toEqual({ file: { projectKey: WORKTREE, relativePath: 'src/a.ts' } });
  });

  it('opens a remote worktree as a chat or project of its own host, and adds any other as that host\'s folder', async () => {
    const row = { path: '/srv/app.worktrees/topic', name: 'topic', branch: 'topic', commit: null, main: false, current: false, bare: false, detached: false, prunable: false, locked: false };
    const h = setup('/srv/app', { worktrees: [row] as unknown as Artifacts['rows'] });
    expect(await h.host.run({ op: 'openWorktree', repoId: 'repo-r', path: '/srv/app.worktrees/topic' })).toEqual({ ok: true });
    expect(h.worktreeCalls).toEqual([['chatOf', HOST, '/srv/app.worktrees/topic']]);
    expect(h.added).toEqual([[HOST, '/srv/app.worktrees/topic']]);
  });

  it('creates a worktree at a path in the target\'s rules, offering no folder picker of this computer', async () => {
    const h = setup('/srv/app', { picks: ['topic'], inputs: [undefined] });
    await h.host.runRequest({ op: 'createWorktree', repoId: 'repo-r' });
    const request = h.inputRequests[0] as { value: string; browse?: unknown };
    expect(request.value).toBe('/srv/app.worktrees/topic');
    expect(request.browse).toBeUndefined();

    const typed = setup('/srv/app', { picks: ['topic'], inputs: ['/srv/trees/topic'] });
    expect(await typed.host.runRequest({ op: 'createWorktree', repoId: 'repo-r' })).toEqual({ ok: true });
    expect(typed.service.addWorktree).toHaveBeenCalledWith('repo-r', '/srv/trees/topic', 'topic', undefined);
    expect(typed.host.deps.worktrees.adoptCreated).not.toHaveBeenCalled();

    const local = setup('/srv/app', { picks: ['topic'], inputs: ['C:\\trees\\topic'] });
    await local.host.runRequest({ op: 'createWorktree', repoId: 'repo-r' });
    expect(local.service.addWorktree).not.toHaveBeenCalled();
    expect(local.notices).toEqual(['"C:\\trees\\topic" is not an absolute folder path on prod-1.']);
  });

  it('deletes a remote worktree named by its target path, asking its own host\'s registry about a chat worktree', async () => {
    const row = { path: '/srv/app.worktrees/topic', name: 'topic', branch: 'topic', commit: null, main: false, current: false };
    const h = setup('/srv/app', { worktrees: [row] as unknown as Artifacts['rows'], answers: [0] });
    expect(await h.host.run({ op: 'deleteWorktree', repoId: 'repo-r', path: '/srv/app.worktrees/topic' })).toEqual({ ok: true });
    expect(h.worktreeCalls).toEqual([['deleteChatWorktreeAt', HOST, '/srv/app.worktrees/topic']]);
    expect(h.service.removeWorktree).toHaveBeenCalledWith('repo-r', '/srv/app.worktrees/topic', false);
    expect(h.host.deps.worktrees.markRemoved).not.toHaveBeenCalled();
  });
});

// The merge editor and Git: Rename and Delete on a remote repository: the Result, the moved and the deleted file are each the
// host's project file, named only through remoteFileRef, never a local editor's file with the same path.
const MERGE_AND_MOVE: ReadonlyArray<readonly [string, (h: Setup) => Promise<unknown>]> = [
  ['Open Merge Editor', (h) => h.host.openMergeEditor('repo-r', 'src/a.ts')],
  ['the merge inputs', (h) => h.host.mergeInputs({ repoId: 'repo-r', path: 'src/a.ts' })],
  ['Compute Conflicts', (h) => h.host.mergeFile({ repoId: 'repo-r', path: 'src/a.ts', diff3: true })],
  ['Complete Merge', (h) => h.host.completeMerge('repo-r', 'src/a.ts', 'remote')],
  ['Git: Rename', (h) => h.host.rename('repo-r', 'src/a.ts')],
  ['Git: Delete', (h) => h.host.delete('repo-r', 'src/a.ts', false)],
];

const acted = (h: Setup): unknown[] => [
  ...vi.mocked(h.host.deps.documents.openProjectFile).mock.calls,
  ...vi.mocked(h.editorPane.showMerge).mock.calls,
  ...vi.mocked(h.editorPane.saveDocuments).mock.calls,
  ...vi.mocked(h.service.mergeInputs).mock.calls,
  ...vi.mocked(h.service.mergeFile).mock.calls,
  ...vi.mocked(h.service.completeMerge).mock.calls,
  ...vi.mocked(h.service.move).mock.calls,
  ...vi.mocked(h.service.remove).mock.calls,
  ...vi.mocked(h.editorPane.fileRenamed).mock.calls,
  ...vi.mocked(h.editorPane.closeActive).mock.calls,
];

describe('remote source control: the merge editor and file moves', () => {
  it('opens a conflicted remote file in the merge editor as its host\'s project file, with that file\'s buffer as the Result', async () => {
    const h = setup('/srv/app');
    expect(await h.host.runRequest({ op: 'openMergeEditor', repoId: 'repo-r', path: 'src/a.ts' })).toEqual({ ok: true });
    expect(h.host.deps.documents.openProjectFile).toHaveBeenCalledWith(APP, 'src/a.ts');
    const [merge, document] = vi.mocked(h.editorPane.showMerge).mock.calls[0]!;
    expect(merge).toEqual({ repoId: 'repo-r', path: 'src/a.ts' });
    expect(document.id).toBe('remote');
  });

  it('reads the inputs and computes conflicts with the target\'s buffer and encoding, never a local editor\'s', async () => {
    const h = setup('/srv/app');
    expect(await h.host.mergeInputs({ repoId: 'repo-r', path: 'src/a.ts' })).toMatchObject({ ok: true });
    expect(vi.mocked(h.service.mergeInputs).mock.calls[0]!.slice(1)).toEqual(['src/a.ts', { encoding: 'utf8', bom: false }, 'remote buffer\n']);
    expect(await h.host.mergeFile({ repoId: 'repo-r', path: 'src/a.ts', diff3: true })).toEqual({ ok: true, text: 'merged' });
    expect(vi.mocked(h.service.mergeFile).mock.calls[0]!.slice(1)).toEqual(['src/a.ts', { encoding: 'utf8', bom: false }, true, 'remote buffer\n']);
  });

  it('gives the shell each merge input\'s title in main\'s language, and its marker name as core named it', async () => {
    const el = createDesktopLocalizationService(process.cwd(), 'el', () => undefined);
    const h = setup('/srv/app', { render: el.render });
    const inputs = await h.host.mergeInputs({ repoId: 'repo-r', path: 'src/a.ts' });
    if (!inputs.ok) throw new Error(`no inputs: ${inputs.reason}`);
    expect(inputs.labels).toEqual({
      current: { title: 'Τρέχουσα', marker: 'main', description: 'abc1234', detail: 'main' },
      incoming: { title: 'Αλλαγές στο stash', marker: 'Stashed Changes' },
      base: { title: 'Βάση', marker: 'Base' },
    });
  });

  it('completes a remote merge by saving the host\'s document, staging on the target and closing that Result\'s merge tab', async () => {
    const h = setup('/srv/app');
    expect(await h.host.runRequest({ op: 'completeMerge', repoId: 'repo-r', path: 'src/a.ts', documentId: 'remote' })).toEqual({ ok: true });
    expect(h.editorPane.saveDocuments).toHaveBeenCalledWith(['remote']);
    expect(h.service.completeMerge).toHaveBeenCalledWith('repo-r', 'src/a.ts');
    expect(h.editorPane.closeMerge).toHaveBeenCalledWith('remote');
    // a local editor of the same relative path, or another host's of the same target path, is no Result of it
    for (const documentId of ['local', 'other']) await expect(h.host.completeMerge('repo-r', 'src/a.ts', documentId)).rejects.toThrow('not the file');
    expect(h.editorPane.saveDocuments).toHaveBeenCalledTimes(1);
  });

  it('renames a remote file through git mv, its tabs following it as the host\'s project file', async () => {
    const h = setup('/srv/app', { inputs: ['src/b.ts'] });
    await h.host.rename('repo-r', 'src/a.ts');
    expect(vi.mocked(h.editorPane.fileRenamed).mock.calls[0]!.slice(0, 2)).toEqual([APP, 'src/a.ts']);
    expect(h.service.move).toHaveBeenCalledWith('repo-r', 'src/a.ts', 'src/b.ts');
    expect(h.editorPane.closeActive).not.toHaveBeenCalled();
    expect(h.editorPane.openPath).not.toHaveBeenCalled();
  });

  it('moves no file when the new name is not a relative path inside the repository', async () => {
    const h = setup('/srv/app', { inputs: ['../../etc/passwd'] });
    await h.host.rename('repo-r', 'src/a.ts');
    expect(h.notices).toEqual(['../../etc/passwd is not a valid file or folder name.']);
    expect(h.service.move).not.toHaveBeenCalled();
    expect(h.editorPane.fileRenamed).not.toHaveBeenCalled();
  });

  it('moves no file when the new name, inside the repository, is outside every project of the host', async () => {
    // the repository roots above the project, so the new name passes the path check and only the host's roots refuse it
    const h = setup('/srv', { inputs: ['other/b.ts'] });
    await expect(h.host.rename('repo-r', 'app/src/a.ts')).rejects.toThrow('prod-1 named a file outside its projects.');
    expect(h.notices).toEqual([]);
    expect(h.resolved).toEqual(['/srv/app/src/a.ts', '/srv/other/b.ts']);
    expect(h.service.move).not.toHaveBeenCalled();
    expect(h.editorPane.fileRenamed).not.toHaveBeenCalled();
  });

  it('deletes a remote file through git rm and closes its clean tab by the host\'s project file', async () => {
    const h = setup('/srv/app');
    await h.host.delete('repo-r', 'src/a.ts', false);
    expect(h.service.remove).toHaveBeenCalledWith('repo-r', ['src/a.ts']);
    expect(h.editorPane.closeActive).toHaveBeenCalledWith(SRC, { cleanOnly: true });
  });

  for (const [rootName, root] of [['another root', '/srv/other'], ['..', '/srv/app/../../etc'], ['UNC', '\\\\attacker\\share\\app'], ['drive', 'C:\\Users\\me\\app'], ['another authority\'s project', '/srv/h2app'], ['a local editor\'s folder', localProject]] as const) {
    it.each(MERGE_AND_MOVE)(`%s refuses a repository at ${rootName} before anything opens, saves or runs git`, async (_name, action) => {
      const h = setup(root, { inputs: ['src/b.ts'] });
      await expect(action(h)).rejects.toThrow();
      expect(acted(h)).toEqual([]);
    });
  }
});

describe('remote source control on a Windows host', () => {
  it('reads the host\'s path rules: its separator, and paths that differ only in case are one', () => {
    const paths = setup('C:\\Srv\\App', { os: 'win32' }).host.pathsOf(HOST);
    expect(paths.os).toBe('win32');
    expect(paths.flavor.sep).toBe('\\');
    expect(paths.same('C:\\Srv\\App', 'c:\\srv\\app')).toBe(true);
    expect(paths.same('C:\\Srv\\App', 'C:\\Srv\\App2')).toBe(false);
    expect(paths.inside('C:\\Srv\\App', 'c:\\srv\\app\\src\\a.ts')).toBe(true);
    // a POSIX host keeps case
    expect(setup('/srv/app').host.pathsOf(HOST).same('/srv/App', '/srv/app')).toBe(false);
  });

  // the root as its core reports it, in the project's case and in another case
  for (const root of ['C:\\Srv\\App', 'c:\\srv\\app']) {
    it.each(FILE_ACTIONS)(`%s names the target file as its host project's file, from a repository at ${root}`, async (_name, action) => {
      const h = setup(root, { os: 'win32' });
      await action(h);
      expect(h.resolved.length).toBeGreaterThan(0);
      expect(h.resolved.every((target) => target.toLowerCase().startsWith('c:\\srv\\app\\'))).toBe(true);
      const files = [
        ...vi.mocked(h.editorPane.showRemoteDiff).mock.calls.map((call) => call[1]),
        ...vi.mocked(h.editorPane.openFromUser).mock.calls.map((call) => ({ projectKey: call[0], relativePath: call[1] })),
        ...vi.mocked(h.editorPane.openInBackground).mock.calls.flatMap((call) => call[0].map((entry) => ('file' in entry ? entry.file : entry))),
      ];
      for (const file of files) expect(file).toEqual(SRC);
    });
  }

  // another root, a '..' escape, a UNC share, another drive, a POSIX path and a root-relative path, whose drive would be this
  // computer's current one
  const HOSTILE_WIN = [['another root', 'C:\\Srv\\Other'], ['..', 'C:\\Srv\\App\\..\\..\\Windows'], ['UNC', '\\\\attacker\\share\\app'], ['another drive', 'D:\\Srv\\App'], ['a POSIX path', '/srv/app'], ['a root-relative path', '\\Srv\\App']] as const;
  for (const [rootName, root] of HOSTILE_WIN) {
    it.each(FILE_ACTIONS)(`%s refuses a repository at ${rootName}`, async (_name, action) => {
      const h = setup(root, { os: 'win32' });
      await expect(action(h)).rejects.toThrow();
      expect(opened(h)).toEqual([]);
    });
  }

  it('lists a file of the host in its repository whatever the case of the reported root', () => {
    const location = { path: 'C:\\Srv\\App\\src\\a.ts', projectKey: APP, relativePath: 'src/a.ts' };
    expect(setup('C:\\Srv\\App', { os: 'win32' }).host.gitOf(location)).toEqual({ repoId: 'repo-r', path: 'src/a.ts' });
    expect(setup('c:\\srv\\app', { os: 'win32' }).host.gitOf(location)).toEqual({ repoId: 'repo-r', path: 'src/a.ts' });
    for (const [, root] of HOSTILE_WIN) expect(setup(root, { os: 'win32' }).host.gitOf(location)).toBeUndefined();
  });

  it('creates a worktree only at a drive path of the host, suggesting one in its rules and telling apart a taken path by case', async () => {
    const suggested = setup('C:\\Srv\\App', { os: 'win32', picks: ['topic'], inputs: [undefined] });
    await suggested.host.runRequest({ op: 'createWorktree', repoId: 'repo-r' });
    expect((suggested.inputRequests[0] as { value: string }).value).toBe('C:\\Srv\\App.worktrees\\topic');

    for (const typed of ['/srv/trees/topic', '\\\\server\\share\\topic', '\\Trees\\topic', 'D:trees\\topic']) {
      const refused = setup('C:\\Srv\\App', { os: 'win32', picks: ['topic'], inputs: [typed] });
      await refused.host.runRequest({ op: 'createWorktree', repoId: 'repo-r' });
      expect(refused.service.addWorktree).not.toHaveBeenCalled();
      expect(refused.notices).toEqual([`"${typed}" is not an absolute folder path on prod-1.`]);
    }

    const taken = { path: 'd:\\trees\\topic', name: 'topic', branch: 'other', commit: null, main: false, current: false, bare: false, detached: false, prunable: false, locked: false };
    const typed = setup('C:\\Srv\\App', { os: 'win32', picks: ['topic'], inputs: ['D:/Trees/Topic'], worktrees: [taken] as unknown as Artifacts['rows'] });
    expect(await typed.host.runRequest({ op: 'createWorktree', repoId: 'repo-r' })).toEqual({ ok: true });
    expect(typed.service.addWorktree).toHaveBeenCalledWith('repo-r', 'D:\\Trees\\Topic-1', 'topic', undefined);
  });

  it('deletes a worktree of the host named in another case', async () => {
    const row = { path: 'C:\\Srv\\App.worktrees\\topic', name: 'topic', branch: 'topic', commit: null, main: false, current: false };
    const h = setup('C:\\Srv\\App', { os: 'win32', worktrees: [row] as unknown as Artifacts['rows'], answers: [0] });
    expect(await h.host.run({ op: 'deleteWorktree', repoId: 'repo-r', path: 'c:\\srv\\app.worktrees\\TOPIC' })).toEqual({ ok: true });
    expect(h.service.removeWorktree).toHaveBeenCalledWith('repo-r', 'C:\\Srv\\App.worktrees\\topic', false);
  });
});
