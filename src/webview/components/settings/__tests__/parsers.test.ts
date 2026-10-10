import { describe, expect, it } from 'vitest';
import { parseBudgetUsd, parseRetentionDays, parseTaskBudget } from '../parsers';

const t = (key: string, named?: Record<string, unknown>): string => (named ? `${key} ${JSON.stringify(named)}` : key);

describe('settings input parsers', () => {
  it('keep checkpoints 0 (forever) to 3650 days', () => {
    expect(parseRetentionDays('0', t)).toEqual({ ok: true, value: 0 });
    expect(parseRetentionDays('3650', t)).toEqual({ ok: true, value: 3650 });
    for (const raw of ['3651', '-1', '7.5', 'week']) {
      expect(parseRetentionDays(raw, t)).toEqual({ ok: false, error: t('settingsModal.invalid.integerRange', { min: 0, max: 3650 }) });
    }
  });

  it('read an empty budget as no limit and take only an amount above 0 with at most two decimals', () => {
    expect(parseBudgetUsd('  ', t)).toEqual({ ok: true, value: null });
    expect(parseBudgetUsd('2.50', t)).toEqual({ ok: true, value: 2.5 });
    expect(parseBudgetUsd('5', t)).toEqual({ ok: true, value: 5 });
    for (const raw of ['0', '0.00', '2.505', '-1', '$5', 'abc']) {
      expect(parseBudgetUsd(raw, t)).toEqual({ ok: false, error: 'settingsModal.invalid.amount' });
    }
  });

  it('read an empty task budget as none and take only a whole number above 0', () => {
    expect(parseTaskBudget('', t)).toEqual({ ok: true, value: null });
    expect(parseTaskBudget('1', t)).toEqual({ ok: true, value: 1 });
    for (const raw of ['0', '1.5', '-3']) {
      expect(parseTaskBudget(raw, t)).toEqual({ ok: false, error: 'settingsModal.invalid.positiveInteger' });
    }
  });
});
