import { NEW_CHAT_ID_PREFIX, type ShellChatAction } from '../preload/shell-channels';

/**
 * What a Chats row offers besides Open, and what main lets run on that chat. A chat of a host with no connection is its
 * mirrored transcript, which only opens; a chat with no session file yet cannot be renamed or tagged.
 */
export function chatActions(chatId: string, mirrored: boolean): readonly ShellChatAction[] {
  if (mirrored) return [];
  return chatId.startsWith(NEW_CHAT_ID_PREFIX) ? ['delete'] : ['rename', 'tag', 'delete'];
}

export interface MirroredGuardDeps {
  // the state chatActions' mirrored comes from
  readonly mirrored: (authority: string) => boolean;
  readonly hostName: (authority: string) => string;
  readonly t: (message: string, ...args: string[]) => string;
  readonly error: (message: string) => void;
}

/** Whether main refuses a change to a chat or worktree of the authority, telling the user: its chats are mirrored transcripts. */
export function refusesMirrored(deps: MirroredGuardDeps, authority: string): boolean {
  if (!deps.mirrored(authority)) return false;
  deps.error(deps.t('{0} is not connected, so its chats are read-only until it connects.', deps.hostName(authority)));
  return true;
}
