// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ModelInfo } from '@shared/types/settings';

type Label = { hostId: string; name: string; computer: string };

// A remote chat's page: main's init names its host as this computer's host store does, and a rename reaches it on onHost.
const page = vi.hoisted(() => {
  const state: { label: Label | undefined; listener: ((label: Label) => void) | undefined } = { label: { hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' }, listener: undefined };
  (globalThis as unknown as { window: Record<string, unknown> }).window ??= {};
  return state;
});

vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: vi.fn() }) }));

window.damoclesBridge = {
  postMessage: vi.fn(),
  onMessage: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
  getHost: () => page.label,
  onHost: (listener) => {
    page.listener = listener;
    return () => undefined;
  },
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  queueAction: () => undefined,
};

const { default: ModelEffortPopover } = await import('../composer/ModelEffortPopover.vue');
const { useSettingsStore } = await import('@/stores/useSettingsStore');
const { i18n } = await import('@/i18n');

enableAutoUnmount(afterEach);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const OPUS: ModelInfo = { value: 'claude-opus-5-5', displayName: 'Claude Opus', description: '' };
const GPT: ModelInfo = { value: 'gpt-6', displayName: 'GPT-6', description: '', backend: 'openai' };
const HOSTED: ModelInfo = { value: 'gpt-6-host', displayName: 'GPT-6 mini', description: '', backend: 'openai', credentialSource: 'host' };

async function openMenu(models: ModelInfo[]): Promise<void> {
  useSettingsStore().setAvailableModels(models);
  useSettingsStore().setModelState('claude-opus-5-5', 'claude-opus-5-5');
  mount(ModelEffortPopover, { attachTo: document.body, global: { plugins: [i18n] } });
  const trigger = document.body.querySelector<HTMLElement>('[data-testid="composer-model"]');
  if (!trigger) throw new Error('no model chip');
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  await nextTick();
}

const heads = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="composer-model-source"]')].map((head) => [head.dataset['credentialSource'], head.textContent?.trim()]);
const optionsIn = (source: string) => [...document.body.querySelectorAll<HTMLElement>(`[role="group"][data-credential-source="${source}"] [data-testid="composer-model-option"]`)].map((option) => option.querySelector('.truncate')?.textContent?.trim());

describe('the model menu of a remote chat whose host runs some models on its own credentials', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
  });

  it('groups the user\'s sign-in and the host\'s environment, each named as this computer names them, with the host model\'s hint', async () => {
    await openMenu([OPUS, GPT, HOSTED]);
    expect(heads()).toEqual([['client', 'Your sign-in · ALEXIOS-PC'], ['host', 'prod-1\'s environment']]);
    expect(optionsIn('client')).toEqual(['Claude Opus', 'GPT-6']);
    expect(optionsIn('host')).toEqual(['GPT-6 mini']);
    const hints = [...document.body.querySelectorAll('[data-testid="composer-model-hint"]')].map((hint) => hint.textContent?.trim());
    expect(hints).toEqual(['Uses prod-1\'s OpenAI credentials. Spend counts under prod-1.']);
    // a host model is picked like any other
    expect(document.body.querySelector('[data-credential-source="host"] [data-testid="composer-model-option"]')?.hasAttribute('data-disabled')).toBe(false);
  });

  it('names the host again after a rename on this computer', async () => {
    await openMenu([OPUS, HOSTED]);
    page.listener?.({ hostId: 'h1', name: 'staging', computer: 'ALEXIOS-PC' });
    await nextTick();
    expect(heads()).toEqual([['client', 'Your sign-in · ALEXIOS-PC'], ['host', 'staging\'s environment']]);
    expect(document.body.querySelector('[data-testid="composer-model-hint"]')?.textContent?.trim()).toBe('Uses staging\'s OpenAI credentials. Spend counts under staging.');
    page.listener?.({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' });
  });

  it('is unchanged while no model comes from the host', async () => {
    await openMenu([OPUS, GPT]);
    expect(heads()).toEqual([]);
    expect(document.body.querySelector('[data-testid="composer-model-hint"]')).toBeNull();
    expect([...document.body.querySelectorAll('[data-testid="composer-model-option"]')]).toHaveLength(2);
  });

  it('says it in Greek', async () => {
    i18n.global.locale.value = 'el';
    await openMenu([OPUS, HOSTED]);
    expect(heads()).toEqual([['client', 'Η σύνδεσή σας · ALEXIOS-PC'], ['host', 'Περιβάλλον του prod-1']]);
  });
});
