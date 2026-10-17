// Rule 14's first half for a chat worktree: every question comes first, so a Cancel, or a chat that starts working before the
// hold, leaves its tabs, buffers, terminals, chats and formatter as they were; only then does anything stop.
import type { RootCloseAnswers } from '../editor-pane';

export interface CloseWorktreeDeps {
  readonly editor: {
    confirmCloseRoot(rootKey: string, answered?: RootCloseAnswers): Promise<RootCloseAnswers | undefined>;
    closeRoot(rootKey: string, answers: RootCloseAnswers): boolean;
  };
  readonly terminals: {
    idsIn(rootKey: string): string[];
    // asks only when one of them runs a process; false: the user kept them
    confirmKill(ids: readonly string[]): Promise<boolean>;
    kill(id: string): void;
  };
  // unloads the chats using the worktree
  readonly closeChats: () => void;
  // the root left the root list; consumers keyed by root follow
  readonly rootsChanged: () => void;
  // settles once the root's formatter host has exited: Windows refuses to remove a live process's working folder
  readonly releaseFormatter: (rootKey: string) => Promise<void>;
  // settles once core released the working folder (its runtime, project MCP servers, watchers and Compass)
  readonly whenFolderReleased: () => Promise<void>;
}

/**
 * Asks about the root's dirty tabs, then its terminals (again for a buffer edited or a terminal opened while a question was
 * open), then calls stop, which takes the delete's hold and closes the root, and stops what runs there. false: a question was
 * cancelled or stop refused, and nothing was stopped.
 */
export async function closeWorktreeRoot(deps: CloseWorktreeDeps, rootKey: string, stop: () => boolean): Promise<boolean> {
  let answers = await deps.editor.confirmCloseRoot(rootKey);
  if (!answers) return false;
  const asked = new Set<string>();
  for (let ids = deps.terminals.idsIn(rootKey); ids.length > 0; ids = deps.terminals.idsIn(rootKey).filter((id) => !asked.has(id))) {
    if (!(await deps.terminals.confirmKill(ids))) return false;
    for (const id of ids) asked.add(id);
    answers = await deps.editor.confirmCloseRoot(rootKey, answers);
    if (!answers) return false;
  }
  // nothing awaits between the last answer and the close, so no buffer changes in between
  if (!stop() || !deps.editor.closeRoot(rootKey, answers)) return false;
  deps.closeChats();
  for (const id of deps.terminals.idsIn(rootKey)) deps.terminals.kill(id);
  deps.rootsChanged();
  await Promise.all([deps.releaseFormatter(rootKey), deps.whenFolderReleased()]);
  return true;
}
