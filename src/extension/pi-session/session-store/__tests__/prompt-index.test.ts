import { describe, it, expect } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CANCEL_NOTE_DETAIL_KEY, CANCELLED_TOOL_DETAIL_KEY } from '../../../../shared/types/session';
import { isCancelNoteDispatch, nextPromptIndex } from '../prompt-index';
import { reconstructMessages } from '../history-loader';
import { FORK_AT_SECOND_PROMPT, STORED_CONVERSATION, STORED_PROMPT_COUNT, withPrompt } from './prompt-index-fixtures';

/** The index a reload stamps on each replayed user row, keyed by entry id; undefined for a non-prompt. */
function reloadIndices(branch: readonly SessionEntry[]): Map<string, number | undefined> {
  const indices = new Map<string, number | undefined>();
  for (const message of reconstructMessages(branch).messages) {
    if (message.kind === 'user') indices.set(message.entryId, message.promptIndex);
  }
  return indices;
}

describe('prompt index', () => {
  // The live session stamps a new prompt with `nextPromptIndex` of the branch it extends; a reload stamps
  // it from the branch that holds it. The two must agree for every record keyed by the index.
  it.each([
    ['an empty branch', [] as SessionEntry[]],
    ['a fork', [...FORK_AT_SECOND_PROMPT]],
    ['a compacted conversation with mid-run deliveries', [...STORED_CONVERSATION]],
  ])('gives the next prompt on %s the index a reload stamps on it', (_label, branch) => {
    expect(reloadIndices(withPrompt(branch, 'u-new', 'next')).get('u-new')).toBe(nextPromptIndex(branch));
  });

  it('counts a cancel note written before notes were marked, and no marked mid-run delivery', () => {
    const indices = reloadIndices(STORED_CONVERSATION);
    expect(indices.get('u2')).toBe(2);
    expect(indices.get('u-note-legacy')).toBe(3);
    expect(indices.has('u-ms')).toBe(true);
    expect(indices.get('u-ms')).toBeUndefined();
    expect(indices.get('u-note')).toBeUndefined();
    expect(nextPromptIndex(STORED_CONVERSATION)).toBe(STORED_PROMPT_COUNT);
  });
});

describe('a run a cancel note starts', () => {
  const NOTE = 'skip it';
  const cancelledCall = (note: string | undefined): SessionEntry[] => [
    { id: 'a-call', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'powershell', arguments: {} }] } },
    {
      id: 'tr-call',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'Command aborted' }],
        details: { [CANCELLED_TOOL_DETAIL_KEY]: true, ...(note ? { [CANCEL_NOTE_DETAIL_KEY]: note } : {}) },
      },
    },
    { id: 'a-reply', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'I will wait for your reason.' }] } },
  ] as unknown as SessionEntry[];
  const branch = [...STORED_CONVERSATION, ...cancelledCall(NOTE)];

  it('is dispatched with the note of a cancelled call nothing has answered, and belongs to the prompt that ran it', () => {
    expect(isCancelNoteDispatch(branch, NOTE)).toBe(true);
    // The prompt whose run held the call is the last one on the branch.
    expect(nextPromptIndex(branch) - 1).toBe(STORED_PROMPT_COUNT - 1);
  });

  it('is not a prompt with other text, nor a cancel that carried no note', () => {
    expect(isCancelNoteDispatch(branch, 'ok, continue')).toBe(false);
    expect(isCancelNoteDispatch([...STORED_CONVERSATION, ...cancelledCall(undefined)], NOTE)).toBe(false);
  });

  it('is not a later prompt with the same text once the note has been delivered', () => {
    const delivered = withPrompt(branch, 'u-note-run', NOTE);
    expect(isCancelNoteDispatch(delivered, NOTE)).toBe(false);
  });
});
