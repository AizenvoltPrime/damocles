// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import CompactMarker from '../CompactMarker.vue';
import type { CompactMarker as CompactMarkerType } from '@shared/types/session';
import { i18n, applyLocale } from '@/i18n';

function make(overrides: Partial<CompactMarkerType> = {}): CompactMarkerType {
  return {
    id: 'compact-1000',
    timestamp: 1000,
    trigger: 'manual',
    preTokens: 90_000,
    postTokens: 12_000,
    ...overrides,
  };
}

function mountMarker(marker: CompactMarkerType) {
  return mount(CompactMarker, {
    props: { marker },
    global: {
      plugins: [i18n],
      stubs: { MarkdownRenderer: true },
    },
  });
}

afterEach(() => applyLocale('en'));

describe('CompactMarker trigger', () => {
  it('labels a threshold compaction and explains the configured threshold', () => {
    const text = mountMarker(make({ trigger: 'threshold' })).text();
    expect(text).toContain('THRESHOLD');
    expect(text).toContain('Damocles compacted after context use crossed the configured threshold.');
  });

  it('labels an overflow compaction differently and never claims a threshold was crossed', () => {
    const text = mountMarker(make({ trigger: 'overflow' })).text();
    expect(text).toContain('OVERFLOW');
    expect(text).toContain('Damocles compacted after the context overflowed mid-run.');
    expect(text).not.toContain('configured threshold');
    expect(text).not.toContain('THRESHOLD');
  });

  it('gives a manual compaction no trigger hint, because the user already knows why it ran', () => {
    const text = mountMarker(make({ trigger: 'manual' })).text();
    expect(text).toContain('MANUAL');
    expect(text).not.toContain('Damocles compacted after');
  });

  it('gives threshold and overflow different badge colours', () => {
    const thresholdHtml = mountMarker(make({ trigger: 'threshold' })).html();
    const overflowHtml = mountMarker(make({ trigger: 'overflow' })).html();
    expect(thresholdHtml).toContain('text-info');
    expect(overflowHtml).toContain('text-warning');
  });
});

describe('CompactMarker billed usage', () => {
  it('states the billed tokens and appends the dollar figure at or above a cent', () => {
    const text = mountMarker(make({ billedTokens: 12_400, billedCost: 0.0312 })).text();
    expect(text).toContain('12K tokens billed (~$0.03)');
  });

  it('states the billed tokens with no dollar figure below a cent', () => {
    const text = mountMarker(make({ billedTokens: 12_400, billedCost: 0.004 })).text();
    expect(text).toContain('12K tokens billed');
    expect(text).not.toContain('$');
    expect(text).not.toContain('~$');
  });

  it('treats an exact cent as above the threshold', () => {
    const text = mountMarker(make({ billedTokens: 1_000, billedCost: 0.01 })).text();
    expect(text).toContain('(~$0.01)');
  });

  it('prints no billed figure at all when the adapter sent neither field', () => {
    const text = mountMarker(make()).text();
    expect(text).not.toContain('tokens billed');
    expect(text).not.toContain('$');
    // The card still renders its existing token reduction and title.
    expect(text).toContain('Context Compacted');
    expect(text).toContain('90K→12K tokens');
  });

  it('states zero billed tokens rather than hiding them, since zero is a real value', () => {
    const text = mountMarker(make({ billedTokens: 0, billedCost: 0 })).text();
    expect(text).toContain('0 tokens billed');
    expect(text).not.toContain('$');
  });

  it('formats the token and dollar figures the Greek way, not the US way', () => {
    applyLocale('el');
    const text = mountMarker(make({ trigger: 'overflow', billedTokens: 12_400, billedCost: 0.05 })).text();
    expect(text).toContain('Το Damocles έκανε σύμπτυξη αφού το context υπερχείλισε στη μέση της εκτέλεσης.');
    // Greek compact notation and the Greek currency form both use a non-breaking space.
    expect(text).toContain('90 χιλ.→12 χιλ. tokens');
    expect(text).toContain('12 χιλ. tokens χρεώθηκαν (~0,05 $)');
  });
});
