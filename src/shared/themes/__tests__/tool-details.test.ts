import { describe, expect, it } from 'vitest';
import { applyThemeChangeUpdate, miniatureTheme, type ThemeCardUpdate, type ThemeShowNote } from '../agent';
import { BUILTIN_THEME } from '../builtin';
import { parseThemeToolDetails } from '../tool-details';
import { isThemeShotUrl } from '../wallpapers';

const USER_THEME = { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Amber Night' };

describe('a theme tool result\'s details, read back', () => {
  it('is nothing unless it names a theme tool', () => {
    expect(parseThemeToolDetails(undefined)).toBeUndefined();
    expect(parseThemeToolDetails('ThemeSet')).toBeUndefined();
    expect(parseThemeToolDetails({ tool: 'Bash', outcome: 'applied' })).toBeUndefined();
    expect(parseThemeToolDetails({ tool: 'ThemeSet' })).toEqual({ tool: 'ThemeSet' });
  });

  it('keeps the miniature copy of a built-in and of a user theme', () => {
    for (const theme of [BUILTIN_THEME, USER_THEME]) {
      const copy = miniatureTheme(theme);
      expect(parseThemeToolDetails({ tool: 'ThemeSet', outcome: 'applied', theme: copy })).toEqual({ tool: 'ThemeSet', outcome: 'applied', theme: copy });
    }
  });

  it('leaves out an outcome it does not know and a theme that is not one', () => {
    expect(parseThemeToolDetails({ tool: 'ThemeSet', outcome: 'teleported', themeName: 'Amber Night' })).toEqual({ tool: 'ThemeSet', themeName: 'Amber Night' });
    for (const theme of [{ name: 'No looks' }, { ...USER_THEME, looks: {} }, { ...USER_THEME, looks: { dark: { colors: { ...BUILTIN_THEME.looks.dark!.colors, accent: 'url(https://example.com/a.png)' } } } }, 'theme', null]) {
      expect(parseThemeToolDetails({ tool: 'ThemeSet', outcome: 'applied', theme })).toEqual({ tool: 'ThemeSet', outcome: 'applied' });
    }
  });

  it('keeps only the fields that have the shape the card reads', () => {
    expect(parseThemeToolDetails({
      tool: 'ThemeRead', looks: ['light', 'sepia', 'dark'], note: 7, screenshot: 'maybe', shotRefused: 'broken', useArrangement: 'yes', droppedCss: 'all', droppedCssMore: -1,
      undone: { kind: 'conjured' }, laterChange: { change: { kind: 'reset' }, actor: { kind: 'nobody' }, at: 1 },
    })).toEqual({ tool: 'ThemeRead', looks: ['dark', 'light'] });
    const later = { change: { kind: 'save', theme: 'Bleach' }, actor: { kind: 'user' }, at: 5 };
    expect(parseThemeToolDetails({ tool: 'ThemeSet', undone: { kind: 'reset' }, laterChange: later, screenshot: 'sent', droppedCssMore: 3, useArrangement: true }))
      .toEqual({ tool: 'ThemeSet', undone: { kind: 'reset' }, laterChange: later, screenshot: 'sent', droppedCssMore: 3, useArrangement: true });
    expect(parseThemeToolDetails({ tool: 'ThemeRead', shotRefused: 'windowHidden' })).toEqual({ tool: 'ThemeRead', shotRefused: 'windowHidden' });
    expect(parseThemeToolDetails({ tool: 'ThemeRead', shotRefused: 'covered' })).toEqual({ tool: 'ThemeRead', shotRefused: 'covered' });
  });
});

describe('a theme card after an update', () => {
  const card = (showInWindow: boolean, showNote?: ThemeShowNote) => ({ promptId: 'tc-1', state: 'waiting' as const, showInWindow, ...(showNote ? { showNote } : {}) });

  it.each<[string, ThemeCardUpdate, ThemeShowNote | undefined]>([
    ['on, no note', { showInWindow: true }, undefined],
    ['on, with a note', { showInWindow: true, showNote: 'forcedColors' }, undefined],
    ['off, no note', { showInWindow: false }, undefined],
    ['off, with a note', { showInWindow: false, showNote: 'safeStart' }, 'safeStart'],
    ['a note alone', { showNote: 'forcedColors' }, 'forcedColors'],
    ['a state alone', { state: 'applying' }, 'takenOver'],
  ])('Show in window %s', (_name, update, note) => {
    const next = applyThemeChangeUpdate(card(false, 'takenOver'), update);
    expect(next.showNote).toBe(note);
    expect('showNote' in next).toBe(note !== undefined);
    expect(next.showInWindow).toBe(update.showInWindow ?? false);
    expect(next.state).toBe(update.state ?? 'waiting');
    expect(next.promptId).toBe('tc-1');
  });

  it('takes each state and leaves the card it was given as it was', () => {
    const held = card(true);
    expect(applyThemeChangeUpdate(held, { state: 'outdated', showInWindow: false })).toEqual({ promptId: 'tc-1', state: 'outdated', showInWindow: false });
    expect(held).toEqual({ promptId: 'tc-1', state: 'waiting', showInWindow: true });
  });
});

describe('a screenshot URL', () => {
  it('is the app\'s own screenshot path with a 32 hex digit id, and nothing else', () => {
    expect(isThemeShotUrl(`app://damocles/theme-shot/${'3f'.repeat(16)}`)).toBe(true);
    for (const url of ['https://example.com/a.png', 'app://damocles/theme-shot/3f2a9c', `app://damocles/theme-shot/${'3f'.repeat(16)}?x`, `app://damocles/theme-shot/${'3F'.repeat(16)}`, `app://damocles/theme-blob/${'3f'.repeat(16)}`, `app://evil/theme-shot/${'3f'.repeat(16)}`]) {
      expect(isThemeShotUrl(url), url).toBe(false);
    }
  });
});
