import { DEFAULT_MODELS } from '@shared/types/constants';
import { NEW_CHAT_ID_PREFIX, type ShellChat } from '../preload/shell-channels';

export type ChatGroup = 'today' | 'yesterday' | 'earlier';

export type ChatListRow =
  | { readonly kind: 'group'; readonly group: ChatGroup }
  | { readonly kind: 'chat'; readonly chat: ShellChat };

const GROUP_ORDER: readonly ChatGroup[] = ['today', 'yesterday', 'earlier'];

// Day boundaries are local midnights, so a chat from 23:50 yesterday is not "Today".
export function chatGroupOf(timestamp: number, now: Date): ChatGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return 'today';
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  return timestamp >= startOfYesterday ? 'yesterday' : 'earlier';
}

/** The chats under Today / Yesterday / Earlier headers, each group keeping the given order and empty groups left out. */
export function chatListRows(chats: readonly ShellChat[], now: Date): ChatListRow[] {
  const byGroup = new Map<ChatGroup, ShellChat[]>(GROUP_ORDER.map((group) => [group, []]));
  for (const chat of chats) byGroup.get(chatGroupOf(chat.timestamp, now))?.push(chat);
  return GROUP_ORDER.flatMap((group): ChatListRow[] => {
    const members = byGroup.get(group) ?? [];
    return members.length === 0 ? [] : [{ kind: 'group', group }, ...members.map((chat) => ({ kind: 'chat' as const, chat }))];
  });
}

/** Tag → number of chats carrying it, most used first, then alphabetical. */
export function tagCounts(chats: readonly ShellChat[]): Array<{ readonly tag: string; readonly count: number }> {
  const counts = new Map<string, number>();
  for (const chat of chats) if (chat.tag) counts.set(chat.tag, (counts.get(chat.tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** False for a chat with no session file yet, which main refuses to rename or tag. */
export function hasSavedConversation(chat: ShellChat): boolean {
  return !chat.id.startsWith(NEW_CHAT_ID_PREFIX);
}

export function modelLabel(model: NonNullable<ShellChat['model']>): string {
  return DEFAULT_MODELS.find((entry) => entry.value === model.id)?.displayName ?? model.id;
}
