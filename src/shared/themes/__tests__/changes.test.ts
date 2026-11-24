import { describe, expect, it } from 'vitest';
import { MAX_CHANGE_ID_CHARS, parseThemeHistoryChange } from '../changes';

describe('a history change with the theme ids beside its names', () => {
  it('reads a pick, a hold and a project pin with and without their ids, alone and under a restore', () => {
    const changes = [
      { kind: 'pick', look: 'dark', theme: 'System colors', themeId: 'damocles-system', was: 'Aurora', wasId: 'damocles-aurora' },
      { kind: 'pick', look: 'light', theme: 'Night', was: 'Damocles' },
      { kind: 'pick', look: 'light', theme: 'Night', themeId: 'damocles-aurora', wasId: 'damocles' },
      { kind: 'hold', theme: 'Paper', themeId: 'damocles-paper', look: 'light' },
      { kind: 'hold', theme: 'Night', look: 'dark' },
      { kind: 'projectPin', project: 'site', theme: 'Arcade', themeId: 'damocles-arcade', character: 'Pip', everyTheme: true },
      { kind: 'projectPin', project: 'site', theme: 'Night', character: null },
    ] as const;
    for (const change of changes) {
      expect(parseThemeHistoryChange(JSON.parse(JSON.stringify(change)))).toEqual(change);
      expect(parseThemeHistoryChange({ kind: 'restore', before: change })).toEqual({ kind: 'restore', before: change });
    }
  });

  it('refuses an id that is no id', () => {
    for (const themeId of ['', 7, 'x'.repeat(MAX_CHANGE_ID_CHARS + 1)]) {
      expect(parseThemeHistoryChange({ kind: 'hold', theme: 'Night', themeId, look: 'dark' })).toBeUndefined();
      expect(parseThemeHistoryChange({ kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles', wasId: themeId })).toBeUndefined();
      expect(parseThemeHistoryChange({ kind: 'projectPin', project: 'site', theme: 'Night', themeId, character: 'Pip' })).toBeUndefined();
    }
  });
});
