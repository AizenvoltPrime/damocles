import type { PermissionResult } from './types';
import { FEEDBACK_MARKER } from '../../shared/types/constants';

function rejectionMessage(customMessage: string, fileEditNote: boolean): string {
  const note = fileEditNote ? ' (eg. if it was a file edit, the new_string was NOT written to the file)' : '';
  return `The user doesn't want to proceed with this tool use. The tool use was rejected${note}. ${FEEDBACK_MARKER} ${customMessage}`;
}

/**
 * A deny the user chose at a prompt. An empty feedback box is an unexplained "no": the model has nothing
 * to act on, so it becomes pi's `terminate` and ends the turn. Feedback is instruction, so it does not.
 * These two builders are the ONLY place in Damocles that may set `interrupt` — every other deny path
 * belongs to {@link buildUnaskedDenyResult}.
 */
export function buildUserFileEditDenyResult(customMessage: string | undefined, defaultMessage: string): PermissionResult {
  return {
    behavior: 'deny',
    message: customMessage ? rejectionMessage(customMessage, true) : defaultMessage,
    ...(customMessage ? {} : { interrupt: true }),
  };
}

/** @see buildUserFileEditDenyResult — same contract, without the file-edit wording. */
export function buildUserDenyResult(customMessage: string | undefined, defaultMessage: string): PermissionResult {
  return {
    behavior: 'deny',
    message: customMessage ? rejectionMessage(customMessage, false) : defaultMessage,
    ...(customMessage ? {} : { interrupt: true }),
  };
}

/**
 * A deny nobody was asked about: a settings rule, a missing webview, a missing tool-use id, an abort, or
 * session teardown. Damocles decided this on its own, so it must never end the user's turn — `interrupt`
 * stays ABSENT (not `false`; the repo compiles with `exactOptionalPropertyTypes`). `diagnostic` is what
 * actually happened, never a user quote.
 */
export function buildUnaskedDenyResult(diagnostic: string | undefined, defaultMessage: string): PermissionResult {
  return { behavior: 'deny', message: diagnostic ?? defaultMessage };
}

export function buildAllowResult(input: unknown): PermissionResult {
  return { behavior: 'allow', updatedInput: input };
}
