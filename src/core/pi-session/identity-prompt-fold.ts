import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SystemMessage } from '@earendil-works/pi-ai';
import { ENVIRONMENT_SECTION, MODEL_SECTION, PI_CWD_SECTION } from './system-prompt';
import { loadPiAi } from './pi-loader';
import { log } from '../logger';

/** pi-ai's replay of system messages into one, the fold pi's own compaction applies at its boundary. */
type CurrentSystemMessage = (messages: readonly AgentMessage[]) => SystemMessage | undefined;

/** The sections the model must read as ground truth: the chat's model and the environment it works in. Each must change only with that fact, since any change re-folds the whole prompt. */
export const IDENTITY_SECTIONS: readonly string[] = [MODEL_SECTION, PI_CWD_SECTION, ENVIRONMENT_SECTION];

const isSystemMessage = (message: AgentMessage): message is SystemMessage => message.role === 'system';

/**
 * The index of the latest system message after the first that sets an identity section to a text other than the last one
 * that section held. A removal (`null`) is no change, nor is a section's return with the text it held before the removal.
 */
function latestIdentityChange(messages: readonly AgentMessage[]): number | undefined {
  const held = new Map<string, string>();
  let anchor: number | undefined;
  messages.forEach((message, index) => {
    if (!isSystemMessage(message)) return;
    for (const name of IDENTITY_SECTIONS) {
      const text = message.sections?.[name];
      if (typeof text !== 'string' || text === held.get(name)) continue;
      if (index > 0) anchor = index;
      held.set(name, text);
    }
  });
  return anchor;
}

/**
 * The request transcript with every system message up to the latest identity change folded into the leading one, or
 * undefined when no change followed it. See docs/invariants.md "An identity change reaches the model in its leading system prompt".
 */
export function foldThroughIdentityChange(messages: readonly AgentMessage[], currentSystemMessage: CurrentSystemMessage): AgentMessage[] | undefined {
  if (messages[0]?.role !== 'system') return undefined;
  const anchor = latestIdentityChange(messages);
  if (anchor === undefined) return undefined;
  const folded = messages.slice(0, anchor + 1);
  const head = currentSystemMessage(folded);
  if (!head) return undefined;
  return [head, ...folded.filter((message) => !isSystemMessage(message)), ...messages.slice(anchor + 1)];
}

/** Registers the fold on every model request of the sessions this extension serves. */
export function registerIdentityPromptFold(pi: ExtensionAPI): void {
  pi.on('context_with_system', async (event) => {
    try {
      const piAi = await loadPiAi();
      if (!piAi) return undefined;
      const messages = foldThroughIdentityChange(event.messages, (folded) => piAi.getCurrentSystemMessage(folded as Parameters<typeof piAi.getCurrentSystemMessage>[0]));
      return messages ? { messages } : undefined;
    } catch (err) {
      log('[IdentityPromptFold] fold failed, sending pi\'s transcript: %O', err);
      return undefined;
    }
  });
}
