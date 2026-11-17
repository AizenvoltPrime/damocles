import { authorityKeyOfProject } from '../../shared/project-location';
import type { LastChats } from './last-chats';
import type { PanelStateStore } from './panel-state-store';
import type { RemoteState } from './remote/remote-state';

export interface SelectionStores {
  readonly states: Pick<PanelStateStore, 'batch' | 'select' | 'selected'>;
  // undefined until remote-state.json was read
  readonly remoteState: Pick<RemoteState, 'batch' | 'select' | 'selected'> | undefined;
  readonly lastChats: Pick<LastChats, 'remember'>;
  // a remote-state.json write that failed
  readonly report: (err: unknown) => void;
}

export interface ChatSelection {
  readonly projectKey: string;
  // LastChats' id: the session id, or NEW_CHAT_ID_PREFIX and the panel id
  readonly chatId: string;
  readonly panelId: string;
  readonly authority: string;
  readonly sessionId?: string;
}

/**
 * Records the selected chat as its project's last chat and as the selection, in one write of each file. panels.json names
 * only local chats, which an older version reads; a remote selection is remote-state.json's.
 */
export function recordSelection(deps: SelectionStores, selection: ChatSelection): void {
  const { projectKey, authority } = selection;
  const session = selection.sessionId !== undefined ? { sessionId: selection.sessionId } : {};
  const record = (): void => {
    deps.lastChats.remember(projectKey, selection.chatId);
    if (authority === 'local') deps.states.select({ projectKey, panelId: selection.panelId, ...session });
    deps.remoteState?.select(authority === 'local' ? undefined : { projectKey, ...session }).catch(deps.report);
  };
  deps.states.batch(() => (deps.remoteState ? deps.remoteState.batch(record) : record()));
}

/** Records a project shown with no chat (its folder is not there) as the selection, by recordSelection's rule. */
export function recordProjectSelection(deps: Pick<SelectionStores, 'states' | 'remoteState' | 'report'>, projectKey: string): void {
  if (authorityKeyOfProject(projectKey) !== 'local') {
    if (deps.remoteState?.selected()?.projectKey !== projectKey) deps.remoteState?.select({ projectKey }).catch(deps.report);
    return;
  }
  if (deps.states.selected()?.projectKey !== projectKey) deps.states.select({ projectKey });
  if (deps.remoteState?.selected() !== undefined) deps.remoteState.select(undefined).catch(deps.report);
}
