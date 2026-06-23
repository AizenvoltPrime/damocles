import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  extractText,
  extractImages,
  piMessageText,
  lastUserEntry,
  turnExchangeAfter,
  firstExchangeForTitle,
} from '../branch-text';

/**
 * Pure branch/content helpers extracted from pi-session.ts. Fabricated branch/message shapes drive
 * each helper directly — the same data pi's SessionManager hands back.
 */

/** A minimal `AgentSession` whose `sessionManager.getBranch(leaf)` returns the given branch. */
function fakeSession(branch: unknown[]): AgentSession {
  return {
    sessionManager: {
      getLeafId: () => 'leaf',
      getBranch: () => branch,
    },
  } as unknown as AgentSession;
}

const userEntry = (id: string, content: unknown) => ({ type: 'message', id, message: { role: 'user', content } });
const assistantEntry = (id: string, content: unknown) => ({ type: 'message', id, message: { role: 'assistant', content } });
const customEntry = (id: string) => ({ type: 'custom_message', id, customType: 'x', content: 'hidden' });

describe('extractText', () => {
  it('passes a string through unchanged', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('joins text blocks with newlines, dropping non-text blocks', () => {
    const out = extractText([
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } },
      { type: 'text', text: 'b' },
    ]);
    expect(out).toBe('a\nb');
  });

  it('returns empty string for an array with no text blocks', () => {
    expect(extractText([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }])).toBe('');
  });
});

describe('extractImages', () => {
  it('returns [] for a plain string', () => {
    expect(extractImages('no images')).toEqual([]);
  });

  it('maps image blocks to pi ImageContent and drops text blocks', () => {
    const out = extractImages([
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ]);
    expect(out).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
  });
});

describe('piMessageText', () => {
  it('passes a string through', () => {
    expect(piMessageText('plain')).toBe('plain');
  });

  it('joins text blocks with spaces, ignoring tool/other blocks', () => {
    expect(
      piMessageText([
        { type: 'text', text: 'one' },
        { type: 'toolCall', name: 'read', arguments: {} },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one two');
  });

  it('returns "" for a non-array, non-string value', () => {
    expect(piMessageText(undefined)).toBe('');
    expect(piMessageText(null)).toBe('');
    expect(piMessageText({ type: 'text', text: 'x' })).toBe('');
  });
});

describe('lastUserEntry', () => {
  it('returns the last user-role entry (id + joined text), scanning from the end', () => {
    const session = fakeSession([
      userEntry('u1', 'first'),
      assistantEntry('a1', [{ type: 'text', text: 'reply' }]),
      userEntry('u2', [{ type: 'text', text: 'second' }]),
      assistantEntry('a2', [{ type: 'text', text: 'reply2' }]),
    ]);
    expect(lastUserEntry(session)).toEqual({ id: 'u2', text: 'second' });
  });

  it('returns null when the branch has no user message', () => {
    expect(lastUserEntry(fakeSession([assistantEntry('a1', [{ type: 'text', text: 'x' }])]))).toBeNull();
  });
});

describe('turnExchangeAfter', () => {
  it('joins every message after the prior user boundary (advances past priorUserEntryId)', () => {
    const session = fakeSession([
      userEntry('u1', 'old prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'old answer' }]),
      userEntry('u2', 'new prompt'),
      assistantEntry('a2', [{ type: 'text', text: 'new answer' }]),
    ]);
    // Starts AFTER the u1 entry → the prior assistant answer + the new prompt/answer are included;
    // the old user prompt (u1) is excluded.
    expect(turnExchangeAfter(session, 'u1')).toEqual({
      userText: 'new prompt',
      assistantText: 'old answer\n\nnew answer',
    });
  });

  it('with the boundary at the latest user entry, returns only the trailing assistant rounds', () => {
    const session = fakeSession([
      userEntry('u1', 'old prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'old answer' }]),
      userEntry('u2', 'new prompt'),
      assistantEntry('a2', [{ type: 'text', text: 'new answer' }]),
    ]);
    // No NEW user committed after u2 → null (no agent turn recorded).
    expect(turnExchangeAfter(session, 'u2')).toBeNull();
  });

  it('joins multiple mid-turn steers and synthesis rounds separately', () => {
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      userEntry('u2', 'steer'),
      assistantEntry('a1', [{ type: 'text', text: 'round one' }]),
      assistantEntry('a2', [{ type: 'text', text: 'round two' }]),
    ]);
    expect(turnExchangeAfter(session, null)).toEqual({
      userText: 'prompt\n\nsteer',
      assistantText: 'round one\n\nround two',
    });
  });

  it('skips custom_message entries (subagent results / plan-mode nudge)', () => {
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      customEntry('c1'),
      assistantEntry('a1', [{ type: 'text', text: 'answer' }]),
    ]);
    expect(turnExchangeAfter(session, null)).toEqual({ userText: 'prompt', assistantText: 'answer' });
  });

  it('returns null when no new user message was committed past the boundary', () => {
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'answer' }]),
    ]);
    expect(turnExchangeAfter(session, 'u1')).toBeNull();
  });

  it('scans the whole branch when priorUserEntryId is unknown (findIndex → -1, start stays 0)', () => {
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'answer' }]),
    ]);
    // A stale/unknown id isn't found, so start stays at 0 and the full branch is walked.
    expect(turnExchangeAfter(session, 'does-not-exist')).toEqual({ userText: 'prompt', assistantText: 'answer' });
  });
});

describe('firstExchangeForTitle', () => {
  it('formats the first user + assistant exchange', () => {
    const session = fakeSession([
      userEntry('u1', 'do the thing'),
      assistantEntry('a1', [{ type: 'text', text: 'on it' }]),
    ]);
    expect(firstExchangeForTitle(session)).toBe('User: do the thing\n\nAssistant: on it');
  });

  it('truncates very long user/assistant text to 2000 chars each', () => {
    const longUser = 'u'.repeat(5000);
    const longAssistant = 'a'.repeat(5000);
    const session = fakeSession([
      userEntry('u1', longUser),
      assistantEntry('a1', [{ type: 'text', text: longAssistant }]),
    ]);
    const out = firstExchangeForTitle(session)!;
    expect(out).toBe(`User: ${'u'.repeat(2000)}\n\nAssistant: ${'a'.repeat(2000)}`);
  });

  it('returns null when there is no user message', () => {
    expect(firstExchangeForTitle(fakeSession([assistantEntry('a1', [{ type: 'text', text: 'x' }])]))).toBeNull();
  });

  it('formats a user-only exchange (no assistant yet) with an empty assistant half', () => {
    const session = fakeSession([userEntry('u1', 'just asked')]);
    expect(firstExchangeForTitle(session)).toBe('User: just asked\n\nAssistant: ');
  });
});
