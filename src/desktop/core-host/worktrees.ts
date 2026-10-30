// Damocles Core's worktree services: the registry, the git work of the finish actions and the leftover scan, which main's
// WorktreeController asks for over worktrees.call, and the worktree UI main keeps, which core reaches over worktrees.* requests.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAMOCLES_HOME_DIR } from '../../core/paths';
import { l } from '../../core/l10n';
import { LocalizedError } from '../../shared/localized-text';
import { SCM_SETTING_KEYS } from '../../core/scm/settings-keys';
import type { GitRunner } from '../../core/scm/git-runner';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { nulList, projectGit, removeAbandonedTempFolders, worktreeOptions } from '../../core/worktrees/create';
import type { WorktreeHostServices } from '../../core/worktrees/host';
import {
  aheadBehind,
  apply,
  branchContained,
  isRewritten,
  lineChangesSinceBase,
  mergeInto,
  rebaseOnto,
  removeWorktree,
  targetBranch,
  uncommittedFiles,
  unmergedCommits,
  updateFrom,
  worktreeFolderState,
} from '../../core/worktrees/integrate';
import { folderInRepository, linkedWorktreeOf, pruneWorktrees, scanLeftovers } from '../../core/worktrees/leftovers';
import { WorktreeRegistry, type ChatWorktreeRecord } from '../../core/worktrees/registry';
import type { Disposable } from '../../platform/disposable';
import type { WorktreeCalls } from '../core-protocol';
import type { CoreScm } from './scm';
import type { CorePlatform } from './platform';

export interface CoreWorktrees extends Disposable {
  readonly registry: WorktreeRegistry;
  readonly services: WorktreeHostServices;
}

/** The worktree's checked-out submodules (git refuses to remove a worktree holding one without --force), and those with uncommitted work. */
export async function submoduleState(record: ChatWorktreeRecord, runner: GitRunner): Promise<{ readonly initialized: boolean; readonly changed: string[] }> {
  const git = projectGit(runner, record.projectPath);
  const listed = await git.text(record.worktreeRoot, ['submodule', 'status', '--recursive']);
  const initialized = listed.split('\n').some((line) => line.trim() !== '' && !line.startsWith('-'));
  if (!initialized) return { initialized, changed: [] };
  const entries = nulList((await git.run(record.worktreeRoot, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none'], { kind: 'status' })).stdout);
  return { initialized, changed: changedSubmodules(entries) };
}

/** Paths of porcelain v2 entries for a submodule with tracked changes (M) or untracked files (U) inside it. */
export function changedSubmodules(entries: readonly string[]): string[] {
  const changed: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const kind = entry[0];
    // a rename or copy entry is followed by its original path
    if (kind === '2') index++;
    if (kind !== '1' && kind !== '2') continue;
    const fields = entry.split(' ');
    const sub = fields[2] ?? '';
    if (!sub.startsWith('S') || (sub[2] !== 'M' && sub[3] !== 'U')) continue;
    changed.push(fields.slice(kind === '1' ? 8 : 9).join(' '));
  }
  return changed;
}

async function exists(folder: string): Promise<boolean> {
  try {
    await fs.access(folder);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** D33's finish holds main took on this core (worktree.beginFinish), by the id core gave each; a restarted core knows none. */
export interface FinishHolds extends Disposable {
  add(worktreeId: string, hold: Disposable): string;
  release(id: string): void;
  // throws unless id names a hold of worktreeId this core gave out and still keeps
  require(id: string, worktreeId: string): void;
}

export function createFinishHolds(): FinishHolds {
  const holds = new Map<string, { readonly worktreeId: string; readonly hold: Disposable }>();
  return {
    add: (worktreeId, hold) => {
      const id = randomUUID();
      holds.set(id, { worktreeId, hold });
      return id;
    },
    release: (id) => {
      holds.get(id)?.hold.dispose();
      holds.delete(id);
    },
    require: (id, worktreeId) => {
      if (holds.get(id)?.worktreeId !== worktreeId) throw new Error('This worktree action no longer holds the worktree, so it did not run.');
    },
    dispose: () => {
      for (const { hold } of holds.values()) hold.dispose();
      holds.clear();
    },
  };
}

export interface WorktreeCallDeps {
  readonly registry: WorktreeRegistry;
  // undefined when main's probe found no git
  readonly git: () => GitRunner | undefined;
  readonly isTrusted: (folder: string) => boolean;
  readonly holds: FinishHolds;
  readonly log: (line: string) => void;
}

/** WorktreeController's git and registry work, by the names main calls them with (worktrees.call), records named by id. */
export function worktreeCalls(deps: WorktreeCallDeps): WorktreeCalls {
  const { registry, holds, log } = deps;
  const requireGit = (): GitRunner => {
    const git = deps.git();
    if (!git) throw new LocalizedError(l('Git was not found, so the worktree action cannot run.'));
    return git;
  };
  const liveChat = (worktreeId: string): ChatWorktreeRecord => {
    const record = registry.get(worktreeId);
    if (record?.kind !== 'chat' || record.deletedAt !== undefined) throw new LocalizedError(l('This worktree no longer exists.'));
    return record;
  };
  // a finish action runs only while this core holds its worktree's chats (D33)
  const held = (worktreeId: string, hold: string): ChatWorktreeRecord => {
    holds.require(hold, worktreeId);
    return liveChat(worktreeId);
  };
  const isTrusted = (folder: string): boolean => deps.isTrusted(folder);
  return {
    options: (projectPath) => worktreeOptions(requireGit(), projectPath),
    // the project's live chat worktrees whose folder exists, but those a finish action holds, with their changes against baseCommit
    continueRows: async (projectPath, heldIds) => {
      const git = requireGit();
      const skip = new Set(heldIds);
      const records = registry.liveChatRecords(projectPath).filter((record) => !skip.has(record.id));
      const present = (await Promise.all(records.map(async (record) => ((await exists(record.worktreeRoot)) ? record : undefined)))).filter((record) => record !== undefined);
      const settled = await Promise.allSettled(present.map(async (record) => {
        const target = await targetBranch(record, git);
        const [changes, { behind }] = await Promise.all([lineChangesSinceBase(record, git), aheadBehind(record, git, target)]);
        return { worktreeId: record.id, branch: record.branch, ...changes, behind, ...(target !== undefined ? { baseBranch: target } : {}), createdAt: record.createdAt };
      }));
      // a worktree whose git fails is left out of the list, never the list itself
      return settled.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [result.value];
        log(`[worktrees] reading ${present[index]!.worktreeRoot} for the New menu failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        return [];
      });
    },
    apply: async (id, hold) => apply(held(id, hold), requireGit(), registry),
    targetBranch: async (id) => targetBranch(liveChat(id), requireGit()),
    isRewritten: async (id, target) => isRewritten(liveChat(id), requireGit(), target),
    uncommittedFiles: async (id) => uncommittedFiles(liveChat(id), requireGit()),
    mergeInto: async (id, hold, message) => mergeInto(held(id, hold), requireGit(), registry, message !== undefined ? { message } : {}),
    rebaseOnto: async (id, hold) => rebaseOnto(held(id, hold), requireGit(), registry),
    updateFrom: async (id, hold) => updateFrom(held(id, hold), requireGit(), registry),
    folderState: async (id) => worktreeFolderState(liveChat(id).worktreeRoot),
    deleteFacts: async (id) => {
      const record = liveChat(id);
      const git = requireGit();
      const [uncommitted, unmerged, contained, submodules] = await Promise.all([uncommittedFiles(record, git), unmergedCommits(record, git), branchContained(record, git), submoduleState(record, git)]);
      return { uncommitted, unmerged, contained, submodules };
    },
    removeWorktree: async (id, hold, options) => removeWorktree(held(id, hold), requireGit(), registry, options),
    scanLeftovers: (projects) => scanLeftovers({ registry, git: deps.git(), projects, isTrusted }),
    prune: async (projectPath) => pruneWorktrees(requireGit(), projectPath),
    markUsed: (id) => registry.markUsed(id),
    upsertAdopted: async (input) => {
      await registry.upsertAdopted(input);
    },
    // git removed the worktree: its adopted record is marked deleted, so its chats list read-only
    markAdoptedRemoved: async (worktreePath) => {
      const removed = registry.records().filter((record) => record.kind === 'adopted' && record.deletedAt === undefined && folderKey(record.worktreeRoot) === folderKey(worktreePath));
      for (const record of removed) await registry.markDeleted(record.id);
    },
    // Rule 16's pass: an open project that is a linked worktree gets an adopted record under the open project holding its
    // main worktree, so its chats list under that project read-only once its folder goes; with that project closed, none.
    adoptOpenWorktrees: async (projects) => {
      for (const project of projects) {
        if (registry.liveChatRecordAt(project.fsPath)) continue;
        const linked = await linkedWorktreeOf(project.fsPath);
        if (!linked) continue;
        const others = projects.filter((candidate) => candidate.key !== project.key);
        const mainPath = await folderInRepository(linked.repositoryRoot, others.map((candidate) => candidate.fsPath));
        const main = others.find((candidate) => candidate.fsPath === mainPath);
        const existing = registry.records().find((record) => record.kind === 'adopted' && record.deletedAt === undefined && folderKey(record.workingFolder) === project.key);
        const sameProject = existing && (existing.projectPath === undefined ? main === undefined : main !== undefined && folderKey(existing.projectPath) === main.key);
        if (sameProject) continue;
        await registry.upsertAdopted({
          worktreeRoot: linked.worktreeRoot,
          workingFolder: project.fsPath,
          repositoryRoot: linked.repositoryRoot,
          ...(main ? { projectPath: main.fsPath } : {}),
          ...(linked.branch !== undefined ? { branch: linked.branch } : {}),
        });
      }
    },
  };
}

export function startCoreWorktrees(platform: CorePlatform, scm: CoreScm, holds: FinishHolds, log: (line: string) => void): CoreWorktrees {
  const { endpoint } = platform;
  const registry = new WorktreeRegistry({ rootDir: path.join(DAMOCLES_HOME_DIR, 'worktrees'), watcherFactory: platform.fileWatchers, log, lastRecords: platform.init.worktreeRecords });
  removeAbandonedTempFolders(os.tmpdir(), Date.now()).catch((err: unknown) => log(`[worktrees] could not look for abandoned temp folders: ${err instanceof Error ? err.message : String(err)}`));
  const publish = (): void => endpoint.publish('worktrees', { records: [...registry.records()] });
  const changes = registry.onDidChange(publish);
  publish();
  const calls = worktreeCalls({ registry, git: () => scm.runner, isTrusted: (folder) => platform.trust.isTrusted(folder), holds, log });
  // main is trusted to send each call's own arguments; the protocol checked them as bounded JSON
  endpoint.serve('worktrees.call', ({ method, args }) => (calls[method] as (...callArgs: readonly unknown[]) => Promise<unknown>)(...args));

  // a step of each running setup, by worktree
  const setupSteps = new Map<string, (step: { readonly index: number; readonly total: number; readonly command: string }) => void>();
  const steps = endpoint.onEvent('worktrees.setupStep', ({ worktreeId, ...step }) => setupSteps.get(worktreeId)?.(step));
  const services: WorktreeHostServices = {
    registry,
    git: () => scm.runner,
    branchPrefix: () => platform.settings.get<string>(SCM_SETTING_KEYS.branchPrefix, '') ?? '',
    reviewSetup: (request) => endpoint.request('worktrees.reviewSetup', { projectPath: request.projectPath, projectName: request.projectName, commands: request.commands }),
    runSetup: async (request, onStep) => {
      setupSteps.set(request.worktreeId, onStep);
      try {
        return await endpoint.request('worktrees.runSetup', { worktreeId: request.worktreeId, cwd: request.cwd, commands: request.commands, env: request.env });
      } finally {
        if (setupSteps.get(request.worktreeId) === onStep) setupSteps.delete(request.worktreeId);
      }
    },
    showSetupTerminal: (worktreeId) => {
      endpoint.request('worktrees.showSetupTerminal', { worktreeId }).catch((err: unknown) => log(`[worktrees] showing the Setup terminal failed: ${String(err)}`));
    },
    stopSetup: (worktreeId) => {
      endpoint.request('worktrees.stopSetup', { worktreeId }).catch((err: unknown) => log(`[worktrees] stopping the setup failed: ${String(err)}`));
    },
    newChatInWorktree: (projectPath, worktreeId) => endpoint.emit('worktrees.newChatInWorktree', { projectPath, worktreeId }),
    onDidChangeRefs: (listener) => scm.onDidChangeRefs(listener),
    projectRepository: (projectPath) => scm.projectRepository(projectPath),
    onDidChangeProjectRepository: (listener) => scm.onDidChangeProjectRepository(listener),
    confirmHandOff: (request) => endpoint.request('worktrees.confirmHandOff', { direction: request.direction, ...(request.branch !== undefined ? { branch: request.branch } : {}), files: request.files }),
    showRefusal: (request) => endpoint.request('worktrees.showRefusal', { kind: request.kind, files: request.files }),
    showApplyConflicts: (record, files) => endpoint.request('worktrees.showApplyConflicts', { worktreeId: record.id, files }),
    newChatInProject: (projectPath) => endpoint.emit('worktrees.newChatInProject', { projectPath }),
  };
  return {
    registry,
    services,
    dispose: () => {
      steps.dispose();
      changes.dispose();
      registry.dispose();
    },
  };
}
