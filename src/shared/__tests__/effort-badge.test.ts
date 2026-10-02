import { describe, expect, it } from 'vitest';
import { EFFORT_BADGE_LEVELS, effortBadgeLabelKey, isEffortBadgeLevel, publishedEffort, sessionEffort } from '../effort-badge';
import en from '../../webview/i18n/locales/en.json';
import el from '../../webview/i18n/locales/el.json';

describe('effort badge mapping', () => {
  it('maps every pi thinking level one to one', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(publishedEffort(level, true)).toBe(level);
    }
  });

  it('rejects values that are not pi thinking levels, including Damocles-only names', () => {
    for (const value of ['ultracode', 'none', 'High', '', 3, null, undefined]) {
      expect(isEffortBadgeLevel(value)).toBe(false);
      expect(publishedEffort(value, true)).toBeUndefined();
    }
  });

  it('has an en and an el label for every level', () => {
    for (const level of EFFORT_BADGE_LEVELS) {
      const [, group, key] = effortBadgeLabelKey(level).split('.');
      expect(en.effortBadge[group as 'level'][key as typeof level]).toBeTruthy();
      expect(el.effortBadge[group as 'level'][key as typeof level]).toBeTruthy();
    }
  });
});

describe('effort badge visibility', () => {
  it('publishes nothing for a model that does not reason, or whose reasoning flag is unknown', () => {
    expect(publishedEffort('high', false)).toBeUndefined();
    expect(publishedEffort('off', false)).toBeUndefined();
    expect(publishedEffort('high', undefined)).toBeUndefined();
  });

  it("reads a live session's effective level and its model's reasoning flag", () => {
    expect(sessionEffort({ thinkingLevel: 'high', model: { reasoning: true } })).toBe('high');
    expect(sessionEffort({ thinkingLevel: 'off', model: { reasoning: false } })).toBeUndefined();
    expect(sessionEffort({ thinkingLevel: 'medium', model: undefined })).toBeUndefined();
  });
});
