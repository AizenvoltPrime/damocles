// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import SafeStartBanner from '../components/SafeStartBanner.vue';
import { shellI18n } from '../i18n';
import { installVisibilityObserver, type FakeVisibility } from '../../../webview/__tests__/visibility-observer';

const mounted: VueWrapper[] = [];
let visibility: FakeVisibility;
beforeEach(() => {
  vi.useFakeTimers();
  shellI18n.global.locale.value = 'en';
  visibility = installVisibilityObserver();
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function banner(reason: 'launch' | 'crashLoop' | 'reset' = 'launch'): VueWrapper {
  const wrapper = mount(SafeStartBanner, { props: { reason }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe('the safe-start banner', () => {
  it('is a trusted, labelled region that says why the Damocles theme shows, for each reason', () => {
    const root = banner().get('[data-testid="safe-start-banner"]');
    expect(root.attributes('role')).toBe('region');
    expect(root.attributes('aria-labelledby')).toBe('safe-start-title');
    expect(root.attributes('data-trusted')).toBeDefined();
    expect(root.get('#safe-start-title').text()).toBe('Started with the Damocles theme.');
    expect(root.text()).toContain('Your theme is paused for this run until you turn it back on.');
    expect(banner('crashLoop').get('#safe-start-title').text()).toBe('The window kept crashing, so this run shows the Damocles theme.');
    expect(banner('reset').get('#safe-start-title').text()).toBe('Showing the Damocles theme for this run. The engine is not running, so the schedule and project looks were not reset.');
  });

  it('emits useMine and openSettings from its two buttons', async () => {
    const w = banner();
    const [useMine, openSettings] = w.findAll('button');
    expect(useMine!.text()).toBe('Use my theme');
    expect(openSettings!.text()).toBe('Open theme settings');
    await useMine!.trigger('click');
    await openSettings!.trigger('click');
    expect(w.emitted('useMine')).toHaveLength(1);
    expect(w.emitted('openSettings')).toHaveLength(1);
  });

  it('does nothing while covered, says why once the cover outlasts its entrance, and acts once it is fully visible', async () => {
    const w = banner();
    visibility.report(false);
    await nextTick();
    expect(w.get('[role="group"]').attributes('aria-disabled')).toBe('true');
    await w.get('[data-testid="safe-start-use-mine"]').trigger('click');
    expect(w.emitted('useMine')).toBeUndefined();
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(w.get('[data-testid="trusted-checking"]').text()).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');

    visibility.report(true);
    await nextTick();
    expect(w.find('[data-testid="trusted-checking"]').exists()).toBe(false);
    await w.get('[data-testid="safe-start-use-mine"]').trigger('click');
    expect(w.emitted('useMine')).toHaveLength(1);
  });
});
