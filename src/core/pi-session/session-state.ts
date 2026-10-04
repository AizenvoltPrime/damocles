import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

/** Derived from the message so the derivation can never drift from what the webview reads. */
export type SessionState = Extract<ExtensionToWebviewMessage, { type: 'sessionStateChanged' }>['state'];

/** What an unanswered prompt asks of the user; `input` covers forms, MCP elicitations and extension UI dialogs. */
export type PendingKind = 'approval' | 'question' | 'plan' | 'input';

export interface ChatActivity {
  readonly state: SessionState;
  /** Sorted and deduped; non-empty exactly when `state` is `requires_action`. */
  readonly pendingKinds: readonly PendingKind[];
  /** A subagent or team run has not settled. */
  readonly background: boolean;
}

export type TurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'error'; readonly message?: string }
  | { readonly kind: 'budget' }
  | { readonly kind: 'rateLimit'; readonly resetsAt?: number }
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
