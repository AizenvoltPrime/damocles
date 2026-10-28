import { catalogEntryOfPiModel, modelLabel as catalogModelLabel } from '@shared/model-vendor';
import type { ShellChat, ShellChatAction } from '../preload/shell-channels';

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

/** Whether main offers the action on the chat's row; its menu, buttons and keys all ask this. */
export function chatOffers(chat: ShellChat, action: ShellChatAction): boolean {
  return chat.actions.includes(action);
}

/** A chat's recorded pi model as the model lists name it; its pi id when it is outside the catalog. */
export function modelLabel(model: NonNullable<ShellChat['model']>): string {
  const entry = catalogEntryOfPiModel(model.provider, model.id);
  return entry ? catalogModelLabel(entry) : model.id;
}
