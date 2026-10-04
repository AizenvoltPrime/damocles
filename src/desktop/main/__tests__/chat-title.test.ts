import { describe, expect, it } from 'vitest';
import { MAX_CHAT_TITLE_CHARS, storedTitle } from '../chat-title';

describe('storedTitle', () => {
  it('takes the custom title, else the AI title, else the preview, skipping blank ones', () => {
    expect(storedTitle({ customTitle: 'Mine', aiTitle: 'Build fix', preview: 'fix the build' })).toBe('Mine');
    expect(storedTitle({ customTitle: '  ', aiTitle: 'Build fix', preview: 'fix the build' })).toBe('Build fix');
    expect(storedTitle({ aiTitle: '', preview: 'fix the build' })).toBe('fix the build');
    expect(storedTitle({ preview: ' \n ' })).toBe('');
  });

  it('collapses whitespace and clips a long preview', () => {
    const title = storedTitle({ preview: `  line one\n\n${'x'.repeat(300)}` });
    expect(title.length).toBe(MAX_CHAT_TITLE_CHARS);
    expect(title.startsWith('line one x')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(storedTitle({ preview: 'a\tb  c' })).toBe('a b c');
    expect(storedTitle({ preview: 'x'.repeat(MAX_CHAT_TITLE_CHARS) })).toBe('x'.repeat(MAX_CHAT_TITLE_CHARS));
  });
});
