// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import CompassIndicator from '../CompassIndicator.vue';
import { useCompassStore } from '@/stores/useCompassStore';
import { i18n } from '@/i18n';
import type { CompassIndexStatus } from '@shared/types/compass';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

const READY: CompassIndexStatus = { state: 'ready', fileCount: 12, nodeCount: 340, edgeCount: 900, communityCount: 4, flowCount: 0, lastIndexedAt: null };

const mounted: VueWrapper[] = [];
let posted: { type: string }[] = [];
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const t = (key: string) => i18n.global.t(key);

async function openPopover(status: CompassIndexStatus): Promise<void> {
  useCompassStore().updateStatus(status);
  const wrapper = mount(CompassIndicator, { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper as VueWrapper);
  await nextTick();
  wrapper.get('button').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
});

describe('CompassIndicator for an index a newer Damocles upgraded', () => {
  it('says the index is read only and why the rebuild control is off', async () => {
    await openPopover({ ...READY, readOnly: true });

    expect(byTestId('compass-read-only-pill')!.textContent).toContain(t('compass.indicator.readOnly'));
    expect(byTestId('compass-read-only-state')!.textContent).toBe(t('compass.indicator.readOnly'));
    expect(byTestId('compass-read-only-notice')!.textContent?.trim()).toBe(t('compass.indicator.readOnlyNotice'));
    const reindex = byTestId('compass-reindex') as HTMLButtonElement;
    expect(reindex.disabled).toBe(true);
    expect(reindex.getAttribute('aria-describedby')).toBe('compass-read-only-notice');

    reindex.click();
    expect(posted).toEqual([]);
  });

  it('shows no read-only state for an index it can rebuild, and labels the control in the UI language', async () => {
    i18n.global.locale.value = 'el';
    await openPopover(READY);

    expect(byTestId('compass-read-only-pill')).toBeNull();
    expect(byTestId('compass-read-only-notice')).toBeNull();
    const reindex = byTestId('compass-reindex') as HTMLButtonElement;
    expect(reindex.disabled).toBe(false);
    expect(reindex.textContent?.trim()).toBe(t('compass.indicator.reindex'));
    expect(reindex.textContent?.trim()).not.toBe('Reindex');
  });
});
