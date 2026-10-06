import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { PromptOwner } from '../../shared/types/permissions';

/** Derived from the message so the derivation can never drift from what the webview reads. */
export type SessionState = Extract<ExtensionToWebviewMessage, { type: 'sessionStateChanged' }>['state'];

/** What an unanswered prompt asks of the user; `input` covers forms, MCP elicitations and extension UI dialogs. */
export type PendingKind = 'approval' | 'question' | 'plan' | 'input';

/** One unanswered prompt, for attention routing; a notification keys on `id`, so one prompt notifies once. */
export interface PendingPrompt {
  /** Stable while the prompt is pending (its tool use id, or the dialog id for an `input` prompt). */
  readonly id: string;
  readonly kind: PendingKind;
  readonly owner: PromptOwner;
  /** One line describing the prompt, capped at `PROMPT_SUMMARY_MAX_CHARS`, e.g. "edit src/a.ts (+7 −2)" or the question. */
  readonly summary?: string;
}

/** An unanswered prompt as its holder keeps it: the message it was posted with. */
export interface RaisedPrompt {
  readonly id: string;
  readonly kind: PendingKind;
  readonly request: ExtensionToWebviewMessage;
}

export interface ChatActivity {
  readonly state: SessionState;
  /** Sorted and deduped; non-empty exactly when `state` is `requires_action`. */
  readonly pendingKinds: readonly PendingKind[];
  /** Every unanswered prompt, the permission prompts then the host dialogs, each in the order raised; its kinds are exactly `pendingKinds`. */
  readonly pendingPrompts: readonly PendingPrompt[];
  /** A subagent or team run has not settled. */
  readonly background: boolean;
}

export type TurnOutcome =
  | { readonly kind: 'completed'; readonly durationMs?: number }
  | { readonly kind: 'error'; readonly message?: string }
  | { readonly kind: 'budget' }
  /** The window fields name the full subscription window a usage refresh found after the error (D55), and are absent when it found none. */
  | {
      readonly kind: 'rateLimit';
      /** As `UsageThresholdCrossing.windowId`. */
      readonly windowId?: string;
      /** As `UsageThresholdCrossing.windowLabel`, e.g. "Session (5hr)" or "Weekly". */
      readonly windowLabel?: string;
      /** Epoch ms. */
      readonly resetsAt?: number;
    }
  | { readonly kind: 'cancelled' };

/** What the turn's own lifecycle says on its own, before any pending prompt is taken into account. */
export type TurnState = Exclude<SessionState, 'requires_action'>;

/** A turn lifecycle move; a turn going idle always says how it ended. */
export type TurnChange = readonly ['running'] | readonly ['idle', TurnOutcome];

/**
 * The session state the webview shows. A pending prompt outranks the turn lifecycle unconditionally,
 * including when no turn is in flight, because a prompt nobody has answered is the thing the user has
 * to act on either way.
 */
export function deriveSessionState(turn: TurnState, pendingPrompts: boolean): SessionState {
  return pendingPrompts ? 'requires_action' : turn;
}

// The rate-limit wording of pi-ai's retry classifier (`utils/retry.js`); provider errors carry no structured status.
const RATE_LIMIT_ERROR = /rate.?limit|too many requests|\b429\b|usage.?limit/i;

/** How a turn that ended on the provider or prompt error `message` settled. */
export function turnOutcomeOfError(message: string): TurnOutcome {
  return RATE_LIMIT_ERROR.test(message) ? { kind: 'rateLimit' } : { kind: 'error', message };
}
