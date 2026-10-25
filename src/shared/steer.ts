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

/** Tag a raw steer message with the priority marker. An image-only steer is the marker line alone. */
export function wrapSteerMessage(message: string): string {
  return message ? `${STEER_INSTRUCTION_PREFIX}\n${message}` : STEER_INSTRUCTION_PREFIX;
}

const RESUME_CONTEXT =
  'You were stopped before you finished, and you have been resumed. Continue your task from where you left off, at the same depth as before: finish the steps you had planned, then report. Check current state before redoing any step that may have been cut off.';

/** The note's authority over the agent's planned work; every resume and restart prompt with a note states it. */
export const RESUME_NOTE_RULES =
  'The agent that resumed you left the note below; each of its lines is quoted with "> ". Do what the note asks. Where it explicitly changes or replaces a planned step, follow the note. Only an explicit instruction in the note to stop, skip or drop work ends planned work early; a note about how to report or format the result does not shorten the work.';

export const RESUME_NOTE_LABEL = 'Note from the agent that resumed you:';

// Every line is quoted, so no line of the note can open with the steer marker or pose as the label.
const NOTE_LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;

/**
 * `context` (resume text, or the original task on a restart), then the quoted note under its rules. The note is
 * model-written and never a steer, which would give it operator authority over the agent's plan.
 */
export function withResumeNote(context: string, message?: string): string {
  const trimmed = message?.trim();
  if (!trimmed) return context;
  const quoted = trimmed.split(NOTE_LINE_BREAK).map((line) => (line ? `> ${line}` : '>')).join('\n');
  return `${context}\n\n${RESUME_NOTE_RULES}\n\n${RESUME_NOTE_LABEL}\n${quoted}`;
}

/** The prompt that continues a resumed agent. */
export function buildResumePrompt(message?: string): string {
  return withResumeNote(RESUME_CONTEXT, message);
}

/** Remove the priority marker for display (the raw instruction is shown; the UI labels it as steering). */
export function stripSteerPrefix(text: string): string {
  if (!text.startsWith(STEER_INSTRUCTION_PREFIX)) return text;
  return text.slice(STEER_INSTRUCTION_PREFIX.length).replace(/^\r?\n/, '');
}

/** A user `/steer` as the parent or lead learns of it: the images themselves never reach them, only a count. */
export interface UserSteerNote {
  message: string;
  imageCount?: number;
}

/** `quote` renders a non-empty message; an empty one reads `(no text)`, then an image-count suffix if any. */
export function describeUserSteer(note: UserSteerNote, quote: (message: string) => string): string {
  const text = note.message ? quote(note.message) : '(no text)';
  const count = note.imageCount ?? 0;
  if (!count) return text;
  return `${text} (+${count} ${count === 1 ? 'image' : 'images'})`;
}

const rawQuote = (message: string): string => `"${message}"`;

/**
 * Parent-facing prefix noting each user `/steer` on a subagent's consumed result, so the parent knows
 * the operator redirected the subagent mid-task. Empty when no user steers occurred (output unchanged).
 * Single source of truth for both the foreground (`recordResultText`) and background keep-alive paths.
 */
export function formatUserSteerPrefix(userSteers: readonly UserSteerNote[] | undefined): string {
  if (!userSteers?.length) return '';
  return userSteers.map((note) => `[User steered this agent mid-task: ${describeUserSteer(note, rawQuote)}]`).join('\n') + '\n';
}

/** The team counterpart of `formatUserSteerPrefix`, prefixed onto a team's result. */
export function formatTeamUserSteerPrefix(steers: ReadonlyArray<UserSteerNote & { memberName: string }>): string {
  if (!steers.length) return '';
  return steers.map((note) => `[User steered team member "${note.memberName}" mid-task: ${describeUserSteer(note, rawQuote)}]`).join('\n') + '\n';
}
