// Damocles Core's source control: the one git runner, askpass server and ScmService of the app (one process owns every git
// queue), served to desktop main over scm.* with a mirror of what main reads synchronously (docs/invariants.md "Desktop host").
import { promises as fs } from 'node:fs';
import { PiRuntime } from '../../core/pi-session/pi-runtime';
import { agentSocketPath } from '../../core/client-snapshots';
import { createAskpassServer, removeAbandonedSocketFolders, type AskpassServer, type RelayCredential } from '../../core/scm/askpass/askpass-server';
import { createRelayedPasswords, installCredentialRelay, type CredentialRelay } from '../../core/scm/askpass/credential-relay';
import { generateCommitMessage } from '../../core/scm/commit-message';
import { gitErrorText } from '../../core/scm/errors';
import { createGitRunner, type GitCloner, type GitRunner } from '../../core/scm/git-runner';
import type { Repository } from '../../core/scm/repository';
import { ScmService, type CommitVariant, type RepoSnapshot, type ScmEvent } from '../../core/scm/scm-service';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { verbatim } from '../../core/l10n';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import type { Disposable } from '../../platform/disposable';
import type { LogSink } from '../../platform/log-sink';
import { INVALID, MAX_MESSAGE_CHARS, parseScmProjects, type RepositoryCall, type ScmCall, type ScmCommitOutcome, type ScmRepositoryEntry } from '../core-protocol';
import { credentialPrompt } from './askpass-prompt';
import { backgroundCompletion } from './commit-message-completion';
import type { CorePlatform } from './platform';
import { createAskProxy } from './platform/proxied';

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

// A commit's failure as main shows it: core's refusal as its text, else git's own words, cut to what main's parse of the result takes.
function commitErrorText(err: unknown): LocalizedText {
  return err instanceof LocalizedError ? err.text : verbatim(gitErrorText(err).slice(0, MAX_MESSAGE_CHARS));
}

export function startCoreScm(platform: CorePlatform, gitLog: LogSink, log: (line: string) => void): CoreScm {
  const { endpoint, init } = platform;
  // a daemon's core relays git credentials to the acting client; the target's own helpers are reported for the consent, and
  // an erase reaches the client only when it names the password the relay answered
  const relayedPasswords = createRelayedPasswords();
  let loggedUnnamedErase = false;
  const helperProbe = (cwd: string, url: string): Promise<boolean> => {
    if (runner === undefined) return Promise.resolve(false);
    return runner.targetHasCredentialHelper(cwd, url, service.trustedProjectAt(cwd)).catch((err: unknown) => {
      gitLog.appendLine(`[askpass] could not read the target's own credential helpers, so the consent warns of one: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    });
  };
  const relayCredential: RelayCredential = async ({ op, cwd, fields, passwordHash }, signal) => {
    if (op === 'erase') {
      if (passwordHash === undefined) {
        if (!loggedUnnamedErase) {
          loggedUnnamedErase = true;
          gitLog.appendLine('[askpass] git sent an erase that names no password, so the relay cannot tell it refused the credential your computer gave; such an erase is not passed on');
        }
        return { kind: 'none' };
      }
      if (!relayedPasswords.refused(fields, passwordHash)) return { kind: 'none' };
      return endpoint.request('askpass.credential', { op, fields, targetHelper: false }, signal);
    }
    const targetHelper = await helperProbe(cwd, `${fields.protocol}://${fields.host}/${fields.path ?? ''}`);
    const answer = await endpoint.request('askpass.credential', { op, fields, targetHelper }, signal);
    if (answer.kind === 'credential') relayedPasswords.answered(fields, answer.password);
    return answer;
  };
  const askpass: AskpassServer = createAskpassServer({
    paths: init.paths.askpass,
    prompt: credentialPrompt((prompt, signal) => endpoint.request('askpass.prompt', prompt, signal)),
    ...(init.remote ? { credential: relayCredential } : {}),
    log: (line) => gitLog.appendLine(line),
  });
  const relays = init.remote !== undefined && init.paths.askpass.credentialRelay !== undefined;
  const relayFailed = (err: unknown): void => {
    const line = `[scm] the git credential relay does not listen; the next git call or agent shell that wants it listens again: ${err instanceof Error ? err.message : String(err)}`;
    log(line);
    gitLog.appendLine(line);
  };
  // the relay while the askpass server listens at its handle; only the latest listen sets it
  let relay: CredentialRelay | undefined;
  let relayGeneration = 0;
  let closed = false;
  const listenRelay = (): Promise<void> => {
    const generation = ++relayGeneration;
    return askpass.relay().then(
      (listening) => {
        if (generation === relayGeneration) relay = listening;
      },
      (err: unknown) => {
        if (generation === relayGeneration) relay = undefined;
        relayFailed(err);
      },
    );
  };
  const readRelay = (): CredentialRelay | undefined => {
    if (relay === undefined && relays && !closed) void listenRelay();
    return relay;
  };
  // the daemon made the relay's removed folder again: the relay listens at its new handle from then on
  const relayMoved = relays
    ? endpoint.onMirror('hostSockets', ({ relayHandle }) => {
      if (relayHandle === undefined) return;
      relay = undefined;
      askpass.moveRelay(relayHandle).then(listenRelay, relayFailed);
    })
    : undefined;
  if (relays) {
    installCredentialRelay(readRelay);
    void listenRelay();
  }
  // a core that crashed or was killed never closed its server; Windows' named pipes leave nothing behind
  if (process.platform !== 'win32') {
    removeAbandonedSocketFolders({ now: Date.now(), log: (line) => gitLog.appendLine(line) }).catch((err: unknown) => log(`[scm] the askpass folder sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  const { git } = init;
  const runner = git.available && git.path !== undefined && git.version !== undefined
    ? createGitRunner({
      git: { path: git.path, version: git.version },
      log: gitLog,
      isTrusted: (project) => platform.trust.isTrusted(project),
      credentialRelay: readRelay,
      // a daemon's core: no git call runs with an inherited SSH_AUTH_SOCK
      ...(init.remote ? { agentSocket: () => agentSocketPath(platform) } : {}),
    })
    : undefined;
  const service = new ScmService({
    runner,
    askpass,
    trust: platform.trust,
    watchers: platform.fileWatchers,
    settings: platform.settings,
    globalState: platform.state.global,
    ask: createAskProxy(endpoint),
    notify: (message, actions) => platform.notifications.info(message, actions),
    // a daemon's core has no trash: it deletes permanently after the question says so, and never asks for shell.trash
    ...(init.remote
      ? { trash: (absolutePath: string) => fs.rm(absolutePath, { recursive: true }), deletesPermanently: true }
      : { trash: (absolutePath: string) => endpoint.request('shell.trash', { path: absolutePath }) }),
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
  endpoint.serve('scm.commit', async ({ repoId, message, variant, saved, branchName }): Promise<ScmCommitOutcome> => {
    const outcome = await service.commit(repoId, message, variant as CommitVariant, {
      saved,
      ...(branchName !== undefined ? { branchName: () => endpoint.request('scm.branchName', { token: branchName }) } : {}),
    });
    if (outcome.ok) return { ok: true };
    return outcome.reason === 'failed' ? { ok: false, reason: 'failed', error: commitErrorText(outcome.error) } : { ok: false, reason: outcome.reason };
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
    close: () => {
      closed = true;
      relayGeneration++;
      relay = undefined;
      if (relays) installCredentialRelay(undefined);
      return askpass.dispose();
    },
    dispose: () => {
      subscription.dispose();
      relayMoved?.dispose();
      refsListeners.clear();
      repositoryListeners.clear();
      service.dispose();
    },
  };
}
