import { describe, expect, it } from 'vitest';
import type { StoredSession } from '../../../shared/types/session';
import { MAX_CHAT_TITLE_CHARS, chatTitle, panelTitle, storedTitle } from '../chat-title';

const row = (id: string, preview: string): StoredSession => ({ id, timestamp: 0, preview });

describe('chatTitle', () => {
  it('is undefined before any read titled the session', () => {
    expect(chatTitle(undefined, new Map(), 's1')).toBeUndefined();
  });

  it("takes the session's row, '' for a row with no title", () => {
    expect(chatTitle([row('s0', 'other'), row('s1', 'fix the build')], new Map([['s1', 'old']]), 's1')).toBe('fix the build');
    expect(chatTitle([row('s1', ' ')], new Map(), 's1')).toBe('');
  });

  it('keeps the known title while the catalog reloads or lacks the row, and names nothing for an unread session', () => {
    const known = new Map([['s1', 'fix the build']]);
    expect(chatTitle(undefined, known, 's1')).toBe('fix the build');
    expect(chatTitle([row('s0', 'other')], known, 's1')).toBe('fix the build');
    expect(chatTitle([row('s0', 'other')], new Map(), 's1')).toBeUndefined();
  });

  it("never names a chat that switched sessions by its earlier session's title", () => {
    const known = new Map([['s1', 'fix the build']]);
    expect(chatTitle(undefined, known, 's2')).toBeUndefined();
    expect(chatTitle([row('s1', 'fix the build')], known, 's2')).toBeUndefined();
  });

  it('keeps New chat for the session a new chat started until a read titles it, and lets the read win', () => {
    expect(chatTitle(undefined, new Map(), 's1', true)).toBe('');
    expect(chatTitle([row('s0', 'other')], new Map(), 's1', true)).toBe('');
    expect(chatTitle([row('s1', 'fix the build')], new Map(), 's1', true)).toBe('fix the build');
    expect(chatTitle(undefined, new Map([['s1', 'fix the build']]), 's1', true)).toBe('fix the build');
  });
});

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

describe('panelTitle', () => {
  it('shows a core\'s panel title on one line, its hidden characters escaped, clipped as a row title', () => {
    expect(panelTitle('Design · Contacts list')).toBe('Design · Contacts list');
    expect(panelTitle('Design ·\n Contacts\u202e list ')).toBe('Design · Contacts\\u{202E} list');
    expect(panelTitle(`Design · ${'x'.repeat(300)}`)).toHaveLength(MAX_CHAT_TITLE_CHARS);
  });
});
