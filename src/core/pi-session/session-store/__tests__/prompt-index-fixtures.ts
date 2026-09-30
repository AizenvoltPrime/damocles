import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_MID_STREAM_ENTRY } from '../constants';

const user = (id: string, text: string): SessionEntry =>
  ({ id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }) as unknown as SessionEntry;
const assistant = (id: string, text: string): SessionEntry =>
  ({ id, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as unknown as SessionEntry;

const midStreamMarker = (id: string, userEntryId: string): SessionEntry =>
  ({ id, type: 'custom', customType: DAMOCLES_MID_STREAM_ENTRY, data: { userEntryId } }) as unknown as SessionEntry;

/**
 * A stored conversation holding three typed prompts (`u0`, `u1`, `u2`) and a compaction after the
 * second. During the third run come a mid-stream queued batch (`u-ms`) and a cancel note (`u-note`),
 * both marked and consuming no index, and a cancel note written before notes were marked
 * (`u-note-legacy`), which is prompt 3. The next prompt appended to it is prompt 4.
 */
export const STORED_CONVERSATION: readonly SessionEntry[] = [
  user('u0', 'first prompt'),
  assistant('a0', 'first answer'),
  user('u1', 'second prompt'),
  assistant('a1', 'second answer'),
  { id: 'c1', type: 'compaction', summary: 'the summary', tokensBefore: 1234, timestamp: '2026-06-20T20:22:57.439Z' } as unknown as SessionEntry,
  user('u2', 'third prompt'),
  assistant('a2-start', 'working'),
  user('u-ms', 'queued while streaming'),
  midStreamMarker('ms-1', 'u-ms'),
  assistant('a2-batch', 'batch read'),
  user('u-note-legacy', 'the build hung, skip it'),
  assistant('a2-legacy-note', 'legacy note read'),
  user('u-note', 'the tests hung, skip them'),
  midStreamMarker('ms-2', 'u-note'),
  assistant('a2', 'third answer'),
];
export const STORED_PROMPT_COUNT = 4;

/** A fork made by rewinding to the second prompt: the branch ends at that prompt's parent. */
export const FORK_AT_SECOND_PROMPT: readonly SessionEntry[] = STORED_CONVERSATION.slice(0, 2);
export const FORK_PROMPT_COUNT = 1;

/** `branch` with the prompt `id` and its answer appended, as pi commits them. */
export function withPrompt(branch: readonly SessionEntry[], id: string, text: string): SessionEntry[] {
  return [...branch, user(id, text), assistant(`${id}-answer`, 'answer')];
}
