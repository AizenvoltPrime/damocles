// The desktop host part of a project relocation (docs/desktop-app.md "Locate"): once core's part reached coreDone, main's own
// path-keyed state follows the project to its new folder. One fact drives it: a coreDone relocation from a key the project
// list still names, which the list has not recorded as applied. Every step is idempotent, and the list changes after every
// step a later run needs, recording the relocation in the same write: a part cut short before it runs again at the next
// launch, and a part done never runs again. One instance serves one core: this computer's, or a remote authority's, whose paths are the target's.
import type { Coded, RelocatedWorktree, RelocationView } from '../../core/project-relocation/types';
import { visibleText } from '../../shared/visible-text';
import { rootKey } from '../preload/folder-root';
import type { FileRef } from '../preload/shell-channels';
import type { RootCloseAnswers } from './editor-pane';

type Translate = (message: string, ...args: string[]) => string;

// the repair's waits main shows as notices of their own (relocationRepairNotice)
const REPAIR_NOTICES: ReadonlySet<string> = new Set(['untrusted', 'repairFailed']);

export interface RelocatedFolder {
  readonly key: string;
  readonly fsPath: string;
}

/**
 * Who asked for a relocation: a Locate of this run, with the old root's unsaved-editor answers it took; this app in an
 * earlier run (only a desktop core runs for this app alone); or another app or device.
 */
export type RelocationRequester = { readonly answers: RootCloseAnswers } | 'thisApp' | 'other';

export interface RelocateStateDeps {
  // the project key of a folder path of this core's machine
  readonly keyOf: (fsPath: string) => string;
  // the listed project of this key, with the name the sidebar shows
  readonly listed: (key: string) => { readonly name: string } | undefined;
  // whether the listed project's folder reads missing or unavailable
  readonly absent: (key: string) => boolean;
  // whether the project list recorded this relocation as applied
  readonly applied: (id: string) => boolean;
  // "Chats of acme moved to D:\work\acme." with Open, for a relocation another app requested; true: Open
  readonly offerOpen: (view: RelocationView, name: string) => Promise<boolean>;
  // Open's questions, Locate's own: the old root's unsaved editors, then its terminals; undefined: cancelled
  readonly askClose: (key: string) => Promise<RootCloseAnswers | undefined>;
  readonly isTrusted: (fsPath: string) => boolean;
  // Add Project's trust question, which Open asks for the new folder as Locate does
  readonly requestTrust: (fsPath: string) => Promise<boolean>;
  // the saved layout's file tabs of the project
  readonly savedTabs: (key: string) => readonly FileRef[];
  // panels.json (saved chats, selection, last chats), the chats kept closed for the move and the window layout
  readonly relocateStores: (from: RelocatedFolder, to: RelocatedFolder) => Promise<void>;
  // the same stores' keys of each chat worktree, which stays where it is: its root key under the project
  readonly relocateWorktreeStores: (worktree: RelocatedWorktree, fromKey: string, toKey: string) => void;
  readonly revokeTrust: (fsPath: string) => Promise<void>;
  // what this computer holds of the project beyond main's stores: forge bindings and MCP toggles, and a remote project's
  // session mirror and /stats host alias
  readonly applyHostState: (view: RelocationView, from: RelocatedFolder, to: RelocatedFolder) => Promise<void>;
  // the new folder in the old one's place in the project list, or the old row gone in a merge, recording `id` as applied in
  // the same write
  readonly relocateList: (from: RelocatedFolder, to: RelocatedFolder, id: string) => Promise<void>;
  // the new folder in the old one's slot of the sidebar order, with the old key's dismissed WSL notice
  readonly relocateOrder: (from: RelocatedFolder, to: RelocatedFolder) => Promise<void>;
  // a chat worktree root's live editor tabs and unsaved text name its new root key; its folder stays where it is, so they stay
  // open
  readonly relocateRoot: (fromRootKey: string, toRootKey: string) => void;
  // opens these files of the new folder, those that exist, without taking the active tab
  readonly reopenTabs: (files: readonly FileRef[]) => Promise<void>;
  // closes the old root's live tabs, dropping the text the answers discarded
  readonly closeOldRoot: (key: string, answers: RootCloseAnswers) => void;
  // the project's saved chats that did not open while its folder was gone, now saved under the new key, open
  readonly reopenChats: (toKey: string) => void;
  readonly select: (key: string) => Promise<void>;
  readonly announce: (message: string) => void;
  // a step's failure the finished move still carries (memories left for a later start), in the user's language
  readonly describe: (failure: Coded, project: { readonly name: string; readonly fsPath: string }) => string;
  readonly report: (action: string, err: unknown) => void;
  readonly t: Translate;
}

/** The files `isFile` finds; one whose check fails counts as absent, and the failure is logged unless the file is missing. */
export async function presentFiles<T>(files: readonly T[], isFile: (file: T) => Promise<boolean>, failed: (file: T, err: unknown) => void): Promise<T[]> {
  const present = await Promise.all(files.map((file) => isFile(file).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') failed(file, err);
    return false;
  })));
  return files.filter((_, index) => present[index]);
}

/**
 * By authority, its core's relocations mirror as that core last published it. A remote core publishes it before its attach is
 * ready, while no client of it can be read, so only a published mirror replaces the last one.
 */
export class RelocationMirrors {
  private readonly published = new Map<string, readonly RelocationView[]>();

  /** Records the mirror a core published, or nothing when no core's mirror was read; answers the ids that left it. */
  publish(authority: string, views: readonly RelocationView[] | undefined): string[] {
    if (views === undefined) return [];
    const now = new Set(views.map((view) => view.id));
    const left = this.views(authority).filter((view) => !now.has(view.id)).map((view) => view.id);
    this.published.set(authority, views);
    return left;
  }

  views(authority: string): readonly RelocationView[] {
    return this.published.get(authority) ?? [];
  }
}

/** Applies coreDone relocations to main's state, once per relocation at a time. */
export class RelocatedProjects {
  private readonly deps: RelocateStateDeps;
  // by relocation id, the apply under way
  private readonly applying = new Map<string, Promise<void>>();
  // relocations offered with Open in this run, which a dismissed notice does not offer again
  private readonly offered = new Set<string>();

  constructor(deps: RelocateStateDeps) {
    this.deps = deps;
  }

  /**
   * A coreDone relocation from a listed project the list has not recorded as applied: applied at once when this app
   * requested it, else offered with Open, which applies it after Locate's questions. Unless this run's Locate asked for it,
   * the old folder must be absent: one there is a folder listed again at that path, another project.
   */
  async reached(view: RelocationView, requester: RelocationRequester): Promise<void> {
    if (view.state !== 'coreDone' || this.deps.applied(view.id)) return;
    const key = this.deps.keyOf(view.from);
    const project = this.deps.listed(key);
    if (!project || (typeof requester === 'string' && !this.deps.absent(key))) return;
    if (requester === 'thisApp') return this.apply(view, new Map());
    if (requester !== 'other') return this.apply(view, requester.answers);
    if (this.offered.has(view.id)) return;
    this.offered.add(view.id);
    if (!(await this.deps.offerOpen(view, project.name))) return;
    const answers = await this.deps.askClose(key);
    if (!answers) return;
    // declining keeps the move going, as with Locate
    if (!this.deps.isTrusted(view.to)) await this.deps.requestTrust(view.to);
    await this.apply(view, answers);
  }

  private apply(view: RelocationView, answers: RootCloseAnswers): Promise<void> {
    const running = this.applying.get(view.id);
    if (running) return running;
    const applied = this.run(view, answers).finally(() => this.applying.delete(view.id));
    this.applying.set(view.id, applied);
    return applied;
  }

  private async run(view: RelocationView, answers: RootCloseAnswers): Promise<void> {
    const from: RelocatedFolder = { key: this.deps.keyOf(view.from), fsPath: view.from };
    const to: RelocatedFolder = { key: this.deps.keyOf(view.to), fsPath: view.to };
    const project = this.deps.listed(from.key);
    if (!project || this.deps.applied(view.id)) return;
    const tabs = this.deps.savedTabs(from.key).map((file) => ({ ...file, projectKey: to.key }));
    await this.deps.relocateStores(from, to);
    for (const worktree of view.worktrees ?? []) this.deps.relocateWorktreeStores(worktree, from.key, to.key);
    await this.deps.revokeTrust(from.fsPath);
    await this.deps.applyHostState(view, from, to);
    // until the list changes, the old key stays listed and the next launch applies the relocation again
    await this.deps.relocateList(from, to, view.id);
    // a worktree's root key holds its project's, and resolves under the new one once the list names it
    for (const { worktreeId } of view.worktrees ?? []) this.deps.relocateRoot(rootKey({ projectKey: from.key, worktreeId }), rootKey({ projectKey: to.key, worktreeId }));
    // the order is cosmetic: a failure leaves the row last, and the steps after it still run
    await this.deps.relocateOrder(from, to).catch((err: unknown) => this.deps.report('Moving the project in the sidebar order', err));
    // the new folder's tabs open before the old root closes, so the saved layout never loses them
    await this.deps.reopenTabs(tabs);
    this.deps.closeOldRoot(from.key, answers);
    this.deps.reopenChats(to.key);
    await this.deps.select(to.key);
    const { t } = this.deps;
    const name = visibleText(project.name);
    const where = visibleText(view.to);
    const moved = view.chats === 1 ? t('Moved 1 chat of {0} to {1}.', name, where) : t('Moved {0} chats of {1} to {2}.', String(view.chats), name, where);
    // a repair waiting on trust or with failures has a notice of its own, with its action; a core that predates `waiting` names
    // only the first step left
    const waits = view.waiting ?? (view.failure && view.step !== 'repair' ? [view.failure] : []);
    const described = waits.filter((wait) => !REPAIR_NOTICES.has(wait.code)).map((wait) => this.deps.describe(wait, { name: project.name, fsPath: view.from }));
    this.deps.announce([moved, ...described].join(' '));
  }
}
