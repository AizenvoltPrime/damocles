// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from '@/App.vue';
import { i18n } from '@/i18n';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import type { BridgeHost } from '@shared/damocles-bridge';
import { OFFLINE_GRACE_MS, RECONNECTED_MS, type ChatConnection, type HeldMessageAction } from '@shared/host-connection';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

// useChatHost subscribes once per page, so every test's bridge shares one host and one set of listeners.
let label: BridgeHost | undefined;
const hostListeners = new Set<(host: BridgeHost) => void>();
let connection: ChatConnection | undefined;
let connectionListener: ((next: ChatConnection) => void) | undefined;
const actions: string[] = [];
const queueActions: HeldMessageAction[] = [];
const posted: unknown[] = [];
const pushHost = async (next: BridgeHost): Promise<void> => {
  label = next;
  for (const listener of hostListeners) listener(next);
  await nextTick();
};
const pushConnection = async (next: ChatConnection): Promise<void> => {
  connection = next;
  connectionListener?.(next);
  await nextTick();
};

let app: VueWrapper | null = null;

// classes that keep a sentence on one line or cut it
const SINGLE_LINE = /^(truncate|text-ellipsis|whitespace-nowrap|line-clamp-.+)$/;
// classes that cut, hide or fix the height of an element, so a wrapped line or an action inside it would not show whole
const CLIPPING = /^(truncate|overflow(-[xy])?-(hidden|clip)|h-\d.*|max-h-.+|hidden|invisible|sr-only)$|:(hidden|invisible|sr-only)$/;
const clippingOnPath = (from: Element, to: Element): string[] => {
  const found: string[] = [];
  for (let at: Element | null = from; at; at = at === to ? null : at.parentElement) found.push(...[...at.classList].filter((name) => CLIPPING.test(name)));
  return found;
};

beforeEach(() => {
  setActivePinia(createPinia());
  actions.length = 0;
  queueActions.length = 0;
  posted.length = 0;
  connection = undefined;
  connectionListener = undefined;
  window.damoclesBridge = {
    postMessage: (message) => void posted.push(message),
    onMessage: () => () => undefined,
    getState: () => undefined,
    setState: () => undefined,
    getHost: () => label,
    onHost: (listener) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
    getOffline: () => undefined,
    hostAction: (action) => void actions.push(action),
    getConnection: () => connection,
    onConnection: (listener) => {
      connectionListener = listener;
      return () => undefined;
    },
    queueAction: (action) => void queueActions.push(action),
  };
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
  delete (window as { damoclesBridge?: unknown }).damoclesBridge;
});

const HOST = { hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' };

async function mountApp(): Promise<VueWrapper> {
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
  // useChatHost keeps one host for the page: this test's label replaces the one an earlier test pushed
  if (label) await pushHost(label);
  return app;
}

describe("a remote chat's connection banner", () => {
  it('shows under the chat header while the host is offline, and Reconnect asks main for that host', async () => {
    label = { ...HOST, attention: 'offline' };
    await mountApp();
    await nextTick();
    const header = app!.get('[data-testid="chat-header"]').element;
    const banner = app!.get('[data-testid="chat-connection-banner"]');
    expect(banner.attributes('data-state')).toBe('offline');
    expect(banner.text()).toContain('prod-1 is offline');
    // the header is first in the pane, so it stays level with the neighbouring panes' top bars
    expect(header.compareDocumentPosition(banner.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.parentElement?.firstElementChild).toBe(header);
    await banner.get('button').trigger('click');
    expect(actions).toEqual(['reconnect']);
  });

  it('asks for a sign-in while an attempt waits on the user', async () => {
    label = { ...HOST, attention: 'signIn' };
    await mountApp();
    await pushHost({ ...HOST, attention: 'signIn' });
    const banner = app!.get('[data-testid="chat-connection-banner"]');
    expect(banner.text()).toContain('prod-1 is waiting for you to sign in');
    await banner.get('button').trigger('click');
    expect(actions).toEqual(['signIn']);
  });

  it('counts down after the grace, names the renamed host at once, and shows green before it collapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    label = HOST;
    connection = { state: { phase: 'waiting', since: Date.now(), retryAt: Date.now() + 5000 }, queued: [] };
    await mountApp();
    await nextTick();
    expect(app!.find('[data-testid="chat-connection-banner"]').exists()).toBe(false);
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    await nextTick();
    expect(app!.get('[data-testid="chat-connection-banner-text"]').text()).toBe('Reconnecting to prod-1 in 3 s');
    expect(app!.get('[data-testid="chat-connection-banner-announcement"]').text()).toBe('Reconnecting to prod-1');
    await pushHost({ ...HOST, name: 'billing-prod' });
    expect(app!.get('[data-testid="chat-connection-banner-text"]').text()).toBe('Reconnecting to billing-prod in 3 s');
    await app!.get('[data-testid="chat-connection-banner-action"]').trigger('click');
    expect(actions).toEqual(['reconnect']);
    await pushConnection({ state: { phase: 'connected' }, queued: [] });
    expect(app!.get('[data-testid="chat-connection-banner"]').attributes('data-state')).toBe('reconnected');
    vi.advanceTimersByTime(RECONNECTED_MS);
    await nextTick();
    expect(app!.find('[data-testid="chat-connection-banner"]').exists()).toBe(false);
  });
});

// happy-dom lays nothing out, so these pin the classes Chromium wraps with; the screenshots in the frontend report show the result.
describe('at a narrow width', () => {
  const LONG = 'Run the database migrations on staging, then restart the API and tail its log until the health check passes';

  it('wraps the failed sentence onto its own line before any action, and clips or hides no action', async () => {
    label = HOST;
    connection = { state: { phase: 'failed', since: Date.now() - OFFLINE_GRACE_MS, code: 'authFailed' }, queued: [] };
    await mountApp();
    await nextTick();
    const banner = app!.get('[data-testid="chat-connection-banner"]');
    const text = app!.get('[data-testid="chat-connection-banner-text"]');
    const actions = app!.get('[data-testid="chat-connection-banner-actions"]');
    expect(banner.attributes('data-state')).toBe('failed');
    expect(banner.classes()).toContain('@container/banner');
    expect(text.classes()).toContain('@max-[24rem]/banner:basis-full');
    expect(text.classes().filter((name) => SINGLE_LINE.test(name))).toEqual([]);
    expect(text.element.parentElement).toBe(actions.element.parentElement);
    expect(text.element.parentElement!.classList).toContain('flex-wrap');
    expect(actions.classes()).toContain('flex-wrap');
    expect(actions.findAll('button').map((button) => button.text())).toEqual(['Retry', 'Show log', 'Edit host']);
    for (const button of actions.findAll('button')) expect(clippingOnPath(button.element, banner.element)).toEqual([]);
  });

  it('shows the shared queued status once and truncates long chip text, whole in its title, so chips flow side by side', async () => {
    label = HOST;
    const queued = [{ id: 'q1', text: LONG, imageCount: 0, status: 'queued' }, { id: 'q2', text: `${LONG} again`, imageCount: 0, status: 'queued' }] as const;
    connection = { state: { phase: 'running', since: 1 }, queued: [...queued] };
    await mountApp();
    await nextTick();
    expect(app!.get('[data-testid="held-messages-status"]').text()).toBe('Queued · sends when prod-1 reconnects');
    expect(app!.get('[data-testid="held-messages"]').classes()).toContain('flex-wrap');
    const chips = app!.findAll('[data-testid="held-message"]');
    expect(chips.map((chip) => chip.get('[data-testid="held-message-text"]').attributes('title'))).toEqual(queued.map((message) => message.text));
    for (const chip of chips) {
      const text = chip.get('[data-testid="held-message-text"]');
      expect(text.classes()).toEqual(expect.arrayContaining(['truncate', 'min-w-0', '@max-[40rem]/held:max-w-20']));
      // the per-chip status is read out, never drawn, so a long chip is no wider than its text and Cancel
      expect(chip.findAll('span').filter((span) => span.text() === 'Queued · sends when prod-1 reconnects').map((span) => span.classes())).toEqual([['sr-only']]);
      expect(clippingOnPath(chip.get('[data-testid="held-message-cancel"]').element, chip.element)).toEqual([]);
    }
  });
});

describe("a remote chat's held messages", () => {
  const QUEUED = { id: 'q1', text: 'deploy it', imageCount: 0, status: 'queued' } as const;

  it('shows each held message as a chip with Cancel, and announces a newly held one', async () => {
    label = HOST;
    connection = { state: { phase: 'running', since: 1 }, queued: [QUEUED] };
    await mountApp();
    await nextTick();
    const chip = app!.get('[data-testid="held-message"]');
    expect(chip.attributes('data-status')).toBe('queued');
    expect(chip.text()).toContain('deploy it');
    expect(chip.text()).toContain('Queued · sends when prod-1 reconnects');
    await chip.get('[data-testid="held-message-cancel"]').trigger('click');
    expect(queueActions).toEqual([{ action: 'cancel', id: 'q1' }]);
    await pushConnection({ state: { phase: 'running', since: 1 }, queued: [QUEUED, { ...QUEUED, id: 'q2', text: 'and test it' }] });
    expect(app!.get('[data-testid="held-messages-announcement"]').text()).toBe('Message queued until prod-1 reconnects');
  });

  it('turns a message core refused for another conversation into a not-sent chip with Copy and Discard', async () => {
    label = HOST;
    connection = { state: { phase: 'connected' }, queued: [{ ...QUEUED, status: 'notSent' }] };
    await mountApp();
    await nextTick();
    const chip = app!.get('[data-testid="held-message"]');
    expect(chip.text()).toContain('Not sent: this chat moved to another conversation');
    expect(chip.find('[data-testid="held-message-cancel"]').exists()).toBe(false);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await chip.get('[data-testid="held-message-copy"]').trigger('click');
    expect(writeText).toHaveBeenCalledWith('deploy it');
    await chip.get('[data-testid="held-message-discard"]').trigger('click');
    expect(queueActions).toEqual([{ action: 'discard', id: 'q1' }]);
  });

  it.each([
    ['a sign-in wait', () => usePermissionStore().addSignIn({ requestId: 's1', provider: 'anthropic' })],
    ["an MCP server's question", () => useElicitationStore().addElicitation({ serverName: 'docs', message: 'Token?', mode: 'form', elicitationId: 'e1' })],
    ["an extension's dialog", () => useExtensionUiStore().setRequest({ requestId: 'x1', kind: 'confirm', title: 'Go on?' } as never)],
  ])('hints that %s can be answered once the host reconnects', async (_name, raise) => {
    label = HOST;
    connection = { state: { phase: 'waiting', since: 1, retryAt: 2 }, queued: [] };
    await mountApp();
    raise();
    await nextTick();
    expect(app!.get('[data-testid="prompts-away-hint"]').text()).toBe('prod-1 is not connected. You can answer once it reconnects.');
  });

  it('keeps a waiting approval readable but closed to input while the host is away, with a hint', async () => {
    label = HOST;
    connection = { state: { phase: 'waiting', since: 1, retryAt: 2 }, queued: [] };
    await mountApp();
    usePermissionStore().addPermission('t1', { owner: { kind: 'main' }, toolName: 'Bash', toolInput: { command: 'npm test' }, command: 'npm test' });
    await nextTick();
    const prompts = app!.get('[data-testid="chat-prompts"]');
    expect(prompts.attributes('inert')).toBeDefined();
    expect(prompts.find('[data-testid="permission-card"]').exists()).toBe(true);
    expect(app!.get('[data-testid="prompts-away-hint"]').text()).toBe('prod-1 is not connected. You can answer once it reconnects.');
    await pushConnection({ state: { phase: 'connected' }, queued: [] });
    expect(app!.get('[data-testid="chat-prompts"]').attributes('inert')).toBeUndefined();
    expect(app!.find('[data-testid="prompts-away-hint"]').exists()).toBe(false);
  });
});
