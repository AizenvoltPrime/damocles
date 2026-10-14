// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];
const GIT = 'damocles.desktop.git.';

async function openSourceControl(): Promise<void> {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'sourceControl' });
  await flushPromises();
}

const row = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="settings-row-${GIT}${key}"]`)!;
const pressed = (key: string): string[] => [...row(key).querySelectorAll('button[aria-pressed="true"]')].map((button) => button.textContent!.trim());
const options = (key: string): string[] => [...row(key).querySelectorAll('button[aria-pressed]')].map((button) => button.textContent!.trim());
const switchOf = (key: string): HTMLElement => row(key).querySelector<HTMLElement>('[role="switch"]')!;

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.mocked(api.setPref).mockClear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings › Source control', () => {
  it('lists the fetch and sync rows first and the clone rows last, titled as the final prototype titles them', async () => {
    await openSourceControl();
    const heads = [...document.querySelectorAll('.sm-group-head')].map((head) => head.textContent!.trim());
    expect(heads).toEqual(['Fetch and sync', 'Commit', 'Branches and repositories', 'Clone']);
    const titles = (keys: readonly string[]): string[] => keys.map((key) => row(key).querySelector('[id^="settings-row-label-"]')!.textContent!.trim());
    expect(titles(['autofetch', 'autofetchPeriod', 'pruneOnFetch', 'confirmSync', 'rebaseWhenSync', 'followTagsWhenSync', 'allowForcePush', 'autoStash', 'defaultCloneDirectory', 'openAfterClone'])).toEqual([
      'Autofetch', 'Autofetch period', 'Prune on fetch', 'Confirm sync', 'Rebase when syncing', 'Follow tags when syncing', 'Allow force push', 'Auto stash', 'Default clone folder', 'Open after clone',
    ]);
    const order = [...document.querySelectorAll('[data-testid^="settings-row-damocles.desktop.git."]')].map((element) => element.getAttribute('data-testid')!.slice(`settings-row-${GIT}`.length));
    expect(order.slice(0, 10)).toEqual(['autofetch', 'autofetchPeriod', 'pruneOnFetch', 'confirmSync', 'rebaseWhenSync', 'followTagsWhenSync', 'allowForcePush', 'autoStash', 'pullBeforeCheckout', 'postCommitCommand']);
    // appendix A.5: Save files before stash right after Save files before commit
    expect(order.slice(order.indexOf('promptToSaveFilesBeforeCommit'), order.indexOf('promptToSaveFilesBeforeCommit') + 2)).toEqual(['promptToSaveFilesBeforeCommit', 'promptToSaveFilesBeforeStash']);
    expect(order.slice(-2)).toEqual(['defaultCloneDirectory', 'openAfterClone']);
  });

  it("shows each key's default: autofetch and confirm sync on, every other switch off, 180 seconds, and Prompt", async () => {
    await openSourceControl();
    expect(switchOf('autofetch').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('confirmSync').getAttribute('aria-checked')).toBe('true');
    for (const key of ['pruneOnFetch', 'rebaseWhenSync', 'followTagsWhenSync', 'allowForcePush', 'autoStash']) expect(switchOf(key).getAttribute('aria-checked'), key).toBe('false');
    expect(row('autofetchPeriod').querySelector('input')!.value).toBe('180');
    expect(options('openAfterClone')).toEqual(['Always', 'Prompt']);
    expect(pressed('openAfterClone')).toEqual(['Prompt']);
    const folder = row('defaultCloneDirectory').querySelector('input')!;
    expect([folder.value, folder.placeholder]).toEqual(['', 'ask each time']);
  });

  it('offers None, Push and Sync for the post-commit command and writes each row to its key', async () => {
    await openSourceControl();
    expect(options('postCommitCommand')).toEqual(['None', 'Push', 'Sync']);
    expect(pressed('postCommitCommand')).toEqual(['None']);
    [...row('postCommitCommand').querySelectorAll<HTMLElement>('button[aria-pressed]')].find((button) => button.textContent!.trim() === 'Sync')!.click();
    expect(api.setPref).toHaveBeenCalledWith(`${GIT}postCommitCommand`, 'sync');
    switchOf('allowForcePush').click();
    expect(api.setPref).toHaveBeenCalledWith(`${GIT}allowForcePush`, true);
    const period = row('autofetchPeriod').querySelector('input')!;
    period.value = '0';
    period.dispatchEvent(new Event('input'));
    period.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect(api.setPref).not.toHaveBeenCalledWith(`${GIT}autofetchPeriod`, 0);
    period.value = '300';
    period.dispatchEvent(new Event('input'));
    period.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(api.setPref).toHaveBeenCalledWith(`${GIT}autofetchPeriod`, 300);
    const folder = row('defaultCloneDirectory').querySelector('input')!;
    folder.value = '  C:\\dev  ';
    folder.dispatchEvent(new Event('input'));
    folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(api.setPref).toHaveBeenCalledWith(`${GIT}defaultCloneDirectory`, 'C:\\dev');
  });

  it('offers Pull before checkout (off) and Save files before stash (Always, Staged, Never; Always) and writes each to its key', async () => {
    await openSourceControl();
    expect(row('pullBeforeCheckout').querySelector('[id^="settings-row-label-"]')!.textContent!.trim()).toBe('Pull before checkout');
    expect(switchOf('pullBeforeCheckout').getAttribute('aria-checked')).toBe('false');
    switchOf('pullBeforeCheckout').click();
    expect(api.setPref).toHaveBeenCalledWith(`${GIT}pullBeforeCheckout`, true);
    expect(row('promptToSaveFilesBeforeStash').querySelector('[id^="settings-row-label-"]')!.textContent!.trim()).toBe('Save files before stash');
    expect(options('promptToSaveFilesBeforeStash')).toEqual(['Always', 'Staged', 'Never']);
    expect(pressed('promptToSaveFilesBeforeStash')).toEqual(['Always']);
    [...row('promptToSaveFilesBeforeStash').querySelectorAll<HTMLElement>('button[aria-pressed]')].find((button) => button.textContent!.trim() === 'Never')!.click();
    expect(api.setPref).toHaveBeenCalledWith(`${GIT}promptToSaveFilesBeforeStash`, 'never');
  });

  it('has English and Greek strings for every new row', () => {
    for (const name of ['Autofetch', 'AutofetchPeriod', 'PruneOnFetch', 'ConfirmSync', 'RebaseWhenSync', 'FollowTagsWhenSync', 'AllowForcePush', 'AutoStash', 'DefaultCloneDirectory', 'OpenAfterClone', 'PullBeforeCheckout', 'PromptToSaveFilesBeforeStash']) {
      for (const part of ['label', 'description']) {
        const key = `settingsHost.rows.git${name}.${part}`;
        expect(shellI18n.global.te(key, 'en') && shellI18n.global.te(key, 'el'), key).toBe(true);
        expect(shellI18n.global.t(key, 1, { locale: 'el' }), key).not.toBe(shellI18n.global.t(key, 1, { locale: 'en' }));
      }
    }
  });
});
