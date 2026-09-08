// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ThinkingDroppedNotice from '../ThinkingDroppedNotice.vue';
import type { ThinkingDroppedNotice as ThinkingDroppedNoticeType } from '@shared/types/session';
import { i18n, applyLocale } from '@/i18n';

function make(overrides: Partial<ThinkingDroppedNoticeType> = {}): ThinkingDroppedNoticeType {
  return {
    id: 'd1',
    count: 1,
    reasons: ['a different model wrote the reasoning, and the requested model may not read it'],
    timestamp: 1000,
    ...overrides,
  };
}

function mountNotice(notice: ThinkingDroppedNoticeType) {
  return mount(ThinkingDroppedNotice, { props: { notice }, global: { plugins: [i18n] } });
}

afterEach(() => applyLocale('en'));

describe('ThinkingDroppedNotice', () => {
  it('uses the singular noun at count 1 and never prints the number', () => {
    const text = mountNotice(make({ count: 1 })).text();
    expect(text).toContain('Anthropic dropped a thinking block');
    expect(text).not.toContain('1 thinking block');
  });

  it('uses the plural noun with the count at 3', () => {
    const text = mountNotice(
      make({ count: 3, reasons: ['reason a', 'reason b', 'reason c'] }),
    ).text();
    expect(text).toContain('Anthropic dropped 3 thinking blocks');
    expect(text).not.toContain('a thinking block');
  });

  it('joins every reason with "; " and renders each one verbatim', () => {
    const text = mountNotice(
      make({ count: 2, reasons: ['the conversation changed since the reasoning was written', 'unknown reason'] }),
    ).text();
    expect(text).toContain('the conversation changed since the reasoning was written; unknown reason');
  });

  it('states what the drop means, because this notice is on by default', () => {
    const text = mountNotice(make()).text();
    expect(text).toContain('The model lost part of its reasoning chain on this turn.');
  });

  it('renders without a reason line when the adapter sent an empty reasons array', () => {
    const text = mountNotice(make({ count: 1, reasons: [] })).text();
    expect(text).toContain('Anthropic dropped a thinking block');
    expect(text).toContain('The model lost part of its reasoning chain on this turn.');
  });

  it('localizes to Greek and keeps the vendor name in Latin script', () => {
    applyLocale('el');
    const text = mountNotice(make({ count: 3, reasons: ['unknown reason'] })).text();
    expect(text).toContain('Η Anthropic απέρριψε 3 μπλοκ σκέψης');
    expect(text).toContain('Το μοντέλο έχασε μέρος της αλυσίδας συλλογισμού του σε αυτόν τον γύρο.');
  });
});
