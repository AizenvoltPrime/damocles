import type { StoreContext } from "../types";

type Retry = { attempt: number; maxAttempts: number };

/** The transcript and status line of the nested agent a failed-call message names. */
export interface NestedTranscript {
  addError: (message: string) => void;
  retract: (messageId: string) => void;
  setRetry: (retry: Retry | null) => void;
}

/**
 * A failed-call message's `parentToolUseId` names a subagent card by its `Agent` call id or a team agent
 * by its id. Null when no transcript holds it: such a message is dropped, never shown in the main chat.
 */
export function nestedTranscript(stores: StoreContext, owner: string): NestedTranscript | null {
  const { subagentStore, teamStore } = stores;
  if (subagentStore.hasSubagent(owner)) {
    return {
      addError: (message) => subagentStore.addSubagentError(owner, message),
      retract: (messageId) => subagentStore.retractSubagentMessage(owner, messageId),
      setRetry: (retry) => subagentStore.setSubagentRetry(owner, retry),
    };
  }
  if (teamStore.hasAgent(owner)) {
    return {
      addError: (message) => teamStore.handleAgentError(owner, message),
      retract: (messageId) => teamStore.retractAgentMessage(owner, messageId),
      setRetry: (retry) => teamStore.setAgentRetry(owner, retry),
    };
  }
  return null;
}
