/**
 * steer.ts — Shared contract for steering messages injected into a running subagent.
 *
 * A steering message (from the user's `/steer` command or the model's `SteerSubagent` tool) is injected
 * into the subagent's conversation as a user message. To make it an unambiguous, absolute-priority
 * mid-task override — rather than a suggestion the subagent can weigh against its original task — every
 * injected steer is tagged with `STEER_INSTRUCTION_PREFIX`, and each subagent's system prompt
 * (`buildAgentPrompt`) declares that a message carrying this marker overrides all prior instructions.
 * The prefix is stripped for UI display, since the overlay already labels the message as steering.
 */

/** Marker that opens every injected steering message; the subagent system prompt grants it top priority. */
export const STEER_INSTRUCTION_PREFIX = '[STEERING INSTRUCTION: ABSOLUTE PRIORITY]';

/** Tag a raw steer message with the priority marker for injection into a subagent session. */
export function wrapSteerMessage(message: string): string {
  return `${STEER_INSTRUCTION_PREFIX}\n${message}`;
}

/** Remove the priority marker for display (the raw instruction is shown; the UI labels it as steering). */
export function stripSteerPrefix(text: string): string {
  if (!text.startsWith(STEER_INSTRUCTION_PREFIX)) return text;
  return text.slice(STEER_INSTRUCTION_PREFIX.length).replace(/^\r?\n/, '');
}

/**
 * Parent-facing prefix noting each user `/steer` on a subagent's consumed result, so the parent knows
 * the operator redirected the subagent mid-task. Empty when no user steers occurred (output unchanged).
 * Single source of truth for both the foreground (`recordResultText`) and background keep-alive paths.
 */
export function formatUserSteerPrefix(userSteers: readonly string[] | undefined): string {
  if (!userSteers?.length) return '';
  return userSteers.map((message) => `[User steered this agent mid-task: "${message}"]`).join('\n') + '\n';
}
