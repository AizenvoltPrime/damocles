import type { ChatWorktreeRecord } from './registry';

export const PROJECT_FOLDER_ENV = 'DAMOCLES_PROJECT_FOLDER';
export const WORKTREE_INDEX_ENV = 'DAMOCLES_WORKTREE_INDEX';

/** D32: what every shell Damocles starts in a chat worktree gets; never written into process.env. */
export function worktreeEnvironment(record: Pick<ChatWorktreeRecord, 'projectPath' | 'index'>): Record<string, string> {
  return { [PROJECT_FOLDER_ENV]: record.projectPath, [WORKTREE_INDEX_ENV]: String(record.index) };
}
