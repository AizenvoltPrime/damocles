// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Palette } from 'lucide-vue-next';
import { i18n, initLocaleMessaging } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES, type WebviewToExtensionMessage } from '@shared/types/messages';
import type { SettingsSectionId } from '@shared/settings-sections';
import { settingsViewHandlers, type SettingsHandlerContext } from '@/composables/message-handler/handlers/settings-handlers';
import { useUIStore } from '@/stores/useUIStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';
import SettingsModal from '../SettingsModal.vue';
import SettingsRow from '../SettingsRow.vue';
import { NO_HOST_SETTINGS, type HostSettings } from '../settings-rows';
import { PANEL_HOST_SETTINGS } from '../panel-host-settings';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

let posted: WebviewToExtensionMessage[] = [];
const mounted: VueWrapper[] = [];

const t = (key: string, named?: Record<string, unknown>): string => (named ? i18n.global.t(key, named) : i18n.global.t(key));

async function open(host: HostSettings = NO_HOST_SETTINGS, section?: SettingsSectionId, footer: 'hostSettings' | 'settingsFiles' = 'hostSettings'): Promise<VueWrapper> {
  const wrapper = mount(SettingsModal, {
    props: { host, footer: { kind: footer }, backdrop: 'blur', target: section ? { section } : undefined },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  await nextTick();
  return wrapper;
}

const modal = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="settings-modal"]')!;
const row = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="settings-row-${id}"]`);
const search = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function type(text: string): Promise<void> {
  const input = search();
  input.value = text;
  input.dispatchEvent(new Event('input'));
  await nextTick();
  await nextTick();
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function context(): SettingsHandlerContext {
  return { stores: { settingsStore: useSettingsStore(), uiStore: useUIStore(), extensionUiStore: useExtensionUiStore(), voiceJarvisStore: useVoiceJarvisStore() } };
}

// happy-dom has no Web Animations; the modal's exit awaits Element.animate().finished.
function stubAnimate(animate: (...args: unknown[]) => Animation): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true });
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as WebviewToExtensionMessage));
  document.documentElement.removeAttribute('data-reduced-motion');
});

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SettingsModal structure', () => {
  it('is a labelled modal dialog with a vertical tablist and opens on This chat', async () => {
    await open();
    expect(modal().getAttribute('role')).toBe('dialog');
    expect(modal().getAttribute('aria-modal')).toBe('true');
    const tablist = document.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute('aria-orientation')).toBe('vertical');
    expect(document.querySelector('[data-testid="settings-nav-chat"]')!.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.sm-title')!.textContent).toContain(t('settingsModal.sectionsMeta.chat.label'));
    expect(row('permission-mode')).not.toBeNull();
    expect(document.querySelector(`[aria-label="${t('settingsModal.close')}"]`)).not.toBeNull();
  });

  it('shows host sections only when the host passes them in', async () => {
    const AppearanceRows = defineComponent({ setup: () => () => h(SettingsRow, { id: 'damocles.desktop.theme' }) });
    const host: HostSettings = {
      sections: [{
        id: 'appearance',
        label: 'settingsModal.title',
        subtitle: 'settingsModal.title',
        icon: Palette,
        component: AppearanceRows,
        rows: [{ id: 'damocles.desktop.theme', section: 'appearance', label: 'settingsModal.title', keys: ['damocles.desktop.theme'] }],
      }],
      rows: [],
    };
    await open();
    expect(document.querySelector('[data-testid="settings-nav-appearance"]')).toBeNull();
    mounted.pop()!.unmount();

    await open(host);
    document.querySelector<HTMLElement>('[data-testid="settings-nav-appearance"]')!.click();
    await nextTick();
    expect(row('damocles.desktop.theme')).not.toBeNull();
  });

  it('moves between sections with Up and Down', async () => {
    await open();
    const chat = document.querySelector<HTMLElement>('[data-testid="settings-nav-chat"]')!;
    chat.focus();
    press('ArrowDown', {}, chat);
    await nextTick();
    await nextTick();
    expect(document.querySelector('[data-testid="settings-nav-defaults"]')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('settings-nav-defaults');
  });

  it('staggers only the first 12 rows a query shows', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, voice: true });
    useSettingsStore().setVoiceConfig({ ...useSettingsStore().voiceConfig, mode: 'wake-word' }, false);
    await open();
    await type('zzzz');
    await type('e');
    const delays = [...document.querySelectorAll<HTMLElement>('.sm-row')].map((el) => el.style.getPropertyValue('--sm-row-delay'));
    expect(delays.length).toBeGreaterThan(12);
    expect(delays.slice(0, 3)).toEqual(['0ms', '25ms', '50ms']);
    expect(delays[11]).toBe('275ms');
    expect(delays.slice(12).every((delay) => delay === '0s')).toBe(true);
  });
});

describe('state', () => {
  it('asks once for the whole state, and shows each collapsed account row from the answer', async () => {
    await open(NO_HOST_SETTINGS, 'accounts');
    expect(posted).toEqual([{ type: 'requestSettingsState' }]);
    const ctx = context();
    settingsViewHandlers.claudeAuthStatusChanged({ type: 'claudeAuthStatusChanged', mode: 'allowance' }, ctx);
    settingsViewHandlers.openaiAuthStatusChanged({ type: 'openaiAuthStatusChanged', status: { chatgpt: { signedIn: true }, codex: { signedIn: false }, apikey: { configured: false } }, preferApiKey: false }, ctx);
    settingsViewHandlers.deepseekAuthStatusChanged({ type: 'deepseekAuthStatusChanged', configured: true }, ctx);
    settingsViewHandlers.stepfunAuthStatusChanged({ type: 'stepfunAuthStatusChanged', configured: true }, ctx);
    settingsViewHandlers.openrouterAuthStatusChanged({ type: 'openrouterAuthStatusChanged', configured: true }, ctx);
    settingsViewHandlers.typesafeAuthStatusChanged({ type: 'typesafeAuthStatusChanged', configured: true, memoryJudge: { kind: 'unknown' } }, ctx);
    await nextTick();
    const status = (provider: string): string => row(`account-${provider}`)!.querySelector('[role="status"]')!.textContent!.trim();
    expect(status('anthropic')).toBe(t('claudeAuth.status.allowance'));
    expect(status('openai')).toBe(t('settingsModal.account.signedIn'));
    for (const provider of ['deepseek', 'stepfun', 'openrouter', 'typesafe']) expect(status(provider)).toBe(t('settingsModal.account.keySaved'));
    expect([...document.querySelectorAll('[aria-expanded="true"]')]).toEqual([]);
    expect(posted).toEqual([{ type: 'requestSettingsState' }]);
  });

  it('keeps the results page mounted while the query changes, so nothing is asked for per keystroke', async () => {
    await open();
    await type('budget');
    const budget = row('damocles.maxBudgetUsd');
    await type('budge');
    await type('budg');
    expect(row('damocles.maxBudgetUsd')).toBe(budget);
    expect(posted).toEqual([{ type: 'requestSettingsState' }]);
  });
});

describe('a request while the modal shows', () => {
  it('goes to the section and expands the account row it names, again after the user collapsed it', async () => {
    const wrapper = await open(NO_HOST_SETTINGS, 'chat');
    await type('budget');
    const target = { section: 'accounts', account: 'openai' } as const;
    await wrapper.setProps({ target: { ...target } });
    expect(search().value).toBe('');
    expect(document.querySelector('[data-testid="settings-nav-accounts"]')!.getAttribute('aria-selected')).toBe('true');
    const toggle = row('account-openai')!.querySelector<HTMLElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await wrapper.setProps({ target: { ...target } });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not expand the row again when the user comes back to Accounts on their own', async () => {
    const wrapper = await open();
    await wrapper.setProps({ target: { section: 'accounts', account: 'openai' } });
    document.querySelector<HTMLElement>('[data-testid="settings-nav-defaults"]')!.click();
    await nextTick();
    document.querySelector<HTMLElement>('[data-testid="settings-nav-accounts"]')!.click();
    await nextTick();
    expect(row('account-openai')!.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('search', () => {
  it('filters every section, groups results under section headers and highlights the match', async () => {
    await open();
    await type('budget');
    expect(document.querySelector('.sm-title')!.textContent).toContain(t('settingsModal.searchResults'));
    expect(row('damocles.maxBudgetUsd')).not.toBeNull();
    expect(row('damocles.taskBudget')).not.toBeNull();
    expect(row('permission-mode')).toBeNull();
    const heads = [...document.querySelectorAll('h3.sm-group-head')].map((el) => el.textContent?.trim());
    expect(heads).toContain(t('settingsModal.sectionsMeta.workspace.label'));
    expect(row('damocles.maxBudgetUsd')!.querySelector('mark')!.textContent!.toLowerCase()).toBe('budget');
    expect(document.querySelector('.sm-pill')?.classList.contains('sm-pill-hidden') ?? true).toBe(true);
  });

  it('matches a setting key, as VS Code matches setting ids', async () => {
    await open();
    await type('damocles.cacheWarming');
    expect(row('damocles.cacheWarming')).not.toBeNull();
    expect(document.querySelectorAll('.sm-row')).toHaveLength(1);
  });

  it('shows the empty state for a query nothing matches', async () => {
    await open();
    await type('zzzz');
    expect(document.querySelector('.sm-empty')!.textContent).toContain(t('settingsModal.empty', { q: 'zzzz' }));
  });

  it('focuses the search on Ctrl+F', async () => {
    await open();
    (document.querySelector('[data-testid="settings-nav-chat"]') as HTMLElement).focus();
    const event = press('f', { ctrlKey: true }, document);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search());
  });
});

describe('Escape', () => {
  it('clears a non-empty query first and closes only on an empty one', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    const wrapper = await open();
    await type('budget');
    press('Escape', {}, search());
    await nextTick();
    expect(search().value).toBe('');
    expect(wrapper.emitted('closed')).toBeUndefined();

    press('Escape', {}, search());
    await nextTick();
    expect(wrapper.emitted('closed')).toHaveLength(1);
  });

  it('plays the exit before it reports closed when motion is allowed', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const animate = vi.fn(() => ({ finished }) as unknown as Animation);
    stubAnimate(animate);
    const wrapper = await open();
    document.querySelector<HTMLElement>(`[aria-label="${t('settingsModal.close')}"]`)!.click();
    await nextTick();
    expect(modal().hasAttribute('data-leaving')).toBe(true);
    expect(animate).toHaveBeenCalledWith([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.98)' }], expect.objectContaining({ duration: 160 }));
    expect(wrapper.emitted('closed')).toBeUndefined();
    finish();
    await flush();
    expect(wrapper.emitted('closed')).toHaveLength(1);
  });

  it('reports closed even when the exit animation is cancelled', async () => {
    stubAnimate(() => {
      const finished = Promise.reject(new DOMException('cancelled', 'AbortError'));
      // The Web Animations spec marks a cancelled animation's finished promise as handled.
      finished.catch(() => undefined);
      return { finished } as unknown as Animation;
    });
    const wrapper = await open();
    document.querySelector<HTMLElement>(`[aria-label="${t('settingsModal.close')}"]`)!.click();
    await flush();
    expect(wrapper.emitted('closed')).toHaveLength(1);
  });

  it('leaves Escape to a text field holding an edit, which reverts it', async () => {
    useSettingsStore().setBudgetLimit(5);
    const wrapper = await open(NO_HOST_SETTINGS, 'workspace');
    const input = row('damocles.maxBudgetUsd')!.querySelector('input')!;
    input.value = '9';
    input.dispatchEvent(new Event('input'));
    press('Escape', {}, input);
    await nextTick();
    expect(input.value).toBe('5');
    expect(wrapper.emitted('closed')).toBeUndefined();
    expect(modal().hasAttribute('data-leaving')).toBe(false);
  });
});

describe('controls write their messages', () => {
  it('a switch writes the default YOLO setting', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    row('damocles.dangerouslySkipPermissions')!.querySelector<HTMLElement>('[role="switch"]')!.click();
    expect(posted).toContainEqual({ type: 'setDefaultDangerouslySkipPermissions', enabled: true });
    expect(useSettingsStore().currentSettings.defaultDangerouslySkipPermissions).toBe(true);
  });

  it('a segmented control writes cache warming', async () => {
    await open(NO_HOST_SETTINGS, 'application');
    const idle = [...row('damocles.cacheWarming')!.querySelectorAll<HTMLElement>('button[aria-pressed]')].find((el) => el.textContent?.includes(t('settingsModal.cacheWarming.idle')))!;
    idle.click();
    expect(posted).toContainEqual({ type: 'setCacheWarming', mode: 'idle' });
  });

  it('a select writes the default model', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    const trigger = row('damocles.model')!.querySelector<HTMLElement>('button[role="combobox"]')!;
    press('Enter', {}, trigger);
    await flush();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => !el.hasAttribute('data-state') || el.getAttribute('data-state') !== 'checked')!;
    press('Enter', {}, option);
    await flush();
    expect(posted.some((message) => message.type === 'setDefaultModel')).toBe(true);
  });

  it('a slider saves on release, not on every input event', async () => {
    useSettingsStore().updateAutoCompactConfig({ enabled: true, triggerPercent: 80 });
    await open(NO_HOST_SETTINGS, 'workspace');
    const range = row('damocles.autoCompact.triggerPercent')!.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '70';
    range.dispatchEvent(new Event('input'));
    await nextTick();
    expect(row('damocles.autoCompact.triggerPercent')!.querySelector('output')!.textContent).toBe('70%');
    expect(posted.filter((message) => message.type === 'setAutoCompact')).toHaveLength(0);
    range.dispatchEvent(new Event('change'));
    expect(posted).toContainEqual({ type: 'setAutoCompact', config: { enabled: true, triggerPercent: 70 } });
  });

  it('a text input saves on Enter and shows an inline error for invalid input', async () => {
    await open(NO_HOST_SETTINGS, 'workspace');
    const input = row('damocles.maxBudgetUsd')!.querySelector('input')!;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    press('Enter', {}, input);
    await nextTick();
    expect(row('damocles.maxBudgetUsd')!.querySelector('[data-testid="setting-invalid"]')).not.toBeNull();
    expect(posted.filter((message) => message.type === 'setBudgetLimit')).toHaveLength(0);

    input.value = '2.50';
    input.dispatchEvent(new Event('input'));
    press('Enter', {}, input);
    expect(posted).toContainEqual({ type: 'setBudgetLimit', budgetUsd: 2.5 });
  });

  it('disables the Workspace rows in a folder core cannot write, and offers the chat\'s trust action', async () => {
    useSettingsStore().setWorkspaceWritable(false);
    await open(NO_HOST_SETTINGS, 'workspace');
    expect(row('damocles.maxBudgetUsd')!.querySelector('input')!.disabled).toBe(true);
    expect(row('damocles.taskBudget')!.querySelector('input')!.disabled).toBe(true);
    expect(row('damocles.autoCompact')!.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    const notice = document.querySelector<HTMLElement>('[data-testid="settings-workspace-untrusted"]')!;
    expect(notice.textContent).toContain(t('settingsModal.workspaceUntrusted'));
    notice.querySelector('button')!.click();
    expect(posted).toContainEqual({ type: 'setProjectTrusted' });
  });

  it('points the desktop modal, which may not send the trust request, at the Projects list', async () => {
    const store = useSettingsStore();
    store.setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false });
    store.setWorkspaceWritable(false);
    await open(NO_HOST_SETTINGS, 'workspace');
    const notice = document.querySelector<HTMLElement>('[data-testid="settings-workspace-untrusted"]')!;
    expect(notice.textContent).toContain(t('settingsModal.workspaceUntrustedProjects'));
    expect(notice.querySelector('button')).toBeNull();
  });

  it('an account row opens its sign-in panel with a password field', async () => {
    await open(NO_HOST_SETTINGS);
    document.querySelector<HTMLElement>('[data-testid="settings-nav-accounts"]')!.click();
    await nextTick();
    const button = row('account-deepseek')!.querySelector<HTMLElement>('button[aria-expanded]')!;
    button.click();
    await nextTick();
    const key = row('account-deepseek')!.querySelector<HTMLInputElement>('input')!;
    expect(key.type).toBe('password');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('save feedback', () => {
  it('names the scope a confirmed write landed in, with the file in its title', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    row('damocles.dangerouslySkipPermissions')!.querySelector<HTMLElement>('[role="switch"]')!.click();
    settingsViewHandlers.settingWriteResult({ type: 'settingWriteResult', key: 'damocles.dangerouslySkipPermissions', ok: true, scope: 'user', file: '/home/u/.damocles/settings.json' }, context());
    await nextTick();
    const saved = row('damocles.dangerouslySkipPermissions')!.querySelector('[data-testid="setting-saved"]')!;
    expect(saved.textContent).toContain(t('settingsModal.savedTo', { file: t('settingsModal.scopeFile.user') }));
    expect(saved.getAttribute('title')).toBe('/home/u/.damocles/settings.json');
    expect(saved.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('reverts the control and shows the error when the write fails', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    const toggle = row('damocles.dangerouslySkipPermissions')!.querySelector<HTMLElement>('[role="switch"]')!;
    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    settingsViewHandlers.settingWriteResult({ type: 'settingWriteResult', key: 'damocles.dangerouslySkipPermissions', ok: false, error: 'EACCES' }, context());
    await nextTick();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(row('damocles.dangerouslySkipPermissions')!.querySelector('[data-testid="setting-error"]')!.textContent).toContain('EACCES');
  });

  it('settles two quick writes to one key in order, keeping the confirmed value when the second fails', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    const toggle = row('damocles.dangerouslySkipPermissions')!.querySelector<HTMLElement>('[role="switch"]')!;
    toggle.click();
    await nextTick();
    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const ctx = context();
    settingsViewHandlers.settingWriteResult({ type: 'settingWriteResult', key: 'damocles.dangerouslySkipPermissions', ok: true, scope: 'user', file: '/home/u/.damocles/settings.json' }, ctx);
    settingsViewHandlers.settingWriteResult({ type: 'settingWriteResult', key: 'damocles.dangerouslySkipPermissions', ok: false, error: 'EACCES' }, ctx);
    await nextTick();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('when the first of two quick writes fails, the second decides, and both failing restores the value before them', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    const toggle = row('damocles.dangerouslySkipPermissions')!.querySelector<HTMLElement>('[role="switch"]')!;
    toggle.click();
    await nextTick();
    toggle.click();
    await nextTick();
    const fail = { type: 'settingWriteResult', key: 'damocles.dangerouslySkipPermissions', ok: false, error: 'EACCES' } as const;
    settingsViewHandlers.settingWriteResult(fail, context());
    await nextTick();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    settingsViewHandlers.settingWriteResult(fail, context());
    await nextTick();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(useSettingsStore().currentSettings.defaultDangerouslySkipPermissions).toBe(false);
  });

  it('names a project file that supplies a value in the source badge', async () => {
    const store = useSettingsStore();
    store.updateSettings(store.currentSettings, { 'damocles.maxBudgetUsd': { scope: 'local', path: '/w/a/.damocles/settings.local.json', value: 4 } });
    await open(NO_HOST_SETTINGS, 'workspace');
    expect(row('damocles.maxBudgetUsd')!.querySelector('[data-testid="setting-source"]')!.textContent).toContain('.damocles/settings.local.json');
  });
});

describe('VS Code host rows', () => {
  it('switches the chat panel language at once and stores the choice through the extension', async () => {
    const before = i18n.global.locale.value;
    initLocaleMessaging((message) => void posted.push(message));
    try {
      await open(PANEL_HOST_SETTINGS, 'application');
      await vi.waitFor(() => expect(row('chat-panel-language')).not.toBeNull());
      const greek = [...row('chat-panel-language')!.querySelectorAll<HTMLElement>('button[aria-pressed]')].find((el) => el.textContent?.includes('Ελληνικά'))!;
      greek.click();
      await nextTick();
      expect(i18n.global.locale.value).toBe('el');
      expect(posted).toContainEqual({ type: 'setLanguagePreference', locale: 'el' });
    } finally {
      i18n.global.locale.value = before;
    }
  });
});

const DESKTOP_CAPABILITIES = { ...VSCODE_HOST_CAPABILITIES, voice: false, hostSpeechExtensions: false, hostSettingsEditor: false, settingsSources: true, monaco: true, ideContext: false, settingsInPanel: false } as const;

describe('shared controls', () => {
  it('draws the nav pill and the segmented thumb with the shared sliding indicator', async () => {
    await open(NO_HOST_SETTINGS, 'application');
    expect(document.querySelector('[role="tablist"] [data-testid="sliding-indicator"]')).not.toBeNull();
    expect(row('damocles.cacheWarming')!.querySelector('[data-testid="sliding-indicator"]')).not.toBeNull();
  });

  it('renders each settings switch as the shared switch', async () => {
    await open(NO_HOST_SETTINGS, 'defaults');
    const toggle = row('damocles.dangerouslySkipPermissions')!.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
    expect(toggle.getAttribute('aria-label')).toBe(t('settingsModal.rows.defaultYolo.label'));
  });
});

describe('auto-compact rows', () => {
  it('shows the setting\'s Saved hint and source badge on its own row only, and the slider\'s chip names its field', async () => {
    const store = useSettingsStore();
    store.updateAutoCompactConfig({ enabled: true, triggerPercent: 80 });
    store.updateSettings(store.currentSettings, { 'damocles.autoCompact': { scope: 'local', path: '/w/a/.damocles/settings.local.json', value: { enabled: true } } });
    await open(NO_HOST_SETTINGS, 'workspace');
    const setting = row('damocles.autoCompact')!;
    const slider = row('damocles.autoCompact.triggerPercent')!;
    const chip = (el: HTMLElement): string => el.querySelector('.sm-badge:not(.sm-badge-file)')!.textContent!.trim();
    expect(chip(setting)).toBe('damocles.autoCompact');
    expect(chip(slider)).toBe('damocles.autoCompact.triggerPercent');
    expect(setting.querySelector('[data-testid="setting-source"]')).not.toBeNull();
    expect(slider.querySelector('[data-testid="setting-source"]')).toBeNull();

    const range = slider.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '70';
    range.dispatchEvent(new Event('input'));
    range.dispatchEvent(new Event('change'));
    settingsViewHandlers.settingWriteResult({ type: 'settingWriteResult', key: 'damocles.autoCompact', ok: true, scope: 'local', file: '/w/a/.damocles/settings.local.json' }, context());
    await nextTick();
    expect(setting.querySelector('[data-testid="setting-saved"]')).not.toBeNull();
    expect(slider.querySelector('[data-testid="setting-saved"]')).toBeNull();
  });
});

describe('values from settings files', () => {
  const PROJECT = '/w/a/.damocles/settings.json';

  it('lists in Workspace each file value no shown row writes, with its value and file, and opens the file as the footer does', async () => {
    const store = useSettingsStore();
    store.setHostCapabilities(DESKTOP_CAPABILITIES);
    store.updateSettings(store.currentSettings, {
      'damocles.maxTurns': { scope: 'project', path: PROJECT, value: 7 },
      'damocles.maxBudgetUsd': { scope: 'local', path: '/w/a/.damocles/settings.local.json', value: 3 },
      'damocles.voice.mode': { scope: 'project', path: PROJECT, value: 'wake-word' },
    });
    const wrapper = await open(NO_HOST_SETTINGS, 'workspace', 'settingsFiles');
    const entries = [...document.querySelectorAll<HTMLElement>('[data-testid="settings-file-value"]')];
    // Voice has rows, but its section is hidden on a host without a voice path.
    expect(entries.map((entry) => entry.dataset['key'])).toEqual(['damocles.maxTurns', 'damocles.voice.mode']);
    expect(entries[0]!.textContent).toContain('7');
    expect(entries[1]!.textContent).toContain('"wake-word"');
    expect(entries[0]!.querySelector('[data-testid="setting-source"]')!.textContent).toContain('.damocles/settings.json');
    expect(row('damocles.maxBudgetUsd')!.querySelector('[data-testid="setting-source"]')).not.toBeNull();

    const openFile = entries[0]!.querySelector<HTMLButtonElement>('button')!;
    expect(openFile.textContent).toContain(t('settingsModal.fileValues.open'));
    expect(openFile.textContent).toContain(PROJECT);
    openFile.click();
    expect(wrapper.emitted('editSettingsFile')).toEqual([['project']]);
  });

  it('shows no list when every file value has a row, nor while a search runs', async () => {
    const store = useSettingsStore();
    store.setHostCapabilities(DESKTOP_CAPABILITIES);
    store.updateSettings(store.currentSettings, { 'damocles.maxBudgetUsd': { scope: 'local', path: '/w/a/.damocles/settings.local.json', value: 3 } });
    await open(NO_HOST_SETTINGS, 'workspace');
    expect(document.querySelector('[data-testid="settings-file-values"]')).toBeNull();

    store.updateSettings(store.currentSettings, { 'damocles.maxTurns': { scope: 'project', path: PROJECT, value: 7 } });
    await nextTick();
    expect(document.querySelector('[data-testid="settings-file-values"]')).not.toBeNull();
    await type('budget');
    expect(document.querySelector('[data-testid="settings-file-values"]')).toBeNull();
  });
});

describe('Edit settings.json menu', () => {
  const footer = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="settings-footer"]')!;
  const item = (scope: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="settings-edit-json-${scope}"]`)!;

  async function openMenu(): Promise<void> {
    footer().focus();
    press('Enter', {}, footer());
    await flush();
  }

  function availability(project: 'available' | 'untrusted', local: 'available' | 'noProject'): void {
    settingsViewHandlers.settingsFileAvailability({
      type: 'settingsFileAvailability',
      files: {
        user: { available: true },
        project: project === 'available' ? { available: true } : { available: false, reason: 'untrusted' },
        local: local === 'available' ? { available: true } : { available: false, reason: 'noProject' },
      },
    }, context());
  }

  beforeEach(() => useSettingsStore().setHostCapabilities(DESKTOP_CAPABILITIES));

  it('disables a file the host says does not apply, with its reason, and enables it again on the next update', async () => {
    availability('untrusted', 'noProject');
    await open(NO_HOST_SETTINGS, 'chat', 'settingsFiles');
    await openMenu();
    expect(item('project').hasAttribute('data-disabled')).toBe(true);
    expect(item('project').textContent).toContain(t('settings.jsonFiles.untrusted'));
    expect(item('local').textContent).toContain(t('settings.jsonFiles.noProject'));
    expect(item('user').hasAttribute('data-disabled')).toBe(false);

    availability('available', 'available');
    await nextTick();
    expect(item('project').hasAttribute('data-disabled')).toBe(false);
    expect(item('project').textContent).not.toContain(t('settings.jsonFiles.untrusted'));
  });

  it('moves with the arrow keys and by type-ahead, and opens the chosen file', async () => {
    availability('available', 'available');
    const wrapper = await open(NO_HOST_SETTINGS, 'chat', 'settingsFiles');
    await openMenu();
    expect(document.activeElement).toBe(item('user'));
    press('ArrowDown');
    await nextTick();
    expect(document.activeElement).toBe(item('project'));
    press('e');
    await nextTick();
    expect(document.activeElement).toBe(item('local'));
    press('Enter');
    await flush();
    expect(wrapper.emitted('editSettingsFile')).toEqual([['local']]);
  });

  it('closes on a press outside it', async () => {
    availability('available', 'available');
    await open(NO_HOST_SETTINGS, 'chat', 'settingsFiles');
    await openMenu();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // reka listens for an outside press only from the task after the menu opens.
    await flush();
    document.querySelector<HTMLElement>('.sm-title')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    await flush();
    await flush();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('image generation', () => {
  const IMAGE = { enabled: false, model: 'a/img', imageModels: [{ id: 'a/img', name: 'Image A' }, { id: 'b/img', name: 'Image B' }], openRouterConfigured: true };

  it('shows its rows only once core sends the settings, without asking for them itself', async () => {
    await open(NO_HOST_SETTINGS, 'integrations');
    expect(row('damocles.imageGeneration.enabled')).toBeNull();
    expect(row('damocles.imageGeneration.model')).toBeNull();
    settingsViewHandlers.imageGenerationSettings({ type: 'imageGenerationSettings', settings: IMAGE }, context());
    await nextTick();
    expect(row('damocles.imageGeneration.enabled')).not.toBeNull();
    expect(row('damocles.imageGeneration.model')).not.toBeNull();
    expect(posted).toEqual([{ type: 'requestSettingsState' }]);
  });

  it('posts the model chosen with the keyboard', async () => {
    useSettingsStore().setImageGeneration(IMAGE);
    await open(NO_HOST_SETTINGS, 'integrations');
    const trigger = row('damocles.imageGeneration.model')!.querySelector<HTMLElement>('button[role="combobox"]')!;
    trigger.focus();
    press('Enter', {}, trigger);
    await flush();
    press('ArrowDown');
    await flush();
    press('Enter');
    await flush();
    expect(posted).toContainEqual({ type: 'setImageGenerationModel', model: 'b/img' });
  });

  it('names a model the catalog lacks and says when an OpenRouter key is needed', async () => {
    useSettingsStore().setImageGeneration({ ...IMAGE, model: 'gone/img', openRouterConfigured: false });
    await open(NO_HOST_SETTINGS, 'integrations');
    expect(row('damocles.imageGeneration.model')!.textContent).toContain(t('settings.imageGeneration.unknownModel', { model: 'gone/img' }));
    expect(row('damocles.imageGeneration.enabled')!.textContent).toContain(t('settingsModal.imageNeedsKey'));
  });
});

describe('workspace folder rows', () => {
  const A: WorkspaceFolderInfo = { key: '/w/a', name: 'a', label: 'alpha', path: '/w/a' };
  const B: WorkspaceFolderInfo = { key: '/w/b', name: 'b', label: 'beta', path: '/w/b' };
  const folderSelect = (): HTMLButtonElement => row('workspace-folder')!.querySelector<HTMLButtonElement>('button[role="combobox"]')!;

  it('hides the chat folder row with no folder, and with one folder disables it and hides the default folder row', async () => {
    await open();
    expect(row('workspace-folder')).toBeNull();
    mounted.pop()!.unmount();

    useSettingsStore().setWorkspaceFolders([A], A.key, A.key);
    await open();
    expect(folderSelect().disabled).toBe(true);
    document.querySelector<HTMLElement>('[data-testid="settings-nav-defaults"]')!.click();
    await nextTick();
    expect(row('default-workspace-folder')).toBeNull();
  });

  it('keeps showing the old folder until core confirms the switch, and allows no second switch meanwhile', async () => {
    const store = useSettingsStore();
    store.setWorkspaceFolders([A, B], A.key, A.key);
    await open();
    folderSelect().focus();
    press('Enter', {}, folderSelect());
    await flush();
    press('ArrowDown');
    await flush();
    press('Enter');
    await flush();
    expect(posted).toContainEqual({ type: 'setPanelWorkspaceFolder', folderKey: B.key });
    expect(folderSelect().textContent).toContain('alpha');
    expect(folderSelect().disabled).toBe(true);
    store.requestPanelWorkspaceFolder(A.key);
    expect(posted.filter((message) => message.type === 'setPanelWorkspaceFolder')).toHaveLength(1);

    settingsViewHandlers.workspaceFolderUpdate({ type: 'workspaceFolderUpdate', folders: [A, B], panelFolderKey: B.key, defaultFolderKey: A.key }, context());
    await nextTick();
    expect(folderSelect().textContent).toContain('beta');
    expect(folderSelect().disabled).toBe(false);
  });
});

describe('Prefer API key', () => {
  it('toggles from its label text, which names the switch', async () => {
    await open(NO_HOST_SETTINGS, 'accounts');
    settingsViewHandlers.openaiAuthStatusChanged({ type: 'openaiAuthStatusChanged', status: { chatgpt: { signedIn: true }, codex: { signedIn: false }, apikey: { configured: true } }, preferApiKey: false }, context());
    row('account-openai')!.querySelector<HTMLElement>('button[aria-expanded]')!.click();
    await nextTick();
    const toggle = document.querySelector<HTMLElement>('[data-testid="openai-prefer-api-key"]')!;
    expect(toggle.hasAttribute('aria-label')).toBe(false);
    const label = document.getElementById(toggle.getAttribute('aria-labelledby')!)!;
    expect(label.textContent!.trim()).toBe(t('openai.preferApiKey.label'));
    label.click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'setOpenAIPreferApiKey', preferApiKey: true }));
  });
});

describe('Remove all voice files', () => {
  async function voiceFiles(): Promise<HTMLElement> {
    const store = useSettingsStore();
    store.setVoiceConfig({ ...store.voiceConfig, mode: 'push-to-talk' }, false);
    await open(NO_HOST_SETTINGS, 'voice');
    const remove = document.querySelector<HTMLElement>('[data-testid="voice-remove-all"]')!;
    remove.focus();
    remove.click();
    await flush();
    await flush();
    return remove;
  }

  it('asks in an alert dialog that takes focus and hands it back on Cancel', async () => {
    const remove = await voiceFiles();
    const dialog = document.querySelector<HTMLElement>('[data-testid="voice-remove-all-confirm"]')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.querySelector<HTMLElement>('[data-testid="confirm-cancel"]')!.click();
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="voice-remove-all-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(posted.some((message) => message.type === 'voiceRemoveAllFiles')).toBe(false);
  });

  it('removes the files only once confirmed', async () => {
    await voiceFiles();
    document.querySelector<HTMLElement>('[data-testid="voice-remove-all-confirm"] [data-testid="confirm-action"]')!.click();
    expect(posted).toContainEqual({ type: 'voiceRemoveAllFiles' });
  });
});
