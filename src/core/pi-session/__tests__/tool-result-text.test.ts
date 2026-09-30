import { describe, it, expect } from 'vitest';
import { joinResultText, resultImageCount } from '../tool-result-text';

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

describe('resultImageCount', () => {
  it('counts supported image parts and skips text and unsupported media types', () => {
    expect(resultImageCount({ content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
      { type: 'image', data: 'CCCC', mimeType: 'image/svg+xml' },
      { type: 'image', data: '', mimeType: 'image/png' },
    ] })).toBe(2);
  });

  it('is zero for a text-only, string or missing result', () => {
    expect(resultImageCount({ content: [{ type: 'text', text: 'a' }] })).toBe(0);
    expect(resultImageCount('plain')).toBe(0);
    expect(resultImageCount(undefined)).toBe(0);
  });
});
