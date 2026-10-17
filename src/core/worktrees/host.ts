import type { Disposable } from '../../platform/disposable';
import type { Platform } from '../../platform/platform';
import type { GitRunner } from '../scm/git-runner';
import type { ChangeLetter } from '../scm/repository';
import type { WorktreeFile } from './create';
import type { ChatWorktreeRecord, WorktreeId, WorktreeRegistry } from './registry';

/** `index` is 1-based. */
export interface SetupStep {
  readonly index: number;
  readonly total: number;
  readonly command: string;
}

export interface SetupReviewRequest {
  readonly projectPath: string;
  readonly projectName: string;
  readonly commands: readonly string[];
}

export interface SetupRunRequest {
  /** The Setup terminal's Restart passes it to PanelManager.retrySetup. */
  readonly worktreeId: WorktreeId;
  /** The worktree's working folder. */
  readonly cwd: string;
  readonly commands: readonly string[];
  /** DAMOCLES_PROJECT_FOLDER and DAMOCLES_WORKTREE_INDEX (D32). */
  readonly env: Readonly<Record<string, string>>;
}

export interface HandOffConfirmRequest {
  readonly direction: 'toWorktree' | 'toProject';
  readonly branch?: string;
  readonly files: readonly { readonly path: string; readonly letter: ChangeLetter; readonly alsoUserEdits: boolean }[];
}

export interface RefusalRequest {
  readonly kind: 'handOff' | 'apply';
  readonly files: readonly WorktreeFile[];
}

/**
 * The platform as core's worktree readers take it. Declared here and not in src/platform, because the services are made of
 * core objects (the registry, the git runner).
 */
export interface PlatformWithWorktrees extends Platform {
  /** Supplied only by a host with `capabilities.worktrees`. */
  readonly worktrees?: WorktreeHostServices;
}

/** What a host with worktree chats (desktop) supplies to core; VS Code supplies none (slice 12a rule 17). */
export interface WorktreeHostServices {
  /** The one registry instance of this process; main reads the same instance. */
  readonly registry: WorktreeRegistry;
  /** The trust-gated runner source control uses; undefined when git is missing. */
  git(): GitRunner | undefined;
  /** `damocles.desktop.git.branchPrefix`, or '' when unset (D63). */
  branchPrefix(): string;
  /** D32's review dialog; 'skip' when dismissed. */
  reviewSetup(req: SetupReviewRequest): Promise<'run' | 'skip'>;
  /**
   * Runs the commands one after another in the "Setup" terminal tab, stopping at the first failure; resolves the last exit
   * code. `onStep` runs as each command starts. A second call for the same worktree restarts it.
   */
  runSetup(req: SetupRunRequest, onStep: (step: SetupStep) => void): Promise<{ exitCode: number }>;
  /** Reveals the worktree's Setup terminal tab. */
  showSetupTerminal(worktreeId: WorktreeId): void;
  /** Ends the worktree's Setup terminal process, if one runs, before its folder is removed. */
  stopSetup(worktreeId: WorktreeId): void;
  /** Starts another chat in the live chat worktree `worktreeId` of `projectPath` and selects it. */
  newChatInWorktree(projectPath: string, worktreeId: WorktreeId): void;
  /** Fires with the path of a listed project whose repository's refs changed, spelled as listed (the refs watcher). */
  onDidChangeRefs(listener: (projectPath: string) => void): Disposable;
  /** The repository root source control has open for the project, its own or a parent's (D9); undefined offers no worktrees. */
  projectRepository(projectPath: string): string | undefined;
  /** Fires with a project's path whenever `projectRepository` may answer differently for it (discovery settled, a repository opened or closed). */
  onDidChangeProjectRepository(listener: (projectPath: string) => void): Disposable;
  /** D61's confirmation; true moves the files. */
  confirmHandOff(req: HandOffConfirmRequest): Promise<boolean>;
  /** A refusal naming the files. */
  showRefusal(req: RefusalRequest): Promise<void>;
  /** An Apply of `record` into its project folder left `files` in conflict; told as the Apply command tells it. */
  showApplyConflicts(record: ChatWorktreeRecord, files: readonly string[]): Promise<void>;
  /** "New chat in project folder" from a read-only chat. */
  newChatInProject(projectPath: string): void;
}
