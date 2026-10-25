// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import type { McpResourceAttachmentInfo } from '@shared/types/chat-attachment';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn(), dismiss: vi.fn() }));
vi.mock('vue-sonner', async (importOriginal) => ({ ...(await importOriginal<object>()), toast }));

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {
    this.callback([{ contentRect: { width: 16, height: 16 }, borderBoxSize: [{ inlineSize: 900, blockSize: 46 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect(): void {}
  unobserve(): void {}
}

type Globals = { acquireVsCodeApi?: (() => VsCodeApi) | undefined };
const g = globalThis as unknown as Globals;
const setupApi = g.acquireVsCodeApi;

const guide: McpResourceAttachmentInfo = { id: 'r1', kind: 'mcpResource', server: 'docs', uri: 'docs://guide', name: 'Guide', mimeType: 'text/markdown' };

let app: VueWrapper | null = null;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  toast.info.mockClear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  g.acquireVsCodeApi = setupApi;
  delete window.damoclesBridge;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const frames = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
const q = (selector: string): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);

/** The chat page on one host: its bridge, the capabilities that host sends, and the messages the page posts. */
async function chatPage(host: 'vscode' | 'desktop') {
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  let deliver: (message: ExtensionToWebviewMessage) => void;
  if (host === 'vscode') {
    const api: VsCodeApi = { postMessage: (message: unknown) => void posted.push(message as { type: string }), getState: () => undefined, setState: () => {} };
    g.acquireVsCodeApi = () => api;
    deliver = (message) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  } else {
    delete g.acquireVsCodeApi;
    // As the panel preload does: every subscriber hears each message, so the picker's own one leaves App's in place.
    const listeners = new Set<(message: unknown) => void>();
    window.damoclesBridge = {
      postMessage: (message: unknown) => void posted.push(message as { type: string }),
      onMessage: (next: (message: unknown) => void) => {
        listeners.add(next);
        return () => { listeners.delete(next); };
      },
      getState: () => undefined,
      setState: () => {},
      getHost: () => undefined,
      onHost: () => () => {},
    } satisfies NonNullable<typeof window.damoclesBridge>;
    deliver = (message) => {
      for (const listener of [...listeners]) listener(message);
    };
  }
  const [{ mount }, { setActivePinia, createPinia }, { default: App }, { i18n }, { useSettingsStore }, { VSCODE_HOST_CAPABILITIES }] = await Promise.all([
    import('@vue/test-utils'),
    import('pinia'),
    import('@/App.vue'),
    import('@/i18n'),
    import('@/stores/useSettingsStore'),
    import('@shared/types/messages'),
  ]);
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  useSettingsStore().hostCapabilities = host === 'vscode'
    ? VSCODE_HOST_CAPABILITIES
    : { ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false, historyInPanel: false, folderPickerInPanel: false, windowLayout: true, worktrees: true };
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
  await frames();
  const send = async (message: ExtensionToWebviewMessage) => {
    deliver(message);
    await frames();
  };
  return { posted, send };
}

async function typeAndSend(text: string): Promise<void> {
  const textarea = q('textarea') as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await frames();
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await frames();
}

describe.each(['vscode', 'desktop'] as const)('an attached MCP resource in the %s chat page', (host) => {
  it('shows its chip in the composer, sends its id with the message, and shows it on the sent message', async () => {
    const page = await chatPage(host);
    await page.send({ type: 'terminalAttachmentsUpdate', attachments: [guide], focusComposer: true });
    const chip = q('[data-testid="terminal-attachments"] [data-testid="mcp-resource-attachment-chip"]')!;
    expect(chip.getAttribute('data-uri')).toBe('docs://guide');
    expect(chip.querySelector('[data-testid="mcp-resource-attachment-name"]')?.textContent).toBe('Guide');
    expect(chip.querySelector('[data-testid="mcp-resource-attachment-server"]')?.textContent).toBe('docs');
    expect(chip.querySelector('[data-testid="mcp-resource-attachment-preview-button"]')?.getAttribute('aria-label')).toBe('Details of Guide · docs');

    await typeAndSend('summarize it');
    expect(page.posted).toContainEqual(expect.objectContaining({ type: 'sendMessage', content: 'summarize it', terminalAttachmentIds: ['r1'] }));

    await page.send({ type: 'terminalAttachmentsUpdate', attachments: [] });
    await page.send({ type: 'userMessage', content: 'summarize it', terminalAttachments: [guide], correlationId: 'c1', promptIndex: 0 });
    const { useStreamingStore } = await import('@/stores/useStreamingStore');
    expect(useStreamingStore().messages.filter((message) => message.role === 'user').map((message) => message.terminalAttachments)).toEqual([[guide]]);
  }, 30_000);

  it('puts the text back in the composer with the reason when core refuses the send, and core\'s update restores the chip', async () => {
    const page = await chatPage(host);
    await page.send({ type: 'promptReturned', content: [{ type: 'text', text: 'summarize it' }], reason: 'mcpResourceUnavailable', detail: 'Guide from docs could not be read: gone' });
    await page.send({ type: 'terminalAttachmentsUpdate', attachments: [guide] });

    expect((q('textarea') as HTMLTextAreaElement).value).toBe('summarize it');
    expect(q('[data-testid="mcp-resource-attachment-chip"]')).not.toBeNull();
    expect(toast.info).toHaveBeenCalledWith(
      'An attached MCP resource could not be sent, so your message and its attachments are back in the input.',
      { description: 'Guide from docs could not be read: gone' },
    );
  }, 30_000);
});

const serverStatus = (names: string[]): ExtensionToWebviewMessage => ({
  type: 'mcpServerStatus',
  servers: names.map((name) => ({ name, status: 'connected', enabled: true, hasResources: true })),
  mcpEnabled: true,
  configErrors: [],
  toolExposureScopes: ['user'],
  localMcpUnignored: false,
});

/** The chat page with the MCP panel open and the picker opened from it for `docs`. */
async function openPicker(host: 'vscode' | 'desktop') {
  const page = await chatPage(host);
  await page.send(serverStatus(['docs', 'notes']));
  const { useUIStore } = await import('@/stores/useUIStore');
  useUIStore().openMcpPanel();
  await frames();
  q('[data-testid="mcp-panel"] [data-row-action="browseResources"]')!.click();
  // The picker is an async component.
  await vi.waitFor(() => expect(q('[data-testid="mcp-resource-picker"]')).not.toBeNull(), { timeout: 10_000 });
  return { ...page, uiStore: useUIStore() };
}

describe.each(['vscode', 'desktop'] as const)('Browse resources from the MCP panel in the %s chat page', (host) => {
  it('opens the picker over the panel for that server, and an attach closes both and leaves focus in the composer', async () => {
    const page = await openPicker(host);
    const listRequest = page.posted.find((message) => message.type === 'requestMcpResources')!;
    expect(listRequest).toMatchObject({ serverName: 'docs' });

    await page.send({ type: 'mcpResources', requestId: listRequest['requestId'] as string, resources: [{ uri: 'docs://guide', name: 'Guide' }] });
    q('[data-uri="docs://guide"]')!.click();
    await frames();
    const attach = page.posted.find((message) => message.type === 'attachMcpResource')!;
    expect(attach).toMatchObject({ serverName: 'docs', uri: 'docs://guide' });
    // Core adds the chip, focusing the composer, and then answers the picker.
    await page.send({ type: 'terminalAttachmentsUpdate', attachments: [{ ...guide, id: 'r2' }], focusComposer: true });
    await page.send({ type: 'mcpResourceAttached', requestId: attach['requestId'] as string });
    expect(q('[data-testid="mcp-resource-picker"]')).toBeNull();
    expect(page.uiStore.showMcpPanel).toBe(false);
    expect(document.activeElement).toBe(q('textarea'));
  }, 30_000);

  it('closes the picker when the chat moves to another folder, and when the server set changes', async () => {
    const page = await openPicker(host);
    await page.send(serverStatus(['notes', 'docs']));
    expect(q('[data-testid="mcp-resource-picker"]')).not.toBeNull();
    await page.send({ type: 'workspaceFolderUpdate', folders: [], panelFolderKey: 'other', defaultFolderKey: 'other' });
    expect(q('[data-testid="mcp-resource-picker"]')).toBeNull();

    q('[data-testid="mcp-panel"] [data-row-action="browseResources"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="mcp-resource-picker"]')).not.toBeNull(), { timeout: 10_000 });
    await page.send(serverStatus(['docs']));
    expect(q('[data-testid="mcp-resource-picker"]')).toBeNull();
  }, 30_000);
});

describe('an MCP resource tool card', () => {
  it('opens McpToolOverlay for read_mcp_resource', async () => {
    await chatPage('vscode');
    const [{ useStreamingStore }, { useUIStore }] = await Promise.all([import('@/stores/useStreamingStore'), import('@/stores/useUIStore')]);
    useStreamingStore().messages.push({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{ id: 'read-1', name: 'read_mcp_resource', input: { server: 'docs', uri: 'docs://guide' }, status: 'completed', result: 'text' }],
    });
    useUIStore().expandTool('read-1', 'session');
    await vi.waitFor(() => expect(app!.findComponent({ name: 'McpToolOverlay' }).exists()).toBe(true), { timeout: 10_000 });
    expect(app!.findComponent({ name: 'ToolOverlay' }).exists()).toBe(false);
  }, 30_000);
});

describe('an MCP resource chip on a sent message', () => {
  it('names the resource and its server, with no remove button', async () => {
    const [{ mount }, { setActivePinia, createPinia }, { default: UserMessageBlock }, { i18n }] = await Promise.all([
      import('@vue/test-utils'),
      import('pinia'),
      import('../UserMessageBlock.vue'),
      import('@/i18n'),
    ]);
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    app = mount(UserMessageBlock, {
      props: { message: { id: 'u1', role: 'user', content: 'summarize it', timestamp: 1, terminalAttachments: [guide] }, messageIndex: 0, canRewind: false, promptIndex: 0 },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
      attachTo: document.body,
    });
    const chip = q('[data-testid="user-message-terminal-attachments"] [data-testid="mcp-resource-attachment-chip"]')!;
    expect(chip.textContent).toContain('Guide');
    expect(chip.textContent).toContain('docs');
    expect(chip.querySelector('[data-testid="mcp-resource-attachment-remove"]')).toBeNull();
  }, 30_000);

  it('shows a URI’s hidden characters in its title and details, and keeps the raw URI', async () => {
    const [{ mount }, { default: McpResourceAttachmentChip }, { i18n }] = await Promise.all([
      import('@vue/test-utils'),
      import('../McpResourceAttachmentChip.vue'),
      import('@/i18n'),
    ]);
    i18n.global.locale.value = 'en';
    const spoofed = { ...guide, uri: 'docs://safe\u202Etxt.exe' };
    app = mount(McpResourceAttachmentChip, { props: { attachment: spoofed }, global: { plugins: [i18n] }, attachTo: document.body });
    expect(q('[data-testid="mcp-resource-attachment-chip"]')!.getAttribute('data-uri')).toBe(spoofed.uri);
    const trigger = q('[data-testid="mcp-resource-attachment-preview-button"]')!;
    expect(trigger.getAttribute('title')).toBe('MCP resource Guide from docs: docs://safe\\u{202E}txt.exe');

    trigger.click();
    await vi.waitFor(() => expect(q('[data-testid="mcp-resource-attachment-uri"]')).not.toBeNull());
    expect(q('[data-testid="mcp-resource-attachment-uri"]')!.textContent!.trim()).toBe('docs://safe\\u{202E}txt.exe');
  }, 30_000);

  /** The chip's details line, which names the server and the resource's type. */
  async function detailsLine(attachment: McpResourceAttachmentInfo, locale: 'en' | 'el', message?: string): Promise<string> {
    const [{ mount }, { default: McpResourceAttachmentChip }, { i18n }] = await Promise.all([
      import('@vue/test-utils'),
      import('../McpResourceAttachmentChip.vue'),
      import('@/i18n'),
    ]);
    i18n.global.locale.value = locale;
    if (message !== undefined) i18n.global.mergeLocaleMessage(locale, { mcp: { resourceChip: { details: message } } });
    app = mount(McpResourceAttachmentChip, { props: { attachment }, global: { plugins: [i18n] }, attachTo: document.body });
    q('[data-testid="mcp-resource-attachment-preview-button"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="mcp-resource-attachment-details"]')).not.toBeNull());
    return q('[data-testid="mcp-resource-attachment-details"]')!.textContent!.trim();
  }

  it.each([
    ['en', 'docs · text/markdown'],
    ['el', 'docs · text/markdown'],
  ] as const)('names the server and the type in %s', async (locale, expected) => {
    expect(await detailsLine(guide, locale)).toBe(expected);
  }, 30_000);

  it('names the server alone for a resource with no type', async () => {
    expect(await detailsLine({ id: 'r1', kind: 'mcpResource', server: 'docs', uri: 'docs://guide', name: 'Guide' }, 'el')).toBe('docs');
  }, 30_000);

  it('leaves the order and punctuation of the server and the type to the translation', async () => {
    expect(await detailsLine(guide, 'el', '{type}, από {serverName}')).toBe('text/markdown, από docs');
  }, 30_000);
});
