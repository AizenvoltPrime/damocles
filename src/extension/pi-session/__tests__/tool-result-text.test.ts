import { describe, it, expect } from 'vitest';
import { joinResultText } from '../tool-result-text';

/**
 * Four callers share this: the two stream adapters render its output on a card, and the team runner
 * puts it into `teamAgentToolResult.result` and into the persisted `tool_result` block, where a reload
 * replays it as the authoritative record. A blank returned here is therefore written to disk.
 */
describe('joinResultText', () => {
  it('joins the text blocks of a pi tool result', () => {
    expect(joinResultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab');
  });

  it('skips non-text blocks and blocks whose text is not a string', () => {
    expect(joinResultText({ content: [{ type: 'image', text: 'no' }, { type: 'text' }, { type: 'text', text: 'yes' }] })).toBe('yes');
  });

  it('falls back to a bare string result, which a custom tool or an MCP shim can return', () => {
    expect(joinResultText('plain text result')).toBe('plain text result');
  });

  it('returns empty for a result that carries neither content blocks nor a string', () => {
    expect(joinResultText(undefined)).toBe('');
    expect(joinResultText(null)).toBe('');
    expect(joinResultText({ content: 'not an array' })).toBe('');
    expect(joinResultText({ details: {} })).toBe('');
    expect(joinResultText(42)).toBe('');
  });
});
