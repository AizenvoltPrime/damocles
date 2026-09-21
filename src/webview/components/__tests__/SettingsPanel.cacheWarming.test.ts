// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// `vue3-lottie` runs canvas setup at import time, which happy-dom does not provide.
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import SettingsPanel from '../SettingsPanel.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import { at, firstEmit } from '@/__tests__/helpers';
import type { CacheWarmingMode } from '@shared/types/settings';

/**
 * pi falls back to `"streaming"` for any cache-warming value outside its enum instead of failing, so
 * a renamed message field or a stray mode string is inert at runtime rather than loud. These pin the
 * three mode strings, the `mode` field name, and the `"streaming"` default.
 */

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const mounted: { unmount: () => void }[] = [];
function track<T extends { unmount: () => void }>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

async function mountPanel(cacheWarming: CacheWarmingMode): Promise<VueWrapper> {
  const store = useSettingsStore();
  const wrapper = track(mount(SettingsPanel, {
    props: {
      settings: { ...store.currentSettings, cacheWarming },
      availableModels: [],
      visible: true,
      activeModel: '',
      defaultModel: '',
      panelThinking: null,
      panelThinkingModel: '',
      defaultThinking: null,
      defaultThinkingModel: '',
      voiceConfig: store.voiceConfig,
      voiceHasApiKey: false,
      exploreHasApiKey: false,
      exploreProvider: '',
      exploreModel: '',
      exploreEffort: '',
    },
    attachTo: document.body,
    global: { plugins: [i18n] },
  })) as VueWrapper;
  // Reka mounts the sheet's portalled content on the tick after mount.
  await nextTick();
  return wrapper;
}

/** The panel renders through a portal, so the select lives on `document.body`, not under the wrapper. */
function cacheWarmingTrigger(): HTMLElement {
  const trigger = document.body.querySelector<HTMLElement>('[aria-labelledby="cache-warming-label"]');
  if (!trigger) throw new Error('no select trigger is labelled by #cache-warming-label');
  return trigger;
}

/** Reka defers open and select across a custom event and its own `nextTick`, so one tick is not enough. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const press = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

/** Reka keeps the listbox out of the DOM until the select opens, so every read opens it first. */
async function openCacheWarmingSelect(): Promise<HTMLElement[]> {
  press(cacheWarmingTrigger(), 'Enter');
  await flush();
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('SettingsPanel cache-warming select', () => {
  it('offers exactly three modes, in the order off, streaming, idle', async () => {
    await mountPanel('streaming');
    const labels = (await openCacheWarmingSelect()).map((option) => option.textContent?.trim());
    expect(labels).toEqual([
      'Off',
      'While an agent run is in flight',
      'While a run is in flight and while idle',
    ]);
  });

  // A label with only `aria-labelledby` on the trigger names the control for a screen reader, while a
  // pointer user clicking it gets nothing. `for` makes the click land on the trigger and focus it.
  it('points its label at the trigger, which focuses on a label click', async () => {
    await mountPanel('streaming');
    const label = document.body.querySelector<HTMLLabelElement>('#cache-warming-label')!;
    const trigger = cacheWarmingTrigger();

    expect(label.getAttribute('for')).toBe(trigger.id);
    expect(trigger.tagName).toBe('BUTTON');

    label.click();
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows the mode the settings carry', async () => {
    await mountPanel('idle');
    expect(cacheWarmingTrigger().textContent).toContain('While a run is in flight and while idle');
  });

  it.each([
    ['off', 0],
    ['streaming', 1],
    ['idle', 2],
  ] as const)('picking option %s emits setCacheWarming with that mode', async (mode, index) => {
    const wrapper = await mountPanel('streaming');
    press(at(await openCacheWarmingSelect(), index), 'Enter');
    await flush();
    expect(firstEmit(wrapper.emitted('setCacheWarming'), 'setCacheWarming')).toBe(mode);
  });
});

describe('App forwards the mode to the extension', () => {
  it('posts { type: "setCacheWarming", mode } and records it in the store', async () => {
    const posted: unknown[] = [];
    const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
    vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message));

    const app = track(mount(App, { global: { plugins: [i18n] } }));
    app.findComponent(SettingsPanel).vm.$emit('setCacheWarming', 'idle');
    await nextTick();

    expect(posted).toContainEqual({ type: 'setCacheWarming', mode: 'idle' });
    expect(useSettingsStore().currentSettings.cacheWarming).toBe('idle');
  });
});

describe('useSettingsStore cache warming', () => {
  it('defaults to streaming, matching the package.json contribution', () => {
    expect(useSettingsStore().currentSettings.cacheWarming).toBe('streaming');
  });

  it('setCacheWarmingMode replaces the mode', () => {
    const store = useSettingsStore();
    store.setCacheWarmingMode('off');
    expect(store.currentSettings.cacheWarming).toBe('off');
  });
});
