import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SystemMessage } from '@earendil-works/pi-ai';
import { MODEL_SECTION } from './system-prompt';
import { loadPiAi } from './pi-loader';
import { log } from '../logger';

/** pi-ai's replay of system messages into one, the fold pi's own compaction applies at its boundary. */
type CurrentSystemMessage = (messages: readonly AgentMessage[]) => SystemMessage | undefined;

const isSystemMessage = (message: AgentMessage): message is SystemMessage => message.role === 'system';

/**
 * The index of the latest system message after the first that sets `MODEL_SECTION` to a text other than the last one it
 * held. A removal (`null`) is no switch, nor is the section's return with the text it held before the removal.
 */
function latestModelSwitch(messages: readonly AgentMessage[]): number | undefined {
  let held: string | undefined;
  let anchor: number | undefined;
  messages.forEach((message, index) => {
    const model = isSystemMessage(message) ? message.sections?.[MODEL_SECTION] : undefined;
    if (typeof model !== 'string' || model === held) return;
    if (index > 0) anchor = index;
    held = model;
  });
  return anchor;
}

/**
 * The request transcript with every system message up to the latest model switch folded into the leading one, or
 * undefined when no switch followed it. pi patches a changed section mid-conversation, which reaches Anthropic after the
 * user's message; a switch starts a new prompt cache anyway, so the new model reads its prompt, its identity included, as
 * the leading system prompt. The fold point moves only at the next switch, so the cached prefix holds for an unchanged
 * model, and a later section change still arrives as pi's patch. `MODEL_SECTION` must change only with the chat's model:
 * any other change to its text re-folds the whole prompt.
 */
export function foldThroughModelSwitch(messages: readonly AgentMessage[], currentSystemMessage: CurrentSystemMessage): AgentMessage[] | undefined {
  if (messages[0]?.role !== 'system') return undefined;
  const anchor = latestModelSwitch(messages);
  if (anchor === undefined) return undefined;
  const folded = messages.slice(0, anchor + 1);
  const head = currentSystemMessage(folded);
  if (!head) return undefined;
  return [head, ...folded.filter((message) => !isSystemMessage(message)), ...messages.slice(anchor + 1)];
}

/** Registers the fold on every model request of the sessions this extension serves. */
export function registerModelSwitchPromptFold(pi: ExtensionAPI): void {
  pi.on('context_with_system', async (event) => {
    try {
      const piAi = await loadPiAi();
      if (!piAi) return undefined;
      const messages = foldThroughModelSwitch(event.messages, (folded) => piAi.getCurrentSystemMessage(folded as Parameters<typeof piAi.getCurrentSystemMessage>[0]));
      return messages ? { messages } : undefined;
    } catch (err) {
      log('[ModelSwitchPrompt] fold failed, sending pi\'s transcript: %O', err);
      return undefined;
    }
  });
}
