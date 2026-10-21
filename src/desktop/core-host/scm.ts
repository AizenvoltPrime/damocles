// Damocles Core's source control: the one git runner, askpass server and ScmService of the app (one process owns every git
// queue), served to desktop main over scm.* with a mirror of what main reads synchronously (docs/invariants.md "Desktop host").
import { PiRuntime } from '../../core/pi-session/pi-runtime';
import { createAskpassServer, removeAbandonedSocketFolders, type AskpassServer } from '../../core/scm/askpass/askpass-server';
import { generateCommitMessage } from '../../core/scm/commit-message';
import { gitErrorText } from '../../core/scm/errors';
import { createGitRunner, type GitCloner, type GitRunner } from '../../core/scm/git-runner';
import type { Repository } from '../../core/scm/repository';
import { ScmService, type CommitVariant, type RepoSnapshot, type ScmEvent } from '../../core/scm/scm-service';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { Disposable } from '../../platform/disposable';
import type { LogSink } from '../../platform/log-sink';
import { INVALID, parseScmProjects, type RepositoryCall, type ScmCall, type ScmRepositoryEntry } from '../core-protocol';
import { credentialPrompt } from './askpass-prompt';
import { backgroundCompletion } from './commit-message-completion';
import type { CorePlatform } from './platform';

export interface CoreScm extends Disposable {
  readonly service: ScmService;
  // undefined when main's probe found no git
  readonly runner: (GitRunner & GitCloner) | undefined;
  // the root of the repository source control opened for a project folder, its own or a parent's (D9)
  projectRepository(projectPath: string): string | undefined;
  // a listed project whose repository's branches or HEAD changed (AD4), by its path as listed
  onDidChangeRefs(listener: (projectPath: string) => void): Disposable;
  // a project folder whose repositories source control discovered again
  onDidChangeProjectRepository(listener: (projectPath: string) => void): Disposable;
  // closes the askpass server, whose POSIX socket folder is removed only once the close finishes
  close(): Promise<void>;
}

// The facts main reads off a repository synchronously (ScmService.repository and snapshot).
function repositoryEntry(service: ScmService, repoId: string): (ScmRepositoryEntry & { readonly snapshot: RepoSnapshot }) | undefined {
  const target = service.repository(repoId);
  const snapshot = service.snapshot(repoId);
  if (!target || !snapshot) return undefined;
  const { repo } = target;
  return {
    projectKey: target.projectKey,
    projectPath: target.projectPath,
    kind: target.kind,
    root: repo.root,
    gitDir: repo.info.gitDir,
    commonDir: repo.info.commonDir,
    snapshot,
  };
}

// The Repository reads main makes (core-protocol/scm-calls.ts REPOSITORY_CALLS), each from its own argument list.
function repositoryRead(repo: Repository, method: RepositoryCall, args: readonly unknown[]): Promise<unknown> {
  const [first, second] = args as [unknown, unknown];
  switch (method) {
    case 'confinedEntry':
      return repo.confinedEntry(first as string);
    case 'commitTemplate':
      return repo.commitTemplate();
    case 'isValidBranchName':
      return repo.isValidBranchName(first as string);
    case 'diff':
      return repo.diff(first as Parameters<Repository['diff']>[0], second as string);
    case 'commitObject':
      return repo.commitObject(first as string);
    case 'show':
      return repo.show(first as 'index' | 'HEAD', second as string);
  }
}

export function startCoreScm(platform: CorePlatform, gitLog: LogSink, log: (line: string) => void): CoreScm {
  const { endpoint, init } = platform;
  const t = (message: string, ...args: Array<string | number>): string => platform.localization.t(message, ...args);
  const askpass: AskpassServer = createAskpassServer({ paths: init.paths.askpass, prompt: credentialPrompt((prompt, signal) => endpoint.request('askpass.prompt', prompt, signal)), log: (line) => gitLog.appendLine(line) });
  // a core that crashed or was killed never closed its server; Windows' named pipes leave nothing behind
  if (process.platform !== 'win32') {
    removeAbandonedSocketFolders({ now: Date.now(), log: (line) => gitLog.appendLine(line) }).catch((err: unknown) => log(`[scm] the askpass folder sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  const { git } = init;
  const runner = git.available && git.path !== undefined && git.version !== undefined
    ? createGitRunner({ git: { path: git.path, version: git.version }, log: gitLog, isTrusted: (project) => platform.trust.isTrusted(project) })
    : undefined;
  const service = new ScmService({
    runner,
    askpass,
    trust: platform.trust,
    watchers: platform.fileWatchers,
    settings: platform.settings,
    globalState: platform.state.global,
    ask: (question) => endpoint.request('dialogs.ask', question),
    notify: (message, ...actions) => platform.notifications.info(message, ...actions),
    trash: (absolutePath) => endpoint.request('shell.trash', { path: absolutePath }),
    t,
    log,
  });

  // the repositories each project's last published view listed, so a view that drops one publishes its close
  const listed = new Map<string, Set<string>>();
  // the status revision each open repository was last published whole at; until it grows, only its flags go out
  const published = new Map<string, number>();
  const publishRepository = (repoId: string): void => {
    const repository = repositoryEntry(service, repoId);
    if (repository === undefined) {
      published.delete(repoId);
      endpoint.publish('scm', { kind: 'repository', repoId });
      return;
    }
    const { busy, running, lastRemote, revision } = repository.snapshot;
    if (published.get(repoId) === revision) {
      endpoint.publish('scm', { kind: 'repositoryState', repoId, busy, running, lastRemote });
      return;
    }
    published.set(repoId, revision);
    endpoint.publish('scm', { kind: 'repository', repoId, repository });
  };
  const publishView = (projectKey: string): void => {
    const view = service.view(projectKey);
    const realPath = service.projectRealPath(projectKey);
    endpoint.publish('scm', { kind: 'view', projectKey, ...(view ? { view } : {}), ...(realPath !== undefined ? { realPath } : {}) });
    const now = new Set(view?.repos.map((repo) => repo.repoId) ?? []);
    const before = listed.get(projectKey) ?? new Set<string>();
    for (const repoId of now) if (!before.has(repoId)) publishRepository(repoId);
    for (const repoId of before) if (!now.has(repoId)) publishRepository(repoId);
    if (view) listed.set(projectKey, now);
    else listed.delete(projectKey);
  };
  const projectsOf = new Map<string, string>();
  const refsListeners = new Set<(projectPath: string) => void>();
  const repositoryListeners = new Set<(projectPath: string) => void>();
  const fire = (listeners: ReadonlySet<(projectPath: string) => void>, projectPath: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(projectPath);
      } catch (err) {
        log(`[scm] a listener threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }
  };
  // Every delta an event's change made goes out before the event, which main's ScmHost acts on (the ordering rule).
  const changed = (event: ScmEvent): void => {
    if (event.kind === 'view') publishView(event.projectKey);
    else if (event.kind === 'repository') publishRepository(event.repoId);
    else if (event.kind === 'decorations') endpoint.publish('scm', { kind: 'decorations', projectKey: event.projectKey, files: service.decorations(event.projectKey) });
    else if (event.kind === 'clone') endpoint.publish('scm', { kind: 'clone', state: service.cloneState() });
    endpoint.emit('scm.changed', { event });
    if (event.kind === 'view') {
      const projectPath = projectsOf.get(event.projectKey);
      if (projectPath !== undefined) fire(repositoryListeners, projectPath);
    }
    // by project path, as listed: a repository root is its realpath, which an 8.3 or linked project path never equals
    if (event.kind === 'artifacts' && event.groups.includes('branches')) {
      const repository = service.repository(event.repoId);
      if (repository !== undefined) fire(refsListeners, repository.projectPath);
    }
  };
  const subscription = service.onDidChange(changed);

  const completeCommitMessage = backgroundCompletion(() => PiRuntime.unlessRetired(), (key) => platform.secrets.get(key), log);
  // every listed name is one of the service's methods
  const calls: { readonly [M in ScmCall]: ScmService[M] } = service;
  endpoint.serve('scm.call', ({ method, args }) => {
    if (method === 'setProjects') {
      const projects = parseScmProjects(args[0]);
      if (projects === INVALID) throw new Error('Malformed project list');
      projectsOf.clear();
      // a project folder, never a chat worktree root main lists beside it (main/worktrees/roots.ts)
      for (const project of projects) if (project.key === folderKey(project.path)) projectsOf.set(project.key, project.path);
      service.setProjects(projects);
      return undefined;
    }
    return (calls[method] as (...callArgs: unknown[]) => unknown).apply(service, [...args]);
  });
  endpoint.serve('scm.commit', async ({ repoId, message, variant, saved, branchName }) => {
    const outcome = await service.commit(repoId, message, variant as CommitVariant, {
      saved,
      ...(branchName !== undefined ? { branchName: () => endpoint.request('scm.branchName', { token: branchName }) } : {}),
    });
    return outcome.ok || outcome.error === undefined ? outcome : { ...outcome, error: gitErrorText(outcome.error) };
  });
  endpoint.serve('scm.ignoredIn', async ({ projectKey, relativeDir, entries }) => [...(await service.ignoredIn(projectKey, relativeDir, entries))]);
  endpoint.serve('scm.commitBlob', ({ repoId, commit, path }) => service.commitBlob(repoId, commit, path));
  endpoint.serve('scm.generateMessage', ({ repoId }) => {
    const target = service.repository(repoId);
    if (!target) throw new Error('Unknown repository');
    return generateCommitMessage(target.repo, completeCommitMessage, target.projectPath);
  });
  endpoint.serve('scm.repo', ({ repoId, method, args }) => {
    const target = service.repository(repoId);
    if (!target) throw new Error('Unknown repository');
    return repositoryRead(target.repo, method, args);
  });

  return {
    service,
    runner,
    projectRepository: (projectPath) => {
      const view = service.view(folderKey(projectPath));
      const repo = view?.repos.find((candidate) => candidate.kind === 'root') ?? view?.repos.find((candidate) => candidate.kind === 'parent');
      return repo ? service.repository(repo.repoId)?.repo.root : undefined;
    },
    onDidChangeRefs: (listener) => {
      refsListeners.add(listener);
      return { dispose: () => { refsListeners.delete(listener); } };
    },
    onDidChangeProjectRepository: (listener) => {
      repositoryListeners.add(listener);
      return { dispose: () => { repositoryListeners.delete(listener); } };
    },
    close: () => askpass.dispose(),
    dispose: () => {
      subscription.dispose();
      refsListeners.clear();
      repositoryListeners.clear();
      service.dispose();
    },
  };
}
