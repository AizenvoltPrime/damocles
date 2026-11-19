// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ThinkingDroppedNotice from '../ThinkingDroppedNotice.vue';
import type { ThinkingDroppedNotice as ThinkingDroppedNoticeType, ThinkingDroppedReason } from '@shared/types/session';
import { i18n, applyLocale } from '@/i18n';

const MODEL = 'a different model wrote the reasoning, and the requested model may not read it';
const PREFIX = 'the conversation changed since the reasoning was written';
const reason = (message: string, count = 1): ThinkingDroppedReason => ({ text: { message }, count });

function make(overrides: Partial<ThinkingDroppedNoticeType> = {}): ThinkingDroppedNoticeType {
  return {
    id: 'd1',
    count: 1,
    reasons: [reason(MODEL)],
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
    const text = mountNotice(make({ count: 3, reasons: [reason(PREFIX, 3)] })).text();
    expect(text).toContain('Anthropic dropped 3 thinking blocks');
    expect(text).not.toContain('a thinking block');
  });

  it('shows one reason that dropped every block once, with no count beside it', () => {
    const text = mountNotice(make({ count: 7, reasons: [reason(PREFIX, 7)] })).text();
    expect(text).toContain(PREFIX);
    expect(text.split(PREFIX)).toHaveLength(2);
    expect(text).not.toContain('(7)');
  });

  it('shows each of several reasons once with its count, joined with "; "', () => {
    const text = mountNotice(make({ count: 7, reasons: [reason(PREFIX, 5), reason(MODEL, 2)] })).text();
    expect(text).toContain(`${PREFIX} (5); ${MODEL} (2)`);
  });

  it('shows a code Damocles has no sentence for as written', () => {
    const text = mountNotice(make({ reasons: [{ text: { message: '{0}', args: ['some_future_mismatch'] }, count: 1 }] })).text();
    expect(text).toContain('some_future_mismatch');
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

  it('localizes the title and each reason to Greek and keeps the vendor name in Latin script', async () => {
    await applyLocale('el');
    const text = mountNotice(make({ count: 3, reasons: [reason(PREFIX, 2), reason('unknown reason')] })).text();
    expect(text).toContain('Η Anthropic απέρριψε 3 μπλοκ σκέψης');
    expect(text).toContain('η συνομιλία άλλαξε από τότε που γράφτηκε ο συλλογισμός (2); άγνωστος λόγος (1)');
    expect(text).toContain('Το μοντέλο έχασε μέρος της αλυσίδας συλλογισμού του σε αυτόν τον γύρο.');
  });
});
