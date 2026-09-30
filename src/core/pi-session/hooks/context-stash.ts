/**
 * PreToolUse `additionalContext` waiting to be delivered on its tool's result. pi's `tool_call` return
 * can only block (not inject context), so a hook's context is carried to the PostToolUse path keyed by
 * `toolCallId`. Each entry is tagged with its owning session so a turn-boundary sweep can drop orphans —
 * a tool that proceeded but whose `tool_result` never arrived (turn aborted post-approval, session torn
 * down mid-flight) — without touching another concurrent session's pending entries (the primary runtime's
 * stash is process-global across panels; a subagent's stash is local to that one subagent).
 */

interface StashedContext {
  sessionId: string;
  contexts: string[];
}

/** Keyed by `toolCallId`. Written by the gate on a proceed path, drained by the PostToolUse handler. */
export type PreToolUseContextStash = Map<string, StashedContext>;

export function createPreToolUseContextStash(): PreToolUseContextStash {
  return new Map();
}

/** Append a hook's context for `toolCallId`, tagging the owning session for the orphan sweep. */
export function stashPreToolUseContext(
  stash: PreToolUseContextStash,
  sessionId: string,
  toolCallId: string,
  context: string,
): void {
  const existing = stash.get(toolCallId);
  if (existing) existing.contexts.push(context);
  else stash.set(toolCallId, { sessionId, contexts: [context] });
}

/** Read + remove the stashed context for `toolCallId` (the PostToolUse drain). */
export function takePreToolUseContext(stash: PreToolUseContextStash, toolCallId: string): string[] | undefined {
  const entry = stash.get(toolCallId);
  if (!entry) return undefined;
  stash.delete(toolCallId);
  return entry.contexts;
}

/** Drop every entry owned by `sessionId` — the orphan sweep run at that session's turn boundary. */
export function clearSessionPreToolUseContext(stash: PreToolUseContextStash, sessionId: string): void {
  for (const [toolCallId, entry] of stash) {
    if (entry.sessionId === sessionId) stash.delete(toolCallId);
  }
}
