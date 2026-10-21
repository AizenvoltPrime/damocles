// Core's ScmService as desktop main's ScmHost reads and calls it: the synchronous reads answer from core's scm mirror, the rest
// are scm.* requests on the running core (docs/invariants.md "Desktop host"). One instance per app run; each core attaches.
import { randomUUID } from 'node:crypto';
import type { CommitMessageResult } from '../../../core/scm/commit-message';
import type { GitVersion } from '../../../core/scm/git-runner';
import type { ChangeGroup, CommitOutcome, RepoKind, Repository, RepositoryStatus } from '../../../core/scm/repository';
import type { CloneState, CommitHooks, CommitVariant, Decoration, ProjectView, RepoSnapshot, ScmEvent, ScmService } from '../../../core/scm/scm-service';
import type { Disposable } from '../../../platform/disposable';
import { SCM_CALLS, type RepositoryCall, type ScmCall, type ScmMirrorPatch, type ScmRepositoryEntry } from '../../core-protocol';
import type { CoreClient } from '../core-client';
import { Emitter } from '../../local-services/emitter';

type Awaitable<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

/** Every ScmService method main calls over scm.call, each now answered by core. */
export type ScmCalls = { readonly [M in ScmCall]: Awaitable<ScmService[M]> };

/** The Repository main reads: its facts from the mirror, its reads as scm.repo requests. */
export interface ScmRepository {
  readonly repoId: string;
  readonly root: string;
  readonly kind: RepoKind;
  readonly info: { readonly gitDir: string; readonly commonDir: string };
  readonly gitVersion: GitVersion;
  readonly lastStatus: RepositoryStatus | undefined;
  confinedEntry(relativePath: string): Promise<string>;
  commitTemplate(): Promise<string | null>;
  isValidBranchName(name: string): Promise<boolean>;
  diff(group: ChangeGroup, relativePath: string): ReturnType<Repository['diff']>;
  commitObject(hash: string): ReturnType<Repository['commitObject']>;
  show(side: 'index' | 'HEAD', relativePath: string): Promise<Buffer | 'tooLarge' | undefined>;
}

export interface ScmRepositoryRef {
  readonly repo: ScmRepository;
  readonly projectKey: string;
  readonly projectPath: string;
  readonly kind: RepoKind;
}

export interface ScmServiceClient extends ScmCalls {
  onDidChange(listener: (event: ScmEvent) => void): Disposable;
  projectKeys(): string[];
  view(projectKey: string): ProjectView | undefined;
  snapshot(repoId: string): RepoSnapshot | undefined;
  repository(repoId: string): ScmRepositoryRef | undefined;
  projectRealPath(projectKey: string): string | undefined;
  decorations(projectKey: string): Record<string, Decoration>;
  cloneState(): CloneState;
  gitVersion(): GitVersion | undefined;
  commit(repoId: string, message: string, variant: CommitVariant, hooks: CommitHooks): Promise<CommitOutcome>;
  ignoredIn(projectKey: string, relativeDir: string, entries: ReadonlyArray<{ readonly name: string; readonly dir: boolean }>): Promise<Set<string>>;
  commitBlob(repoId: string, commit: string, relativePath: string): Promise<Buffer | 'tooLarge' | undefined>;
  generateMessage(repoId: string): Promise<CommitMessageResult>;
}

export interface ScmClient extends ScmServiceClient, Disposable {
  // core's scm mirror and events from now on; the detach forgets them and tells ScmHost every view and repository closed
  attach(client: CoreClient): Disposable;
}

type RepositoryEntry = Omit<ScmRepositoryEntry, 'snapshot'> & { readonly snapshot: RepoSnapshot };

// A void method of ScmService goes to the attached core without its caller waiting, and a failure is logged; with no core
// attached it has nothing to act on. The last project list and autofetch project are sent again to each core that attaches.
const FIRE_AND_FORGET: ReadonlySet<ScmCall> = new Set(['setProjects', 'setAutofetchProject', 'refresh', 'cancel', 'cancelClone', 'noteWorktreeConflicts']);
const REPLAYED: readonly ScmCall[] = ['setProjects', 'setAutofetchProject'];
const NO_CLONE: CloneState = { running: null, last: null };

const toBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export interface ScmClientDeps {
  // the running core, waited for through a restart
  readonly core: <T>(label: string, work: (client: CoreClient) => Promise<T>) => Promise<T>;
  readonly gitVersion: GitVersion | undefined;
  readonly log: (line: string) => void;
}

export function createScmClient(deps: ScmClientDeps): ScmClient {
  const { core, log } = deps;
  const views = new Map<string, { readonly view: ProjectView; readonly realPath?: string }>();
  const repositories = new Map<string, { readonly entry: RepositoryEntry; readonly ref: ScmRepositoryRef }>();
  const decorations = new Map<string, Record<string, Decoration>>();
  let clone: CloneState = NO_CLONE;
  const changed = new Emitter<[ScmEvent]>('scm', log);
  // Commit to a New Branch's name inputs of the commits in flight, by the token core asks with
  const branchNames = new Map<string, () => Promise<string | undefined>>();

  const repoCall = <T>(repoId: string, method: RepositoryCall, args: readonly unknown[]): Promise<T> =>
    core(`scm.repo ${method}`, async (client) => (await client.scmRepo(repoId, method, args)) as T);
  const handleOf = (repoId: string, entry: RepositoryEntry): ScmRepository => ({
    repoId,
    root: entry.root,
    kind: entry.kind,
    info: { gitDir: entry.gitDir, commonDir: entry.commonDir },
    get gitVersion(): GitVersion {
      if (!deps.gitVersion) throw new Error('Git was not found');
      return deps.gitVersion;
    },
    get lastStatus() {
      return repositories.get(repoId)?.entry.snapshot.status ?? entry.snapshot.status;
    },
    confinedEntry: (relativePath) => repoCall(repoId, 'confinedEntry', [relativePath]),
    commitTemplate: () => repoCall(repoId, 'commitTemplate', []),
    isValidBranchName: (name) => repoCall(repoId, 'isValidBranchName', [name]),
    diff: (group, relativePath) => repoCall(repoId, 'diff', [group, relativePath]),
    commitObject: (hash) => repoCall(repoId, 'commitObject', [hash]),
    show: async (side, relativePath) => {
      const bytes = await repoCall<Uint8Array | 'tooLarge' | undefined>(repoId, 'show', [side, relativePath]);
      return bytes instanceof Uint8Array ? toBuffer(bytes) : bytes;
    },
  });
  const applyPatch = (patch: ScmMirrorPatch): void => {
    switch (patch.kind) {
      case 'view':
        if (patch.view === undefined) {
          views.delete(patch.projectKey);
          decorations.delete(patch.projectKey);
        } else views.set(patch.projectKey, { view: patch.view as ProjectView, ...(patch.realPath !== undefined ? { realPath: patch.realPath } : {}) });
        return;
      case 'repository': {
        if (patch.repository === undefined) {
          repositories.delete(patch.repoId);
          return;
        }
        const entry = patch.repository as RepositoryEntry;
        const known = repositories.get(patch.repoId);
        // the handle stays one object while the repository is open, as ScmService's Repository does
        const repo = known?.ref.repo ?? handleOf(patch.repoId, entry);
        repositories.set(patch.repoId, { entry, ref: { repo, projectKey: entry.projectKey, projectPath: entry.projectPath, kind: entry.kind } });
        return;
      }
      case 'repositoryState': {
        // core published the repository whole before its first flags
        const known = repositories.get(patch.repoId);
        if (!known) return;
        const snapshot: RepoSnapshot = { ...known.entry.snapshot, busy: patch.busy, running: patch.running, lastRemote: patch.lastRemote };
        repositories.set(patch.repoId, { entry: { ...known.entry, snapshot }, ref: known.ref });
        return;
      }
      case 'decorations':
        decorations.set(patch.projectKey, patch.files as Record<string, Decoration>);
        return;
      case 'clone':
        clone = patch.state as CloneState;
        return;
    }
  };

  let attached: CoreClient | undefined;
  const replayed = new Map<ScmCall, readonly unknown[]>();
  const send = (client: CoreClient, method: ScmCall, args: readonly unknown[]): void => {
    client.scmCall(method, args).catch((err: unknown) => log(`[scm] ${method} failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  const calls = Object.fromEntries(SCM_CALLS.map((method) => [method, (...args: unknown[]) => {
    if (!FIRE_AND_FORGET.has(method)) return core(`scm ${method}`, (client) => client.scmCall(method, args));
    if (REPLAYED.includes(method)) replayed.set(method, args);
    if (attached) send(attached, method, args);
    return Promise.resolve();
  }])) as unknown as ScmCalls;

  return {
    ...calls,
    attach: (client) => {
      attached = client;
      for (const method of REPLAYED) {
        const args = replayed.get(method);
        if (args) send(client, method, args);
      }
      client.serveBranchNames(async (token) => {
        const ask = branchNames.get(token);
        if (!ask) throw new Error('No commit waits for a branch name');
        return ask();
      });
      const subscriptions = [
        client.onScmMirror(applyPatch),
        client.onScmChanged((event) => changed.fire(event as ScmEvent)),
      ];
      return {
        dispose: () => {
          if (attached === client) attached = undefined;
          for (const subscription of subscriptions) subscription.dispose();
          // the mirrors reset with their core; ScmHost lists nothing until the next core reports
          const closedViews = [...views.keys()];
          const closedRepos = [...repositories.keys()];
          views.clear();
          repositories.clear();
          decorations.clear();
          clone = NO_CLONE;
          for (const repoId of closedRepos) changed.fire({ kind: 'repository', repoId });
          for (const projectKey of closedViews) changed.fire({ kind: 'view', projectKey });
          changed.fire({ kind: 'clone' });
        },
      };
    },
    onDidChange: (listener) => changed.add(listener),
    projectKeys: () => [...views.keys()],
    view: (projectKey) => views.get(projectKey)?.view,
    snapshot: (repoId) => repositories.get(repoId)?.entry.snapshot,
    repository: (repoId) => repositories.get(repoId)?.ref,
    projectRealPath: (projectKey) => views.get(projectKey)?.realPath,
    decorations: (projectKey) => decorations.get(projectKey) ?? {},
    cloneState: () => clone,
    gitVersion: () => deps.gitVersion,
    commit: async (repoId, message, variant, hooks) => {
      const token = hooks.branchName ? randomUUID() : undefined;
      if (token !== undefined && hooks.branchName) branchNames.set(token, hooks.branchName);
      try {
        return (await core('scm commit', (client) => client.scmCommit(repoId, message, variant, hooks.saved ?? [], token))) as CommitOutcome;
      } finally {
        if (token !== undefined) branchNames.delete(token);
      }
    },
    ignoredIn: async (projectKey, relativeDir, entries) => new Set(await core('scm ignoredIn', (client) => client.scmIgnoredIn(projectKey, relativeDir, entries))),
    commitBlob: async (repoId, commit, relativePath) => {
      const bytes = await core('scm commitBlob', (client) => client.scmCommitBlob(repoId, commit, relativePath));
      return bytes instanceof Uint8Array ? toBuffer(bytes) : bytes;
    },
    generateMessage: async (repoId) => (await core('Generate Commit Message', (client) => client.scmGenerateMessage(repoId))) as CommitMessageResult,
    dispose: () => {
      changed.clear();
      branchNames.clear();
    },
  };
}
