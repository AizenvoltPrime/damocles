// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import type { UpdateSnapshot } from '../../preload/updates';
import OverlayApp from '../overlay/OverlayApp.vue';
import UpdatePill from '../components/UpdatePill.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, fakeShellApi } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];
// The default Transition stubs swap content at once; happy-dom never ends an out-in leave.
const stubs = { transition: true, 'transition-group': true };

async function openAbout(release?: string): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'about', ...(release ? { release } : {}) });
  await flushPromises();
}

const $ = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const testId = (id: string): HTMLElement | null => $(`[data-testid="${id}"]`);
const row = (version: string): HTMLElement => $(`[data-version-row="${version}"]`)!;
const notesOf = (version: string): HTMLElement | null => $(`[data-testid="whats-new-notes"][data-version="${version}"]`);

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api.releases.notes = { '3.4.0': '### Added\n\n- **Pill.** Shows progress.', '3.3.0': '### Fixed\n\n- **Older fix.** [link](https://example.com/notes)' };
  vi.mocked(api.getReleaseNotes).mockClear();
  vi.mocked(api.getReleaseIndex).mockClear();
  vi.mocked(api.restartToUpdate).mockClear();
  vi.mocked(api.checkForUpdates).mockClear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings › About', () => {
  it('shows the version card for the unpackaged app, with updates off', async () => {
    await openAbout();
    const card = testId('settings-row-about-version')!;
    expect(card.textContent).toContain('Damocles 3.4.0');
    expect(card.textContent).toContain('Windows · x64');
    expect(testId('about-runtimes')!.textContent).toMatch(/Electron\s*38\.0\.0.*Chromium\s*140\.0\.0\.0.*Node\s*22\.19\.0/);
    expect(testId('about-update-status')!.dataset.state).toBe('disabled');
    expect(testId('about-update-detail')!.textContent).toContain('Updates are off in development builds.');
    expect((testId('about-check') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the state main pushes: ready offers Restart and the update\'s sanitized notes', async () => {
    await openAbout();
    api.pushUpdate({
      state: { kind: 'ready', version: '3.5.0', notes: '<h3>Added</h3><p>New <img src="https://x.example/a.png" onerror="bad()">thing</p>' },
      lastCheckedAt: null,
      platform: 'win32',
    });
    await flushPromises();
    expect(testId('about-update-status')!.dataset.state).toBe('ready');
    // The offered update heads What's new, expanded with the feed's notes.
    expect(row('3.5.0').getAttribute('aria-expanded')).toBe('true');
    expect(row('3.5.0').querySelector('[data-testid="whats-new-update"]')!.textContent).toBe('Update');
    expect(document.querySelector('[data-version-row]')).toBe(row('3.5.0'));
    const pending = notesOf('3.5.0')!;
    expect(pending.textContent).toContain('New thing');
    expect(pending.querySelector('img')).toBeNull();
    expect(pending.querySelector('h3')!.dataset.section).toBe('added');
    testId('about-restart')!.click();
    expect(api.restartToUpdate).toHaveBeenCalledTimes(1);
    expect(testId('about-check')!.hasAttribute('disabled')).toBe(true);

    api.pushUpdate({ state: { kind: 'upToDate', checkedAt: Date.now() }, lastCheckedAt: Date.parse('2026-01-02T09:05:00'), platform: 'win32' });
    await flushPromises();
    expect($('[data-version-row="3.5.0"]')).toBeNull();
    expect(testId('about-last-checked')!.textContent).toMatch(/09:05/);
    testId('about-check')!.click();
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('says it is restarting while the quit that installs the update runs, with Restart disabled, and offers Restart again once the quit is cancelled', async () => {
    await openAbout();
    const update = { version: '3.5.0', notes: '<p>New thing</p>' };
    api.pushUpdate({ state: { kind: 'restarting', ...update }, lastCheckedAt: null, platform: 'win32' });
    await flushPromises();
    expect(testId('about-update-status')!.dataset.state).toBe('restarting');
    expect(testId('about-update-status')!.textContent!.trim()).toBe('Restarting');
    expect(testId('about-update-status')!.querySelector('svg')!.classList.contains('d-spinning')).toBe(true);
    expect(testId('about-update-detail')!.textContent!.trim()).toBe('Damocles is restarting to install 3.5.0.');
    const restart = testId('about-restart') as HTMLButtonElement;
    expect(restart.disabled).toBe(true);
    expect(restart.textContent!.trim()).toBe('Restarting');
    expect(row('3.5.0').querySelector('[data-testid="whats-new-update"]')).not.toBeNull();
    restart.click();
    expect(api.restartToUpdate).not.toHaveBeenCalled();

    api.pushUpdate({ state: { kind: 'ready', ...update }, lastCheckedAt: null, platform: 'win32' });
    await flushPromises();
    expect((testId('about-restart') as HTMLButtonElement).disabled).toBe(false);
    expect(testId('about-restart')!.textContent!.trim()).toBe('Restart to update');
  });

  it('marks the running version Current and expands it, and loads an older version\'s notes on its first expand', async () => {
    await openAbout();
    expect(row('3.4.0').getAttribute('aria-expanded')).toBe('true');
    expect(row('3.4.0').querySelector('[data-testid="whats-new-current"]')!.textContent).toBe('Current');
    expect(row('3.3.0').querySelector('[data-testid="whats-new-current"]')).toBeNull();
    expect(notesOf('3.4.0')!.textContent).toContain('Pill.');
    expect(row('3.3.0').getAttribute('aria-expanded')).toBe('false');
    expect(notesOf('3.3.0')).toBeNull();

    row('3.3.0').click();
    await flushPromises();
    expect(row('3.3.0').getAttribute('aria-expanded')).toBe('true');
    expect(notesOf('3.3.0')!.querySelector('a')!.getAttribute('target')).toBe('_blank');

    row('3.3.0').click();
    await flushPromises();
    expect(notesOf('3.3.0')).toBeNull();
    row('3.3.0').click();
    await flushPromises();
    expect(vi.mocked(api.getReleaseNotes).mock.calls.map(([version]) => version)).toEqual(['3.4.0', '3.3.0']);
  });

  it('says that a version\'s notes could not load, without the error text from main, and loads them again on the next expand', async () => {
    vi.mocked(api.getReleaseNotes).mockRejectedValueOnce(new Error("Error invoking remote method 'release-notes': Error: ENOENT: no such file, open '/home/me/CHANGELOG.md'"));
    await openAbout();
    const failed = notesOf('3.4.0')!;
    expect(failed.querySelector('[role="alert"]')!.textContent!.trim()).toBe('These notes could not load.');
    expect(failed.textContent).not.toContain('ENOENT');
    row('3.4.0').click();
    await flushPromises();
    row('3.4.0').click();
    await flushPromises();
    expect(notesOf('3.4.0')!.textContent).toContain('Pill.');
  });

  it('says the release list could not load', async () => {
    vi.mocked(api.getReleaseIndex).mockRejectedValueOnce(new Error('ENOENT'));
    await openAbout();
    expect(testId('whats-new-failed')!.textContent!.trim()).toBe('The release notes could not load.');
    expect($('[data-version-row]')).toBeNull();
  });

  it('expands the release a request names', async () => {
    await openAbout('3.3.0');
    expect(row('3.3.0').getAttribute('aria-expanded')).toBe('true');
    expect(notesOf('3.3.0')!.textContent).toContain('Older fix.');
  });
});

describe('title-bar update pill', () => {
  const snapshot = (state: UpdateSnapshot['state'], platform: UpdateSnapshot['platform'] = 'win32'): UpdateSnapshot => ({ state, lastCheckedAt: null, platform });

  it('shows only for a download, a ready update or a macOS release, and follows main\'s state', async () => {
    const shell = fakeShellApi();
    mounted.push(mount(UpdatePill, { props: { api: shell, platform: 'win32' }, global: { plugins: [shellI18n], stubs }, attachTo: document.body }));
    await flushPromises();
    expect(testId('update-pill')).toBeNull();

    shell.pushUpdate(snapshot({ kind: 'downloading', version: '3.5.0', percent: 42 }));
    await flushPromises();
    expect(testId('update-pill')!.dataset.state).toBe('downloading');
    expect(testId('update-pill-label')!.textContent).toBe('Downloading 42%');
    expect(testId('update-pill-fill')!.getAttribute('aria-valuenow')).toBe('42');
    expect($('.update-pill-ring')).toBeNull();

    shell.answerNext({ kind: 'menu', itemId: 'restart' });
    shell.pushUpdate(snapshot({ kind: 'ready', version: '3.5.0', notes: '' }));
    await flushPromises();
    expect(testId('update-pill-label')!.textContent).toBe('Restart to update');
    expect(testId('update-pill-fill')!.getAttribute('aria-valuenow')).toBe('100');
    expect($('.update-pill-ring')).not.toBeNull();
    testId('update-pill')!.click();
    await flushPromises();
    const menu = shell.overlayRequests.at(-1);
    expect(menu?.kind === 'menu' ? menu.items.map((item) => item.kind === 'item' ? item.id : '-') : []).toEqual(['restart', 'releaseNotes', 'showLog']);
    expect(shell.runUpdateAction).toHaveBeenCalledWith('restart');

    shell.pushUpdate(snapshot({ kind: 'idle' }));
    await flushPromises();
    expect(testId('update-pill')).toBeNull();
  });

  it('says it is restarting while the quit runs, with Restart disabled in its menu, and draws no attention again once the quit is cancelled', async () => {
    const shell = fakeShellApi();
    mounted.push(mount(UpdatePill, { props: { api: shell, platform: 'win32' }, global: { plugins: [shellI18n], stubs }, attachTo: document.body }));
    await flushPromises();
    shell.pushUpdate(snapshot({ kind: 'restarting', version: '3.5.0', notes: '' }));
    await flushPromises();
    expect(testId('update-pill')!.dataset.state).toBe('restarting');
    expect(testId('update-pill-label')!.textContent).toBe('Restarting');
    expect(testId('update-pill')!.querySelector('svg')!.classList.contains('d-spinning')).toBe(true);
    expect(testId('update-pill')!.getAttribute('title')).toBe('Damocles is restarting to install 3.5.0.');

    testId('update-pill')!.click();
    await flushPromises();
    const menu = shell.overlayRequests.at(-1);
    expect(menu?.kind === 'menu' ? menu.items.map((item) => (item.kind === 'item' ? [item.id, item.disabled === true] : '-')) : []).toEqual([['restart', true], ['showLog', false]]);
    expect(shell.runUpdateAction).not.toHaveBeenCalled();

    shell.pushUpdate(snapshot({ kind: 'ready', version: '3.5.0', notes: '' }));
    await flushPromises();
    expect(testId('update-pill-label')!.textContent).toBe('Restart to update');
    expect($('.update-pill-ring')).toBeNull();
  });

  it('opens only the release page on macOS', async () => {
    const shell = fakeShellApi();
    mounted.push(mount(UpdatePill, { props: { api: shell, platform: 'darwin' }, global: { plugins: [shellI18n], stubs }, attachTo: document.body }));
    await flushPromises();
    shell.pushUpdate(snapshot({ kind: 'available', version: '3.5.0', notes: '' }, 'darwin'));
    await flushPromises();
    expect(testId('update-pill')!.textContent).toContain('Update available');
    expect(testId('update-pill')!.hasAttribute('aria-haspopup')).toBe(false);
    testId('update-pill')!.click();
    await flushPromises();
    expect(shell.overlayRequests).toEqual([]);
    expect(shell.runUpdateAction).toHaveBeenCalledWith('releasePage');
  });
});
