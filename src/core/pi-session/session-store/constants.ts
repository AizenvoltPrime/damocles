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
 * Inert custom entry recorded when a prompt's user entry commits with terminal attachments, keyed by
 * `{ userEntryId, count }`: the stored text starts with `count` attachment blocks (`src/core/terminal-attachment.ts`).
 * Readers strip blocks only for an entry it names. Inert in LLM context; the history loader skips it.
 */
export const DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY = 'damocles-terminal-attachments';

/**
 * pi custom-entry marking that the keyed user entry was delivered mid-run rather than typed as a prompt:
 * either a queued batch (the user queued one or more messages while the agent was streaming and pi
 * committed them as one combined steer entry) or a shell cancel note. Payload `{ userEntryId: string }`.
 * Inert in LLM context (a `CustomEntry`). The marked entry consumes no prompt index, and on reload the
 * webview re-applies the amber "sent mid-stream" styling to it. The history loader skips the marker so
 * it never renders as a chat bubble.
 */
export const DAMOCLES_MID_STREAM_ENTRY = 'damocles-mid-stream';

/**
 * pi custom-entry recording what a Stop cut short, written once the aborted run settles (`turn-stopped.ts`):
 * the tool calls in flight, which the live view marked abandoned, and the error entries pi wrote while
 * winding down, which the live view never showed. Inert in LLM context; the history loader applies it.
 */
export const DAMOCLES_TURN_STOPPED_ENTRY = 'damocles-turn-stopped';

/**
 * Team member session custom-entry `{ ids: string[] }`, appended right after pi commits a delivered team message
 * as a user entry: the delivery ids that message carried, so a resume never redelivers it. Inert in LLM
 * context; the history loader skips it.
 */
export const DAMOCLES_TEAM_DELIVERED_ENTRY = 'damocles-team-delivered';

/**
 * pi custom-entry recording that the user steered a running/queued subagent via `/steer`. Payload
 * `{ agentId, agentType?, description?, message }`. Inert in LLM context (a `CustomEntry`). Unlike the
 * other markers this is a STANDALONE entry keyed to nothing — its position on the branch IS its position
 * in the transcript. The history loader replays it in place as an amber injected "You steered <agent>"
 * chip (consuming no prompt index); it otherwise skips custom entries.
 */
export const DAMOCLES_STEER_ENTRY = 'damocles-steer';

/** Parent-session custom entry: the parent started or resumed a subagent or team. Payloads and readers
 *  for this and the agent-file entries below live in `agent-records.ts`. */
export const DAMOCLES_AGENT_INVOCATION_ENTRY = 'damocles-agent-invocation';

/** Agent-file custom entry: the agent's launch config, the first custom entry of its pi session. */
export const DAMOCLES_AGENT_LAUNCH_ENTRY = 'damocles-agent-launch';
/**
 * A daemon's core, at a run's start when it changed: `{ clientProviders: string[] }`, the providers the run's client holds a
 * credential for. Spend after it on any other provider used the host's own credential (`docs/invariants.md`, "Usage accounting").
 */
export const DAMOCLES_CREDENTIAL_SOURCE_ENTRY = 'damocles-credential-source';
/** Where a chat works (AD12): `{ worktreeId, projectPath, place }`; the latest decides the folder a resume binds to. */
export const DAMOCLES_WORKTREE_ENTRY = 'damocles.worktree';
/** A design chat's role (PD-23): `{ v: 1, designId, folder, parentSessionId | null, ruleSet, title }`; the latest one on the branch decides. */
export const DAMOCLES_DESIGN_ENTRY = 'damocles.design';
/** A parent's link to its design (PD-23): `{ v: 1, designId, folder, parentSessionId, title }`; inert unless `parentSessionId` is the session's own id. */
export const DAMOCLES_DESIGN_LINK_ENTRY = 'damocles.design-link';
/** Parent custom message (display): a delivered design version, `DesignResultView` details; one per `(designId, version)` per branch. */
export const DAMOCLES_DESIGN_RESULT = 'damocles-design-result';
/** Design chat custom message (display): a brief from the parent, `DesignBriefView` details; one per `briefId` per branch. */
export const DAMOCLES_DESIGN_BRIEF = 'damocles-design-brief';
/** Parent custom entry (hidden): the version pause's answer (PD-29), `{ v: 1, designId, fromVersion, toVersion, choice }`; one per `(designId, toVersion)` per branch. */
export const DAMOCLES_DESIGN_VERSION_CHOICE = 'damocles-design-version-choice';
/** Design chat custom entry (hidden): `{ userEntryId, feedbackId }`, the user message a preview's markup was sent as (PD-12). */
export const DAMOCLES_DESIGN_MARKUP_ENTRY = 'damocles.design-markup';
/** Design chat custom entry (hidden): `{ userEntryId, references: [{ id, image, imageIndex }] }`, the user message's images saved as references (PD-40). */
export const DAMOCLES_DESIGN_REFERENCES_ENTRY = 'damocles.design-references';
/** Design chat custom entry (hidden): `{ userEntryId, toolCallId, tweakId, label, property, value }`, a tweak the user kept (PD-13); RecordDecision reads the latest per tweak. */
export const DAMOCLES_DESIGN_TWEAK_KEPT = 'damocles-design-tweak-kept';
/** Parent custom message (hidden): the model's instruction for the version pause's answer, sent after its choice entry. */
export const DAMOCLES_DESIGN_VERSION_INSTRUCTION = 'damocles-design-version-instruction';

/** Agent-file custom entry: a resume starts here; later messages render on that resume call's card. */
export const DAMOCLES_AGENT_SEGMENT_ENTRY = 'damocles-agent-segment';

/** Agent-file custom entry: the agent's terminal status for the current segment. */
export const DAMOCLES_AGENT_STATUS_ENTRY = 'damocles-agent-status';

/** Parent-session hidden custom message listing interrupted agents the model may resume. */
export const DAMOCLES_INTERRUPTION_NOTICE = 'damocles-interruption-notice';
