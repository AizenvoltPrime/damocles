// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import CacheMissNotice from '../CacheMissNotice.vue';
import type { CacheMissNotice as CacheMissNoticeType } from '@shared/types/session';
import { i18n, applyLocale } from '@/i18n';
import { CACHE_TTL_MS } from '@shared/types/constants';

function make(overrides: Partial<CacheMissNoticeType> = {}): CacheMissNoticeType {
  return {
    id: 'n1',
    missedTokens: 50_000,
    missedCost: 0.42,
    idleMs: CACHE_TTL_MS + 60_000,
    modelChanged: false,
    timestamp: 1000,
    ...overrides,
  };
}

function mountNotice(notice: CacheMissNoticeType) {
  return mount(CacheMissNotice, { props: { notice }, global: { plugins: [i18n] } });
}

afterEach(() => applyLocale('en'));

describe('CacheMissNotice', () => {
  it('renders the cost with a single ≈ prefix (locale supplies it; component must not double it)', () => {
    const text = mountNotice(make({ missedCost: 0.42 })).text();
    expect(text).toContain('≈$0.42');
    expect(text).not.toContain('≈≈');
  });

  it('omits the cost entirely when missedCost is 0 (tokens-only detail)', () => {
    const text = mountNotice(make({ missedCost: 0 })).text();
    expect(text).not.toContain('$');
    expect(text).not.toContain('≈');
    expect(text).toContain('50.0K');
  });

  it('titles an idle-gap expiry "Prompt cache expired" and shows the idle hint', () => {
    const text = mountNotice(make({ modelChanged: false, idleMs: CACHE_TTL_MS + 120_000 })).text();
    expect(text).toContain('Prompt cache expired');
    expect(text).toContain('idle');
  });

  it('titles a model-switch miss distinctly and does NOT claim the cache "expired"', () => {
    const text = mountNotice(make({ modelChanged: true })).text();
    expect(text).toContain('after model switch');
    expect(text).not.toContain('Prompt cache expired');
  });

  it('suppresses the idle hint when a model switch co-occurs with an idle gap (title blames the switch, not TTL)', () => {
    // modelChanged AND a >TTL idle gap: the title already reports the switch, so the "idle for N min"
    // hint must not appear underneath (it would contradict the stated cause).
    const text = mountNotice(make({ modelChanged: true, idleMs: CACHE_TTL_MS + 300_000 })).text();
    expect(text).toContain('after model switch');
    expect(text).not.toContain('idle');
  });

  it('uses the generic title for a sub-TTL miss with no model change (no idle hint)', () => {
    const text = mountNotice(make({ modelChanged: false, idleMs: 1000 })).text();
    expect(text).toContain('Prompt cache miss');
    expect(text).not.toContain('Prompt cache expired');
    expect(text).not.toContain('idle');
  });

  it('localizes to Greek (setting descriptions and titles come from el.json)', () => {
    applyLocale('el');
    const text = mountNotice(make({ modelChanged: true })).text();
    expect(text).toContain('αλλαγή μοντέλου');
    expect(text).not.toContain('≈≈');
  });
});
