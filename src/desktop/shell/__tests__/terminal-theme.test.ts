import { describe, expect, it } from 'vitest';
import { searchDecorations, terminalTheme } from '../terminal/terminal-theme';

// Every tone's text and fill tokens differ here, as they do in a user theme, so a tint read from the text token shows.
const TOKENS: Readonly<Record<string, string>> = {
  '--d-pane-terminal': '#10101000',
  '--d-pane-editor': '#202020',
  '--d-bg': '#000000',
  '--d-text': '#eeeeee',
  '--d-muted': '#888888',
  '--d-accent': '#aaccff',
  '--d-accent-fill': '#3366cc',
  '--d-warning': '#ffdd88',
  '--d-warning-fill': '#cc8800',
  ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`--d-ansi-${index}`, `#0000${index.toString(16).padStart(2, '0')}`])),
};
const read: string[] = [];
const style = {
  getPropertyValue: (name: string): string => {
    read.push(name);
    return ` ${TOKENS[name] ?? ''} `;
  },
} as unknown as CSSStyleDeclaration;

describe('terminalTheme', () => {
  it('takes the terminal panel\'s pane token as its background, see-through as main wrote it', () => {
    expect(terminalTheme(style).background).toBe('#10101000');
  });

  it('takes the editor\'s pane token for a terminal in the editor area, and never the panel\'s', () => {
    read.length = 0;
    expect(terminalTheme(style, '--d-pane-editor').background).toBe('#202020');
    expect(read).not.toContain('--d-pane-terminal');
  });

  it('fills the sixteen ANSI slots in xterm\'s order', () => {
    const theme = terminalTheme(style);
    expect([
      theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ]).toEqual(Array.from({ length: 16 }, (_, index) => TOKENS[`--d-ansi-${index}`]));
  });

  it('tints the selection from the accent fill and draws the cursor in the accent text shade', () => {
    const theme = terminalTheme(style);
    expect(theme.selectionBackground).toBe('#3366cc4d');
    expect(theme.cursor).toBe('#aaccff');
  });
});

describe('searchDecorations', () => {
  it('tints, borders and marks matches from the fill tokens', () => {
    expect(searchDecorations(style)).toEqual({
      matchBackground: '#cc88004d',
      matchOverviewRuler: '#cc8800',
      activeMatchBackground: '#3366cc80',
      activeMatchBorder: '#3366cc',
      activeMatchColorOverviewRuler: '#3366cc',
    });
  });
});
