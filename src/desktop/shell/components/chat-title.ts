import type { ShellState } from '../../preload/shell-channels';

/** The selected chat's name in the title bar and the focus overlay: undefined until main has read its title. */
export function chatTitleText(chat: ShellState['selectedChat'], t: (key: string) => string): string | undefined {
  if (chat?.title === undefined) return undefined;
  return chat.title || t('chats.newChat');
}
