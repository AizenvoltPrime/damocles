import type { OverlayMenuItem } from '../preload/overlay-channels';
import { WORKTREE_FINISH_ACTIONS, type WorktreeFinishAction, type WorktreeFinishState } from '../preload/shell-channels';
import { visibleText } from '@shared/visible-text';

type Translate = (key: string, values?: Record<string, unknown>) => string;

// Menu item ids of the finish actions (D33); they never clash with a row or chip menu's own ids.
const FINISH_PREFIX = 'worktree:';

/** The finish action a menu answer names, or undefined for any other item. */
export function finishActionOf(itemId: string): WorktreeFinishAction | undefined {
  if (!itemId.startsWith(FINISH_PREFIX)) return undefined;
  const action = itemId.slice(FINISH_PREFIX.length);
  return (WORKTREE_FINISH_ACTIONS as readonly string[]).includes(action) ? (action as WorktreeFinishAction) : undefined;
}

/**
 * Apply, Merge into, Update from, Push branch and Delete worktree (D33) as a chip or row menu shows them: disabled while a
 * chat using the worktree works, Merge and Update while the project folder's HEAD is detached, Push without a remote. The
 * branch is git's name as main sends it; the labels show its hidden characters.
 */
export function finishMenuItems(t: Translate, finish: WorktreeFinishState, baseBranch: string | undefined): OverlayMenuItem[] {
  const busy = finish.busy ? { disabled: true, disabledReason: t('worktree.finish.busy') } : {};
  const detached = finish.detachedTarget || baseBranch === undefined;
  const targetGone = detached ? { disabled: true, disabledReason: t('worktree.finish.detached') } : {};
  return [
    { kind: 'item', id: `${FINISH_PREFIX}apply`, label: t('worktree.finish.apply'), icon: 'folder-input', ...busy },
    {
      kind: 'item',
      id: `${FINISH_PREFIX}merge`,
      label: baseBranch === undefined ? t('worktree.finish.mergeDetached') : t('worktree.finish.merge', { branch: visibleText(baseBranch) }),
      icon: 'git-merge',
      ...targetGone,
      ...busy,
    },
    {
      kind: 'item',
      id: `${FINISH_PREFIX}update`,
      label: baseBranch === undefined ? t('worktree.finish.updateDetached') : t('worktree.finish.update', { branch: visibleText(baseBranch) }),
      icon: 'arrow-down-to-line',
      ...targetGone,
      ...busy,
    },
    { kind: 'item', id: `${FINISH_PREFIX}push`, label: t('worktree.finish.push'), icon: 'cloud-upload', ...(finish.hasRemote ? {} : { disabled: true, disabledReason: t('worktree.finish.noRemote') }) },
    { kind: 'separator' },
    { kind: 'item', id: `${FINISH_PREFIX}delete`, label: t('worktree.finish.delete'), icon: 'trash-2', danger: true, ...busy },
  ];
}
