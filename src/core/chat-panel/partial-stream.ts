/**
 * A streaming `partial` carries its stream's whole text so far, so a newer one of the same key replaces an older one: the key is
 * its stream (parentToolUseId and messageId) and its field set. undefined for any other message.
 */
export function partialStreamKey(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { type, parentToolUseId, data } = message as { type?: unknown; parentToolUseId?: unknown; data?: unknown };
  if (type !== "partial" || typeof data !== "object" || data === null) return undefined;
  return JSON.stringify([parentToolUseId ?? null, (data as { messageId?: unknown }).messageId ?? null, Object.keys(data).sort()]);
}
