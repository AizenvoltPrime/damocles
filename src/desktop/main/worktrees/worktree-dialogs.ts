// The worktree questions (slice 12a) as the overlay's themed dialogs (D41). Main accepts only an answer to the request it
// issued, of that dialog's own shape (parseWorktreeDialogAnswer); Escape and a withdrawn dialog answer its cancel choice.
// When the overlay cannot show one, the question goes to the message asker, which falls back to the OS box.
import type { WebContents } from 'electron';
import type { OverlayAnswer, OverlayRequest, WorktreeDialog, WorktreeDialogAnswer, WorktreeFile } from '../../preload/overlay-channels';
import type { AskMessage, MessageQuestion } from '../message-dialog';
import { boundWorktreeDialog } from '../overlay';
import { visibleText } from '../../../shared/visible-text';

export type WorktreeDialogOf<D extends WorktreeDialog['dialog']> = Extract<WorktreeDialog, { dialog: D }>;
export type WorktreeAnswerOf<D extends WorktreeDialog['dialog']> = Extract<WorktreeDialogAnswer, { dialog: D }>;

export type AskWorktreeDialog = <D extends WorktreeDialog['dialog']>(dialog: WorktreeDialogOf<D>) => Promise<WorktreeAnswerOf<D>>;

export interface WorktreeDialogDeps {
  readonly overlay: () => { request(request: OverlayRequest, returnFocus: WebContents | undefined): Promise<OverlayAnswer> } | undefined;
  readonly focused: () => WebContents | undefined;
  readonly ask: AskMessage;
  // a notice, for a question no message dialog can ask
  readonly warn: (message: string) => void;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
}

/** The answer a dismissed dialog stands for. */
export function cancelAnswer(dialog: WorktreeDialog): WorktreeDialogAnswer {
  switch (dialog.dialog) {
    case 'setupReview': return { dialog: 'setupReview', choice: 'skip' };
    case 'delete': return { dialog: 'delete', choice: 'cancel', deleteBranch: dialog.deleteBranchDefault };
    case 'mergeMessage': return { dialog: 'mergeMessage', choice: 'cancel', message: '' };
    case 'rewritten': return { dialog: 'rewritten', choice: 'cancel' };
    case 'refusal': return { dialog: 'refusal', choice: 'ok' };
    case 'handOffConfirm': return { dialog: 'handOffConfirm', choice: 'cancel' };
    case 'leftovers': return { dialog: 'leftovers', choice: 'close' };
  }
}

const list = (lines: readonly string[]): string => lines.join('\n');

// The same question as a message dialog: its actions in order, each mapped back to the dialog's answer; null when a message
// dialog cannot ask it (a commit message needs a text box).
// A file as the message box lists it: its status letter, then its path.
const fileLine = (file: WorktreeFile): string => `${file.letter} ${file.path}`;

function asMessage(dialog: WorktreeDialog, t: WorktreeDialogDeps['t']): { readonly question: MessageQuestion; readonly answers: readonly WorktreeDialogAnswer[] } | null {
  switch (dialog.dialog) {
    case 'setupReview':
      return {
        question: { severity: 'warning', message: t('Run this project\'s worktree setup?'), preview: dialog.commands.map(visibleText), actions: [t('Run')], cancelLabel: t('Skip') },
        answers: [{ dialog: 'setupReview', choice: 'run' }],
      };
    case 'delete':
      return {
        question: {
          severity: 'danger',
          message: t('Delete worktree'),
          detail: list([dialog.path, ...[...dialog.uncommitted, ...dialog.submoduleChanges].map(fileLine), ...dialog.unmergedCommits.map((commit) => `${commit.hash.slice(0, 7)} ${commit.subject}`)].map(visibleText)),
          actions: [t('Delete worktree')],
          cancelLabel: t('Cancel'),
        },
        answers: [{ dialog: 'delete', choice: 'delete', deleteBranch: dialog.deleteBranchDefault }],
      };
    case 'mergeMessage':
      return null;
    case 'rewritten':
      return {
        question: {
          severity: 'warning',
          message: t('{0} was rewritten after this worktree started', visibleText(dialog.branch)),
          detail: t('Merging now would bring back the commit it replaced.'),
          actions: [t('Rebase onto {0}', visibleText(dialog.branch)), t('Apply instead')],
          cancelLabel: t('Cancel'),
          defaultAction: 0,
        },
        answers: [{ dialog: 'rewritten', choice: 'rebase' }, { dialog: 'rewritten', choice: 'apply' }],
      };
    case 'refusal':
      return {
        question: { severity: 'warning', message: t('These files have local changes in the project folder:'), detail: list(dialog.files.map((file) => visibleText(fileLine(file)))), actions: [t('OK')], defaultAction: 0 },
        answers: [{ dialog: 'refusal', choice: 'ok' }],
      };
    case 'handOffConfirm':
      return {
        question: {
          severity: 'warning',
          message: dialog.direction === 'toWorktree' ? t('Move this chat to a worktree?') : t('Move this chat to the project folder?'),
          detail: list(dialog.files.map((file) => (file.alsoUserEdits ? `${visibleText(fileLine(file))} (${t('also has your edits')})` : visibleText(fileLine(file))))),
          actions: [dialog.direction === 'toWorktree' ? t('Move to worktree') : t('Move to project folder')],
          cancelLabel: t('Cancel'),
          defaultAction: 0,
        },
        answers: [{ dialog: 'handOffConfirm', choice: 'move' }],
      };
    case 'leftovers':
      return {
        question: { severity: 'info', message: dialog.items.length === 1 ? t('1 leftover worktree') : t('{0} leftover worktrees', dialog.items.length), detail: list(dialog.items.map((item) => visibleText(item.path))), actions: [t('OK')], defaultAction: 0 },
        answers: [{ dialog: 'leftovers', choice: 'close' }],
      };
  }
}

export function createWorktreeDialogAsker(deps: WorktreeDialogDeps): AskWorktreeDialog {
  const fallback = async (dialog: WorktreeDialog): Promise<WorktreeDialogAnswer> => {
    const message = asMessage(dialog, deps.t);
    if (!message) {
      deps.log(`[worktrees] the ${dialog.dialog} dialog needs the overlay, which could not show it; it answers cancel`);
      deps.warn(deps.t('The merge needs its commit message dialog, which could not be shown, so nothing was merged.'));
      return cancelAnswer(dialog);
    }
    const chosen = await deps.ask(message.question);
    return chosen === undefined ? cancelAnswer(dialog) : message.answers[chosen] ?? cancelAnswer(dialog);
  };
  const ask = async (dialog: WorktreeDialog): Promise<WorktreeDialogAnswer> => {
    const overlay = deps.overlay();
    if (!overlay) return fallback(dialog);
    let answer: OverlayAnswer;
    try {
      answer = await overlay.request(boundWorktreeDialog(dialog), deps.focused());
    } catch (err) {
      deps.log(`[worktrees] the overlay could not ask the ${dialog.dialog} dialog (${err instanceof Error ? err.message : String(err)})`);
      return fallback(dialog);
    }
    if (answer.kind !== 'worktreeDialog') return cancelAnswer(dialog);
    const { kind: _kind, ...rest } = answer;
    return rest;
  };
  return ask as AskWorktreeDialog;
}
