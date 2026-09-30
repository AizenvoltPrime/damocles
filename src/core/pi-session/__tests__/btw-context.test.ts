import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { buildBtwContextBlock, BTW_MAX_CONTEXT_CHARS } from '../btw-context';

/**
 * The `/btw` conversation-snapshot assembly extracted from pi-session.ts. The nontrivial logic is the
 * char-budget eviction: drop OLDEST turns while over budget, then tail-slice (keep NEWEST content) if a
 * single message still exceeds the budget. A fabricated `session.messages` array drives each path.
 */

/** A minimal `AgentSession` whose `.messages` is the given array. */
function fakeSession(messages: unknown[]): AgentSession {
  return { messages } as unknown as AgentSession;
}

const msg = (role: string, content: unknown) => ({ role, content });

describe('buildBtwContextBlock — role filtering + formatting', () => {
  it('keeps only user/assistant turns, labels them, and joins with blank lines', () => {
    const block = buildBtwContextBlock(
      fakeSession([
        msg('user', 'hello'),
        msg('assistant', [{ type: 'text', text: 'hi there' }]),
        msg('toolResult', 'ignored tool output'),
        msg('system', 'ignored system'),
        msg('user', 'follow up'),
      ]),
    );
    expect(block).toBe('User: hello\n\nAssistant: hi there\n\nUser: follow up');
  });

  it('drops messages whose text is blank/whitespace-only', () => {
    const block = buildBtwContextBlock(
      fakeSession([
        msg('user', '   '),
        msg('assistant', [{ type: 'text', text: 'kept' }]),
        msg('user', ''),
      ]),
    );
    expect(block).toBe('Assistant: kept');
  });

  it('returns empty string when there are no user/assistant turns', () => {
    expect(buildBtwContextBlock(fakeSession([msg('toolResult', 'x'), msg('system', 'y')]))).toBe('');
  });
});

describe('buildBtwContextBlock — char-budget eviction', () => {
  it('drops the OLDEST turns first when the joined block exceeds the budget', () => {
    // Each message fits under budget alone, but together they exceed it (~0.6×budget each). The loop
    // drops the oldest (`old`) and the surviving newest line is returned intact (no tail-slice).
    const big = 'A'.repeat(Math.floor(BTW_MAX_CONTEXT_CHARS * 0.6));
    const block = buildBtwContextBlock(
      fakeSession([
        msg('user', `old ${big}`),
        msg('assistant', [{ type: 'text', text: `new ${big}` }]),
      ]),
    );
    expect(block.startsWith('Assistant: new ')).toBe(true);
    expect(block).not.toContain('User: old');
    expect(block.length).toBeLessThanOrEqual(BTW_MAX_CONTEXT_CHARS);
  });

  it('tail-slices a SINGLE over-budget message, keeping the NEWEST content (end of string)', () => {
    // One message alone exceeds the budget: the while-loop can't drop below 1 line, so the final
    // slice keeps the trailing BTW_MAX_CONTEXT_CHARS — the newest characters, not the oldest.
    const head = 'HEAD'.repeat(10);
    const tail = 'Z'.repeat(BTW_MAX_CONTEXT_CHARS);
    const block = buildBtwContextBlock(fakeSession([msg('user', `${head}${tail}`)]));
    expect(block.length).toBe(BTW_MAX_CONTEXT_CHARS);
    expect(block).not.toContain('HEAD'); // oldest content evicted
    expect(block.endsWith('Z')).toBe(true); // newest content survives
    expect(block).toBe(block.slice(-BTW_MAX_CONTEXT_CHARS));
  });

  it('leaves an under-budget block untouched', () => {
    const block = buildBtwContextBlock(fakeSession([msg('user', 'small'), msg('assistant', [{ type: 'text', text: 'reply' }])]));
    expect(block).toBe('User: small\n\nAssistant: reply');
  });
});
