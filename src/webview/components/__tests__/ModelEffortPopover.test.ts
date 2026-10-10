// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ModelEffortPopover from '../composer/ModelEffortPopover.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { settingsViewHandlers, type SettingsHandlerContext } from '@/composables/message-handler/handlers/settings-handlers';
import { i18n } from '@/i18n';

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage }) }));

enableAutoUnmount(afterEach);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const options = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-effort-option"]')];

/** Reka opens a menu on Enter and portals its content to `document.body`. */
async function openMenu(): Promise<void> {
  mount(ModelEffortPopover, { attachTo: document.body, global: { plugins: [i18n] } });
  const trigger = document.body.querySelector<HTMLElement>('[data-testid="composer-model"]');
  if (!trigger) throw new Error('no model chip');
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  await nextTick();
}

describe('ModelEffortPopover reasoning effort', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    postMessage.mockClear();
    const settings = useSettingsStore();
    settings.setModelState('claude-opus-5-5', 'claude-opus-5-5');
    settings.setPanelThinking({ thinkingDisabled: false, effort: 'high' }, 'claude-opus-5-5');
  });

  it('renders the levels as one radio group of pills with the selected one checked', async () => {
    await openMenu();
    const pills = options();
    expect(pills.map((pill) => pill.textContent?.trim())).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultracode']);
    expect(pills.every((pill) => pill.getAttribute('role') === 'menuitemradio')).toBe(true);
    expect(pills.filter((pill) => pill.getAttribute('aria-checked') === 'true').map((pill) => pill.textContent?.trim())).toEqual(['High']);
    expect(pills[0]?.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Reasoning effort');
  });

  it('posts setPanelEffort for the picked level and keeps the menu open', async () => {
    await openMenu();
    options()[3]?.click();
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'setPanelEffort', effort: 'xhigh', model: 'claude-opus-5-5' });
    expect(document.body.querySelector('[data-testid="composer-model-menu"]')).not.toBeNull();
  });

  it('shows a picked model only once core reports it committed, so a refused pick never reaches the label', async () => {
    const settings = useSettingsStore();
    const trigger = () => document.body.querySelector<HTMLElement>('[data-testid="composer-model"]');
    const label = () => trigger()?.textContent?.trim();
    await openMenu();
    const pick = async (name: string) => {
      if (!document.body.querySelector('[data-testid="composer-model-menu"]')) {
        trigger()?.focus();
        trigger()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await flush();
        await nextTick();
      }
      [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-option"]')].find((option) => option.textContent?.trim() === name)?.click();
      await flush();
    };
    const commit = async (activeModel: string) => {
      settingsViewHandlers.modelUpdate(
        { type: 'modelUpdate', activeModel, defaultModel: 'claude-opus-5-5', contextWindowSize: 1_000_000 },
        { stores: { settingsStore: settings } } as unknown as SettingsHandlerContext,
      );
      await nextTick();
    };

    await pick('Step 5 Preview');
    expect(postMessage).toHaveBeenCalledWith({ type: 'setActiveModel', model: 'step-5-preview' });
    expect(label()).toMatch(/^Opus 5\.5/);
    await commit('claude-opus-5-5');
    expect(label()).toMatch(/^Opus 5\.5/);

    await pick('Haiku 5.5');
    expect(postMessage).toHaveBeenCalledWith({ type: 'setActiveModel', model: 'claude-haiku-5-5' });
    expect(label()).toMatch(/^Opus 5\.5/);
    await commit('claude-haiku-5-5');
    expect(label()).toMatch(/^Haiku 5\.5/);
  });

  it('sends a pick of the model the chat already runs on, which withdraws an earlier refused pick in core', async () => {
    await openMenu();
    [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-option"]')].find((option) => option.textContent?.trim() === 'Opus 5.5')?.click();
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'setActiveModel', model: 'claude-opus-5-5' });
  });

  it('draws the selection as one indicator, never a ring bound to pointer highlight', async () => {
    await openMenu();
    expect(document.body.querySelectorAll('[data-testid="composer-model-menu"] [data-testid="sliding-indicator"]')).toHaveLength(1);
    for (const pill of options()) expect(pill.className).not.toMatch(/data-\[highlighted\]:ring/);
  });
});
