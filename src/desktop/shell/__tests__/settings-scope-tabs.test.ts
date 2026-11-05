// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { OverlaySettingsScope, OverlaySettingsScopes, PopupAnswer } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import shellEl from '../locales/el.json';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const HOST = 'A very long host name that goes on well past the width of a tab';
const scopes = (active: OverlaySettingsScope): OverlaySettingsScopes => ({ host: { name: HOST }, projectFile: '/srv/app/.damocles/settings.json', active });
const mounted: VueWrapper[] = [];
let pinia: Pinia;

async function openOn(active: OverlaySettingsScope, section: 'chat' | 'defaults' | 'integrations' = 'chat'): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section, scopes: scopes(active) });
  await flushPromises();
}

// core's first settingsUpdate to a scoped view carries the keys that tab may write
async function update(writableKeys: string[] | undefined): Promise<void> {
  const store = useSettingsStore();
  api.settingsMessage({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false } });
  api.settingsMessage({ type: 'settingsUpdate', settings: store.currentSettings, workspaceWritable: true, ...(writableKeys ? { writableKeys } : {}) });
  await flushPromises();
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const tab = (name: 'user' | 'host' | 'project'): HTMLElement => q(`[data-testid="settings-scope-${name}"]`)!;
const row = (id: string): HTMLElement | null => q(`[data-testid="settings-row-${id}"]`);
const press = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
// reka selects a tab on a primary-button mousedown
const choose = (target: HTMLElement): void => {
  target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
};

// the frames a leaving banner's transition waits for before it finishes
async function frames(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await flushPromises();
  }
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.mocked(api.setSettingsScope).mockReset();
  vi.mocked(api.setSettingsScope).mockImplementation(async (scope) => ({ ok: true, value: scope }));
  vi.mocked(api.signInScopeHost).mockClear();
  document.documentElement.setAttribute('data-reduced-motion', '');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('settings scope tabs', () => {
  it('lists the remote chat\'s own rows on its host tab, and on the User tab points to that tab instead of editing another chat', async () => {
    await openOn('machine');
    expect(q('[data-testid="settings-scope-loading"]')!.textContent).toContain(`Loading the ${HOST} settings`);
    expect(row('permission-mode')).toBeNull();
    await update(['damocles.model']);
    expect(row('permission-mode')).not.toBeNull();
    expect(q('[data-testid="settings-scope-banner"]')!.textContent).toContain(`Changes only this chat on ${HOST}`);

    api.settingsAttached(2, scopes('user'));
    await update(undefined);
    expect(row('permission-mode')).toBeNull();
    expect(row('model')).toBeNull();
    expect(q('[data-testid="settings-scope-empty"]')!.textContent).toBe(`This chat runs on ${HOST}. Change its settings on the ${HOST} tab.`);
  });

  it('lists nothing while a tab click waits for main, and goes back to the attached tab, saying so, when main cannot attach it', async () => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    expect(row('damocles.model')).not.toBeNull();
    let refuse!: (error: Error) => void;
    vi.mocked(api.setSettingsScope).mockImplementationOnce(() => new Promise<PopupAnswer<OverlaySettingsScope>>((_resolve, reject) => { refuse = reject; }));
    choose(tab('project'));
    await flushPromises();
    expect(api.setSettingsScope).toHaveBeenCalledWith('project');
    expect(tab('project').getAttribute('aria-selected')).toBe('true');
    expect(row('damocles.model')).toBeNull();
    expect(q('[data-testid="settings-scope-banner"]')).toBeNull();
    expect(q('[data-testid="settings-scope-loading"]')!.textContent).toContain('Loading the Project settings');

    refuse(new Error('The settings of that tab could not be opened'));
    await flushPromises();
    expect(tab('host').getAttribute('aria-selected')).toBe('true');
    expect(row('damocles.model')).not.toBeNull();
    expect(q('[data-testid="settings-scope-failed"]')!.textContent).toBe('The Project settings could not be opened.');
    expect(q('[data-testid="settings-scope-failed"]')!.getAttribute('role')).toBe('status');
  });

  it('shows the desktop app\'s own sections and Voice only on the User tab, and offers each tab\'s own settings files', async () => {
    await openOn('machine');
    expect(q('[data-testid="settings-nav-voice"]')).toBeNull();
    await update(['damocles.model']);
    expect(q('[data-testid="settings-nav-appearance"]')).toBeNull();
    expect(q('[data-testid="settings-nav-voice"]')).toBeNull();
    const files = async (): Promise<string[]> => {
      const footer = q('[data-testid="settings-footer"]')!;
      footer.focus();
      press(footer, 'Enter');
      await flushPromises();
      const items = [...document.querySelectorAll<HTMLElement>('[data-testid^="settings-edit-json-"]')].map((item) => `${item.dataset.testid!.slice('settings-edit-json-'.length)}: ${item.textContent!.trim()}`);
      press(document.activeElement as HTMLElement, 'Escape');
      await flushPromises();
      return items;
    };
    expect(await files()).toEqual([`user: Edit settings.json on ${HOST}`]);

    api.settingsAttached(2, scopes('project'));
    await update(['damocles.maxBudgetUsd']);
    expect(q('[data-testid="settings-nav-voice"]')).toBeNull();
    expect(await files()).toEqual(['project: Edit project settings.json', 'local: Edit local settings.local.json']);

    api.settingsAttached(3, scopes('user'));
    await update(undefined);
    expect(q('[data-testid="settings-nav-appearance"]')).not.toBeNull();
    expect(q('[data-testid="settings-nav-voice"]')).not.toBeNull();
    expect(await files()).toEqual(['user: Edit user settings.json']);
  });

  it.each([
    ['machine', `Not reachable from ${HOST}`],
    ['user', 'Not reachable here'],
  ] as const)('on the %s tab names the chat a loopback model cannot be reached from', async (active, hint) => {
    await openOn(active, 'defaults');
    await update(active === 'user' ? undefined : ['damocles.model']);
    const models = useSettingsStore().availableModels.map((model) => (model.value === 'step-5-preview' ? { ...model, unavailable: { reason: 'loopback-endpoint' as const, endpoint: 'http://127.0.0.1:8080' } } : model));
    api.settingsMessage({ type: 'availableModels', models });
    await flushPromises();
    const select = row('damocles.model')!.querySelector<HTMLElement>('button[aria-label="Default model"]')!;
    select.focus();
    press(select, 'Enter');
    await flushPromises();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent!.includes('Step 5 Preview'))!;
    expect(option.textContent).toContain(hint);
  });

  it("keeps a waiting tab's page mounted and inert under its host's banner, and lifts both once main attached it again", async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    const field = row('damocles.model')!;
    const content = q('[data-testid="settings-content"]')!;
    expect(content.hasAttribute('inert')).toBe(false);

    api.settingsAway('reconnecting');
    await flushPromises();
    const banner = q('[data-testid="settings-scope-away"]')!;
    expect(banner.textContent!.trim()).toBe(`Reconnecting to ${HOST}…`);
    expect(banner.closest('[role="status"], [aria-live]')).toBeNull();
    const announcement = q('[data-testid="settings-scope-away-announcement"]')!;
    expect(announcement.getAttribute('role')).toBe('status');
    expect(announcement.textContent!.trim()).toBe(`Reconnecting to ${HOST}…`);
    expect(announcement.closest('[aria-busy]')).toBeNull();
    expect(q('[data-testid="settings-scope-away-user"]')).toBeNull();
    expect(content.hasAttribute('inert')).toBe(true);
    expect(content.getAttribute('aria-busy')).toBe('true');
    expect(content.contains(banner)).toBe(false);
    expect(q('[role="tabpanel"]')!.hasAttribute('aria-busy')).toBe(false);
    expect(tab('project').getAttribute('aria-selected')).toBe('true');
    expect(row('damocles.model')).toBe(field);

    // the same tab of the same project attaches again: the page stays mounted
    api.settingsAttached(2, scopes('project'));
    api.settingsAway(null);
    await update(['damocles.model']);
    await frames();
    expect(q('[data-testid="settings-scope-away"]')).toBeNull();
    expect(announcement.textContent!.trim()).toBe('');
    expect(content.hasAttribute('inert')).toBe(false);
    expect(content.hasAttribute('aria-busy')).toBe(false);
    expect(row('damocles.model')).toBe(field);
  });

  it.each([
    ['restarting', `Restarting the engine on ${HOST}`, false],
    ['halted', `Engine stopped on ${HOST}`, true],
  ] as const)('names a %s engine on the host of the waiting tab', async (state, text, offersUser) => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    api.settingsAway(state);
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(text);
    expect(q('[data-testid="settings-scope-away-user"]') !== null).toBe(offersUser);
  });

  it.each([
    ['signIn', `${HOST} is waiting for you to sign in`],
    ['failed', `Couldn't reconnect to ${HOST}`],
  ] as const)("says the %s host of the waiting tab in the words of its chat's connection banner, and offers the User tab", async (state, text) => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway(state);
    await flushPromises();
    expect(q('[data-testid="settings-scope-away"]')!.dataset.state).toBe(state);
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(text);
    expect(q('[data-testid="settings-scope-away-announcement"]')!.textContent!.trim()).toBe(text);
    expect(q('[data-testid="settings-scope-away-user"]')!.textContent!.trim()).toBe('Show User settings');
    expect(q('[data-testid="settings-scope-away-sign-in"]') !== null).toBe(state === 'signIn');
  });

  it("says the update banner offers its host's switch, points to that banner and offers the User tab, never the switch itself", async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway({ state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 2 } });
    await flushPromises();
    const banner = q('[data-testid="settings-scope-away"]')!;
    expect(banner.dataset.state).toBe('switchOffered');
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(`${HOST} is running 2 agents on Damocles 3.7.0`);
    expect(q('[data-testid="settings-scope-away-hint"]')!.textContent).toBe('Close Settings to choose when to switch, on the banner at the top of the chat.');
    expect(q('[data-testid="settings-scope-away-announcement"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(`${HOST} is running 2 agents on Damocles 3.7.0 Close Settings to choose when to switch, on the banner at the top of the chat.`);
    expect(q('[data-testid="settings-scope-away-user"]')!.textContent!.trim()).toBe('Show User settings');
    expect(banner.textContent).not.toContain('Switch now');
    expect(q('[data-testid="settings-content"]')!.hasAttribute('inert')).toBe(true);

    api.settingsAway({ state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 1 } });
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(`${HOST} is running 1 agent on Damocles 3.7.0`);
  });

  it('says the offered switch in Greek with the host\'s article', async () => {
    await openOn('machine', 'defaults');
    shellI18n.global.mergeLocaleMessage('el', shellEl);
    shellI18n.global.locale.value = 'el';
    api.settingsAway({ state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 2 } });
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(`Στο ${HOST} τρέχουν 2 agents στο Damocles 3.7.0`);
    expect(q('[data-testid="settings-scope-away-hint"]')!.textContent).toBe('Κλείστε τις Ρυθμίσεις για να επιλέξετε πότε θα γίνει η μετάβαση, από το μήνυμα στην κορυφή της συνομιλίας.');
  });

  it("lets a refused sign-in reach the page's error handler, and takes a closed answer as nothing to do", async () => {
    const errors: unknown[] = [];
    mounted.push(mount(OverlayApp, {
      props: { api, settingsBridge },
      global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false }, config: { errorHandler: (err) => { errors.push(err); } } },
      attachTo: document.body,
    }));
    await flushPromises();
    api.request('s1', { kind: 'settings', generation: 1, section: 'defaults', scopes: scopes('machine') });
    await flushPromises();
    api.settingsAway('signIn');
    await flushPromises();
    vi.mocked(api.signInScopeHost).mockResolvedValueOnce({ ok: false, reason: 'closed' });
    q('[data-testid="settings-scope-away-sign-in"]')!.click();
    await flushPromises();
    expect(errors).toEqual([]);
    vi.mocked(api.signInScopeHost).mockRejectedValueOnce(new Error('Malformed sign-in request'));
    q('[data-testid="settings-scope-away-sign-in"]')!.click();
    await flushPromises();
    expect(errors).toEqual([new Error('Malformed sign-in request')]);
  });

  it("offers the host's own sign-in from the banner of a host that waits for it", async () => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('signIn');
    await flushPromises();
    const signIn = q('[data-testid="settings-scope-away-sign-in"]')!;
    expect(signIn.textContent!.trim()).toBe(`Sign in to ${HOST}`);
    signIn.click();
    await flushPromises();
    expect(api.signInScopeHost).toHaveBeenCalledTimes(1);
  });

  it('names the sign-in of the waiting host in Greek with its article', async () => {
    await openOn('machine', 'defaults');
    shellI18n.global.mergeLocaleMessage('el', shellEl);
    shellI18n.global.locale.value = 'el';
    api.settingsAway('signIn');
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(`Το ${HOST} περιμένει να συνδεθείτε`);
    expect(q('[data-testid="settings-scope-away-sign-in"]')!.textContent!.trim()).toBe(`Σύνδεση στο ${HOST}`);
  });

  it.each([
    ['offline', 'reconnecting'],
    ['halted', 'restarting'],
  ] as const)('moves focus to the selected tab when Show User settings leaves as the banner turns from %s to %s on its own', async (from, to) => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway(from);
    await flushPromises();
    const showUser = q('[data-testid="settings-scope-away-user"]')!;
    showUser.focus();
    expect(document.activeElement).toBe(showUser);
    api.settingsAway(to);
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-user"]')).toBeNull();
    expect(document.activeElement).toBe(tab('project'));
  });

  it('keeps focus on Show User settings when the banner turns from offline to failed, which offers it too', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('offline');
    await flushPromises();
    const showUser = q('[data-testid="settings-scope-away-user"]')!;
    showUser.focus();
    api.settingsAway('failed');
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-user"]')).toBe(showUser);
    expect(document.activeElement).toBe(showUser);
  });

  it('moves focus to the selected tab when the sign-in it was on leaves, and keeps it on Show User settings', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('signIn');
    await flushPromises();
    q('[data-testid="settings-scope-away-user"]')!.focus();
    api.settingsAway('failed');
    await flushPromises();
    expect(document.activeElement).toBe(q('[data-testid="settings-scope-away-user"]'));

    api.settingsAway('signIn');
    await flushPromises();
    q('[data-testid="settings-scope-away-sign-in"]')!.focus();
    api.settingsAway('failed');
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-sign-in"]')).toBeNull();
    expect(document.activeElement).toBe(tab('project'));
  });

  it('opens the User tab from Show User settings while a tab clicked before still waits for main, the later choice winning', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('offline');
    await flushPromises();
    let answerHost!: () => void;
    vi.mocked(api.setSettingsScope).mockImplementationOnce((scope) => new Promise<PopupAnswer<OverlaySettingsScope>>((resolve) => { answerHost = () => resolve({ ok: true, value: scope }); }));
    choose(tab('host'));
    await flushPromises();
    vi.mocked(api.setSettingsScope).mockImplementationOnce(async (scope) => {
      api.settingsAttached(3, scopes(scope));
      api.settingsAway(null);
      return { ok: true, value: scope };
    });
    q('[data-testid="settings-scope-away-user"]')!.click();
    await flushPromises();
    expect(vi.mocked(api.setSettingsScope).mock.calls.map(([scope]) => scope)).toEqual(['machine', 'user']);
    // main answers the earlier click late; the later one stays
    answerHost();
    await flushPromises();
    expect(tab('user').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('user'));
  });

  it('sends a tab clicked while another click waits for main, and keeps only the later answer', async () => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    let answerProject!: () => void;
    vi.mocked(api.setSettingsScope).mockImplementationOnce((scope) => new Promise<PopupAnswer<OverlaySettingsScope>>((resolve) => { answerProject = () => resolve({ ok: true, value: scope }); }));
    choose(tab('project'));
    await flushPromises();
    choose(tab('host'));
    await flushPromises();
    expect(vi.mocked(api.setSettingsScope).mock.calls.map(([scope]) => scope)).toEqual(['project', 'machine']);
    answerProject();
    await flushPromises();
    expect(tab('host').getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="settings-scope-loading"]')).toBeNull();
  });

  it("keeps the wait over an attach until main ends it, whatever host name that attach carries", async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('reconnecting');
    await flushPromises();
    api.settingsAttached(2, { ...scopes('project'), host: { name: 'renamed' } });
    await flushPromises();
    expect(q('[data-testid="settings-scope-away"]')!.dataset.state).toBe('reconnecting');
    expect(q('[data-testid="settings-content"]')!.hasAttribute('inert')).toBe(true);
  });

  it('moves focus from the page that turns inert to the selected tab', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    const field = row('damocles.model')!.querySelector<HTMLElement>('button')!;
    field.focus();
    expect(document.activeElement).toBe(field);
    api.settingsAway('reconnecting');
    await flushPromises();
    expect(document.activeElement).toBe(tab('project'));
  });

  it('closes a select opened from the page as it turns busy, and moves focus from it to the selected tab', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    const select = row('damocles.model')!.querySelector<HTMLElement>('button[aria-label="Default model"]')!;
    select.focus();
    press(select, 'Enter');
    await flushPromises();
    expect(q('[role="listbox"]')!.contains(document.activeElement)).toBe(true);
    api.settingsAway('reconnecting');
    await flushPromises();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.activeElement).toBe(tab('project'));
  });

  it("closes the footer's settings.json menu as the page turns busy, and moves focus from it to the selected tab", async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    const footer = q('[data-testid="settings-footer"]')!;
    footer.focus();
    press(footer, 'Enter');
    await flushPromises();
    expect(q('[role="menu"]')!.contains(document.activeElement)).toBe(true);
    api.settingsAway('restarting');
    await flushPromises();
    expect(q('[data-testid^="settings-edit-json-"]')).toBeNull();
    expect(document.activeElement).toBe(tab('project'));
  });

  it("closes the host's MCP panel as the page turns busy, and moves focus from it to the selected tab", async () => {
    await openOn('machine', 'integrations');
    await update(['damocles.mcp.enabled']);
    q('[data-testid="mcp-host-servers-open"]')!.click();
    await flushPromises();
    expect(q('[data-testid="mcp-panel"]')!.contains(document.activeElement)).toBe(true);
    api.settingsAway('reconnecting');
    await frames();
    expect(q('[data-testid="mcp-panel"]')).toBeNull();
    expect(document.activeElement).toBe(tab('host'));
  });

  it.each([
    ['reconnecting', 'lucide-refresh-cw', 'd-pulsing'],
    ['restarting', 'lucide-rotate-cw', 'd-spinning'],
  ] as const)("shows the %s banner with the icon and motion of the banner whose words it uses", async (state, icon, motion) => {
    await openOn('project', 'defaults');
    api.settingsAway(state);
    await flushPromises();
    const shown = q('[data-testid="settings-scope-away"] svg')!;
    expect(shown.classList).toContain(icon);
    expect(shown.classList).toContain(motion);
  });

  it('holds Sign in while main opens the Connect dialog, keeping focus on it and ignoring clicks, and offers it again once main answered', async () => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('signIn');
    await flushPromises();
    let answer!: () => void;
    vi.mocked(api.signInScopeHost).mockImplementationOnce(() => new Promise<PopupAnswer<void>>((resolve) => (answer = () => resolve({ ok: true, value: undefined }))));
    const signIn = q('[data-testid="settings-scope-away-sign-in"]')!;
    signIn.focus();
    signIn.click();
    await flushPromises();
    expect(signIn.getAttribute('aria-disabled')).toBe('true');
    expect(signIn.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(signIn);
    signIn.click();
    await flushPromises();
    expect(api.signInScopeHost).toHaveBeenCalledTimes(1);
    answer();
    await flushPromises();
    expect(signIn.hasAttribute('aria-disabled')).toBe(false);
  });

  it('ends the wait when main says so before it attaches settings of no remote host, as for a local chat', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('reconnecting');
    await flushPromises();
    api.settingsAway(null);
    api.settingsAttached(2, undefined);
    await update(undefined);
    await frames();
    expect(q('[data-testid="settings-scope-away"]')).toBeNull();
    expect(q('[data-testid="settings-content"]')!.hasAttribute('inert')).toBe(false);
  });

  it('says a tab clicked during the wait could not be opened, outside the inert page, until the wait ends', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('reconnecting');
    await flushPromises();
    vi.mocked(api.setSettingsScope).mockRejectedValueOnce(new Error('The settings of that tab could not be opened'));
    choose(tab('host'));
    await flushPromises();
    const failed = q('[data-testid="settings-scope-failed"]')!;
    expect(failed.textContent).toBe(`The ${HOST} settings could not be opened.`);
    expect(q('[data-testid="settings-content"]')!.contains(failed)).toBe(false);
    expect(tab('project').getAttribute('aria-selected')).toBe('true');

    api.settingsAttached(2, scopes('project'));
    api.settingsAway(null);
    await flushPromises();
    expect(failed.textContent).toBe('');
  });

  it('keeps the waiting tab selected and its page mounted while main answers a tab clicked during the wait, and after it refuses', async () => {
    await openOn('project', 'defaults');
    await update(['damocles.model']);
    const banner = q('[data-testid="settings-scope-banner"]')!;
    const field = row('damocles.model')!;
    api.settingsAway('restarting');
    await flushPromises();
    let refuse!: (error: Error) => void;
    vi.mocked(api.setSettingsScope).mockImplementationOnce(() => new Promise<PopupAnswer<OverlaySettingsScope>>((_resolve, reject) => { refuse = reject; }));
    choose(tab('host'));
    await flushPromises();
    expect(api.setSettingsScope).toHaveBeenCalledWith('machine');
    expect(tab('project').getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="settings-scope-loading"]')).toBeNull();
    expect(q('[data-testid="settings-scope-banner"]')).toBe(banner);
    expect(row('damocles.model')).toBe(field);

    refuse(new Error('The settings of that tab could not be opened'));
    await flushPromises();
    expect(q('[data-testid="settings-scope-failed"]')!.textContent).toBe(`The ${HOST} settings could not be opened.`);
    expect(tab('project').getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="settings-scope-banner"]')).toBe(banner);
    expect(row('damocles.model')).toBe(field);
  });

  it('offers the User tab from the banner of a host that went offline', async () => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    api.settingsAway('reconnecting');
    api.settingsAway('offline');
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(`${HOST} is offline.`);
    const showUser = q('[data-testid="settings-scope-away-user"]')!;
    expect(showUser.textContent!.trim()).toBe('Show User settings');
    showUser.focus();
    vi.mocked(api.setSettingsScope).mockImplementationOnce(async (scope) => {
      api.settingsAttached(2, scopes(scope));
      api.settingsAway(null);
      return { ok: true, value: scope };
    });
    showUser.click();
    await flushPromises();
    expect(api.setSettingsScope).toHaveBeenCalledWith('user');
    expect(tab('user').getAttribute('aria-selected')).toBe('true');
    // the button left with its banner, so focus is on the tab it opened
    expect(document.activeElement).toBe(tab('user'));
  });

  it('names the User tab on the offline banner by its Greek label', async () => {
    await openOn('machine', 'defaults');
    shellI18n.global.mergeLocaleMessage('el', shellEl);
    shellI18n.global.locale.value = 'el';
    api.settingsAway('offline');
    await flushPromises();
    expect(q('[data-testid="settings-scope-away-text"]')!.textContent).toBe(`Το ${HOST} είναι εκτός σύνδεσης.`);
    expect(q('[data-testid="settings-scope-away-user"]')!.textContent!.trim()).toBe('Εμφάνιση των ρυθμίσεων: Χρήστης');
  });

  it('moves focus with the arrow keys without switching, and names a long host in full in its title', async () => {
    await openOn('machine');
    tab('host').focus();
    press(tab('host'), 'ArrowRight');
    await flushPromises();
    expect(document.activeElement).toBe(tab('project'));
    expect(api.setSettingsScope).not.toHaveBeenCalled();
    expect(tab('host').getAttribute('aria-selected')).toBe('true');
    press(tab('project'), 'Enter');
    await flushPromises();
    expect(api.setSettingsScope).toHaveBeenCalledWith('project');
    expect(tab('host').getAttribute('title')).toBe(HOST);
    // no TabsContent registers, so no tab names a panel that does not exist
    expect(tab('host').hasAttribute('aria-controls')).toBe(false);
    expect(tab('host').querySelector('.truncate')!.textContent).toBe(HOST);
  });

  it('offers the host\'s own MCP servers only on its host tab', async () => {
    await openOn('machine', 'integrations');
    await update(['damocles.mcp.enabled']);
    expect(row('mcpHostServers')!.textContent).toContain(`MCP servers on ${HOST}`);
    // the panel's own words reach the overlay page, whose i18n holds only the namespaces merged into it
    q('[data-testid="mcp-host-servers-open"]')!.click();
    await flushPromises();
    const panel = q('[data-testid="mcp-panel"]')!;
    expect(panel.textContent).toContain(`MCP servers on ${HOST}`);
    expect(panel.textContent).toContain('Enable MCP');
    expect(q('[data-testid="mcp-add-server"]')!.textContent).toContain('Add server');
    expect(panel.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(panel.textContent!.replaceAll('mcp.json', '')).not.toMatch(/\b(mcp|overlays?)\.[a-z]/);
    api.settingsAttached(2, scopes('project'));
    await update(['damocles.mcp.enabled']);
    expect(row('damocles.mcp.enabled')).not.toBeNull();
    expect(row('mcpHostServers')).toBeNull();
    api.settingsAttached(3, scopes('user'));
    await update(undefined);
    expect(row('mcpHostServers')).toBeNull();
  });

  describe("the host tab's Allow YOLO", () => {
    const refusedHost = (canAllowYolo: boolean): OverlaySettingsScopes['host'] => ({ name: HOST, ...(canAllowYolo ? { canAllowYolo: true } : {}) });

    // core's state for a tab whose host refuses YOLO, with the default on
    async function refusedState(): Promise<void> {
      const store = useSettingsStore();
      api.settingsMessage({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false, bypassPermissions: false } });
      api.settingsMessage({ type: 'settingsUpdate', settings: { ...store.currentSettings, defaultDangerouslySkipPermissions: true }, workspaceWritable: true, writableKeys: ['damocles.dangerouslySkipPermissions'] });
      await flushPromises();
    }

    async function openRefused(canAllowYolo: boolean): Promise<void> {
      mounted.push(mount(OverlayApp, {
        props: { api, settingsBridge },
        global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
        attachTo: document.body,
      }));
      await flushPromises();
      api.request('s1', { kind: 'settings', generation: 1, section: 'defaults', scopes: { host: refusedHost(canAllowYolo), active: 'machine' } });
      await flushPromises();
      await refusedState();
    }

    it('asks main for a host it may ask about', async () => {
      vi.mocked(api.allowHostYolo).mockClear();
      await openRefused(true);
      q('[data-testid="default-yolo-allow"]')!.click();
      await flushPromises();
      expect(api.allowHostYolo).toHaveBeenCalledTimes(1);
    });

    it('offers no note or ask for a host main never asks about', async () => {
      await openRefused(false);
      expect(q('[data-testid="default-yolo-refused"]')).toBeNull();
      expect(q('[data-testid="default-yolo-allow"]')).toBeNull();
    });

    it('follows the host of each attach while the modal stays open', async () => {
      await openRefused(true);
      expect(q('[data-testid="default-yolo-allow"]')).not.toBeNull();
      api.settingsAttached(2, { host: refusedHost(false), active: 'machine' });
      await flushPromises();
      await refusedState();
      expect(q('[data-testid="default-yolo-refused"]')).toBeNull();
      api.settingsAttached(3, { host: refusedHost(true), active: 'machine' });
      await flushPromises();
      await refusedState();
      expect(q('[data-testid="default-yolo-allow"]')).not.toBeNull();
      api.settingsScopeHost(refusedHost(false));
      await flushPromises();
      expect(q('[data-testid="default-yolo-refused"]')).toBeNull();
    });
  });
});
