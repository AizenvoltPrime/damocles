// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import type { HostTone } from '@shared/host-tones';
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
// what performance.now() reads, in ms since the question showed
let now = 0;

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.mocked(api.answer).mockClear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountOverlay(): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
}

async function ask(anchor = { x: 1100, y: 300, width: 36, height: 20 }, hostColor?: HostTone): Promise<HTMLElement> {
  if (mounted.length === 0) await mountOverlay();
  api.request('y1', { kind: 'allowYolo', hostName: 'prod-1', ...(hostColor ? { hostColor } : {}), anchor });
  await flushPromises();
  return vi.waitFor(() => {
    const shown = document.querySelector<HTMLElement>('[role="dialog"][data-testid="allow-yolo"]');
    expect(shown).not.toBeNull();
    return shown!;
  });
}

async function again(): Promise<HTMLElement> {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.mocked(api.answer).mockClear();
  now = 0;
  return ask();
}

const accept = (dialog: HTMLElement): HTMLElement => dialog.querySelector<HTMLElement>('[data-testid="allow-yolo-accept"]')!;
const settingsModal = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="settings-modal"]');

describe('Allow YOLO', () => {
  it('names the host, says where to undo it, and focuses Cancel first', async () => {
    const dialog = await ask();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Allow YOLO on prod-1?');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent!.trim()).toBe('Your chats on prod-1 can then skip permission prompts. You can turn this off in Settings › User › Remote hosts.');
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.querySelector('[data-testid="allow-yolo-cancel"]')));
    // a control in the right half hangs the panel leftward from its own end: 1136 - 320
    expect(dialog.style.left).toBe('816px');
    expect(dialog.style.top).toBe('326px');
  });

  it("shows the host's badge in its safety tone", async () => {
    const dialog = await ask(undefined, 'danger');
    const badge = dialog.querySelector<HTMLElement>('[data-testid="allow-yolo-host"]')!;
    expect(badge.textContent!.trim()).toBe('prod-1');
    expect(badge.classList.contains('d-tone-danger')).toBe(true);
  });

  it('hangs from the start of a control in the left half, and above it when the room is there', async () => {
    const dialog = await ask({ x: 200, y: 700, width: 60, height: 28 });
    expect(dialog.style.left).toBe('200px');
    expect(dialog.style.bottom).toBe('106px');
  });

  it('allows only on its own button, and answers once', async () => {
    const dialog = await ask();
    now = 500;
    accept(dialog).click();
    dialog.querySelector<HTMLElement>('[data-testid="allow-yolo-cancel"]')!.click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('y1', { kind: 'allowYolo', allow: true }));
    expect(api.answer).toHaveBeenCalledTimes(1);
  });

  it('ignores Allow, by pointer or by key, for 500 ms after it shows', async () => {
    const dialog = await ask();
    now = 499;
    accept(dialog).click();
    // a button's Enter or Space reaches it as a click with no pointer detail
    accept(dialog).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await flushPromises();
    expect(api.answer).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="allow-yolo"]')).not.toBeNull();
    now = 500;
    accept(dialog).click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('y1', { kind: 'allowYolo', allow: true }));
  });

  it('refuses on Cancel, on Escape and on a click beside it', async () => {
    let dialog = await ask();
    dialog.querySelector<HTMLElement>('[data-testid="allow-yolo-cancel"]')!.click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('y1', { kind: 'allowYolo', allow: false }));

    dialog = await again();
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.querySelector('[data-testid="allow-yolo-cancel"]')));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('y1', { kind: 'allowYolo', allow: false }));

    await again();
    const beside = document.body.appendChild(document.createElement('div'));
    beside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('y1', { kind: 'allowYolo', allow: false }));
  });

  it('above the settings modal, Escape and a click beside it close only the question', async () => {
    await mountOverlay();
    api.request('s1', { kind: 'settings', generation: 1, section: 'chat' });
    await flushPromises();
    expect(settingsModal()).not.toBeNull();

    let dialog = await ask();
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.querySelector('[data-testid="allow-yolo-cancel"]')));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('y1', { kind: 'allowYolo', allow: false }));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="allow-yolo"]')).toBeNull());
    expect(settingsModal()).not.toBeNull();

    vi.mocked(api.answer).mockClear();
    api.request('y2', { kind: 'allowYolo', hostName: 'prod-1', anchor: { x: 1100, y: 300, width: 36, height: 20 } });
    await flushPromises();
    dialog = await vi.waitFor(() => document.querySelector<HTMLElement>('[role="dialog"][data-testid="allow-yolo"]')!);
    // reka listens for an outside pointerdown from the task after its layer mounts
    await new Promise((resolve) => setTimeout(resolve, 0));
    settingsModal()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('y2', { kind: 'allowYolo', allow: false }));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="allow-yolo"]')).toBeNull());
    expect(settingsModal()).not.toBeNull();
    expect(api.answer).not.toHaveBeenCalledWith('s1', expect.anything());
    expect(dialog.isConnected).toBe(false);
  });
});
