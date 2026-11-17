// Moved project folders (docs/invariants.md "Project relocation"): preflight, the journaled relocation, its resume at
// every core start, and the views the host reads. ChatPanelProvider builds it with the stores it re-keys.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcherFactory } from '../../platform/file-watcher';
import type { TrustService } from '../../platform/trust-service';
import type { WorkspaceFolders } from '../../platform/workspace-folders';
import { GIT_HARDENING_ARGS } from '../git-hardening';
import { gitExecutable } from '../git-executable';
import { DAMOCLES_HOME_DIR, FOLDER_IDENTITIES_PATH, PROJECT_RELOCATIONS_PATH, WORKTREES_ROOT_DIR } from '../paths';
import { agentDataRoot } from '../pi-session/agent-records';
import { folderRepoIdOf } from '../pi-session/checkpoints/resolver';
import { folderPresenceProbe } from '../pi-session/folder-presence';
import { childEnv } from '../pi-session/checkpoints/exec';
import type { SessionMetaIndex } from '../pi-session/session-store/meta-index/client';
import { piSessionIdFromFile } from '../pi-session/session-store/meta-index/protocol';
import { piSessionDir } from '../pi-session/session-store/session-dir';
import { isSessionHeldByPanelHere, sessionLeaseBlocker } from '../pi-session/session-store/session-lease';
import { runProcess } from '../process-launcher/run';
import type { GitRunner } from '../scm/git-runner';
import { REGISTRY_FILE, WorktreeRegistry, type ChatWorktreeRecord, type WorktreeRecord } from '../worktrees/registry';
import { folderKey } from '../workspace-folders/folder-key';
import { mountPointOf } from '../workspace-folders/folder-presence-probe';
import { currentPathOf, foldAliases } from './aliases';
import { currentRelocations, installRelocations, isPendingRecord, relocationsSnapshot } from './current';
import { needsRun, RelocationEngine, type StepRunner } from './engine';
import { identityRelation, readFolderIdentity, ROOT_COMMITS_ARGS, rootsOfOutput, type FolderIdentity } from './identity';
import { FolderIdentityStore, type IdentityRead } from './identity-store';
import { movedFromCandidates } from './moved-from';
import { chatWorktreeOwner, planWorktrees, runPreflight, type ChatHold, type PreflightDeps } from './preflight';
import { runCheckpointsStep } from './steps/checkpoints';
import { runCompassStep } from './steps/compass';
import { runHostStateStep, type HostStateTargets } from './steps/host-state';
import { runMemoryStep, type MemoryRelocation } from './steps/memory';
import { STEP_DONE } from './steps/outcome';
import { runRepairStep, type RepairStepDeps } from './steps/repair';
import { agentRunsUnder, defaultSessionsStepDeps } from './steps/session-fs';
import { agentSessionIds, ownedSessions, runSessionsStep } from './steps/sessions';
import { defaultWorktreesStepDeps, runWorktreesStep } from './steps/worktrees';
import { RelocationStore } from './store';
import { adminDirNaming, repositoryDirs } from './worktree-links';
import { RELOCATION_STEPS, type Coded, type MovedFromCandidate, type PreflightAnswer, type PreflightRequest, type RelocationFolder, type RelocationPauseAfter, type RelocationRecord, type RelocationRequest, type RelocationRequester, type RelocationView, type RelocationViewState } from './types';

const ROOT_COMMITS_OUTPUT_BYTES = 4096;

type ChatHolder = ChatHold['holder'] | undefined;

// Who holds the chat's own lease: another process, a panel or writer of this one, or nobody.
function chatHolder(sessionId: string): ChatHolder {
  const blocker = sessionLeaseBlocker(sessionId);
  if (blocker?.kind === 'other-process') return 'otherProcess';
  return blocker !== undefined || isSessionHeldByPanelHere(sessionId) ? 'thisProcess' : undefined;
}

export interface ProjectRelocationsDeps {
  readonly requestedBy: RelocationRequester;
  readonly watcherFactory: FileWatcherFactory;
  readonly metaIndex: Pick<SessionMetaIndex, 'move' | 'meta'>;
  readonly memory: MemoryRelocation;
  readonly hostState: HostStateTargets;
  /** The worktree registry, on a host with chat worktrees; elsewhere preflight and the worktrees step open one for their own duration. */
  readonly worktrees?: WorktreeRegistry;
  /** The trust-gated git runner of a host with chat worktrees (undefined while git is missing); elsewhere the repair step runs git itself. */
  readonly git?: () => GitRunner | undefined;
  /** Finish holds and hand-offs in flight, on a host with chat worktrees. */
  readonly worktreeActivity?: PreflightDeps['worktreeActivity'];
  /**
   * The repair step runs git only in a project this answers trusted for that folder alone (`folderTrust` on a host whose trust
   * is window wide), and runs again when trust is granted.
   */
  readonly trust: Pick<TrustService, 'isTrusted' | 'onDidGrantTrust'>;
  /** The host's project folders, whose identities are recorded while they exist. */
  readonly projectFolders: () => readonly string[];
  readonly log: (line: string) => void;
  readonly file?: string;
  readonly identitiesFile?: string;
  readonly lockDir?: string;
}

export class ProjectRelocations implements Disposable {
  private readonly deps: ProjectRelocationsDeps;
  private readonly store: RelocationStore;
  private readonly engine: RelocationEngine;
  private readonly listeners = new Set<() => void>();
  // relocations this core saw with work left; once coreDone they stay in the views for the rest of the run
  private readonly seenPending = new Set<string>();
  private readonly subscription: Disposable;
  private readonly trustSubscription: Disposable;
  private readonly identities: FolderIdentityStore;
  // one recording at a time, so two reads of a folder never race in the store
  private recording: Promise<void> = Promise.resolve();
  // set once the core's folder registry is ready, before which no relocation runs
  private resumed = false;

  constructor(deps: ProjectRelocationsDeps) {
    this.deps = deps;
    this.store = new RelocationStore({ file: deps.file ?? PROJECT_RELOCATIONS_PATH, watcherFactory: deps.watcherFactory, log: deps.log });
    this.identities = new FolderIdentityStore({ file: deps.identitiesFile ?? FOLDER_IDENTITIES_PATH, log: deps.log });
    const sessionsDeps = defaultSessionsStepDeps(deps.metaIndex);
    // a chat worktree's folder stays where it is, so only the project's folder has anything to move
    const moved = (record: RelocationRecord): RelocationFolder[] => record.folders.filter((folder) => folderKey(folder.from) !== folderKey(folder.to));
    const steps: Record<(typeof RELOCATION_STEPS)[number], StepRunner> = {
      checkpoints: ({ record, before }) => runCheckpointsStep(moved(record), before),
      sessions: async ({ record, before, progress, sessionCommitted }) => {
        const mapped = (folder: string, recordedAt: number | undefined): string => currentPathOf(before.aliases, folder, recordedAt);
        const owners = projectsOf(record);
        const folders = moved(record);
        const counts = await Promise.all(folders.map(async (folder) => (await ownedSessions(owners, mapped, sessionsDeps, piSessionDir(folder.from))).length));
        for (const [index, folder] of folders.entries()) {
          const later = counts.slice(index + 1).reduce((sum, count) => sum + count, 0);
          const outcome = await runSessionsStep({
            from: folder.from,
            to: folder.to,
            owners,
            currentPathOf: mapped,
            onCommitted: async (moved, remaining) => {
              progress(Math.max(0, record.chats - remaining - later) + moved, record.chats);
              await sessionCommitted();
            },
            log: deps.log,
          }, sessionsDeps);
          if (outcome.kind !== 'done') return outcome;
        }
        return { kind: 'done' };
      },
      worktrees: async ({ record }) => {
        // adopted records name the project too, so any registry is opened
        if (!record.folders.some((folder) => folder.kind === 'worktree') && !(await this.hasRegistry())) return STEP_DONE;
        return this.withRegistry((registry) => runWorktreesStep({ folders: record.folders, log: deps.log }, defaultWorktreesStepDeps(registry)));
      },
      repair: async ({ record }) => {
        const project = record.folders[0]!;
        // a later relocation moved the project on, and its own repair step re-links the worktrees
        if (folderKey(this.laterPathOf(record, project.to)) !== folderKey(project.to)) return STEP_DONE;
        const ids = record.folders.flatMap((folder) => (folder.kind === 'worktree' && folder.worktreeId !== undefined ? [folder.worktreeId] : []));
        // the worktrees step re-pointed the records, which name each worktree's folder
        const worktrees = ids.length === 0 ? [] : await this.withRegistry(async (registry) => ids.flatMap((worktreeId) => {
          const found = registry.get(worktreeId);
          return found?.kind === 'chat' ? [{ worktreeId, root: found.worktreeRoot }] : [];
        }));
        return runRepairStep({ project: project.to, repository: record.repository, worktrees, log: deps.log }, this.repairDeps(project.to));
      },
      memory: async ({ record }) => {
        const earlier = this.earlierMemoryOf(record);
        if (earlier !== undefined) return { kind: 'waiting', failure: { code: 'earlierMove', params: { path: earlier } } };
        return runMemoryStep(record.folders, deps.memory, (folder) => this.laterPathOf(record, folder));
      },
      compass: ({ record }) => runCompassStep(moved(record), deps.log),
      hostState: ({ record }) => runHostStateStep(moved(record), deps.hostState),
    };
    this.engine = new RelocationEngine({ store: this.store, steps, ...(deps.lockDir !== undefined ? { lockDir: deps.lockDir } : {}), log: deps.log, onChange: () => this.emit() });
    this.subscription = this.store.onDidChange(() => this.storeChanged());
    this.trustSubscription = deps.trust.onDidGrantTrust(() => {
      this.trustGranted();
      void this.recordIdentities();
    });
    this.storeChanged();
  }

  /** Every relocation with work left whose lock this process can take; called once the core's folder registry is ready. */
  resumeAtStart(): Promise<void> {
    this.resumed = true;
    return this.engine.resumeAtStart();
  }

  async preflight(request: PreflightRequest): Promise<PreflightAnswer> {
    return (await this.preflightWith(request)).answer;
  }

  /**
   * Records the identity and POSIX mount point of each project folder that is there now (all of them by default); a folder that is
   * not there keeps the ones recorded for it. Root commits are read only for a trusted folder at its repository's root with none
   * recorded.
   */
  recordIdentities(folders: readonly string[] = this.deps.projectFolders()): Promise<void> {
    const run = this.recording.then(async () => {
      const recorded = await this.identities.entries();
      const reads: IdentityRead[] = [];
      for (const folder of folders) {
        if ((await folderPresenceProbe.path(folder)) !== 'directory') continue;
        const identity = await readFolderIdentity(folder);
        const known = recorded.find((entry) => folderKey(entry.path) === folderKey(folder));
        const roots = identity && !(known && known.roots.length > 0) ? await this.rootCommits(folder, identity) : [];
        const mount = identity ? await this.mountOf(folder) : undefined;
        reads.push({ folder, identity: identity && { ...identity, roots }, ...(mount !== undefined ? { mount } : {}) });
      }
      await this.identities.record(reads, Date.now());
    });
    this.recording = run.catch((err: unknown) => this.deps.log(`[ProjectRelocations] recording folder identities failed: ${err instanceof Error ? err.message : String(err)}`));
    return this.recording;
  }

  // The POSIX mount point the present folder lies on, when not the system root; Windows reads its drive or share root instead.
  private async mountOf(folder: string): Promise<string | undefined> {
    if (process.platform === 'win32') return undefined;
    const mount = await mountPointOf(folder).catch((err: unknown) => {
      this.deps.log(`[ProjectRelocations] reading the mount point of ${folder} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    return mount === undefined || path.posix.dirname(mount) === mount ? undefined : mount;
  }

  /** The missing project folders whose chats `to` may take over: see movedFromCandidates. */
  async movedFrom(to: string): Promise<MovedFromCandidate[]> {
    const identity = await readFolderIdentity(to);
    if (!identity) return [];
    const { all } = await this.worktreeRecordsOf(to);
    return movedFromCandidates(to, identity, {
      recorded: () => this.identities.entries(),
      relocationSources: () => [
        ...this.store.records().filter(isPendingRecord).map((record) => record.folders[0]!.from),
        ...this.store.foreignPending().flatMap((source) => source.folders.slice(0, 1).map((folder) => folder.from)),
      ],
      inChatWorktree: (folder) => this.chatWorktreeOf(folder, all) !== undefined,
      presence: (target) => folderPresenceProbe.path(target),
      chatsOf: async (from) => (await this.chatFilesOf(from, (await this.worktreeRecordsOf(from)).records)).length,
      rootsOfTarget: () => this.recordedRootsOr(to, identity),
    });
  }

  // The root commits recordIdentities stored for the folder, under the gate rootCommits applies, else git's.
  private async recordedRootsOr(folder: string, identity: FolderIdentity): Promise<readonly string[]> {
    if (identity.subpath !== '' || !this.deps.trust.isTrusted(folder)) return [];
    const recorded = await this.identities.get(folder);
    return recorded !== undefined && recorded.subpath === '' && recorded.roots.length > 0 ? recorded.roots : this.rootCommits(folder, identity);
  }

  // The folder's identity now, with its root commits only while it is trusted.
  private async currentIdentity(folder: string): Promise<FolderIdentity | undefined> {
    const identity = await readFolderIdentity(folder);
    return identity && { ...identity, roots: await this.rootCommits(folder, identity) };
  }

  // git runs only in a trusted folder at its repository's root, so a parent repository D9 has not opened is never read.
  private async rootCommits(folder: string, identity: FolderIdentity): Promise<string[]> {
    if (identity.subpath !== '' || !this.deps.trust.isTrusted(folder)) return [];
    const output = await this.gitIn(folder, 'read')([...ROOT_COMMITS_ARGS], folder).catch((err: unknown) => {
      this.deps.log(`[ProjectRelocations] reading the root commits of ${folder} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    return output?.code === 0 ? rootsOfOutput(output.stdout) : [];
  }

  /** Preflight again with every check, then the write-ahead record; resolves once it is on disk, before anything moves. */
  async relocate(request: RelocationRequest): Promise<{ readonly id: string } | { readonly refusal: Coded }> {
    const { answer, worktrees } = await this.preflightWith(request);
    if (!answer.ok) return { refusal: answer.refusal };
    const { from, to } = request;
    const plan = planWorktrees(worktrees, to);
    if ('refusal' in plan) return { refusal: plan.refusal };
    // A located folder continues in the old folder's checkpoint repo; a merge target keeps its own. A chat worktree stays where
    // its checkpoints are.
    const folders: RelocationFolder[] = [
      { kind: 'project', from, to, ...(answer.mode === 'locate' ? { checkpointRepo: folderRepoIdOf(from) } : {}) },
      ...plan.folders,
    ];
    const written = await this.engine.begin({
      id: randomUUID(),
      requestedBy: this.deps.requestedBy,
      mode: answer.mode,
      folders,
      ...(plan.repository !== undefined ? { repository: plan.repository } : {}),
      chats: answer.chats,
    });
    return 'refusal' in written ? written : { id: written.id };
  }

  private async preflightWith(request: PreflightRequest): Promise<{ readonly answer: PreflightAnswer; readonly worktrees: readonly ChatWorktreeRecord[] }> {
    const { records, all, unreadable, known } = await this.worktreeRecordsOf(request.from);
    let files: Promise<string[]> | undefined;
    const chatFiles = (): Promise<string[]> => (files ??= this.chatFilesOf(request.from, records));
    const answer = await runPreflight(request, {
      records: () => this.store.records(),
      foreignPending: () => this.store.foreignPending(),
      chatsOf: async () => (await chatFiles()).map((file) => piSessionIdFromFile(path.basename(file))),
      titleOf: async (sessionId) => {
        const file = (await chatFiles()).find((candidate) => piSessionIdFromFile(path.basename(candidate)) === sessionId);
        const stored = file ? await this.deps.metaIndex.meta(file).catch((err: unknown) => {
          this.deps.log(`[ProjectRelocations] the title of ${sessionId} could not be read: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }) : null;
        return stored?.customTitle ?? stored?.aiTitle ?? stored?.preview ?? '';
      },
      holderOf: async (sessionId) => {
        const file = (await chatFiles()).find((candidate) => piSessionIdFromFile(path.basename(candidate)) === sessionId);
        // Only the chats of the project's own session dir move, and their agent data with them.
        const moves = file !== undefined && folderKey(path.dirname(file)) === folderKey(piSessionDir(request.from));
        const agentRun = moves ? await this.agentDataHolder(agentDataRoot(path.dirname(file), sessionId)) : undefined;
        const chat = chatHolder(sessionId);
        // what closing this window's chats does not release comes first
        if (chat === 'otherProcess') return { holder: chat, by: 'chat' };
        if (agentRun !== undefined) return { holder: agentRun, by: 'agentRun' };
        return chat && { holder: chat, by: 'chat' };
      },
      presence: (target) => folderPresenceProbe.path(target),
      volumeOf: (target) => folderPresenceProbe.volumeOf(target),
      worktrees: () => ({ records, unreadable, known }),
      chatWorktreeOf: (folder) => this.chatWorktreeOf(folder, all),
      repositoryDirs,
      relinkable: async (commonDir, dotGit) => (await adminDirNaming(commonDir, dotGit)) !== undefined,
      ...(this.deps.worktreeActivity ? { worktreeActivity: this.deps.worktreeActivity } : {}),
      damoclesHome: DAMOCLES_HOME_DIR,
    });
    if (answer.ok && (await this.sharesNothing(request.from, request.to))) return { answer: { ...answer, notices: [...answer.notices, { code: 'otherRepository' }] }, worktrees: records };
    return { answer, worktrees: records };
  }

  // Who holds a part of a chat's agent data: the lease of an agent file in it, or a run of this process (agentRunsUnder).
  private async agentDataHolder(root: string): Promise<ChatHolder> {
    let holder: ChatHolder = agentRunsUnder(root) ? 'thisProcess' : undefined;
    for (const id of await agentSessionIds(defaultSessionsStepDeps(this.deps.metaIndex), root)) {
      const blocker = sessionLeaseBlocker(id);
      if (blocker?.kind === 'other-process') return 'otherProcess';
      if (blocker !== undefined) holder = 'thisProcess';
    }
    return holder;
  }

  // Both identities are known and share neither a remote nor a root commit.
  private async sharesNothing(from: string, to: string): Promise<boolean> {
    const recorded = await this.identities.get(from);
    const current = recorded && (await this.currentIdentity(to));
    return recorded !== undefined && current !== undefined && identityRelation(recorded, current) === 'different';
  }

  // The project's chat worktree records, live or deleted, and every record; none where no registry was ever written. Only a
  // host's own registry keeps the records last parsed, so one opened while registry.json does not parse knows none.
  private async worktreeRecordsOf(from: string): Promise<{ readonly records: readonly ChatWorktreeRecord[]; readonly all: readonly WorktreeRecord[]; readonly unreadable: boolean; readonly known: boolean }> {
    if (!(await this.hasRegistry())) return { records: [], all: [], unreadable: false, known: true };
    return this.withRegistry(async (registry) => ({
      records: registry.recordsOfProject(from).filter((record): record is ChatWorktreeRecord => record.kind === 'chat'),
      all: registry.records(),
      unreadable: registry.unreadable() !== undefined,
      known: this.deps.worktrees !== undefined,
    }));
  }

  // The host keeps a registry, or one was written.
  private async hasRegistry(): Promise<boolean> {
    return this.deps.worktrees !== undefined || fs.promises.access(path.join(WORKTREES_ROOT_DIR, REGISTRY_FILE)).then(() => true, () => false);
  }

  private chatWorktreeOf(folder: string, records: readonly WorktreeRecord[]): { readonly projectPath?: string } | undefined {
    return chatWorktreeOwner(folder, records, this.worktreesRoot(), currentRelocations().pendingPairs);
  }

  // Where `folder`, a path of `record`'s project once it ran, is now by the relocations after it; an abandoned one ran neither
  // its memory step nor its repair.
  private laterPathOf(record: RelocationRecord, folder: string): string {
    const abandoned = new Set(this.store.records().filter((r) => r.state === 'abandoned').map((r) => r.seq));
    return currentPathOf(foldAliases(this.store.aliasSources().filter((source) => source.seq > record.seq && !abandoned.has(source.seq))), folder);
  }

  // A path `record` shares with an earlier relocation this version reads whose memory step is not done: memory is re-keyed by
  // path, so a reused path's rows stay apart only when the relocations naming it re-key in seq order, whichever process runs them.
  private earlierMemoryOf(record: RelocationRecord): string | undefined {
    const keys = new Map(record.folders.flatMap((folder) => [[folderKey(folder.from), folder.from], [folderKey(folder.to), folder.to]]));
    for (const earlier of this.store.records()) {
      if (earlier.seq >= record.seq || earlier.state === 'abandoned' || earlier.steps.memory.state === 'done') continue;
      const shared = earlier.folders.flatMap((folder) => [folder.from, folder.to]).find((named) => keys.has(folderKey(named)));
      if (shared !== undefined) return keys.get(folderKey(shared));
    }
    return undefined;
  }

  // The host's registry, else one opened for the work's duration (VS Code keeps none).
  private async withRegistry<T>(work: (registry: WorktreeRegistry) => Promise<T>): Promise<T> {
    if (this.deps.worktrees) return work(this.deps.worktrees);
    const registry = new WorktreeRegistry({ rootDir: WORKTREES_ROOT_DIR, watcherFactory: this.deps.watcherFactory, log: this.deps.log });
    try {
      return await work(registry);
    } finally {
      registry.dispose();
    }
  }

  private worktreesRoot(): string {
    return this.deps.worktrees?.rootDir ?? WORKTREES_ROOT_DIR;
  }

  private repairDeps(project: string): RepairStepDeps {
    return { isTrusted: (folder) => this.deps.trust.isTrusted(folder), git: this.gitIn(project, 'mutation') };
  }

  // git in a project: the host's trust-gated runner, else the absolute git on the launcher; a read searches no folder above cwd.
  private gitIn(project: string, kind: 'read' | 'mutation'): RepairStepDeps['git'] {
    const hostGit = this.deps.git;
    return async (args, cwd) => {
      if (hostGit) {
        const runner = hostGit();
        if (!runner) throw new Error('git is not available');
        const result = await runner.run(kind === 'read'
          ? { project, cwd, args, kind, parsed: true, allowFailure: true, localOnly: true, ceilingDirectories: [cwd], maxOutputBytes: ROOT_COMMITS_OUTPUT_BYTES }
          : { project, cwd, args, kind, allowFailure: true });
        return { code: result.exitCode, stdout: result.stdout.toString('utf8'), stderr: result.stderr };
      }
      const env = { ...childEnv(), GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', ...(kind === 'read' ? { GIT_CEILING_DIRECTORIES: cwd } : {}) };
      const output = await runProcess({ file: gitExecutable(), args: [...GIT_HARDENING_ARGS, ...args], cwd, env, windowsHide: true });
      return { code: output.exit?.code ?? -1, stdout: output.stdout.toString('utf8'), stderr: output.stderr.toString('utf8') };
    };
  }

  // A grant lets each repair waiting on its project's trust run; the step checks the trust itself.
  private trustGranted(): void {
    for (const record of this.store.records()) {
      const repair = record.steps.repair;
      if (repair.state !== 'waiting' || repair.failure?.code !== 'untrusted' || !this.deps.trust.isTrusted(record.folders[0]!.to)) continue;
      this.engine.retry(record.id).catch((err: unknown) => this.deps.log(`[ProjectRelocations] repairing the worktrees of ${record.id} after a trust grant failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  async retry(id: string): Promise<void> {
    await this.engine.retry(id);
  }

  /** Stop moving: abandons a paused relocation, leaving what it moved where it landed; a refusal when it is not paused. */
  abandon(id: string): Promise<Coded | undefined> {
    return this.engine.abandon(id);
  }

  /** coreDone relocations whose old folder's key is in `keys`, the latest per key. */
  relocationsFrom(keys: readonly string[]): RelocationView[] {
    const wanted = new Set(keys.map(folderKey));
    const latest = new Map<string, ViewedRecord>();
    for (const record of this.store.records().filter(hasView)) {
      if (record.state !== 'coreDone') continue;
      const key = folderKey(record.folders[0]!.from);
      if (!wanted.has(key)) continue;
      const held = latest.get(key);
      if (!held || held.seq < record.seq) latest.set(key, record);
    }
    return [...latest.values()].map((record) => this.viewOf(record));
  }

  /** This computer's record of a remote host's project moved on that host, which /stats applies to the host's rows. */
  addHostAlias(alias: { readonly hostId: string; readonly from: string; readonly to: string; readonly startedAt?: number }): Promise<void> {
    return this.store.addHostAlias(alias);
  }

  /** The hostState step again in this core: a no-op once nothing is left under the old keys. */
  async applyHostState(id: string): Promise<void> {
    const record = this.store.get(id);
    if (record) await runHostStateStep(record.folders, this.deps.hostState);
  }

  /** Pending relocations and those that reached coreDone in this core's run; an abandoned one has none. */
  views(): RelocationView[] {
    return this.store.records().filter(hasView).filter((record) => needsRun(record) || this.seenPending.has(record.id)).map((record) => this.viewOf(record));
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  setPauseAfter(pauseAfter: RelocationPauseAfter): void {
    this.engine.setPauseAfter(pauseAfter);
  }

  whenIdle(): Promise<void> {
    return this.engine.whenIdle();
  }

  dispose(): void {
    this.engine.dispose();
    this.subscription.dispose();
    this.trustSubscription.dispose();
    this.store.dispose();
    this.listeners.clear();
    installRelocations(undefined);
  }

  // The project's chats: those of its own session dir, which the sessions step moves, and those of its chat worktrees' working
  // folders, which stay with their worktrees.
  private async chatFilesOf(from: string, worktrees: readonly ChatWorktreeRecord[]): Promise<string[]> {
    const mapped = (folder: string, recordedAt: number | undefined): string => currentPathOf(currentRelocations().aliases, folder, recordedAt);
    const files = new Set<string>();
    for (const folder of [from, ...worktrees.map((record) => record.workingFolder)]) {
      const dir = piSessionDir(folder);
      for (const name of await ownedSessions([from], mapped, defaultSessionsStepDeps(this.deps.metaIndex), dir)) files.add(path.join(dir, name));
    }
    return [...files];
  }

  private storeChanged(): void {
    for (const record of this.store.records()) if (needsRun(record)) this.seenPending.add(record.id);
    installRelocations(relocationsSnapshot(this.store.records(), this.store.aliasSources(), this.store.hostAliases(), this.store.foreignPending(), this.store.journalId()));
    this.emit();
    if (this.resumed) this.earlierMovesFinished();
  }

  // A memory step waiting on an earlier relocation runs once that one's memory step is done, in this process or another.
  private earlierMovesFinished(): void {
    for (const record of this.store.records()) {
      const memory = record.steps.memory;
      if (memory.state !== 'waiting' || memory.failure?.code !== 'earlierMove' || this.earlierMemoryOf(record) !== undefined) continue;
      this.engine.retry(record.id).catch((err: unknown) => this.deps.log(`[ProjectRelocations] moving the memories of ${record.id} after an earlier move failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        this.deps.log(`[ProjectRelocations] change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private viewOf(record: ViewedRecord): RelocationView {
    const open = RELOCATION_STEPS.find((name) => record.steps[name].state !== 'done');
    const step = open ?? 'hostState';
    const stepState = record.steps[step];
    const showsFailure = record.state === 'paused' || stepState.state === 'waiting';
    const waitingStep = RELOCATION_STEPS.find((name) => record.steps[name].state === 'waiting');
    const failure = showsFailure ? stepState.failure : waitingStep !== undefined ? record.steps[waitingStep].failure : undefined;
    const waiting = RELOCATION_STEPS.flatMap((name) => (record.steps[name].state === 'waiting' && record.steps[name].failure ? [record.steps[name].failure] : []));
    const worktrees = record.folders.flatMap((folder) => (folder.kind === 'worktree' && folder.worktreeId !== undefined ? [{ worktreeId: folder.worktreeId, from: folder.from, to: folder.to }] : []));
    const sessionsDone = record.steps.sessions.state === 'done';
    const progress = sessionsDone ? { done: record.chats, total: record.chats } : this.engine.progressOf(record.id) ?? { done: 0, total: record.chats };
    return {
      id: record.id,
      seq: record.seq,
      requestedBy: record.requestedBy,
      mode: record.mode,
      from: record.folders[0]!.from,
      to: record.folders[0]!.to,
      state: record.state,
      startedAt: record.startedAt,
      step,
      progress,
      ...(failure !== undefined ? { failure } : {}),
      ...(waiting.length > 0 ? { waiting } : {}),
      chats: record.chats,
      ...(worktrees.length > 0 ? { worktrees } : {}),
      ...(record.repairFailures !== undefined ? { repairFailures: record.repairFailures } : {}),
    };
  }
}

/** A window-wide trust (VS Code's) as a folder's own: trusted only for a folder the window has open. */
export function folderTrust(trust: Pick<TrustService, 'isTrusted' | 'onDidGrantTrust'>, folders: Pick<WorkspaceFolders, 'folders'>): Pick<TrustService, 'isTrusted' | 'onDidGrantTrust'> {
  return {
    isTrusted: (folder) => trust.isTrusted(folder) && folders.folders().some((open) => folderKey(open.fsPath) === folderKey(folder)),
    onDidGrantTrust: (cb) => trust.onDidGrantTrust(cb),
  };
}

type ViewedRecord = RelocationRecord & { readonly state: RelocationViewState };

function hasView(record: RelocationRecord): record is ViewedRecord {
  return record.state !== 'abandoned';
}

// The relocation's projects by their old paths, which own the sessions it moves.
function projectsOf(record: RelocationRecord): string[] {
  return record.folders.filter((folder) => folder.kind === 'project').map((folder) => folder.from);
}

export type { PreflightAnswer, RelocationView } from './types';
