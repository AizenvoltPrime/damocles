// What a host's attach does with each chat remote-state.json kept for it (docs/invariants.md "Remote daemon and wire").
import type { RemoteChatRecord } from './remote-state';

export interface KeptChatProjects {
  // the project is listed, or a move's host part re-keyed the chat to its new folder before the list names it
  readonly known: (projectKey: string) => boolean;
  readonly absent: (projectKey: string) => boolean;
}

/** open: reopened on the host's core; closed: kept until its folder is back or its move is done; dropped: its project left the list. */
export type KeptChatFate = 'open' | 'closed' | 'dropped';

export function keptChatFate(projectKey: string | undefined, projects: KeptChatProjects): KeptChatFate {
  if (projectKey === undefined) return 'open';
  // a key no project lists reads present
  if (!projects.known(projectKey)) return 'dropped';
  return projects.absent(projectKey) ? 'closed' : 'open';
}

/**
 * The kept chats to reopen: of those naming one conversation the one whose page token is `selected` (the chat to select again),
 * else the first, and none naming a conversation `shown` names.
 */
export function oncePerConversation<T extends Pick<RemoteChatRecord, 'sessionId' | 'panelToken'>>(records: readonly T[], shown: Iterable<string>, selected?: string): T[] {
  // a device shows a panel in one view, so a second view of the conversation could join no panel
  const opened = new Set(shown);
  const kept = new Map<string, T>();
  for (const record of records) {
    if (record.sessionId === undefined || opened.has(record.sessionId)) continue;
    if (!kept.has(record.sessionId) || record.panelToken === selected) kept.set(record.sessionId, record);
  }
  return records.filter((record) => record.sessionId === undefined || kept.get(record.sessionId) === record);
}

export interface KeptChatOpen {
  // the chat's view joins the panel its page token names, else the one holding sessionId; false when none does
  readonly join: (viewKey: string | undefined, sessionId: string | undefined) => Promise<boolean>;
  // a new panel restores the chat into the view a failed join left relayed
  readonly restoreJoining: () => Promise<void>;
  // a new panel restores the chat into its view
  readonly restore: () => Promise<void>;
}

/**
 * Reopens a kept chat: under the epoch it was open in, its own panel, else a restore; under a new one, the panel another device
 * restored its conversation into, else a restore, so no device restores a second panel of a conversation it could join.
 */
export async function reopenKeptChat(record: Pick<RemoteChatRecord, 'panelToken' | 'sessionId'>, rejoin: boolean, open: KeptChatOpen): Promise<void> {
  if (!rejoin && record.sessionId === undefined) return open.restore();
  if (await open.join(rejoin ? record.panelToken : undefined, record.sessionId)) return;
  await open.restoreJoining();
}
