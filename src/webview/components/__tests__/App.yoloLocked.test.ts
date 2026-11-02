// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import type { BridgeHost } from '@shared/damocles-bridge';
import type { HostCapabilities } from '@shared/types/messages';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

// The page posts through the host API vitest.setup.ts installs; main's init names the remote chat's host.
const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
const allowYolo = vi.fn(async (_anchor: { x: number; y: number; width: number; height: number }) => true);
const PROD: BridgeHost = { hostId: 'h1', name: 'prod-1', color: 'danger', computer: 'ALEXIOS-PC', canAllowYolo: true };
let hostLabel: BridgeHost | undefined;
window.damoclesBridge = {
  postMessage: () => undefined,
  onMessage: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
  getHost: () => hostLabel,
  onHost: () => () => undefined,
  getHostNames: () => undefined,
  onHostNames: () => () => undefined,
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  allowYolo,
  queueAction: () => undefined,
};

let app: VueWrapper | null = null;
let posted: { type: string; enabled?: boolean }[] = [];

beforeEach(() => {
  // useChatHost reads the bridge's host once per module graph
  vi.resetModules();
  hostLabel = PROD;
  posted = [];
  allowYolo.mockReset();
  allowYolo.mockResolvedValue(true);
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const yolo = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="composer-yolo"]');
const yoloPosts = (): { type: string; enabled?: boolean }[] => posted.filter((message) => message.type === 'setDangerouslySkipPermissions');

async function chatPage(capabilities: Partial<HostCapabilities>, options: { yoloOn?: boolean } = {}): Promise<HTMLElement | null> {
  const [{ flushPromises, mount }, { createPinia, setActivePinia }, { default: App }, { i18n }, { useSettingsStore }, { VSCODE_HOST_CAPABILITIES }] = await Promise.all([
    import('@vue/test-utils'),
    import('pinia'),
    import('@/App.vue'),
    import('@/i18n'),
    import('@/stores/useSettingsStore'),
    import('@shared/types/messages'),
  ]);
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, ...capabilities });
  if (options.yoloOn) useSettingsStore().setDangerouslySkipPermissions(true);
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return yolo();
}

async function settle(): Promise<void> {
  const { flushPromises } = await import('@vue/test-utils');
  await flushPromises();
}

// the first test compiles App for a fresh module graph
describe("YOLO on a desktop remote chat whose host refuses it", { timeout: 30_000 }, () => {
  const refused = async (): Promise<HTMLElement> => (await chatPage({ bypassPermissions: false }))!;

  it('shows the control locked, naming the host and that activating it asks to allow it', async () => {
    const control = await refused();
    expect(control).not.toBeNull();
    expect(control.dataset.locked).toBe('');
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.getAttribute('aria-pressed')).toBe('false');
    expect(control.title).toBe("YOLO isn't allowed on prod-1. Activate to allow it.");
    const description = document.getElementById(control.getAttribute('aria-describedby')!);
    expect(description!.textContent).toBe("YOLO isn't allowed on prod-1. Activate to allow it.");
    expect(control.contains(description)).toBe(false);
  });

  it('asks main hung from the control, and turns YOLO on only once the host allows it', async () => {
    const control = await refused();
    control.click();
    await settle();
    expect(allowYolo).toHaveBeenCalledTimes(1);
    expect(Object.keys(allowYolo.mock.calls[0]![0]).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(posted).toContainEqual({ type: 'setDangerouslySkipPermissions', enabled: true });
    // on until core's capabilities say the host allows it, so the user can still turn it off
    expect(yolo()!.dataset.locked).toBeUndefined();
    expect(yolo()!.getAttribute('aria-pressed')).toBe('true');
  });

  it('sends the part of the control inside the page', async () => {
    const control = await refused();
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue({ x: -4, y: -2, left: -4, top: -2, right: 36, bottom: 18, width: 40, height: 20 } as DOMRect);
    control.click();
    await settle();
    expect(allowYolo).toHaveBeenCalledWith({ x: 0, y: 0, width: 36, height: 18 });
  });

  it('sends nothing when the user declines', async () => {
    allowYolo.mockResolvedValueOnce(false);
    const control = await refused();
    control.click();
    await settle();
    expect(yoloPosts()).toEqual([]);
    expect(yolo()!.dataset.locked).toBe('');
  });

  it('leaves YOLO off when main rejects the ask', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    allowYolo.mockRejectedValueOnce(new Error('no click or key in the shown chat'));
    const control = await refused();
    control.click();
    await settle();
    expect(yoloPosts()).toEqual([]);
    expect(yolo()!.dataset.locked).toBe('');
    expect(yolo()!.hasAttribute('aria-disabled')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('asks once while the question is open, keeping the control focusable', async () => {
    let answer!: (allowed: boolean) => void;
    allowYolo.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const control = await refused();
    control.focus();
    control.click();
    await settle();
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(control);
    control.click();
    await settle();
    expect(allowYolo).toHaveBeenCalledTimes(1);
    answer(false);
    await settle();
    expect(control.hasAttribute('aria-disabled')).toBe(false);
  });

  it('turns YOLO off without asking while it is on', async () => {
    const control = (await chatPage({ bypassPermissions: false }, { yoloOn: true }))!;
    expect(control.dataset.locked).toBeUndefined();
    control.click();
    await settle();
    expect(allowYolo).not.toHaveBeenCalled();
    expect(yoloPosts()).toEqual([{ type: 'setDangerouslySkipPermissions', enabled: false }]);
  });

  it('toggles plainly once the host allows YOLO', async () => {
    (await chatPage({ bypassPermissions: true }))!.click();
    await settle();
    expect(allowYolo).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ type: 'setDangerouslySkipPermissions', enabled: true });
  });

  it('stays hidden for a host main never asks about', async () => {
    hostLabel = { hostId: 'h2', name: 'loopback', computer: 'ALEXIOS-PC' };
    expect(await chatPage({ bypassPermissions: false })).toBeNull();
  });

  it('stays hidden on a local desktop chat', async () => {
    hostLabel = undefined;
    expect(await chatPage({ bypassPermissions: false })).toBeNull();
  });
});
