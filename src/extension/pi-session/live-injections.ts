import {
  emptyLiveInjections,
  isContextInjectionDetails,
  type LiveInjections,
} from '../memory/injection/details';

/** customType marking the per-prompt context injection so the webview adapter can suppress it. */
export const CONTEXT_INJECTION_CUSTOM_TYPE = 'damocles-context-injection';

/**
 * Fold the injection messages of a session projection (exactly what the model will be sent) into
 * the memories, profile and Compass status it already carries. Reads `details` only, never the text,
 * because a memory quoting another id would otherwise make that id look injected. Messages without
 * valid details (other custom types, sessions recorded before details existed) are ignored.
 */
export function readLiveInjections(messages: readonly unknown[]): LiveInjections {
  const live = emptyLiveInjections();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const m = message as { role?: unknown; customType?: unknown; details?: unknown };
    if (m.role !== 'custom' || m.customType !== CONTEXT_INJECTION_CUSTOM_TYPE) continue;
    if (!isContextInjectionDetails(m.details)) continue;
    const details = m.details;
    for (const notice of details.notices) {
      if (notice.kind !== 'edited') live.memories.delete(notice.id);
    }
    for (const item of details.memories) {
      const existing = live.memories.get(item.id);
      if (existing?.tier === 'full' && item.tier === 'compact') continue;
      live.memories.set(item.id, { hash: item.hash, tier: item.tier, promptIndex: details.promptIndex });
    }
    if (details.profile) live.profileInContext = true;
    if (details.compassKey !== null) live.compassKey = details.compassKey;
  }
  return live;
}
