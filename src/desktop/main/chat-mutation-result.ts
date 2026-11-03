import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import { englishText, type LocalizedText } from '../../shared/localized-text';
import type { ChatMutationResult } from '../preload/shell-channels';

export interface ChatMutationDeps {
  readonly log: (line: string) => void;
  readonly t: (message: string, ...args: string[]) => string;
  readonly render: (text: LocalizedText) => string;
  readonly error: (message: string) => void;
  // tells the user the chat no longer exists
  readonly missing: () => ChatMutationResult;
}

/** A catalog result as the shell's: the log line is English, and every refusal reaches the user as exactly one toast (core shows the lease one). */
export function chatMutationResult(result: CatalogResult, failure: string, deps: ChatMutationDeps): ChatMutationResult {
  if (result.ok) return { ok: true };
  if (result.reason === 'leased') return { ok: false, reason: 'leased' };
  if (!('message' in result)) return deps.missing();
  deps.log(`[chats] ${failure} ${result.reason}: ${englishText(result.message)}`);
  // An invalid request's message is the user's to read; a failure's is error detail.
  const message = deps.render(result.message);
  deps.error(result.reason === 'invalid' ? message : deps.t('Damocles could not change the session: {0}', message));
  return { ok: false, reason: 'failed' };
}
