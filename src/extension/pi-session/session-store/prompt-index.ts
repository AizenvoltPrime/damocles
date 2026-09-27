import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CANCEL_NOTE_DETAIL_KEY } from '../../../shared/types/session';
import { extractMidStreamEntryIds } from './mid-stream';

/**
 * The one definition of a prompt, used by the live session and the history loader alike: a user
 * message entry on the active branch other than one delivered mid-run (a queued batch or a cancel
 * note, both marked through `extractMidStreamEntryIds`). An entry's index is the number of prompts
 * before it. Counted from the root, so the prompts a compaction hid keep their indices and an index
 * never repeats along one branch.
 */
export function promptTest(branch: readonly SessionEntry[]): (entry: SessionEntry) => boolean {
  const midStream = extractMidStreamEntryIds(branch);
  return (entry) =>
    entry.type === 'message' &&
    (entry as { message?: { role?: string } }).message?.role === 'user' &&
    !midStream.has(entry.id);
}

/** The index the next prompt appended to `branch` receives. */
export function nextPromptIndex(branch: readonly SessionEntry[]): number {
  const isPrompt = promptTest(branch);
  let count = 0;
  for (const entry of branch) if (isPrompt(entry)) count++;
  return count;
}

/**
 * Whether a run dispatched on `branch` with `prompt` is one a cancel note started: `prompt` is the note
 * recorded on a cancelled call that no user message has followed yet. Such a run belongs to the prompt
 * the note annotates, `nextPromptIndex(branch) - 1`, and consumes no index of its own.
 */
export function isCancelNoteDispatch(branch: readonly SessionEntry[], prompt: string): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== 'message') continue;
    const message = entry.message as { role?: string; details?: unknown };
    if (message.role === 'user') return false;
    if (message.role === 'toolResult' && (message.details as Record<string, unknown> | undefined)?.[CANCEL_NOTE_DETAIL_KEY] === prompt) return true;
  }
  return false;
}
