/**
 * steer.ts — Shared contract for steering messages injected into a running subagent.
 *
 * A steering message (from the user's `/steer` command or the model's `SteerSubagent` tool) is injected
 * into the subagent's conversation as a user message, tagged with `STEER_INSTRUCTION_PREFIX`. The
 * steering protocol in each agent's system prompt (`STEERING_PROTOCOL_BLOCK`) makes a marked message win
 * over any instruction it conflicts with while the rest of the task stands. Stored sessions carry the
 * marker, so it never changes. It is stripped for UI display, since the overlay labels the message as steering.
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

/** A question a design chat's subagent asked the user, as its parent, the designer, learns of it. */
export interface UserAnswerNote {
  question: string;
  answer: string;
  /** The note the user added to the answer. */
  notes?: string;
  /** The design decision the answer recorded. */
  decisionId?: string;
  /** The current decisions the recorded answer conflicts with, which the parent resolves. */
  conflicts?: string[];
  /** What the user typed or noted is on the design chat's branch, where RecordDecision can quote it. */
  wordsOnRecord?: boolean;
}

/**
 * Parent-facing prefix noting each question a subagent asked the user mid-task, read by the same paths as
 * `formatUserSteerPrefix`. The user's text is JSON-quoted, so no line of it can open a line of the result.
 */
export function formatUserAnswerPrefix(answers: readonly UserAnswerNote[] | undefined): string {
  if (!answers?.length) return '';
  return answers.map((note) => {
    const said = `${JSON.stringify(note.question)} → ${JSON.stringify(note.answer)}${note.notes ? ` with the note ${JSON.stringify(note.notes)}` : ''}`;
    const recorded = note.decisionId ? `recorded as ${note.decisionId}${note.conflicts?.length ? `, which conflicts with ${note.conflicts.join(', ')}` : ''}` : 'not recorded as a decision';
    const words = note.wordsOnRecord ? '; the user\'s words are on this design chat\'s record, so you can record what they decided with RecordDecision, quoting them (source kind "chat")' : '';
    return `[The user answered a question mid-task: ${said}, ${recorded}${words}]`;
  }).join('\n') + '\n';
}

/** The team counterpart of `formatUserSteerPrefix`, prefixed onto a team's result. */
export function formatTeamUserSteerPrefix(steers: ReadonlyArray<UserSteerNote & { memberName: string }>): string {
  if (!steers.length) return '';
  return steers.map((note) => `[User steered team member "${note.memberName}" mid-task: ${describeUserSteer(note, rawQuote)}]`).join('\n') + '\n';
}
