// The session's worktree entry (AD12 Sessions). Pure: the session metadata worker bundles it.
import * as path from 'node:path';
import { isWorktreeId } from '../../shared/worktree-id';
import { DAMOCLES_WORKTREE_ENTRY } from '../pi-session/session-store/constants';
import type { ChatPlace } from '../../shared/types/messages';

export interface WorktreeEntryData {
  readonly worktreeId: string;
  readonly projectPath: string;
  readonly place: ChatPlace;
}

function isWorktreeEntryData(value: unknown): value is WorktreeEntryData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isWorktreeId(v['worktreeId']) && typeof v['projectPath'] === 'string' && path.isAbsolute(v['projectPath']) && (v['place'] === 'worktree' || v['place'] === 'project');
}

/** The entry's data when `entry` is a worktree entry. Takes untrusted parsed entries. */
export function worktreeEntryOf(entry: unknown): WorktreeEntryData | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
  return e.type === 'custom' && e.customType === DAMOCLES_WORKTREE_ENTRY && isWorktreeEntryData(e.data) ? e.data : undefined;
}

/** The last worktree entry in file order, which decides where the chat works (AD12). */
export function latestWorktreeEntry(entries: readonly unknown[]): WorktreeEntryData | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const data = worktreeEntryOf(entries[i]);
    if (data) return data;
  }
  return undefined;
}
