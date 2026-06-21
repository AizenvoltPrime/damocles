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

/**
 * pi custom-entry recording the user's ORIGINAL typed input for a turn whose persisted user message
 * diverges from it. Two mechanisms expand a slash command to the body that lands on disk: pi itself
 * expands prompt templates (`/example`) inside `prompt()`, and Damocles' chat-handlers rewrites skills
 * (`/simplify` → "Execute skill simplify") and `/init` (→ a long prompt) before `sendMessage`. Either
 * way the persisted `UserMessage` (which has no slot for the original) holds the expansion, so a
 * reloaded transcript, the up-arrow history, and the session-list preview would otherwise show the
 * expanded body instead of what the user typed. Keyed to the pi user entry by `{ userEntryId, original }`.
 * Inert in LLM context; the history loader skips it.
 */
export const DAMOCLES_ORIGINAL_INPUT_ENTRY = 'damocles-original-input';
