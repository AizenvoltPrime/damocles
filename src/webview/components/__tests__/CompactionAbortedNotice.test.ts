// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import CompactionAbortedNotice from '../CompactionAbortedNotice.vue';
import type { CompactionAbortedNotice as CompactionAbortedNoticeType } from '@shared/types/session';
import { i18n, applyLocale } from '@/i18n';

function make(overrides: Partial<CompactionAbortedNoticeType> = {}): CompactionAbortedNoticeType {
  return {
    id: 'a1',
    trigger: 'threshold',
    willRetry: true,
    timestamp: 1000,
    ...overrides,
  };
}

function mountNotice(notice: CompactionAbortedNoticeType) {
  return mount(CompactionAbortedNotice, { props: { notice }, global: { plugins: [i18n] } });
}

afterEach(() => applyLocale('en'));

/**
 * pi 0.85.0 hard-codes `willRetry: false` on an abort and sends no `errorMessage`, so the two cases
 * that set those pin passthrough of a hand-built event rather than a card a user reaches today.
 */
describe('CompactionAbortedNotice', () => {
  it('renders the retry line when the event carries willRetry true', () => {
    const text = mountNotice(make({ willRetry: true })).text();
    expect(text).toContain('Compaction stopped before it finished');
    expect(text).toContain('Damocles will retry it.');
    expect(text).not.toContain('will not retry');
  });

  it('says Damocles will not retry, and that the context survived', () => {
    const text = mountNotice(make({ willRetry: false })).text();
    expect(text).toContain('Compaction stopped before it finished');
    expect(text).toContain('Damocles will not retry it, and the context is unchanged.');
  });

  it('names the threshold trigger', () => {
    const text = mountNotice(make({ trigger: 'threshold' })).text();
    expect(text).toContain('after context use crossed the configured threshold');
  });

  it('names the overflow trigger distinctly from the threshold one', () => {
    const text = mountNotice(make({ trigger: 'overflow' })).text();
    expect(text).toContain('after the context overflowed mid-run');
    expect(text).not.toContain('configured threshold');
  });

  it('blames the user for a manual trigger instead of Damocles', () => {
    const text = mountNotice(make({ trigger: 'manual' })).text();
    expect(text).toContain('You started this compaction.');
  });

  it('renders the reason line when the event carries an error message', () => {
    const text = mountNotice(make({ errorMessage: 'summary model returned no content' })).text();
    expect(text).toContain('Reason: summary model returned no content');
  });

  it('omits the reason line when no error message came through', () => {
    const text = mountNotice(make()).text();
    expect(text).not.toContain('Reason:');
  });

  it('localizes to Greek', () => {
    applyLocale('el');
    const text = mountNotice(make({ trigger: 'overflow', willRetry: false })).text();
    expect(text).toContain('Η σύμπτυξη σταμάτησε πριν ολοκληρωθεί');
    expect(text).toContain('Το Damocles δεν θα την επαναλάβει· το context παραμένει αμετάβλητο.');
  });
});
