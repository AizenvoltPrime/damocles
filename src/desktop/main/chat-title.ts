import type { StoredSession } from '../../shared/types/session';

// A chat title, not the conversation: long previews are cut so ShellState and the chat list stay small.
export const MAX_CHAT_TITLE_CHARS = 120;

/** A stored chat's title: its custom name, else its AI title, else its preview, on one line and clipped; '' when it has none. */
export function storedTitle(session: Pick<StoredSession, 'customTitle' | 'aiTitle' | 'preview'>): string {
  for (const candidate of [session.customTitle, session.aiTitle, session.preview]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const single = candidate.trim().replace(/\s+/g, ' ');
      return single.length > MAX_CHAT_TITLE_CHARS ? `${single.slice(0, MAX_CHAT_TITLE_CHARS - 1)}…` : single;
    }
  }
  return '';
}
