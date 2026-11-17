// Opening a folder of the same repository as a project folder that is gone (docs/invariants.md "Project relocation"): VS Code has
// no project list, so it offers to move the chats of each such folder here, in merge mode, at activation and when a folder is
// added; Damocles: Move Chats Here asks again, declined folders included.
import * as vscode from 'vscode';
import type { ProjectRelocations } from '../core/project-relocation';
import type { Coded, MovedFromCandidate, PreflightAnswer, RelocationCode, RelocationView } from '../core/project-relocation/types';
import { log } from '../core/logger';
import { folderKey } from '../core/workspace-folders/folder-key';

/** Global state: the declined pairs, each the old folder's key and the opened folder's key joined by a newline. */
export const DECLINED_KEY = 'damocles.relocationOffer.declined';
const MAX_DECLINED = 200;

type Relocations = Pick<ProjectRelocations, 'movedFrom' | 'preflight' | 'relocate' | 'retry' | 'abandon' | 'views' | 'onDidChange'>;
// paused: the relocation is paused, so Stop Moving can abandon it
type Outcome = { readonly kind: 'done'; readonly view: RelocationView } | { readonly kind: 'failed'; readonly text: string; readonly paused?: true };

export function registerRelocationOffer(context: Pick<vscode.ExtensionContext, 'subscriptions' | 'globalState'>, relocations: Relocations): RelocationOffer {
  const offer = new RelocationOffer(relocations, context.globalState);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => { void offer.check(event.added, false); }),
    vscode.commands.registerCommand('damocles.moveChatsHere', () => offer.check(vscode.workspace.workspaceFolders ?? [], true)),
  );
  void offer.check(vscode.workspace.workspaceFolders ?? [], false);
  return offer;
}

export class RelocationOffer {
  private readonly relocations: Relocations;
  private readonly state: vscode.Memento;
  // the lookup of each opened folder in flight, which a check made meanwhile shares
  private readonly checking = new Map<string, Promise<readonly MovedFromCandidate[]>>();
  // pairKey of each offer from its question until its move ends; an unanswered one may wait in the notification centre
  private readonly offering = new Set<string>();

  constructor(relocations: Relocations, state: vscode.Memento) {
    this.relocations = relocations;
    this.state = state;
  }

  /** Offers the chats of each missing folder matching one of `folders`; `again` asks for declined pairs too and says when none matched. */
  async check(folders: readonly vscode.WorkspaceFolder[], again: boolean): Promise<void> {
    let found = 0;
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') continue;
      const to = folder.uri.fsPath;
      for (const candidate of await this.candidatesOf(to)) {
        found++;
        if (this.offering.has(pairKey(candidate.from, to)) || (!again && this.declined(candidate.from, to))) continue;
        await this.offer(candidate, to);
      }
    }
    if (again && found === 0) void vscode.window.showInformationMessage(vscode.l10n.t('Damocles found no chats of a missing folder of this repository.'));
  }

  private candidatesOf(to: string): Promise<readonly MovedFromCandidate[]> {
    const key = folderKey(to);
    const running = this.checking.get(key);
    if (running) return running;
    const lookup = this.relocations.movedFrom(to).catch((err: unknown) => {
      log(`[RelocationOffer] looking for moved folders of ${to} failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }).finally(() => this.checking.delete(key));
    this.checking.set(key, lookup);
    return lookup;
  }

  // Preflight first, so a refusal is shown instead of the question and its notices are part of it.
  private async offer(candidate: MovedFromCandidate, to: string): Promise<void> {
    const { from } = candidate;
    const pair = pairKey(from, to);
    this.offering.add(pair);
    try {
      let answer: PreflightAnswer;
      try {
        answer = await this.relocations.preflight({ from, to, listed: listedFolders() });
      } catch (err) {
        log(`[RelocationOffer] checking the move of ${from} to ${to} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        void vscode.window.showErrorMessage(vscode.l10n.t('Damocles could not move the chats of {0}: {1}', from, err instanceof Error ? err.message : String(err)));
        return;
      }
      if (!answer.ok) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Damocles could not move the chats of {0}: {1}', from, failureText(answer.refusal, from)));
        return;
      }
      // the offer always merges into an open folder, so the merge notice says nothing new
      const notices = answer.notices.filter((notice) => notice.code !== 'merge').map((notice) => failureText(notice, from));
      const move = vscode.l10n.t('Move Chats');
      const notNow = vscode.l10n.t('Not Now');
      const chosen = await vscode.window.showInformationMessage([vscode.l10n.t('Move the chats of {0} here?', from), ...notices].join(' '), move, notNow);
      if (chosen === move) await this.move(from, to);
      else if (chosen === notNow) await this.decline(from, to);
    } finally {
      this.offering.delete(pair);
    }
  }

  private declined(from: string, to: string): boolean {
    return this.state.get<string[]>(DECLINED_KEY, []).includes(pairKey(from, to));
  }

  private async decline(from: string, to: string): Promise<void> {
    const pair = pairKey(from, to);
    const kept = this.state.get<string[]>(DECLINED_KEY, []).filter((entry) => entry !== pair);
    await this.state.update(DECLINED_KEY, [...kept, pair].slice(-MAX_DECLINED));
  }

  // The relocation with its progress; a refusal, a pause or an error offers Retry, which resumes a paused relocation, and a pause
  // Stop Moving, which abandons it once confirmed.
  private async move(from: string, to: string): Promise<void> {
    let id: string | undefined;
    for (;;) {
      const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Moving the chats of {0}', from) },
        async (progress): Promise<Outcome> => {
          const started = await this.start(from, to, id);
          if (typeof started !== 'string') return { kind: 'failed', text: failureText(started.refusal, from) };
          id = started;
          return this.settled(started, from, (done, total) => progress.report({ message: vscode.l10n.t('{0} of {1} chats', String(done), String(total)) }));
        },
      ).then((settled) => settled, (err: unknown): Outcome => {
        log(`[RelocationOffer] moving the chats of ${from} to ${to} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return { kind: 'failed', text: err instanceof Error ? err.message : String(err) };
      });
      if (outcome.kind === 'done') {
        const { view } = outcome;
        const moved = view.chats === 1 ? vscode.l10n.t('Moved 1 chat of {0} here.', from) : vscode.l10n.t('Moved {0} chats of {1} here.', String(view.chats), from);
        // a core that predates `waiting` names only the first step left
        const waits = view.waiting ?? (view.failure ? [view.failure] : []);
        void vscode.window.showInformationMessage([moved, ...waits.map((wait) => failureText(wait, from))].join(' '));
        return;
      }
      const retry = vscode.l10n.t('Retry');
      const stop = vscode.l10n.t('Stop Moving');
      const chosen = await vscode.window.showErrorMessage(vscode.l10n.t('Damocles could not move the chats of {0}: {1}', from, outcome.text), retry, ...(outcome.paused && id !== undefined ? [stop] : []));
      if (chosen === stop && id !== undefined) return this.stopMoving(id, from);
      if (chosen !== retry) return;
    }
  }

  // Abandons the paused relocation once the user confirms: the chats it moved stay here, the rest with the old folder.
  private async stopMoving(id: string, from: string): Promise<void> {
    const stop = vscode.l10n.t('Stop Moving');
    const detail = vscode.l10n.t('The chats already moved here stay here. The rest stay with {0}, as do the memories and settings not moved yet, and Damocles: Move Chats Here can move them later. Nothing moves back.', from);
    if ((await vscode.window.showWarningMessage(vscode.l10n.t('Stop moving the chats of {0}?', from), { modal: true, detail }, stop)) !== stop) return;
    const refusal = await this.relocations.abandon(id);
    if (refusal) void vscode.window.showErrorMessage(failureText(refusal, from));
  }

  // A new relocation, or a retry of the one started before; a refusal leaves nothing to retry.
  private async start(from: string, to: string, previous: string | undefined): Promise<string | { readonly refusal: Coded }> {
    if (previous !== undefined) {
      await this.relocations.retry(previous);
      return previous;
    }
    const started = await this.relocations.relocate({ from, to, listed: listedFolders() });
    return 'refusal' in started ? started : started.id;
  }

  // Resolves once relocation `id` finished its core part or paused.
  private settled(id: string, from: string, report: (done: number, total: number) => void): Promise<Outcome> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        const view = this.relocations.views().find((candidate) => candidate.id === id);
        if (!view) return false;
        report(view.progress.done, view.progress.total);
        if (view.state === 'running') return false;
        subscription?.dispose();
        resolve(view.state === 'coreDone' ? { kind: 'done', view } : { kind: 'failed', text: failureText(view.failure ?? { code: 'stopped' }, from), paused: true });
        return true;
      };
      let subscription: vscode.Disposable | undefined;
      if (!check()) subscription = this.relocations.onDidChange(() => { check(); });
    });
  }
}

const pairKey = (from: string, to: string): string => `${folderKey(from)}\n${folderKey(to)}`;

const listedFolders = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);

const param = (coded: Coded, name: string): string => String(coded.params?.[name] ?? '');

/** A refusal, pause, waiting step or notice of a move in the window's language; `from` is the folder whose chats move. */
export function failureText(coded: Coded, from: string): string {
  const code = coded.code as RelocationCode;
  switch (code) {
    case 'otherAuthority': return vscode.l10n.t('The opened folder is on another host than {0}.', from);
    case 'sameFolder': return vscode.l10n.t('{0} is the opened folder itself.', from);
    case 'insideDamocles': return vscode.l10n.t('The opened folder is inside Damocles\' own data folder.');
    case 'fromExists': return vscode.l10n.t('{0} exists again, so its chats stay with it.', from);
    case 'toMissing': return vscode.l10n.t('The opened folder no longer exists.');
    case 'toNotDirectory': return vscode.l10n.t('The opened folder is no longer a folder.');
    case 'repositoryLayout': return vscode.l10n.t('The new folder does not lie in its repository as {0} did in {1}, so its chat worktrees can\'t follow it.', from, param(coded, 'path'));
    case 'noRepository': return vscode.l10n.t('{0} is not a Git repository, so {1}\'s chat worktrees can\'t be linked to it.', param(coded, 'path'), from);
    case 'worktreeFinishing': return vscode.l10n.t('Apply, Merge, Update or Delete is running on the chat worktree {0}. Try again when it ends.', param(coded, 'branch'));
    case 'worktreeHandOff': return vscode.l10n.t('A chat is moving into or out of the chat worktree {0}. Try again when the move ends.', param(coded, 'branch'));
    case 'unreachable': return vscode.l10n.t('{0} is not reachable, so Damocles can\'t check that {1} is gone. If it still exists there, it will no longer show these chats.', param(coded, 'root'), from);
    case 'worktreesNotRelinkable': return vscode.l10n.t('The new folder\'s repository does not know these chat worktrees, so they can\'t be linked to it: {0}. You can delete them after the move.', param(coded, 'branches'));
    case 'merge': return vscode.l10n.t('{0} is a project already: its settings and layout stay, and these chats join its chats.', param(coded, 'projectPath'));
    case 'insideProject': return vscode.l10n.t('The new folder is inside the project {0}.', param(coded, 'projectPath'));
    case 'otherRepository': return vscode.l10n.t('The new folder looks like another repository: it shares no remote and no first commit with {0}.', from);
    case 'chatHeld': {
      const title = param(coded, 'title') || vscode.l10n.t('Untitled chat');
      if (coded.params?.['holder'] === 'thisProcess') return vscode.l10n.t('The chat "{0}" is open in this window. Close it, then try again.', title);
      return vscode.l10n.t('The chat "{0}" is open in the Damocles app or another VS Code window. Close it there, then try again.', title);
    }
    case 'agentRunHeld': {
      const title = param(coded, 'title') || vscode.l10n.t('Untitled chat');
      if (coded.params?.['holder'] === 'thisProcess') return vscode.l10n.t('A subagent or team of the chat "{0}" is still running in this window. Wait for it to finish, then try again.', title);
      return vscode.l10n.t('A subagent or team of the chat "{0}" is still running in the Damocles app or another VS Code window. Wait for it to finish, then try again.', title);
    }
    case 'pendingRelocation': return vscode.l10n.t('The chats of {0} are being moved already. Wait for that move to finish.', param(coded, 'path'));
    case 'chatWorktree': return coded.params?.['projectPath'] === undefined
      ? vscode.l10n.t('{0} is in the folder where Damocles keeps chat worktrees, so its chats can\'t be moved.', from)
      : vscode.l10n.t('{0} is a chat worktree of {1}, which Damocles keeps in place, so its chats can\'t be moved.', from, param(coded, 'projectPath'));
    case 'registryUnreadable': return vscode.l10n.t('Damocles can\'t read the chat worktree registry, so it can\'t check {0}\'s chat worktrees.', from);
    case 'conflict': return vscode.l10n.t('The move paused: {0} is in the new place already with other content. Keep one copy, then retry.', param(coded, 'path'));
    case 'io': return vscode.l10n.t('The move paused: Damocles could not move {0} ({1}).', param(coded, 'path'), param(coded, 'errno'));
    case 'locked': return vscode.l10n.t('The move paused: a chat of {0} was opened while its chats were moving. Close it, then retry.', from);
    case 'agentRunning': return vscode.l10n.t('The move paused: a subagent or team of a chat of {0} is still running. Wait for it to finish, then retry.', from);
    case 'stopped': return vscode.l10n.t('The move was stopped.');
    case 'earlierMove': return vscode.l10n.t('The project\'s memories move once an earlier move of {0} has moved its own. Damocles moves them then.', param(coded, 'path'));
    case 'notPaused': return vscode.l10n.t('The move of {0} is no longer paused, so it was not stopped.', from);
    case 'relocationRunning': return vscode.l10n.t('The move of {0} is running, so it was not stopped.', from);
    case 'untrusted': return vscode.l10n.t('Trust this folder to re-link its chat worktrees.');
    case 'repairFailed': return coded.params?.['count'] === 1 ? vscode.l10n.t('A chat worktree of {0} could not be re-linked to its repository.', from) : vscode.l10n.t('{0} chat worktrees of {1} could not be re-linked to its repository.', param(coded, 'count'), from);
    case 'memoryReadOnly': {
      const reason = coded.params?.['reason'];
      if (reason === 'disabled') return vscode.l10n.t('The project\'s memories stay with its old folder while memory is turned off. Damocles moves them at a start with memory on.');
      if (reason === 'readOnly') return vscode.l10n.t('The project\'s memories could not move yet: the memory database is read-only. Damocles tries again at its next start.');
      if (reason === 'unavailable') return vscode.l10n.t('The project\'s memories could not move yet: the memory database is not available. Damocles tries again at its next start.');
      return vscode.l10n.t('The project\'s memories could not move yet. Damocles tries again at its next start.');
    }
    default: {
      // a code of a newer core; a code of this version missing above fails the typecheck here
      const unknown: never = code;
      return vscode.l10n.t('Reason: {0}.', String(unknown));
    }
  }
}
