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

/**
 * pi custom-entry marking that the keyed user entry was a delivered mid-stream queued batch — the user
 * queued one or more messages while the agent was streaming and pi committed them as one combined steer
 * entry. Payload `{ userEntryId: string }`. Inert in LLM context (a `CustomEntry`); on reload the
 * webview re-applies the amber "sent mid-stream" styling to that user message. The history loader skips
 * it so it never renders as a chat bubble.
 */
export const DAMOCLES_MID_STREAM_ENTRY = 'damocles-mid-stream';

/**
 * pi custom-entry recording that the user steered a running/queued subagent via `/steer`. Payload
 * `{ agentId, agentType?, description?, message }`. Inert in LLM context (a `CustomEntry`). Unlike the
 * other markers this is a STANDALONE entry keyed to nothing — its position on the branch IS its position
 * in the transcript. The history loader replays it in place as an amber injected "You steered <agent>"
 * chip (consuming no prompt index); it otherwise skips custom entries.
 */
export const DAMOCLES_STEER_ENTRY = 'damocles-steer';
