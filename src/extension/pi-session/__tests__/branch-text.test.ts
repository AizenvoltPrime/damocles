import { describe, it, expect } from 'vitest';
import * as path from 'path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  extractText,
  extractImages,
  piMessageText,
  turnExchangeFrom,
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
const CWD = path.resolve('/ws/current');
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

describe('turnExchangeFrom', () => {
  it('starts at the prompt entry, so the answer before it is not part of this exchange', () => {
    const session = fakeSession([
      userEntry('u1', 'old prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'old answer' }]),
      userEntry('u2', 'new prompt'),
      assistantEntry('a2', [{ type: 'text', text: 'new answer' }]),
    ]);
    expect(turnExchangeFrom(session, 'u2', CWD)).toEqual({ userText: 'new prompt', assistantText: 'new answer', files: [] });
  });

  it('joins the mid-turn steers and notes committed after the prompt, and every synthesis round', () => {
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'round one' }]),
      userEntry('u2', 'steer'),
      assistantEntry('a2', [{ type: 'text', text: 'round two' }]),
    ]);
    expect(turnExchangeFrom(session, 'u1', CWD)).toEqual({
      userText: 'prompt\n\nsteer',
      assistantText: 'round one\n\nround two',
      files: [],
    });
  });

  it('skips custom_message entries (subagent results / plan-mode nudge)', () => {
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      customEntry('c1'),
      assistantEntry('a1', [{ type: 'text', text: 'answer' }]),
    ]);
    expect(turnExchangeFrom(session, 'u1', CWD)).toEqual({ userText: 'prompt', assistantText: 'answer', files: [] });
  });

  it('returns null when the entry is not on the branch', () => {
    const session = fakeSession([userEntry('u1', 'prompt'), assistantEntry('a1', [{ type: 'text', text: 'answer' }])]);
    expect(turnExchangeFrom(session, 'does-not-exist', CWD)).toBeNull();
  });
});

describe('turnExchangeFrom files', () => {
  const toolCall = (args: Record<string, unknown>) => ({ type: 'toolCall', id: 't', name: 'Edit', arguments: args });

  it('collects path and file_path tool-call arguments, resolving relative paths against cwd', () => {
    const other = path.resolve('/other/repo/src/gpu.ts');
    const session = fakeSession([
      userEntry('u1', 'prompt'),
      assistantEntry('a1', [{ type: 'text', text: 'editing' }, toolCall({ file_path: other }), toolCall({ path: 'src/a.ts' })]),
      assistantEntry('a2', [toolCall({ file_path: other }), toolCall({ command: 'ls' })]),
    ]);
    expect(turnExchangeFrom(session, 'u1', CWD)!.files).toEqual([other, path.resolve(CWD, 'src/a.ts')]);
  });

  it('caps the list at 20 files', () => {
    const calls = Array.from({ length: 30 }, (_, i) => toolCall({ path: `f${i}.ts` }));
    const session = fakeSession([userEntry('u1', 'prompt'), assistantEntry('a1', calls)]);
    expect(turnExchangeFrom(session, 'u1', CWD)!.files).toHaveLength(20);
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
