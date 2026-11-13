// Damocles Core's source control: the one git runner, askpass server and ScmService of the app (one process owns every git
// queue), served to desktop main over scm.* with a mirror of what main reads synchronously (docs/invariants.md "Desktop host").
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PiRuntime } from '../../core/pi-session/pi-runtime';
import { agentSocketPath } from '../../core/client-snapshots';
import { createAskpassServer, removeAbandonedSocketFolders, type AskpassRegistration, type AskpassServer, type RelayCredential } from '../../core/scm/askpass/askpass-server';
import { createRelayedPasswords, installCredentialRelay, type CredentialRelay } from '../../core/scm/askpass/credential-relay';
import { credentialHelperPath, installCredentialHelper, managedEntries, managedUrls, type CredentialTakeover, type ManagedServer } from '../../core/scm/askpass/credential-config';
import { createDelegator } from '../../core/forge/delegate';
import { currentPin, runHoldsPin } from '../../core/client-snapshots';
import type { GitCredentialAnswer, GitCredentialOrigin, GitCredentialRequest } from '../../shared/git-credential';
import { knownSecrets } from '../../core/forge/known-secrets';
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
import { INVALID, MAX_MESSAGE_CHARS, parseScmProjects, processActor, type RepositoryCall, type ScmCall, type ScmCommitOutcome, type ScmRepositoryEntry } from '../core-protocol';
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
  // this computer's core: git credential requests are answered by answer, and managed names the servers each origin's
  // takeover covers (docs/invariants.md "GitHub and GitLab accounts")
  connectCredentials(source: CredentialSource): void;
  // the listed project folders by project key, never a chat worktree root
  projectFolders(): ReadonlyMap<string, string>;
  // a prompt registration for a delegation's own sign-in prompts, through the askpass bridge
  askpassFor(label: string): Promise<AskpassRegistration>;
}

export interface CredentialSource {
  readonly answer: RelayCredential;
  readonly managed: (origin: GitCredentialOrigin) => readonly ManagedServer[];
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
    case 'unpushedCount':
      return repo.unpushedCount(first as string);
    case 'ignoresCase':
      return repo.ignoresCase();
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
  // the askpass server's connections keep the context of whatever work listened, so its actor is never the asker: a relay
  // names its client, undefined for the acting one (D20), and the acting one is read with no actor
  const actingClient = (): string | undefined => processActor.run(undefined, () => platform.remote?.clients.acting());
  const relayCredential = async ({ op, cwd, fields, passwordHash }: GitCredentialRequest, clientId: string | undefined, signal: AbortSignal): Promise<GitCredentialAnswer> => {
    // a credential git approves never leaves the target
    if (op === 'store') return { kind: 'none' };
    if (op === 'erase') {
      if (passwordHash === undefined) {
        if (!loggedUnnamedErase) {
          loggedUnnamedErase = true;
          gitLog.appendLine('[askpass] git sent an erase that names no password, so the relay cannot tell it refused the credential your computer gave; such an erase is not passed on');
        }
        return { kind: 'none' };
      }
      if (!relayedPasswords.refused(fields, passwordHash)) return { kind: 'none' };
      return processActor.run(clientId, () => endpoint.request('askpass.credential', { op, fields, targetHelper: false }, signal));
    }
    const targetHelper = await helperProbe(cwd, `${fields.protocol}://${fields.host}/${fields.path ?? ''}`);
    const answer = await processActor.run(clientId, () => endpoint.request('askpass.credential', { op, fields, targetHelper }, signal));
    if (answer.kind === 'credential') {
      relayedPasswords.answered(fields, answer.password);
      // masked in this core's tool results, in memory only, for the window a relayed token lives
      knownSecrets().answered(answer.password);
    }
    return answer;
  };
  // this computer's core: the forge's answers once connected; a daemon's: its takeover below. Until then a helper fails
  // with Damocles' line.
  let source: CredentialSource | undefined;
  const answerCredential: RelayCredential = (request, origin, signal) => {
    if (!source) throw new Error('Git credentials are not connected yet');
    return source.answer(request, origin, signal);
  };
  const askpass: AskpassServer = createAskpassServer({
    paths: init.paths.askpass,
    prompt: credentialPrompt((prompt, signal) => endpoint.request('askpass.prompt', prompt, signal)),
    credential: answerCredential,
    log: (line) => gitLog.appendLine(line),
  });

  // A daemon's core (docs/invariants.md "GitHub and GitLab accounts", remote): the takeover covers the managed servers
  // (clientForges) of the client a request goes to, the turn's pinned one for an agent shell; that client's core answers
  // from its accounts, and a delegate answer runs the target's own helpers first, then today's relay.
  const remoteHost = platform.remote;
  const clientServers = (clientId: string | undefined): ManagedServer[] => (clientId === undefined || !remoteHost ? [] : (remoteHost.clients.forges(clientId)?.servers ?? []).filter((server) => server.hasAccount));
  const isManaged = (servers: readonly ManagedServer[], fields: GitCredentialRequest['fields']): boolean => {
    if (fields.protocol !== 'https') return false;
    const asked = `https://${fields.host.toLowerCase()}/${fields.path ?? ''}`;
    return servers.some((server) => managedUrls(server).some((url) => asked.startsWith(`${url}/`)));
  };
  // the tokens the takeover relayed, for an erase naming one; and what the target's own helpers gave, for its store and erase
  const forgeRelayed = createRelayedPasswords();
  const targetDelegated = new Map<string, Buffer>();
  const targetDelegator = createDelegator({
    git: () => runner?.git.path,
    trustedProjectAt: (cwd) => {
      const project = service.trustedProjectAt(cwd);
      return typeof project === 'string' ? project : undefined;
    },
    log: (line) => gitLog.appendLine(line),
  });
  const hashOf = (password: string): Buffer => createHash('sha256').update(password, 'utf8').digest();
  const namesHeld = (held: Buffer | undefined, named: string | undefined): boolean => held !== undefined && named !== undefined && /^[0-9a-f]{64}$/.test(named) && timingSafeEqual(held, Buffer.from(named, 'hex'));
  const daemonCredential: RelayCredential = async (request, origin, signal) => {
    // an agent shell asks only the client its turn was pinned to when the shell started, while a running turn of its chat
    // still holds that pin, never whoever acts now
    const { op, cwd, fields } = request;
    if (origin.kind === 'agentShell' && (origin.clientId === undefined || !runHoldsPin(origin.panelId, origin.clientId))) {
      gitLog.appendLine(`[askpass] an agent shell asked for ${fields.host} while no running turn of its chat holds the client it started with, so it got nothing`);
      return { kind: 'none' };
    }
    const clientId = origin.kind === 'agentShell' ? origin.clientId : actingClient();
    // today's relay: an agent shell's pinned client, else whichever client the daemon finds acting when it sends
    const relayTo = origin.kind === 'agentShell' ? clientId : undefined;
    if (!isManaged(clientServers(clientId), fields)) return relayCredential(request, relayTo, signal);
    const key = JSON.stringify([fields.host.toLowerCase(), fields.path ?? '']);
    // the target's own helpers never prompt: when they give nothing, today's relay asks this computer, as before accounts
    const agentShell = origin.kind === 'agentShell';
    const onTarget = (): Promise<unknown> => targetDelegator.run({ op, cwd, fields, ...(request.password !== undefined ? { password: request.password } : {}), interactive: false, agentShell }, signal);
    if (op === 'store') {
      if (namesHeld(targetDelegated.get(key), request.passwordHash)) await onTarget();
      return { kind: 'none' };
    }
    if (op === 'erase') {
      const { passwordHash } = request;
      if (passwordHash !== undefined && forgeRelayed.refused(fields, passwordHash)) {
        return processActor.run(clientId, () => endpoint.request('askpass.credential', { op, fields, targetHelper: false, origin, cwd, passwordHash }, signal));
      }
      if (namesHeld(targetDelegated.get(key), request.passwordHash)) {
        targetDelegated.delete(key);
        await onTarget();
      }
      return { kind: 'none' };
    }
    const answer = await processActor.run(clientId, () => endpoint.request('askpass.credential', { op, fields, targetHelper: false, origin, cwd }, signal));
    if (answer.kind === 'credential') {
      forgeRelayed.answered(fields, answer.password);
      knownSecrets().answered(answer.password);
      return answer;
    }
    if (answer.kind !== 'delegate') return answer;
    const filled = await targetDelegator.run({ op: 'get', cwd, fields, interactive: false, agentShell }, signal);
    if (filled) {
      targetDelegated.set(key, hashOf(filled.password));
      // the agent's shell prints what git is given, so the target's own password is masked there as a token is
      if (agentShell) knownSecrets().answered(filled.password);
      return { kind: 'credential', ...filled };
    }
    // a background call never asks this computer, as before accounts existed
    if (origin.kind === 'engine' && !origin.interactive) return { kind: 'none' };
    return relayCredential(request, relayTo, signal);
  };
  if (init.remote) {
    source = {
      answer: daemonCredential,
      // read at spawn: an agent shell's from the client its origin names, the one its asks go to
      managed: (origin) => (remoteHost ? clientServers(origin.kind === 'agentShell' ? origin.clientId : currentPin(remoteHost).clientId) : []),
    };
  }
  // a daemon's core gets its helper from the daemon's relay; this computer's from the desktop build
  const helperPath = init.remote ? init.paths.askpass.credentialRelay?.helper : credentialHelperPath(init.paths.unpackedRoot);
  const takeover: CredentialTakeover | undefined = helperPath === undefined ? undefined : {
    entries: (origin) => (source ? managedEntries(source.managed(origin), helperPath) : []),
    register: (origin) => askpass.registerCredential(origin),
  };
  installCredentialHelper(takeover);
  // the core restart window's end, once a source answers: until then a terminal's or shell's helper could not reach this core
  const answering = (): void => {
    if (takeover && init.restarted === true) gitLog.appendLine('[askpass] Damocles Core answers git credential requests from now on; one made while it was not running failed with "Damocles could not provide credentials."');
  };
  if (source) answering();
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
      ...(takeover ? { credentialTakeover: () => takeover } : {}),
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
  endpoint.serve('scm.commit', async ({ repoId, message, variant, saved, branchName, protectedBranches }): Promise<ScmCommitOutcome> => {
    const outcome = await service.commit(repoId, message, variant as CommitVariant, {
      saved,
      ...(branchName !== undefined ? { branchName: () => endpoint.request('scm.branchName', { token: branchName }) } : {}),
      ...(protectedBranches !== undefined ? { protectedBranches } : {}),
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
      installCredentialHelper(undefined);
      return askpass.dispose();
    },
    connectCredentials: (next) => {
      source = next;
      answering();
    },
    projectFolders: () => projectsOf,
    askpassFor: (label) => askpass.register('interactive', label),
    dispose: () => {
      subscription.dispose();
      relayMoved?.dispose();
      refsListeners.clear();
      repositoryListeners.clear();
      service.dispose();
    },
  };
}
