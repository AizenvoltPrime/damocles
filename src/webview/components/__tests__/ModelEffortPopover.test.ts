// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ModelEffortPopover from '../composer/ModelEffortPopover.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
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

  it('offers None as the leftmost level on GPT-6 Luna', async () => {
    const settings = useSettingsStore();
    settings.setModelState('gpt-6-luna', 'gpt-6-luna');
    settings.setPanelThinking({ thinkingDisabled: false, effort: 'none' }, 'gpt-6-luna');
    await openMenu();
    const pills = options();
    expect(pills.map((pill) => pill.textContent?.trim())).toEqual(['None', 'Low', 'Medium', 'High', 'Extra High', 'Max']);
    expect(pills[0]?.getAttribute('aria-checked')).toBe('true');
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

  it('keeps a model core marks unreachable listed, muted and not pickable, with the reason under its name', async () => {
    const settings = useSettingsStore();
    const opus = settings.availableModels.find((model) => model.value === 'claude-opus-5-5')!;
    const haiku = settings.availableModels.find((model) => model.value === 'claude-haiku-5-5')!;
    settings.setAvailableModels([opus, { ...haiku, unavailable: { reason: 'loopback-endpoint', endpoint: 'http://127.0.0.1:4000/v1' } }]);
    await openMenu();
    const marked = [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-option"]')].find((option) => option.textContent?.includes('Haiku 5.5'));
    expect(marked?.getAttribute('data-unavailable')).toBe('loopback-endpoint');
    expect(marked?.hasAttribute('data-disabled')).toBe(true);
    expect(marked?.textContent).toContain('Not reachable here');
    expect(marked?.getAttribute('title')).toContain('http://127.0.0.1:4000/v1');
    // only the name dims; the reason keeps its token's contrast
    const spans = [...marked!.querySelectorAll('span')];
    expect(marked!.classList).toContain('data-disabled:opacity-100');
    expect(spans.find((span) => span.textContent === 'Haiku 5.5')!.classList).toContain('opacity-50');
    for (let el: HTMLElement | null = spans.find((span) => span.textContent === 'Not reachable here')!; el && el !== marked; el = el.parentElement) {
      expect(el.classList.contains('opacity-50')).toBe(false);
    }
    marked?.click();
    await flush();
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'setActiveModel', model: 'claude-haiku-5-5' });
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

describe('ModelEffortPopover provider filter', () => {
  const groupNames = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-group"]')].map((group) => group.textContent?.trim());
  const modelOptions = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-option"]')];
  const pickerProviders = (providers: string[] | undefined) =>
    useSettingsStore().setAccountInfo({ dollarBilled: true, ...(providers ? { pickerProviders: providers as never } : {}) });

  beforeEach(() => {
    setActivePinia(createPinia());
    postMessage.mockClear();
    useSettingsStore().setModelState('claude-opus-5-5', 'claude-opus-5-5');
  });

  it('lists every group until core reports the picker providers', async () => {
    pickerProviders(undefined);
    await openMenu();
    expect(groupNames()).toEqual(['Anthropic', 'OpenAI', 'StepFun', 'DeepSeek', 'MiniMax', 'xAI', 'Kimi Code', 'Meta', 'GitHub Copilot']);
  });

  // Copilot's own group keeps the plain names; only flat lists qualify them.
  it('lists GitHub Copilot\'s eight models in a group of their own, by their plain names', async () => {
    pickerProviders(['github-copilot']);
    await openMenu();
    expect(groupNames()).toEqual(['Anthropic', 'GitHub Copilot']);
    expect(modelOptions().slice(1).map((option) => option.textContent?.trim())).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna', 'Gemini 4 Argon', 'Gemini 3.8 Flash']);
  });

  it('keeps a model outside the user\'s plan listed, muted and not pickable, naming the plan', async () => {
    const settings = useSettingsStore();
    const sol = settings.availableModels.find((model) => model.value === 'github-copilot/gpt-6.1-sol')!;
    const luna = settings.availableModels.find((model) => model.value === 'github-copilot/gpt-6-luna')!;
    settings.setAvailableModels([luna, { ...sol, unavailable: { reason: 'not-in-plan', provider: 'github-copilot' } }]);
    await openMenu();
    const marked = modelOptions().find((option) => option.textContent?.includes('GPT-6.1 Sol'));
    expect(marked?.getAttribute('data-unavailable')).toBe('not-in-plan');
    expect(marked?.hasAttribute('data-disabled')).toBe(true);
    expect(marked?.textContent).toContain('Not in your plan');
    expect(marked?.getAttribute('title')).toBe('Your GitHub Copilot plan does not include GPT-6.1 Sol.');
    marked?.click();
    await flush();
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'setActiveModel', model: 'github-copilot/gpt-6.1-sol' });
  });

  // pi sends a Copilot Gemini model no reasoning level, so there is nothing for the control to set.
  it('shows no effort control on a GitHub Copilot Gemini model', async () => {
    const settings = useSettingsStore();
    settings.setModelState('github-copilot/gemini-4-argon', 'github-copilot/gemini-4-argon');
    settings.setPanelThinking({ thinkingDisabled: false, effort: null }, 'github-copilot/gemini-4-argon');
    await openMenu();
    expect(document.body.querySelectorAll('[data-testid="composer-effort-option"]')).toHaveLength(0);
  });

  it('lists only the groups core shows', async () => {
    pickerProviders(['anthropic']);
    await openMenu();
    expect(groupNames()).toEqual(['Anthropic']);
    expect(modelOptions().map((option) => option.textContent?.trim())).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  });

  it('keeps the current model listed and checked when its group is hidden', async () => {
    pickerProviders(['deepseek']);
    await openMenu();
    expect(groupNames()).toEqual(['Anthropic', 'DeepSeek']);
    const listed = modelOptions();
    expect(listed.map((option) => option.textContent?.trim())).toEqual(['Opus 5.5', 'DeepSeek V4 Pro', 'DeepSeek V4.1 Flash']);
    expect(listed[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('says so when no group is shown', async () => {
    useSettingsStore().setModelState('retired-model', 'retired-model');
    pickerProviders([]);
    await openMenu();
    expect(groupNames()).toEqual([]);
    const note = document.body.querySelector<HTMLElement>('[data-testid="composer-no-providers"]')!;
    expect(note.textContent?.trim()).toBe('No providers are shown. Turn one on in Models & accounts.');
    // arrow keys reach only menu items, so the item they reach carries the note
    expect(note.getAttribute('role')).toBe('presentation');
    expect(document.body.querySelector('[data-testid="composer-manage-models"]')?.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('describes Manage models with nothing while groups are shown', async () => {
    await openMenu();
    expect(document.body.querySelector('[data-testid="composer-manage-models"]')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('ends with Manage models, which opens Models & accounts in the panel', async () => {
    await openMenu();
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-menu"] [role^="menuitem"]')];
    const manage = items.at(-1);
    expect(manage?.getAttribute('data-testid')).toBe('composer-manage-models');
    expect(manage?.textContent?.trim()).toBe('Manage models…');
    manage?.click();
    await flush();
    expect(useUIStore().settingsTarget).toEqual({ section: 'accounts' });
  });

  it('asks the host for Models & accounts where settings are not in the panel', async () => {
    const settings = useSettingsStore();
    settings.setHostCapabilities({ ...settings.hostCapabilities, settingsInPanel: false });
    await openMenu();
    document.body.querySelector<HTMLElement>('[data-testid="composer-manage-models"]')?.click();
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'openAppSettings', section: 'accounts' });
  });
});
