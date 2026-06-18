/**
 * pi custom-entry type recording a Damocles per-turn checkpoint (US-013). Inert in LLM context
 * (a `CustomEntry`); mirrors the value the checkpoint engine writes via `appendEntry`. The pi
 * history loader skips these so they never render as chat bubbles.
 */
export const DAMOCLES_CHECKPOINT_ENTRY = 'damocles-checkpoint';

/**
 * pi custom-entry marker recording that the user manually renamed the session (US-012). Its presence
 * makes the store map the pi session name to `customTitle` (user rename, outranks an AI title) rather
 * than `aiTitle` (auto-generated). The history loader skips it.
 */
export const DAMOCLES_USER_RENAMED_ENTRY = 'damocles-user-renamed';

/**
 * pi custom-entry holding the session's user tag/label (`{ tag: string | null }`, latest wins; null
 * clears it). Inert in LLM context; the metadata reader folds it into `StoredSession.tag` and the
 * history loader skips it.
 */
export const DAMOCLES_TAG_ENTRY = 'damocles-tag';
