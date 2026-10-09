// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ChatInput from '../ChatInput.vue';
import UserMessageBlock from '../UserMessageBlock.vue';
import TerminalAttachmentChip from '../TerminalAttachmentChip.vue';
import { i18n } from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { createUIHandlers } from '@/composables/message-handler/handlers/ui-handlers';
import { createStreamingHandlers } from '@/composables/message-handler/handlers/streaming-handlers';
import { createHistoryHandlers } from '@/composables/message-handler/handlers/history-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { terminalAttachmentLabel } from '@/utils/terminal-attachment-label';
import type { TerminalAttachmentInfo } from '@shared/types/terminal-attachment';
import type { ChatMessage } from '@shared/types/session';

const bridge = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
let posted: Array<{ type: string; [key: string]: unknown }> = [];
const mounted: VueWrapper[] = [];

const failing: TerminalAttachmentInfo = { id: 'a1', source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 120, omittedLines: 0, preview: 'FAIL <b>a.test.ts</b>' };
const selection: TerminalAttachmentInfo = { id: 'a2', source: 'selection', commandLine: null, exitCode: null, terminalTitle: 'bash', lineCount: 1, omittedLines: 0, preview: 'ok' };

function composer(isProcessing = false): VueWrapper {
  const wrapper = mount(ChatInput, {
    props: { isProcessing, permissionMode: 'default', dangerouslySkipPermissions: false },
    global: { plugins: [i18n], stubs: { ElementAttachmentStrip: true, ImageThumbnailStrip: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

async function typeAndSend(wrapper: VueWrapper, text: string): Promise<void> {
  const textarea = wrapper.get('textarea');
  await textarea.setValue(text);
  textarea.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  posted = [];
  vi.spyOn(bridge, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('terminal attachment chips', () => {
  it('labels a command by its line, exit code and line count, and a selection by its terminal', () => {
    const t = i18n.global.t as never;
    expect(terminalAttachmentLabel(failing, t)).toBe('Terminal: npm test · exit 1 · 120 lines');
    expect(terminalAttachmentLabel(selection, t)).toBe('Terminal selection · bash · 1 line');
  });

  it('labels a multi-line command line the same live and after a reload, which keeps it on one line', () => {
    const t = i18n.global.t as never;
    const live = terminalAttachmentLabel({ ...failing, commandLine: 'npm run build &&\r\n  npm  test\n' }, t);
    expect(live).toBe('Terminal: npm run build && npm test · exit 1 · 120 lines');
    expect(terminalAttachmentLabel({ ...failing, commandLine: 'npm run build &&   npm  test ' }, t)).toBe(live);
  });

  it('renders a detail that repeats another without a duplicate key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wrapper = mount(TerminalAttachmentChip, { props: { attachment: { ...selection, lineCount: 2 } }, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    await wrapper.setProps({ attachment: { ...selection, terminalTitle: '1 line', exitCode: 0 } });
    expect(wrapper.text()).toContain('·1 line·exit 0·1 line');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('Duplicate keys'))).toBe(false);
  });

  it('shows core\'s pending attachments in the composer and asks core to remove one', async () => {
    useUIStore().setTerminalAttachments([failing, selection]);
    const wrapper = composer();
    await wrapper.vm.$nextTick();
    const chips = wrapper.findAll('[data-testid="terminal-attachment-chip"]');
    expect(chips.map((chip) => chip.attributes('data-attachment-id'))).toEqual(['a1', 'a2']);
    expect(chips[0]!.attributes('data-tone')).toBe('danger');
    expect(chips[0]!.get('[data-testid="terminal-attachment-preview-button"]').attributes('aria-label')).toBe('Preview Terminal: npm test · exit 1 · 120 lines');
    await chips[1]!.get('[data-testid="terminal-attachment-remove"]').trigger('click');
    expect(posted).toContainEqual({ type: 'removeTerminalAttachment', id: 'a2' });
  });

  it('hands focus to the next chip, then to the composer, when a focused chip is removed', async () => {
    const ui = useUIStore();
    ui.setTerminalAttachments([failing, selection]);
    const wrapper = composer();
    await wrapper.vm.$nextTick();
    const removeOf = (id: string) => wrapper.get(`[data-attachment-id="${id}"] [data-testid="terminal-attachment-remove"]`);
    (removeOf('a1').element as HTMLElement).focus();
    await removeOf('a1').trigger('click');
    ui.setTerminalAttachments([selection]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(wrapper.get('[data-attachment-id="a2"] [data-testid="terminal-attachment-preview-button"]').element);

    (removeOf('a2').element as HTMLElement).focus();
    await removeOf('a2').trigger('click');
    ui.setTerminalAttachments([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(wrapper.get('textarea').element);
  });

  it('sends the chips\' ids with a message sent now, and none with a queued one', async () => {
    useUIStore().setTerminalAttachments([failing]);
    const now = composer();
    await typeAndSend(now, 'why?');
    expect(now.emitted('send')).toEqual([['why?', expect.any(Boolean), ['a1']]]);

    const queued = composer(true);
    await typeAndSend(queued, 'later');
    expect(queued.emitted('queue')).toEqual([['later']]);
    expect(queued.emitted('send')).toBeUndefined();
  });

  it('previews the output as plain text, never as markup', async () => {
    const wrapper = mount(TerminalAttachmentChip, { props: { attachment: failing }, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper);
    wrapper.get('[data-testid="terminal-attachment-preview-button"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    const preview = document.querySelector('[data-testid="terminal-attachment-preview-text"]');
    expect(preview?.textContent).toBe('FAIL <b>a.test.ts</b>');
    expect(preview?.querySelector('b')).toBeNull();
    expect(wrapper.find('[data-testid="terminal-attachment-remove"]').exists()).toBe(false);
  });

  it('replaces the pending list on each update from core', () => {
    const ui = useUIStore();
    const handlers = createUIHandlers();
    const ctx = { stores: { uiStore: ui } } as unknown as HandlerContext;
    handlers.terminalAttachmentsUpdate!({ type: 'terminalAttachmentsUpdate', attachments: [failing] }, ctx);
    expect(ui.terminalAttachments).toEqual([failing]);
    handlers.terminalAttachmentsUpdate!({ type: 'terminalAttachmentsUpdate', attachments: [] }, ctx);
    expect(ui.terminalAttachments).toEqual([]);
  });

  it('focuses the composer only for an attachment the user just added', async () => {
    const focus = vi.fn();
    const ctx = { stores: { uiStore: useUIStore() }, refs: { chatInputRef: { value: { focus } } } } as unknown as HandlerContext;
    const handlers = createUIHandlers();
    handlers.terminalAttachmentsUpdate!({ type: 'terminalAttachmentsUpdate', attachments: [failing] }, ctx);
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
    handlers.terminalAttachmentsUpdate!({ type: 'terminalAttachmentsUpdate', attachments: [failing, selection], focusComposer: true }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('a sent message with terminal attachments', () => {
  it('carries the chips on the live and the replayed user message, and renders them on the bubble', async () => {
    const streaming = useStreamingStore();
    const ctx = { stores: { streamingStore: streaming } } as unknown as HandlerContext;
    createStreamingHandlers().userMessage!({ type: 'userMessage', content: 'why?', terminalAttachments: [failing], correlationId: 'c1', promptIndex: 0 }, ctx);
    createHistoryHandlers().userReplay!({ type: 'userReplay', content: 'again', terminalAttachments: [selection], sdkMessageId: 'u2', promptIndex: 1 }, ctx);
    streaming.flushReplayQueue();
    const users = streaming.messages.filter((message) => message.role === 'user');
    expect(users.map((message) => message.terminalAttachments?.[0]?.id)).toEqual(['a1', 'a2']);
    expect(users.map((message) => message.content)).toEqual(['why?', 'again']);

    const row = mount(UserMessageBlock, {
      props: { message: users[0] as ChatMessage, messageIndex: 0, canRewind: false, promptIndex: 0 },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    });
    mounted.push(row);
    expect(row.findAll('[data-testid="user-message-terminal-attachments"] [data-testid="terminal-attachment-chip"]')).toHaveLength(1);
  });

  it('renders a message without attachments, as the VS Code host sends it, with no chips', () => {
    const row = mount(UserMessageBlock, {
      props: { message: { id: 'u1', role: 'user', content: 'hello', timestamp: 1 }, messageIndex: 0, canRewind: false, promptIndex: 0 },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    });
    mounted.push(row);
    expect(row.find('[data-testid="user-message-terminal-attachments"]').exists()).toBe(false);
  });
});
