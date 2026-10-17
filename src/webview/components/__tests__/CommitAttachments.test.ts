// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ChatInput from '../ChatInput.vue';
import UserMessageBlock from '../UserMessageBlock.vue';
import CommitAttachmentChip from '../CommitAttachmentChip.vue';
import { i18n } from '@/i18n';
import { commitTime } from '@/utils/clock';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { createInputHandlers } from '@/composables/message-handler/handlers/input-handlers';
import { createHistoryHandlers } from '@/composables/message-handler/handlers/history-handlers';
import type { ChatInputExposed, HandlerContext } from '@/composables/message-handler/types';
import type { CommitAttachmentInfo } from '@shared/types/chat-attachment';
import type { TerminalAttachmentInfo } from '@shared/types/terminal-attachment';
import type { ChatMessage } from '@shared/types/session';

const bridge = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
let posted: Array<{ type: string; [key: string]: unknown }> = [];
const mounted: VueWrapper[] = [];

const SUBJECT = 'Rework the exports so that every module re-exports its public names from one index file';
const commit: CommitAttachmentInfo = {
  id: 'c1', kind: 'commit', hash: '1a2b3c4d5e6f'.padEnd(40, '0'), subject: SUBJECT, author: 'Ada', authorDate: Date.UTC(2026, 4, 1, 10, 30),
  lineCount: 60, omittedLines: 12, preview: 'commit 1a2b3c4\n<b>bold</b>',
};
const terminal: TerminalAttachmentInfo = { id: 't1', kind: 'terminal', source: 'selection', commandLine: null, exitCode: null, terminalTitle: 'bash', lineCount: 1, omittedLines: 0, preview: 'ok' };
const EXPLAIN = 'Explain the changes in this commit.';

function composer(): VueWrapper {
  const wrapper = mount(ChatInput, {
    props: { isProcessing: false, permissionMode: 'default', dangerouslySkipPermissions: false },
    global: { plugins: [i18n], stubs: { ElementAttachmentStrip: true, ImageThumbnailStrip: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('commit attachment chips', () => {
  it('shows the short hash and the subject, the whole label in its title and accessible name, and asks core to remove it', async () => {
    useUIStore().setTerminalAttachments([commit, terminal]);
    const wrapper = composer();
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-attachment-id]').map((chip) => chip.attributes('data-testid'))).toEqual(['commit-attachment-chip', 'terminal-attachment-chip']);
    const chip = wrapper.get('[data-testid="commit-attachment-chip"]');
    expect(chip.get('[data-testid="commit-attachment-hash"]').text()).toBe('1a2b3c4');
    expect(chip.get('[data-testid="commit-attachment-subject"]').text()).toBe(SUBJECT);
    expect(chip.get('[data-testid="commit-attachment-subject"]').classes()).toContain('truncate');
    const button = chip.get('[data-testid="commit-attachment-preview-button"]');
    expect(button.attributes('title')).toBe(`Commit 1a2b3c4 · ${SUBJECT}`);
    expect(button.attributes('aria-label')).toBe(`Preview Commit 1a2b3c4 · ${SUBJECT}`);
    expect(chip.get('[data-testid="commit-attachment-remove"]').attributes('aria-label')).toBe(`Remove Commit 1a2b3c4 · ${SUBJECT}`);
    await chip.get('[data-testid="commit-attachment-remove"]').trigger('click');
    expect(posted).toContainEqual({ type: 'removeTerminalAttachment', id: 'c1' });
  });

  it('announces a commit as it arrives, and sends its id with the message', async () => {
    const ui = useUIStore();
    const wrapper = composer();
    ui.setTerminalAttachments([commit]);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="terminal-attachments"] + p').text()).toBe(`Commit attached: Commit 1a2b3c4 · ${SUBJECT}`);
    const textarea = wrapper.get('textarea');
    await textarea.setValue('why?');
    textarea.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('send')).toEqual([['why?', expect.any(Boolean), ['c1']]]);
  });

  it('previews the commit\'s start as plain text with the lines not shown', async () => {
    const wrapper = mount(CommitAttachmentChip, { props: { attachment: commit }, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper);
    wrapper.get('[data-testid="commit-attachment-preview-button"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    await wrapper.vm.$nextTick();
    const preview = document.querySelector('[data-testid="commit-attachment-preview"]');
    const text = preview?.querySelector('[data-testid="commit-attachment-preview-text"]');
    expect(text?.textContent).toBe('commit 1a2b3c4\n<b>bold</b>');
    expect(text?.querySelector('b')).toBeNull();
    expect(preview?.textContent).toContain('12 more lines not shown');
    expect(preview?.textContent).toContain('Ada');
    // the commit's time as the Graph and the blame card word it, on the 24-hour clock
    expect(preview?.querySelector('[data-testid="commit-attachment-details"]')?.textContent?.trim()).toBe(`1a2b3c4 · Ada · ${commitTime(commit.authorDate, 'en').full}`);
    expect(preview?.textContent).not.toMatch(/AM|PM/);
    expect(wrapper.find('[data-testid="commit-attachment-remove"]').exists()).toBe(false);
  });

  it('renders a replayed message\'s commit chip on the bubble', async () => {
    const streaming = useStreamingStore();
    const ctx = { stores: { streamingStore: streaming } } as unknown as HandlerContext;
    createHistoryHandlers().userReplay!({ type: 'userReplay', content: EXPLAIN, terminalAttachments: [commit], sdkMessageId: 'u1', promptIndex: 0 }, ctx);
    streaming.flushReplayQueue();
    const user = streaming.messages.find((message) => message.role === 'user')!;
    const row = mount(UserMessageBlock, {
      props: { message: user as ChatMessage, messageIndex: 0, canRewind: false, promptIndex: 0 },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    });
    mounted.push(row);
    const chips = row.get('[data-testid="user-message-terminal-attachments"]').findAll('[data-testid="commit-attachment-chip"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.find('[data-testid="commit-attachment-remove"]').exists()).toBe(false);
  });
});

describe('the Explain Changes prompt', () => {
  it('becomes the text of an empty composer, with the caret at its end and the composer focused', async () => {
    const wrapper = composer();
    (wrapper.vm as unknown as ChatInputExposed).appendPrompt(EXPLAIN);
    await wrapper.vm.$nextTick();
    await settle();
    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement;
    expect(textarea.value).toBe(EXPLAIN);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(EXPLAIN.length);
    expect(textarea.selectionEnd).toBe(EXPLAIN.length);
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('joins a draft on a new line and never replaces it', async () => {
    const wrapper = composer();
    await wrapper.get('textarea').setValue('Also check the tests.');
    (wrapper.vm as unknown as ChatInputExposed).appendPrompt(EXPLAIN);
    await wrapper.vm.$nextTick();
    await settle();
    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement;
    expect(textarea.value).toBe(`Also check the tests.\n${EXPLAIN}`);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    // a draft that already ends its line gets no blank line
    await wrapper.get('textarea').setValue('First line\n');
    (wrapper.vm as unknown as ChatInputExposed).appendPrompt(EXPLAIN);
    await wrapper.vm.$nextTick();
    expect(textarea.value).toBe(`First line\n${EXPLAIN}`);
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('reaches the composer from core\'s message, or waits for a composer that has not mounted yet', () => {
    const appendPrompt = vi.fn();
    const handlers = createInputHandlers();
    const ui = useUIStore();
    handlers.composerAppend!({ type: 'composerAppend', text: EXPLAIN }, { stores: { uiStore: ui }, refs: { chatInputRef: { value: { appendPrompt } } } } as unknown as HandlerContext);
    expect(appendPrompt).toHaveBeenCalledWith(EXPLAIN);
    handlers.composerAppend!({ type: 'composerAppend', text: EXPLAIN }, { stores: { uiStore: ui }, refs: { chatInputRef: { value: null } } } as unknown as HandlerContext);
    expect(ui.appendedPrompt).toEqual([EXPLAIN]);
    expect(posted.some((message) => message.type === 'sendMessage')).toBe(false);
  });
});
