// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import SettingsPanel from '../SettingsPanel.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import type { ImageGenerationSettings } from '@shared/types/settings';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

const READY: ImageGenerationSettings = {
  enabled: false,
  model: '',
  imageModels: [
    { id: 'google/gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image' },
    { id: 'openai/gpt-5-image', name: 'GPT-5 Image' },
  ],
  openRouterConfigured: true,
};

let posted: Array<Record<string, unknown>> = [];
const mounted: VueWrapper[] = [];

async function mountPanel(image: ImageGenerationSettings | null): Promise<void> {
  const store = useSettingsStore();
  if (image) store.setImageGeneration(image);
  mounted.push(mount(SettingsPanel, {
    props: {
      settings: store.currentSettings,
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
  }) as VueWrapper);
  // Reka mounts the sheet's portalled content on the tick after mount.
  await nextTick();
}

/** Reka defers open and select across a custom event and its own `nextTick`, so one tick is not enough. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const press = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.body.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

const toggle = () => query('#image-generation-enabled');
const modelTrigger = () => query('#image-generation-model-trigger');

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as Record<string, unknown>));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
});

describe('SettingsPanel image generation', () => {
  it('asks the host for the settings when it opens, and hides the section until they arrive', async () => {
    await mountPanel(null);

    expect(posted).toContainEqual({ type: 'requestImageGenerationSettings' });
    expect(document.body.querySelector('[data-testid="image-generation-settings"]')).toBeNull();
  });

  it('names both controls', async () => {
    await mountPanel(READY);

    expect(query<HTMLLabelElement>('label[for="image-generation-enabled"]').textContent?.trim())
      .toBe(i18n.global.t('settings.imageGeneration.enabledLabel'));
    expect(modelTrigger().tagName).toBe('BUTTON');
    expect(modelTrigger().getAttribute('aria-labelledby')).toBe('image-generation-model-label');
    expect(query('#image-generation-model-label').getAttribute('for')).toBe('image-generation-model-trigger');
  });

  // A native button, so Enter and Space reach the same click handler.
  it('posts setImageGenerationEnabled when toggled', async () => {
    await mountPanel(READY);

    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().getAttribute('role')).toBe('switch');
    toggle().click();
    await flush();

    expect(posted).toContainEqual({ type: 'setImageGenerationEnabled', enabled: true });
  });

  it('lists imageModels and posts setImageGenerationModel for the one picked from the keyboard', async () => {
    await mountPanel(READY);

    press(modelTrigger(), 'Enter');
    await flush();
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options.map((o) => o.textContent?.trim())).toEqual(['Gemini 2.5 Flash Image', 'GPT-5 Image']);

    press(options[1]!, 'Enter');
    await flush();

    expect(posted).toContainEqual({ type: 'setImageGenerationModel', model: 'openai/gpt-5-image' });
  });

  it('shows the chosen model', async () => {
    await mountPanel({ ...READY, model: 'google/gemini-2.5-flash-image' });
    expect(modelTrigger().textContent).toContain('Gemini 2.5 Flash Image');
  });

  it('says a configured model outside imageModels is not available', async () => {
    await mountPanel({ ...READY, model: 'gone/model' });
    expect(document.body.textContent).toContain(i18n.global.t('settings.imageGeneration.unknownModel', { model: 'gone/model' }));
  });

  it('shows the needs-key state only when OpenRouter is not configured', async () => {
    await mountPanel({ ...READY, openRouterConfigured: false });
    expect(query('[data-testid="image-generation-needs-key"]').textContent?.trim())
      .toBe(i18n.global.t('settings.imageGeneration.needsOpenRouterKey'));
    // The notice names a section where the key can be saved without changing the Explore agent.
    expect([...document.body.querySelectorAll('h3')].map((h) => h.textContent?.trim())).toContain(i18n.global.t('openrouter.sectionTitle'));

    mounted.pop()?.unmount();
    await mountPanel(READY);
    expect(document.body.querySelector('[data-testid="image-generation-needs-key"]')).toBeNull();
  });
});
