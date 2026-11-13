// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import type { HeldMemoryQueue, HeldMemoryResult, PopupAnswer, RemoteHostEntry } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, opened } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];
let pinia: Pinia;

// noon UTC, so the day is the same in every time zone the tests run in
const SEPT_2 = Date.UTC(2026, 8, 2, 12);
const OCT_5 = Date.UTC(2026, 9, 5, 12);
const OLD: HeldMemoryQueue = { queueId: 'client-old', count: 3, lastSeen: SEPT_2 };
const ONE: HeldMemoryQueue = { queueId: 'client-one', count: 1, lastSeen: OCT_5 };

const PROD: RemoteHostEntry = {
  hostId: 'h1',
  kind: 'ssh',
  authorityKey: 'ssh+h1',
  name: 'prod-1',
  destinationLabel: 'deploy@prod-1',
  os: 'linux',
  detectedOs: 'linux',
  connection: 'connected',
  settings: { allowBypass: false, forwardAgent: false, rememberPassword: false, browserLocalNetwork: false, openLinksWithoutAsking: false },
  facts: { passwordless: true, keyInstalledByDamocles: true, lingerEnabledByDamocles: false, alwaysCredentialHosts: [], alwaysForgeAccounts: [] },
  heldMemoryQueues: [OLD, ONE],
};

async function openRemoteHosts(): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'remoteHosts' });
  await flushPromises();
}

const $ = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E | null => root.querySelector<E>(selector);
const $$ = (selector: string, root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];
const row = (): HTMLElement | null => $('[data-testid="settings-row-remote-host-held-memory"]');
// a row that left stays in the DOM, under its exit class, until its animation ends
const queues = (): HTMLElement[] => $$('[data-testid="held-memory-queue"]').filter((each) => !each.classList.contains('t-row-leave-active'));
const leaving = (): string[] => $$('[data-testid="held-memory-queue"].t-row-leave-active').map((each) => each.dataset.queueId!);
const queue = (queueId: string): HTMLElement => queues().find((each) => each.dataset.queueId === queueId)!;
const texts = (): string[] => queues().map((each) => $('[data-testid="held-memory-text"]', each)!.textContent!.trim());
const press = async (queueId: string, action: 'deliver' | 'discard'): Promise<void> => {
  // a pressed button takes the focus, as in Chromium
  const button = $(`[data-action="${action}"]`, queue(queueId))!;
  button.focus();
  button.click();
  await flushPromises();
};
const confirmDialog = (): HTMLElement | null => $('[data-testid="held-memory-confirm"]');

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  document.documentElement.setAttribute('data-reduced-motion', '');
  api.remoteHosts.list = [PROD];
  vi.mocked(api.deliverHeldMemory).mockReset().mockResolvedValue(opened({ ok: true }));
  vi.mocked(api.discardHeldMemory).mockReset().mockResolvedValue(opened({ ok: true }));
  vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'win32' });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('Settings, Remote hosts: memories waiting for a device', () => {
  it('shows each held queue with its count and the day its device was last seen', async () => {
    await openRemoteHosts();
    expect(row()!.textContent).toContain('Chats on prod-1 saved these global memories for a device that has not connected to prod-1 for 30 days.');
    expect(texts()).toEqual(['3 memories waiting for a device last seen Sep 2, 2026', '1 memory waiting for a device last seen Oct 5, 2026']);
    const deliver = $('[data-action="deliver"]', queue('client-old'))!;
    expect(deliver.textContent!.trim()).toBe('Deliver here');
    expect($(`#${deliver.getAttribute('aria-describedby')!}`)!.textContent!.trim()).toBe(texts()[0]);
    expect($('[data-action="discard"]', queue('client-old'))!.textContent!.trim()).toBe('Discard');
  });

  it('words the count and formats the day in Greek', async () => {
    vi.mocked(api.getState).mockResolvedValue({ locale: 'el', platform: 'win32' });
    await openRemoteHosts();
    expect(texts()).toEqual(['3 μνήμες περιμένουν μια συσκευή με τελευταία σύνδεση στις 2 Σεπ 2026', '1 μνήμη περιμένει μια συσκευή με τελευταία σύνδεση στις 5 Οκτ 2026']);
    expect($('[data-action="deliver"]', queue('client-one'))!.textContent!.trim()).toBe('Παράδοση εδώ');
  });

  it('shows no row while nothing is held', async () => {
    api.remoteHosts.list = [{ ...PROD, heldMemoryQueues: [] }];
    await openRemoteHosts();
    expect($('[data-testid="remote-host"]')).not.toBeNull();
    expect(row()).toBeNull();
  });

  it('delivers a queue here by its id, drops its row, says so and moves the focus to the next row', async () => {
    await openRemoteHosts();
    await press('client-old', 'deliver');
    expect(api.deliverHeldMemory).toHaveBeenCalledExactlyOnceWith('h1', 'client-old');
    expect(api.discardHeldMemory).not.toHaveBeenCalled();
    expect(queues().map((each) => each.dataset.queueId)).toEqual(['client-one']);
    expect(leaving()).toEqual(['client-old']);
    const outcome = $('[data-testid="held-memory-outcome"]')!;
    expect(outcome.textContent!.trim()).toBe('3 memories are being delivered to this computer.');
    expect(outcome.closest('[aria-live="polite"]')).not.toBeNull();
    expect(document.activeElement).toBe($('[data-action="deliver"]', queue('client-one')));
  });

  it('shows the queue as busy while the call runs and runs one call at a time', async () => {
    let finish!: (answer: PopupAnswer<HeldMemoryResult>) => void;
    vi.mocked(api.deliverHeldMemory).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await openRemoteHosts();
    await press('client-old', 'deliver');
    expect(queue('client-old').getAttribute('aria-busy')).toBe('true');
    expect($('[data-action="deliver"] .d-spinning', queue('client-old'))).not.toBeNull();
    expect($('[data-action="deliver"]', queue('client-one'))!.getAttribute('aria-disabled')).toBe('true');
    await press('client-one', 'deliver');
    expect(api.deliverHeldMemory).toHaveBeenCalledOnce();
    finish(opened({ ok: true }));
    await flushPromises();
    expect(queues().map((each) => each.dataset.queueId)).toEqual(['client-one']);
  });

  it('discards only after the confirm, which focuses Cancel first', async () => {
    await openRemoteHosts();
    await press('client-one', 'discard');
    const dialog = confirmDialog()!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('Discard 1 memory?');
    expect(dialog.textContent).toContain('Damocles deletes the global memory that chats on prod-1 saved for a device last seen Oct 5, 2026. It never reaches any device.');
    expect(document.activeElement).toBe($('[data-testid="held-memory-confirm-cancel"]', dialog));
    expect(api.discardHeldMemory).not.toHaveBeenCalled();

    $('[data-testid="held-memory-confirm-cancel"]', dialog)!.click();
    await flushPromises();
    expect(api.discardHeldMemory).not.toHaveBeenCalled();
    expect(queues()).toHaveLength(2);
    expect(document.activeElement).toBe($('[data-action="discard"]', queue('client-one')));

    await press('client-one', 'discard');
    $('[data-testid="held-memory-confirm-discard"]', confirmDialog()!)!.click();
    await flushPromises();
    expect(api.discardHeldMemory).toHaveBeenCalledExactlyOnceWith('h1', 'client-one');
    expect(queues().map((each) => each.dataset.queueId)).toEqual(['client-old']);
    expect($('[data-testid="held-memory-outcome"]')!.textContent!.trim()).toBe('1 memory was discarded.');
    expect(document.activeElement).toBe($('[data-action="deliver"]', queue('client-old')));
  });

  it('keeps the row with a localized alert when the host is not connected or the call fails', async () => {
    vi.mocked(api.deliverHeldMemory).mockResolvedValueOnce(opened({ ok: false, code: 'notConnected' })).mockRejectedValueOnce(new Error('daemon error'));
    await openRemoteHosts();
    await press('client-old', 'deliver');
    const alert = (): HTMLElement | null => $('[data-testid="held-memory-failure"]', queue('client-old'));
    expect(alert()!.getAttribute('role')).toBe('alert');
    expect(alert()!.textContent!.trim()).toBe('prod-1 is not connected. Connect to it and try again.');
    await press('client-old', 'deliver');
    expect(alert()!.textContent!.trim()).toBe('The memories could not be delivered. Show log has the details.');
    expect(queues()).toHaveLength(2);
    expect($('[data-testid="held-memory-outcome"]')).toBeNull();
  });

  it('drops a queue another device took and says why', async () => {
    vi.mocked(api.deliverHeldMemory).mockResolvedValueOnce(opened({ ok: false, code: 'gone' }));
    await openRemoteHosts();
    await press('client-one', 'deliver');
    expect(queues().map((each) => each.dataset.queueId)).toEqual(['client-old']);
    expect($('[data-testid="held-memory-outcome"]')!.textContent!.trim()).toBe('These memories are no longer waiting. Their device came back, or another device delivered or discarded them.');
  });

  it('keeps the result after the last queue left and shows a queue again once main holds it anew', async () => {
    api.remoteHosts.list = [{ ...PROD, heldMemoryQueues: [ONE] }];
    await openRemoteHosts();
    await press('client-one', 'deliver');
    expect(queues()).toHaveLength(0);
    expect(row()!.textContent).toContain('No memories are waiting for a device on prod-1 now.');
    expect(document.activeElement).toBe($('[data-testid="held-memory-outcome"]'));
    api.hostEntries([{ ...PROD, heldMemoryQueues: [] }]);
    await flushPromises();
    api.hostEntries([{ ...PROD, heldMemoryQueues: [{ ...ONE, count: 2 }] }]);
    await flushPromises();
    expect(texts()).toEqual(['2 memories waiting for a device last seen Oct 5, 2026']);
  });
});
