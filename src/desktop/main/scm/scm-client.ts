// Core's ScmService as desktop main's ScmHost reads and calls it: the synchronous reads answer from core's scm mirror, the rest
// are scm.* requests on the running core (docs/invariants.md "Desktop host"). One instance per app run; each core attaches,
// one per authority: a project's calls go to its authority's core, a repository's to the core that published it.
import { randomUUID } from 'node:crypto';
import type { CommitMessageResult } from '../../../core/scm/commit-message';
import type { GitVersion } from '../../../core/scm/git-runner';
import type { ChangeGroup, RepoKind, Repository, RepositoryStatus } from '../../../core/scm/repository';
import type { CloneState, CommitHooks, CommitVariant, Decoration, ProjectView, RepoSnapshot, ScmEvent, ScmService } from '../../../core/scm/scm-service';
import type { Disposable } from '../../../platform/disposable';
import { SCM_CALLS, type RepositoryCall, type ScmCall, type ScmCommitOutcome, type ScmMirrorPatch, type ScmRepositoryEntry } from '../../core-protocol';
import type { CoreClient } from '../core-client';
import { authorityKeyOfProject } from '../../../shared/project-location';
import { Emitter } from '../../local-services/emitter';

type Awaitable<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

/** Every ScmService method main calls over scm.call, each now answered by core. */
export type ScmCalls = { readonly [M in ScmCall]: Awaitable<ScmService[M]> };

/** The Repository main reads: its facts from the mirror, its reads as scm.repo requests. */
export interface ScmRepository {
  readonly repoId: string;
  // 'local', or the authority key of the remote core that published it, whose paths are native to its target
  readonly authority: string;
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
  commit(repoId: string, message: string, variant: CommitVariant, hooks: CommitHooks): Promise<ScmCommitOutcome>;
  ignoredIn(projectKey: string, relativeDir: string, entries: ReadonlyArray<{ readonly name: string; readonly dir: boolean }>): Promise<Set<string>>;
  commitBlob(repoId: string, commit: string, relativePath: string): Promise<Buffer | 'tooLarge' | undefined>;
  generateMessage(repoId: string): Promise<CommitMessageResult>;
}

export interface ScmClient extends ScmServiceClient, Disposable {
  // core's scm mirror and events from now on, for its authority; the detach forgets them and tells ScmHost every view and
  // repository of that authority closed
  attach(client: CoreClient): Disposable;
}

type RepositoryEntry = Omit<ScmRepositoryEntry, 'snapshot'> & { readonly snapshot: RepoSnapshot };

// A void method of ScmService goes to the attached core without its caller waiting, and a failure is logged; with no core
// attached it has nothing to act on. The last project list and autofetch project are sent again to each core that attaches.
const FIRE_AND_FORGET: ReadonlySet<ScmCall> = new Set(['setProjects', 'setAutofetchProject', 'refresh', 'cancel', 'cancelClone', 'noteWorktreeConflicts']);
const REPLAYED: readonly ScmCall[] = ['setProjects', 'setAutofetchProject'];
// The calls whose first argument is a project key; clone, cancelClone and autofetchNow without a project run on this computer.
const BY_PROJECT: ReadonlySet<ScmCall> = new Set(['init', 'openFolder', 'reopen', 'openParents', 'trustUnsafe']);
const LOCAL_ONLY: ReadonlySet<ScmCall> = new Set(['clone', 'cancelClone']);
const NO_CLONE: CloneState = { running: null, last: null };

const toBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export interface ScmClientDeps {
  // the authority's running core, waited for through a restart
  readonly core: <T>(authority: string, label: string, work: (client: CoreClient) => Promise<T>) => Promise<T>;
  readonly gitVersion: GitVersion | undefined;
  readonly log: (line: string) => void;
}

export function createScmClient(deps: ScmClientDeps): ScmClient {
  const { core, log } = deps;
  const views = new Map<string, { readonly view: ProjectView; readonly realPath?: string }>();
  // each repository with the authority of the core that published it
  const repositories = new Map<string, { readonly entry: RepositoryEntry; readonly ref: ScmRepositoryRef; readonly authority: string }>();
  const decorations = new Map<string, Record<string, Decoration>>();
  let clone: CloneState = NO_CLONE;
  const changed = new Emitter<[ScmEvent]>('scm', log);
  // Commit to a New Branch's name inputs of the commits in flight, by the token core asks with
  const branchNames = new Map<string, () => Promise<string | undefined>>();

  // A repository main never heard of is the local core's, which then answers for it as it does for any closed one.
  const authorityOfRepo = (repoId: unknown): string => (typeof repoId === 'string' ? repositories.get(repoId)?.authority : undefined) ?? 'local';
  const repoCall = <T>(repoId: string, method: RepositoryCall, args: readonly unknown[]): Promise<T> =>
    core(authorityOfRepo(repoId), `scm.repo ${method}`, async (client) => (await client.scmRepo(repoId, method, args)) as T);
  const handleOf = (repoId: string, entry: RepositoryEntry, authority: string): ScmRepository => ({
    repoId,
    authority,
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
  const applyPatch = (authority: string, patch: ScmMirrorPatch): void => {
    switch (patch.kind) {
      case 'view':
        if (patch.view === undefined) {
          views.delete(patch.projectKey);
          decorations.delete(patch.projectKey);
        } else views.set(patch.projectKey, { view: patch.view as ProjectView, ...(patch.realPath !== undefined ? { realPath: patch.realPath } : {}) });
        return;
      case 'repository': {
        const known = repositories.get(patch.repoId);
        // a repository's calls go to the core that published it, so no other core may replace or close it
        if (known && known.authority !== authority) {
          log(`[scm] refused a repository patch from ${authority} for a repository of ${known.authority}`);
          return;
        }
        if (patch.repository === undefined) {
          repositories.delete(patch.repoId);
          return;
        }
        const entry = patch.repository as RepositoryEntry;
        // the handle stays one object while the repository is open, as ScmService's Repository does
        const repo = known?.ref.repo ?? handleOf(patch.repoId, entry, authority);
        repositories.set(patch.repoId, { entry, authority, ref: { repo, projectKey: entry.projectKey, projectPath: entry.projectPath, kind: entry.kind } });
        return;
      }
      case 'repositoryState': {
        // core published the repository whole before its first flags
        const known = repositories.get(patch.repoId);
        if (known?.authority !== authority) return;
        const snapshot: RepoSnapshot = { ...known.entry.snapshot, busy: patch.busy, running: patch.running, lastRemote: patch.lastRemote };
        repositories.set(patch.repoId, { entry: { ...known.entry, snapshot }, ref: known.ref, authority: known.authority });
        return;
      }
      case 'decorations':
        decorations.set(patch.projectKey, patch.files as Record<string, Decoration>);
        return;
      case 'clone':
        if (authority === 'local') clone = patch.state as CloneState;
        return;
    }
  };

  const attached = new Map<string, CoreClient>();
  const replayed = new Map<ScmCall, readonly unknown[]>();
  const send = (client: CoreClient, method: ScmCall, args: readonly unknown[]): void => {
    client.scmCall(method, args).catch((err: unknown) => log(`[scm] ${method} failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  // A replayed call's arguments as one authority's core gets them: its own projects, its keys as core knows them.
  const argsFor = (client: CoreClient, method: ScmCall, args: readonly unknown[]): readonly unknown[] => {
    const { authorityKey } = client.keys;
    if (method === 'setProjects') {
      const projects = (args[0] as readonly { readonly key: string; readonly path: string }[]).filter((project) => authorityKeyOfProject(project.key) === authorityKey);
      return [projects.map((project) => ({ ...project, key: client.keys.toCore(project.key) }))];
    }
    const key = args[0];
    return [typeof key === 'string' && authorityKeyOfProject(key) === authorityKey ? client.keys.toCore(key) : undefined];
  };
  const authorityOfCall = (method: ScmCall, args: readonly unknown[]): string => {
    if (LOCAL_ONLY.has(method)) return 'local';
    if (BY_PROJECT.has(method)) return authorityKeyOfProject(String(args[0]));
    if (method === 'close') return authorityOfRepo((args[0] as readonly unknown[])[0]);
    if (method === 'autofetchNow') {
      const project = replayed.get('setAutofetchProject')?.[0];
      return typeof project === 'string' ? authorityKeyOfProject(project) : 'local';
    }
    return authorityOfRepo(args[0]);
  };
  const calls = Object.fromEntries(SCM_CALLS.map((method) => [method, (...args: unknown[]) => {
    if (REPLAYED.includes(method)) {
      replayed.set(method, args);
      for (const client of attached.values()) send(client, method, argsFor(client, method, args));
      return Promise.resolve();
    }
    const authority = authorityOfCall(method, args);
    if (!FIRE_AND_FORGET.has(method)) {
      return core(authority, `scm ${method}`, (client) => client.scmCall(method, BY_PROJECT.has(method) ? [client.keys.toCore(String(args[0])), ...args.slice(1)] : args));
    }
    const client = attached.get(authority);
    if (client) send(client, method, args);
    return Promise.resolve();
  }])) as unknown as ScmCalls;

  return {
    ...calls,
    attach: (client) => {
      const authority = client.keys.authorityKey;
      attached.set(authority, client);
      for (const method of REPLAYED) {
        const args = replayed.get(method);
        if (args) send(client, method, argsFor(client, method, args));
      }
      client.serveBranchNames(async (token) => {
        const ask = branchNames.get(token);
        if (!ask) throw new Error('No commit waits for a branch name');
        return ask();
      });
      const subscriptions = [
        client.onScmMirror((patch) => applyPatch(authority, patch)),
        client.onScmChanged((event) => changed.fire(event as ScmEvent)),
      ];
      return {
        dispose: () => {
          if (attached.get(authority) === client) attached.delete(authority);
          for (const subscription of subscriptions) subscription.dispose();
          // the mirrors reset with their core; ScmHost lists nothing of the authority until its next core reports
          const closedViews = [...views.keys()].filter((projectKey) => authorityKeyOfProject(projectKey) === authority);
          const closedRepos = [...repositories].filter(([, known]) => known.authority === authority).map(([repoId]) => repoId);
          for (const projectKey of closedViews) {
            views.delete(projectKey);
            decorations.delete(projectKey);
          }
          for (const repoId of closedRepos) repositories.delete(repoId);
          if (authority === 'local') clone = NO_CLONE;
          for (const repoId of closedRepos) changed.fire({ kind: 'repository', repoId });
          for (const projectKey of closedViews) changed.fire({ kind: 'view', projectKey });
          if (authority === 'local') changed.fire({ kind: 'clone' });
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
        return await core(authorityOfRepo(repoId), 'scm commit', (client) => client.scmCommit(repoId, message, variant, hooks.saved ?? [], token));
      } finally {
        if (token !== undefined) branchNames.delete(token);
      }
    },
    ignoredIn: async (projectKey, relativeDir, entries) => new Set(await core(authorityKeyOfProject(projectKey), 'scm ignoredIn', (client) => client.scmIgnoredIn(projectKey, relativeDir, entries))),
    commitBlob: async (repoId, commit, relativePath) => {
      const bytes = await core(authorityOfRepo(repoId), 'scm commitBlob', (client) => client.scmCommitBlob(repoId, commit, relativePath));
      return bytes instanceof Uint8Array ? toBuffer(bytes) : bytes;
    },
    generateMessage: async (repoId) => (await core(authorityOfRepo(repoId), 'Generate Commit Message', (client) => client.scmGenerateMessage(repoId))) as CommitMessageResult,
    dispose: () => {
      changed.clear();
      branchNames.clear();
    },
  };
}
