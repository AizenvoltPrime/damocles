import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

/** Derived from the message so the derivation can never drift from what the webview reads. */
export type SessionState = Extract<ExtensionToWebviewMessage, { type: 'sessionStateChanged' }>['state'];

/** What the turn's own lifecycle says on its own, before any pending prompt is taken into account. */
export type TurnState = Exclude<SessionState, 'requires_action'>;

/**
 * The session state the webview shows. A pending prompt outranks the turn lifecycle unconditionally,
 * including when no turn is in flight, because a prompt nobody has answered is the thing the user has
 * to act on either way.
 */
export function deriveSessionState(turn: TurnState, pendingPrompts: boolean): SessionState {
  return pendingPrompts ? 'requires_action' : turn;
}
